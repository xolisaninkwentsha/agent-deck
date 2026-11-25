// Service agents: long-running programs that aren't Claude Code sessions (e.g. finance-agent).
// They report to the daemon over POST /agent ({agent, event, ...}); see clients/python/agent_deck.py.
// This module only keeps their state; the daemon does the I/O.

export const AGENT_STATUS = {
  IDLE: 'idle', WORKING: 'working', WAITING: 'waiting', ERROR: 'error', NOT_RESPONDING: 'not_responding',
};
export const AGENT_NAME = /^[A-Za-z0-9][\w.-]{0,47}$/;

const MAX_RECENT = 10;
const MAX_WAITING = 50;
const text = (v, n) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, n));
const time = (v, now) => {
  const n = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v); // seconds, ms or ISO
  return Number.isFinite(n) ? n : now;
};
// Links open in the browser from the panel, so only web links are kept.
const safeLink = (v) => {
  try { const u = new URL(String(v)); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; } catch { return ''; }
};

export function newAgent(key, name, host) {
  return {
    key, name, host, displayName: name, description: '', cwd: '',
    heartbeat: 0, lastHeartbeat: 0, lastSeen: 0, startedAt: 0,
    jobs: {}, step: '', recent: [], waiting: {}, schedule: [], scheduleFrom: null,
    lastError: null, lastJobStart: 0, lastOk: 0,
  };
}

// Apply one event. Returns false for an unknown event.
export function applyAgentEvent(a, ev, now = Date.now()) {
  a.lastSeen = now;
  switch (ev.event) {
    case 'start':
      // The long-running process (re)started. Cron jobs run in other processes, so running jobs
      // and the last error stay: a restart mustn't hide a job mid-run or a crash loop.
      a.displayName = text(ev.name, 60) || a.name;
      a.description = text(ev.description, 160);
      a.heartbeat = Math.max(0, Math.min(3600, Number(ev.heartbeat) || 0));
      a.cwd = text(ev.cwd, 300);
      if (a.startedAt) a.restarts = (a.restarts || 0) + 1;
      a.startedAt = now; a.lastHeartbeat = now;
      return true;
    case 'heartbeat':
      a.lastHeartbeat = now;
      return true;
    case 'job_start': {
      const job = text(ev.job, 60) || 'job';
      a.jobs[job] = { job, detail: text(ev.detail, 160), startedAt: now, step: '' };
      a.lastJobStart = now;
      return true;
    }
    case 'step': {
      const running = Object.values(a.jobs).sort((x, y) => y.startedAt - x.startedAt)[0];
      if (running) running.step = text(ev.text, 200); else a.step = text(ev.text, 200);
      return true;
    }
    case 'job_end': {
      const job = text(ev.job, 60) || 'job';
      const started = a.jobs[job]?.startedAt;
      delete a.jobs[job];
      const result = ev.result === 'error' ? 'error' : 'ok';
      a.recent.unshift({ job, result, summary: text(ev.summary, 300), at: now, durationMs: started ? now - started : null });
      a.recent.length = Math.min(a.recent.length, MAX_RECENT);
      if (result === 'ok') a.lastOk = now;
      else a.lastError = { message: text(ev.summary, 500) || `${job} failed`, at: now };
      return true;
    }
    case 'waiting': {
      const id = text(ev.id, 120);
      if (!id) return true;
      a.waiting[id] = { id, title: text(ev.title, 200) || id, link: safeLink(ev.link), at: a.waiting[id]?.at || now };
      const ids = Object.keys(a.waiting);
      for (const old of ids.slice(0, Math.max(0, ids.length - MAX_WAITING))) delete a.waiting[old];
      return true;
    }
    case 'waiting_set': {
      // The agent's whole list of open asks: replaces ours, so a lost "resolved" can't linger.
      const next = {};
      for (const it of (Array.isArray(ev.items) ? ev.items : []).slice(0, MAX_WAITING)) {
        const id = text(it?.id, 120);
        if (id) next[id] = { id, title: text(it.title, 200) || id, link: safeLink(it.link), at: a.waiting[id]?.at || now };
      }
      a.waiting = next;
      return true;
    }
    case 'resolved':
      delete a.waiting[text(ev.id, 120)];
      return true;
    case 'schedule':
      a.schedule = (Array.isArray(ev.schedule) ? ev.schedule : []).slice(0, 20)
        .map((s) => ({ job: text(s.job, 60), nextRun: time(s.next_run, now) })).filter((s) => s.job);
      a.scheduleFrom = 'agent';
      return true;
    case 'error':
      a.lastError = { message: text(ev.message, 500) || 'error', at: now };
      return true;
    default:
      return false;
  }
}

