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
