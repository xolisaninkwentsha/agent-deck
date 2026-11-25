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