// A job that never reported its end (e.g. the cron run was killed) stops counting as running.
export function expireJobs(a, now, maxMs) {
  let changed = false;
  for (const j of Object.values(a.jobs)) {
    if (now - j.startedAt <= maxMs) continue;
    delete a.jobs[j.job];
    a.recent.unshift({ job: j.job, result: 'error', summary: 'no end reported', at: now, durationMs: null });
    a.recent.length = Math.min(a.recent.length, MAX_RECENT);
    changed = true;
  }
  return changed;
}

export function agentStatus(a, now = Date.now()) {
  if (a.heartbeat && now - a.lastHeartbeat > a.heartbeat * 3000) return AGENT_STATUS.NOT_RESPONDING;
  if (a.otlp?.crashLoop) return AGENT_STATUS.ERROR;
  if (a.lastError && a.lastError.at > Math.max(a.lastJobStart, a.lastOk)) return AGENT_STATUS.ERROR;
  if (Object.keys(a.waiting).length) return AGENT_STATUS.WAITING;
  if (Object.keys(a.jobs).length) return AGENT_STATUS.WORKING;
  return AGENT_STATUS.IDLE;
}

export function agentView(a, now = Date.now()) {
  const jobs = Object.values(a.jobs).sort((x, y) => y.startedAt - x.startedAt);
  const next = a.schedule.filter((s) => s.nextRun >= now - 60000).sort((x, y) => x.nextRun - y.nextRun);
  return {
    key: a.key, name: a.name, host: a.host, displayName: a.displayName, description: a.description,
    status: agentStatus(a, now), job: jobs[0] || null, jobsRunning: jobs.length, step: jobs[0]?.step || a.step,
    waiting: Object.values(a.waiting).sort((x, y) => x.at - y.at), lastJob: a.recent[0] || null, recent: a.recent,
    lastError: a.lastError, schedule: next, nextJob: next[0] || null,
    heartbeat: a.heartbeat, lastHeartbeat: a.lastHeartbeat, lastSeen: a.lastSeen,
    startedAt: a.startedAt, restarts: a.restarts || 0,
    source: a.source || 'api',
    ...(a.otlp ? otlpView(a, now) : {}),
  };
}

// ---------- agents that export OpenTelemetry (OTLP) ----------
// One agent per resource service.name. Only the attribute keys below are ever read; span and
// status messages, log bodies and message-content attributes are never looked at. GenAI semantic
// conventions are still in development, so current names come first, then older/alternative ones.
const OTLP_LIMITS = { running: 50, finished: 500, errors: 5, models: 20 };
const STALE_JOB_MS = 15 * 60 * 1000;
// approval.posted (approval.kind, chat.thread): what finance-agent and the funding agent send.
const WAIT_EVENT = /^(waiting|approval\.(requested|posted)|human_input\.requested)$/i;
const DONE_EVENT = /^(resolved|approval\.(resolved|granted|denied)|human_input\.received)$/i;
const AGGREGATE_OPS = new Set(['invoke_agent', 'create_agent', 'execute_tool']);
const firstOf = (attrs, ...keys) => {
  for (const k of keys) { const v = attrs?.[k]; if (v !== undefined && v !== null && v !== '') return v; }
  return undefined;
};
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

export function otlpServiceName(resource) {
  return text(resource?.['service.name'], 60) || 'unknown_service';
}
export function newOtlpAgent(key, service, host, resource) {
  const a = newAgent(key, service, host);
  a.source = 'otlp';
  a.description = resource?.['service.version'] ? `v${text(resource['service.version'], 30)}` : '';
  a.otlp = { running: {}, finished: [], tokens: { day: '', input: 0, output: 0, models: {} }, hb: {}, restartTimes: [], errors: [], crashLoop: false };
  return a;
}

const isJobSpan = (s) => firstOf(s.attrs, 'job.name') !== undefined || s.attrs?.['gen_ai.operation.name'] === 'invoke_agent' || /^invoke_agent\b/.test(s.name);
const jobNameOf = (s) => text(firstOf(s.attrs, 'job.name', 'gen_ai.agent.name') || s.name.replace(/^invoke_agent\s*/, '') || 'job', 60);
// A model or tool call inside something: in agents that wrap all their work in job spans (finance-agent,
// the funding agent), that's a job still running even when the call itself has no job.name.
const isGenAiCall = (s) => /^(chat|execute_tool)$/.test(s.attrs?.['gen_ai.operation.name'] || '') || /^(chat|execute_tool)\s/.test(s.name);
const toolOf = (s) => text(firstOf(s.attrs, 'gen_ai.tool.name') || /^execute_tool\s+(.+)$/.exec(s.name)?.[1] || (s.attrs?.['gen_ai.operation.name'] === 'execute_tool' ? s.name : ''), 60);

