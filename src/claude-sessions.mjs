// Reads what Claude Code itself records about running sessions, so the daemon can show
// sessions that have no hooks and check its own picture against Claude Code's.
//
// ~/.claude/sessions/<pid>.json is written by Claude Code (observed in 2.1.332; not a
// documented format, so every field is optional). Fields used: pid, sessionId, cwd, name
// (auto title), status ("idle" | "busy" | "waiting" | "shell"), waitingFor ("permission
// prompt" | "input needed"), statusUpdatedAt, startedAt, procStart (Linux: /proc start time).
// The <pid>.*.key files next to them are never read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// On Linux, make sure the PID wasn't reused by another program since the file was written.
function sameProcess(pid, procStart) {
  if (procStart == null) return true;
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return true; } // no /proc (macOS)
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // field 3 onwards
  return fields[19] === String(procStart); // field 22: start time
}

export function runningSessions() {
  let files;
  try { files = fs.readdirSync(path.join(CLAUDE_DIR, 'sessions')); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'sessions', f), 'utf8')); } catch { continue; }
    const pid = Number(j.pid || f.split('.')[0]);
    if (!j.sessionId || !pid || !alive(pid) || !sameProcess(pid, j.procStart)) continue;
    out.push({
      pid, sessionId: String(j.sessionId), cwd: j.cwd || '', name: j.name || '',
      status: j.status || null, waitingFor: j.waitingFor || null,
      statusUpdatedAt: Number(j.statusUpdatedAt) || 0, startedAt: Number(j.startedAt) || Date.now(),
    });
  }
  return out;
}