function pushError(a, e) {
  a.otlp.errors.unshift(e);
  a.otlp.errors.length = Math.min(a.otlp.errors.length, OTLP_LIMITS.errors);
}
function addTokens(a, model, input, output, now) {
  const t = a.otlp.tokens, day = new Date(now).toDateString();
  if (t.day !== day) Object.assign(t, { day, input: 0, output: 0, models: {} });
  t.input += input; t.output += output;
  const m = text(model, 60) || 'unknown model';
  if (t.models[m] !== undefined || Object.keys(t.models).length < OTLP_LIMITS.models) t.models[m] = (t.models[m] || 0) + input + output;
}
// A title from the kind of list, when the event has no title of its own.
const KIND_TITLES = { drafts: 'Approve drafts to send', payrun: 'Approve the payment run', payment_run: 'Approve the payment run', policy: 'Approve a round policy' };
const kindTitle = (kind) => (kind ? KIND_TITLES[String(kind).toLowerCase().replace(/[\s-]/g, '_')] || `Approve ${text(kind, 40).replace(/[_-]/g, ' ')}` : '');
function waitingFrom(a, name, attrs, fallbackId, now) {
  if (WAIT_EVENT.test(name)) {
    const link = firstOf(attrs, 'url.full', 'link', 'url', 'waiting.link', 'chat.thread');
    applyAgentEvent(a, {
      event: 'waiting', id: firstOf(attrs, 'waiting.id', 'approval.id', 'id', 'chat.thread') || fallbackId,
      title: firstOf(attrs, 'waiting.title', 'approval.title', 'title') || kindTitle(firstOf(attrs, 'approval.kind', 'waiting.kind')) || 'Waiting on you', link,
    }, now);
  } else if (DONE_EVENT.test(name)) {
    const id = firstOf(attrs, 'waiting.id', 'approval.id', 'id');
    if (id !== undefined) applyAgentEvent(a, { event: 'resolved', id }, now);
  }
}
function finishJob(a, s, now) {
  const o = a.otlp, job = jobNameOf(s), failed = s.status?.code === 2;
  const errType = failed ? text(firstOf(s.attrs, 'error.type') || s.events.find((e) => e.name === 'exception')?.attrs?.['exception.type'] || 'error', 80) : '';
  delete o.running[s.traceId]; delete a.jobs[s.traceId];
  if (s.traceId && !o.finished.includes(s.traceId)) { o.finished.push(s.traceId); if (o.finished.length > OTLP_LIMITS.finished) o.finished.shift(); }
  a.recent.unshift({ job, result: failed ? 'error' : 'ok', summary: errType, at: now, durationMs: s.end && s.start ? Math.max(0, s.end - s.start) : null });
  a.recent.length = Math.min(a.recent.length, MAX_RECENT);
  if (failed) { a.lastError = { message: `${job} failed: ${errType}`, at: now }; pushError(a, { type: errType, job, at: now }); } else a.lastOk = now;
}

export function applyOtlpSpans(a, spans, now = Date.now()) {
  const o = a.otlp;
  a.lastSeen = now;
  for (const s of spans) {
    const op = s.attrs?.['gen_ai.operation.name'];
    if (!AGGREGATE_OPS.has(op)) {
      const input = num(firstOf(s.attrs, 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'llm.usage.prompt_tokens'));
      const output = num(firstOf(s.attrs, 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'llm.usage.completion_tokens'));
      if (input || output) addTokens(a, firstOf(s.attrs, 'gen_ai.response.model', 'gen_ai.request.model'), input, output, now);
    }
    for (const ev of s.events || []) waitingFrom(a, ev.name, ev.attrs, `${s.spanId}:${ev.name}`, now);
    const tool = toolOf(s);
    if (!s.parentSpanId) { if (isJobSpan(s)) finishJob(a, s, now); continue; }
    if (o.finished.includes(s.traceId)) continue; // a child that arrived after its job ended
    let r = o.running[s.traceId];
    if (!r && (isJobSpan(s) || isGenAiCall(s)) && Object.keys(o.running).length < OTLP_LIMITS.running) {
      r = o.running[s.traceId] = { job: isJobSpan(s) ? jobNameOf(s) : 'job', tool: '', startedAt: s.start || now, lastAt: now };
      a.lastJobStart = now;
    }
    if (!r) continue;
    r.lastAt = now;
    if (r.job === 'job' && isJobSpan(s)) r.job = jobNameOf(s);
    if (tool) r.tool = tool;
    a.jobs[s.traceId] = { job: r.job, detail: '', startedAt: r.startedAt, step: r.tool ? `last tool: ${r.tool}` : '' };
  }
}

// The heartbeat: a metric named like "*heartbeat*". For a counter or sum, only an increase counts
// as alive (the SDK exports from its own thread, so a hung main loop still exports the same
// value). A new start time or service.instance.id means the process restarted.
// Delta temporality: each point is the increase since the last export, with a new start time
// every time, so alive = more than 0, and only a new service.instance.id is a restart.
export function applyOtlpMetrics(a, metrics, resource, now = Date.now(), heartbeatSeconds = 60) {
  const o = a.otlp;
  a.lastSeen = now;
  for (const m of metrics) {
    if (/approvals?[._]waiting/i.test(m.name) && m.points.length) { trimWaiting(a, m.points, now); continue; }
    if (!/heartbeat/i.test(m.name) || !m.points.length) continue;
    const p = m.points[m.points.length - 1];
    const delta = m.temporality === 1;
    const level = m.kind === 'histogram' ? p.count : p.value;
    const hb = o.hb, instance = text(resource?.['service.instance.id'], 80);
    const newStart = !delta && hb.start && p.start && p.start !== hb.start;
    const restarted = Boolean(newStart || (hb.instance && instance && instance !== hb.instance));
    if (restarted) { o.restartTimes.push(now); o.restartTimes = o.restartTimes.slice(-20); a.restarts = (a.restarts || 0) + 1; a.startedAt = now; }
    const advanced = restarted || m.kind === 'gauge' || (delta ? level > 0 : hb.value === undefined || level !== hb.value);
    Object.assign(hb, { value: level, start: delta ? 0 : p.start, instance });
    a.heartbeat = heartbeatSeconds;
    if (advanced) a.lastHeartbeat = now;
  }
}

// A count of open approvals (e.g. agent.approvals.waiting), for agents that never say which item
// was handled: when it drops, the oldest items go. Items that arrived after the count was taken stay.
function trimWaiting(a, points, now) {
  const n = Math.max(0, Math.round(points.reduce((sum, p) => sum + (Number(p.value) || 0), 0)));
  const asOf = Math.max(0, ...points.map((p) => p.time || 0)) || now;
  const items = Object.values(a.waiting);
  const newer = items.filter((w) => w.at > asOf).length;
  const older = items.filter((w) => w.at <= asOf).sort((x, y) => y.at - x.at);
  for (const w of older.slice(Math.max(0, n - newer))) delete a.waiting[w.id];
}

export function applyOtlpLogs(a, logs, now = Date.now()) {
  const o = a.otlp;
  a.lastSeen = now;
  for (const r of logs) {
    if (r.eventName) waitingFrom(a, r.eventName, r.attrs, `${r.spanId || r.time}:${r.eventName}`, now);
    if (r.severity < 17) continue; // ERROR and above
    const type = text(firstOf(r.attrs, 'exception.type', 'error.type') || r.eventName || r.severityText || 'ERROR', 80);
    const job = text(firstOf(r.attrs, 'job.name') || o.running[r.traceId]?.job || '', 60);
    pushError(a, { type, job, at: now });
    a.lastError = { message: job ? `${job}: ${type}` : type, at: now };
  }
}

// Per tick: jobs that went silent, expired waiting items, crash-loop detection.
export function otlpTick(a, now, { waitingTtlMs = 7 * 24 * 3600 * 1000 } = {}) {
  const o = a.otlp;
  let changed = false;
  for (const [traceId, r] of Object.entries(o.running)) {
    if (now - r.lastAt <= STALE_JOB_MS) continue;
    delete o.running[traceId]; delete a.jobs[traceId];
    o.finished.push(traceId); if (o.finished.length > OTLP_LIMITS.finished) o.finished.shift();
    a.recent.unshift({ job: r.job, result: 'error', summary: 'no end reported', at: now, durationMs: null });
    a.recent.length = Math.min(a.recent.length, MAX_RECENT);
    changed = true;
  }
  for (const [id, w] of Object.entries(a.waiting)) if (now - w.at > waitingTtlMs) { delete a.waiting[id]; changed = true; }
  const recentRestarts = o.restartTimes.filter((t) => now - t < 10 * 60 * 1000).length;
  const loop = recentRestarts >= 3;
  if (loop && !o.crashLoop) a.lastError = { message: `Restarting repeatedly (${recentRestarts} restarts in 10 min)`, at: now };
  if (loop !== o.crashLoop) { o.crashLoop = loop; changed = true; }
  return changed;
}