const transcriptCache = new Map();
export function transcriptFor(sessionId, cwd) {
  const cached = transcriptCache.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  const projects = path.join(CLAUDE_DIR, 'projects');
  const candidates = [];
  if (cwd) candidates.push(path.join(projects, cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${sessionId}.jsonl`));
  try { for (const d of fs.readdirSync(projects)) candidates.push(path.join(projects, d, `${sessionId}.jsonl`)); } catch {}
  const found = candidates.find((p) => fs.existsSync(p)) || null;
  if (found) transcriptCache.set(sessionId, found);
  return found;
}

// The last `bytes` of a file as text (the first, partial line is dropped), or null.
export function readTail(file, bytes = 65536) {
  try {
    const { size } = fs.statSync(file);
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    const text = buf.toString('utf8');
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return null; }
}

// How full the context window is: input + cache writes + cache reads of the latest main-thread
// (not subagent) assistant message is what the next request will send. Null if not in the tail.
export function contextUsage(tail) {
  if (!tail) return null;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"') || !lines[i].includes('"assistant"')) continue;
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    const u = e.type === 'assistant' && !e.isSidechain ? e.message?.usage : null;
    if (!u) continue;
    const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    if (used > 0) return { model: String(e.message.model || ''), used };
  }
  return null;
}

// Running totals for a session, read from its transcript a piece at a time (each call picks up
// where the last one stopped, at most 8 MB, so a long transcript is caught up over a few ticks):
// tokens in (input, cache writes and reads) and out, the latest model, and calls per tool.
// Main thread only. One API response can span several lines with the same message id (one per
// content block), so a message adds only what it hasn't added yet, and a tool call counts once.
export const newUsage = () => ({ offset: 0, input: 0, output: 0, model: '', tools: {}, msgs: new Map(), toolIds: new Set(), plan: newPlan() });

// The session's plan, for the activity window: its task list (TaskCreate/TaskUpdate, or the older
// TodoWrite list) and the latest plan document (ExitPlanMode), approved, rejected or still proposed.
const newPlan = () => ({ tasks: new Map(), todos: null, doc: null });
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
function planFromCall(plan, c, ts) {
  const input = c.input || {};
  if (c.name === 'TodoWrite' && Array.isArray(input.todos)) {
    plan.todos = input.todos.slice(0, 60).map((t) => ({ text: clip(t.status === 'in_progress' ? t.activeForm || t.content : t.content, 160), status: String(t.status || 'pending') }));
  } else if (c.name === 'TaskUpdate') {
    const t = plan.tasks.get(String(input.taskId ?? ''));
    if (!t) return;
    if (input.status === 'deleted') plan.tasks.delete(t.id);
    else { if (input.status) t.status = String(input.status); if (input.subject) t.subject = clip(input.subject, 160); }
  } else if (c.name === 'ExitPlanMode') {
    plan.doc = { toolId: c.id, text: String(input.plan || '').slice(0, 20000), state: 'proposed', at: ts };
  }
}
// What came back: a created task's id, or the plan's answer (its text comes back when approved).
function planFromResult(plan, e, ts) {
  const r = e.toolUseResult;
  if (r && r.task && r.task.id != null) {
    const id = String(r.task.id);
    plan.tasks.set(id, { id, subject: clip(r.task.subject, 160), status: 'pending' });
    if (plan.tasks.size > 100) plan.tasks.delete(plan.tasks.keys().next().value);
  }
  if (r && typeof r.plan === 'string' && r.plan) {
    plan.doc = { ...(plan.doc || { toolId: '', at: ts }), text: r.plan.slice(0, 20000), state: 'approved' };
  }
  const doc = plan.doc;
  if (doc && doc.state === 'proposed' && Array.isArray(e.message?.content)) {
    for (const c of e.message.content) {
      if (c?.type !== 'tool_result' || c.tool_use_id !== doc.toolId) continue;
      const out = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
      doc.state = c.is_error || /doesn't want to proceed|rejected/i.test(out) ? 'rejected' : 'approved';
    }
  }
}
// For the activity window.
export const planOf = (acc) => {
  const p = acc?.plan;
  if (!p) return null;
  const tasks = p.tasks.size ? [...p.tasks.values()].map((t) => ({ text: t.subject, status: t.status })) : p.todos || [];
  return tasks.length || p.doc ? { tasks, doc: p.doc ? { text: p.doc.text, state: p.doc.state, at: p.doc.at } : null } : null;
};
export function scanUsage(file, acc = newUsage()) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return acc; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < acc.offset) acc = newUsage(); // the file was replaced: start again
    const len = Math.min(size - acc.offset, 8 * 1024 * 1024);
    if (len <= 0) return acc;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, acc.offset);
    const end = buf.lastIndexOf(10); // only whole lines; the rest waits for the next call
    if (end < 0) return acc;
    acc.offset += end + 1;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      // Assistant lines carry usage and tool calls; user lines with a tool result feed the plan.
      const result = line.includes('"toolUseResult"') || (acc.plan.doc?.toolId && line.includes(acc.plan.doc.toolId));
      if (!line.includes('"assistant"') && !result) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'user' && !e.isSidechain) { planFromResult(acc.plan, e, Date.parse(e.timestamp) || 0); continue; }
      const msg = e.type === 'assistant' && !e.isSidechain ? e.message : null;
      if (!msg) continue;
      if (msg.model && msg.model !== '<synthetic>') acc.model = String(msg.model);
      for (const c of Array.isArray(msg.content) ? msg.content : []) {
        if (c?.type !== 'tool_use' || !c.id || acc.toolIds.has(c.id)) continue;
        acc.toolIds.add(c.id);
        const name = String(c.name || 'tool').slice(0, 60);
        acc.tools[name] = (acc.tools[name] || 0) + 1;
        planFromCall(acc.plan, c, Date.parse(e.timestamp) || 0);
      }
      const u = msg.usage, id = msg.id || e.uuid;
      if (u && id) {
        const prev = acc.msgs.get(id) || { in: 0, out: 0 };
        const inNow = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), outNow = u.output_tokens || 0;
        acc.input += Math.max(0, inNow - prev.in);
        acc.output += Math.max(0, outNow - prev.out);
        acc.msgs.set(id, { in: Math.max(inNow, prev.in), out: Math.max(outNow, prev.out) });
      }
    }
    // Repeats of a message or tool call sit close together: keep only the recent ids.
    if (acc.msgs.size > 300) acc.msgs = new Map([...acc.msgs].slice(-150));
    if (acc.toolIds.size > 3000) acc.toolIds = new Set([...acc.toolIds].slice(-1500));
  } finally { fs.closeSync(fd); }
  return acc;
}
// What the panel shows: model, tokens, and the most-used tools.
export const usageSummary = (acc) => ({
  model: acc.model, tokensIn: acc.input, tokensOut: acc.output,
  toolCount: Object.values(acc.tools).reduce((n, x) => n + x, 0),
  tools: Object.entries(acc.tools).sort((a, b) => b[1] - a[1]).slice(0, 6),
});

// Context window by model. Transcripts don't say which window a session has, so infer it.
// 1M models per the Claude API model table (Nov 2026): Fable, Mythos, Opus 5.x / 4.6-4.8,
// Sonnet 5.x / 4.6, Haiku 5.x. Everything else (e.g. Haiku 4.5) defaults to 200K.
const ONE_MILLION = /^claude-(fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5)/;
export function contextWindow(model = '', used = 0, overrides = {}) {
  const key = Object.keys(overrides || {}).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  let window = key ? Number(overrides[key]) || 200000
    : /\[1m\]/i.test(model) || ONE_MILLION.test(model) ? 1000000 : 200000;
  if (used > window) window = Math.max(1000000, used); // can't hold more than its window: it's bigger
  return window;
}

// What the session did last, from the end of its transcript.
export function lastActivity(tail) {
  const res = { tool: null, text: '', todos: null };
  if (!tail) return res;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0 && (!res.tool || !res.text || !res.todos); i--) {
    if (!lines[i].includes('"assistant"')) continue;
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    const content = e.type === 'assistant' && Array.isArray(e.message?.content) ? e.message.content : [];
    for (let k = content.length - 1; k >= 0; k--) {
      const c = content[k];
      if (c.type === 'tool_use') {
        if (!res.tool) res.tool = { name: c.name, input: c.input || {} };
        if (!res.todos && c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) res.todos = c.input.todos;
      } else if (c.type === 'text' && !res.text && c.text) res.text = c.text;
    }
  }
  return res;
}