// After the machine slept: nothing could arrive while it was suspended, so move the liveness
// clocks on by the time asleep (never past now). An agent already silent before the sleep stays silent.
export function shiftClocks(a, ms, now = Date.now()) {
  if (!(ms > 0)) return;
  if (a.lastHeartbeat) a.lastHeartbeat = Math.min(a.lastHeartbeat + ms, now);
  if (a.otlp) for (const r of Object.values(a.otlp.running)) r.lastAt = Math.min(r.lastAt + ms, now);
}

// Spots a sleep: check() runs on every tick, snapshot and agent event, so the gap since the last
// call is at most a tick while the daemon runs. Timers pause during suspend, so whichever of
// those comes first after waking does the shift. Returns the gap when it was a wake, else 0.
export function wakeClock(gapMs, tickMs, start = Date.now()) {
  let last = start;
  return {
    check(agents, now = Date.now()) {
      const gap = now - last;
      last = Math.max(last, now);
      if (gap <= gapMs) return 0;
      for (const a of agents) shiftClocks(a, gap - tickMs, now);
      return gap;
    },
  };
}

function otlpView(a, now) {
  const t = a.otlp.tokens, today = t.day === new Date(now).toDateString();
  return {
    tokensToday: today ? { input: t.input, output: t.output, total: t.input + t.output, models: Object.entries(t.models).sort((x, y) => y[1] - x[1]) } : { input: 0, output: 0, total: 0, models: [] },
    errors: a.otlp.errors, crashLoop: a.otlp.crashLoop,
  };
}

// ---------- the agent's cron jobs, read from the crontab (so agents don't have to report them) ----------
function cronField(spec, min, max) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let [lo, hi] = range === '*' ? [min, max] : range.split('-').map(Number);
    if (hi === undefined) hi = stepStr ? max : lo;
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || !Number.isInteger(step) || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

// Next time (local time, ms) at or after `from` that a 5-field cron expression fires, or null.
export function nextRun(expr, from = Date.now()) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, ho, dom, mo, dow] = [cronField(f[0], 0, 59), cronField(f[1], 0, 23), cronField(f[2], 1, 31), cronField(f[3], 1, 12), cronField(f[4], 0, 7)];
  if (!mi || !ho || !dom || !mo || !dow) return null;
  if (dow.has(7)) dow.add(0);
  const anyDom = f[2] === '*', anyDow = f[4] === '*';
  const d = new Date(from);
  d.setSeconds(0, 0);
  if (d.getTime() < from) d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dayOk = anyDom && anyDow ? true
      : anyDom ? dow.has(d.getDay()) : anyDow ? dom.has(d.getDate()) : dom.has(d.getDate()) || dow.has(d.getDay());
    if (mo.has(d.getMonth() + 1) && dayOk && ho.has(d.getHours()) && mi.has(d.getMinutes())) return d.getTime();
    // skip ahead quickly through hours/days that can't match
    if (!mo.has(d.getMonth() + 1) || !dayOk) { d.setHours(24, 0, 0, 0); continue; }
    if (!ho.has(d.getHours())) { d.setMinutes(60, 0, 0); continue; }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// Jobs in a crontab whose command runs in `cwd`, as [{job, cron}]. Expands NAME=value lines.
// The job name is the word after "-m <package>" (e.g. "python -m collections_agent daily").
export function cronJobs(crontab, cwd) {
  if (!crontab || !cwd) return [];
  const vars = {};
  const out = [];
  for (const raw of String(crontab).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const assign = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (assign) { vars[assign[1]] = assign[2].replace(/^["']|["']$/g, ''); continue; }
    const m = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
    if (!m) continue;
    let cmd = m[2];
    for (let i = 0; i < 3; i++) cmd = cmd.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (all, n) => (n in vars ? vars[n] : all));
    if (!cmd.includes(cwd)) continue;
    const job = cmd.match(/-m\s+\S+\s+([A-Za-z0-9_-]+)/)?.[1];
    if (job) out.push({ job, cron: m[1] });
  }
  return out;
}
