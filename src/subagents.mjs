// A session's subagents, for the activity window. Claude Code keeps each one next to the session's
// transcript: <dir>/<session id>/subagents/agent-<id>.jsonl (its own transcript) and
// agent-<id>.meta.json (type, description, model, background, spawnDepth, toolUseId, finished).
// toolUseId is the Agent call that started it: in the main transcript, or (spawnDepth 2) in
// another subagent's, which is how the tree is rebuilt. Read a piece at a time, like scanUsage.
// Checked with Claude Code 2.1.330-332. If the layout changes, the window just shows no subagents.
import fs from 'node:fs';
import path from 'node:path';
import { describeTool } from './state.mjs';

export const subagentsDir = (transcript) => (transcript ? path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents') : null);

const RUNNING_MS = 3 * 60 * 1000; // "finished" isn't always written: unfinished and quiet this long = stopped
const MAX_AGENTS = 60;            // the most recently active ones
const BUDGET = 16 * 1024 * 1024;  // bytes read per scan, across all agents; the rest waits for the next tick
const SPAWN_TOOLS = new Set(['Agent', 'Task']);
const text = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const newAgent = (id) => ({
  id, meta: {}, metaMtime: 0, offset: 0, mtime: 0, startedAt: 0, lastAt: 0, model: '',
  tokensIn: 0, tokensOut: 0, toolCount: 0, tools: {}, steps: [], lastText: '', spawned: new Set(), msgs: new Map(), toolIds: new Set(),
});

function readMeta(dir, a) {
  const file = path.join(dir, `agent-${a.id}.meta.json`);
  let st;
  try { st = fs.statSync(file); } catch { return; }
  if (st.mtimeMs === a.metaMtime) return;
  try { a.meta = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; a.metaMtime = st.mtimeMs; } catch {}
}

// Read what was added to one agent's transcript since last time (whole lines only).
function readLines(dir, a, budget) {
  const file = path.join(dir, `agent-${a.id}.jsonl`);
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < a.offset) Object.assign(a, newAgent(a.id), { meta: a.meta, metaMtime: a.metaMtime }); // replaced: start again
    const len = Math.min(size - a.offset, budget);
    if (len <= 0) return 0;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, a.offset);
    const end = buf.lastIndexOf(10);
    if (end < 0) return 0;
    a.offset += end + 1;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(e.timestamp) || 0;
      if (ts) { if (!a.startedAt) a.startedAt = ts; a.lastAt = Math.max(a.lastAt, ts); }
      const msg = e.type === 'assistant' ? e.message : null;
      if (!msg) continue;
      if (msg.model && msg.model !== '<synthetic>') a.model = String(msg.model);
      for (const c of Array.isArray(msg.content) ? msg.content : []) {
        if (c?.type === 'text' && c.text) a.lastText = text(c.text, 200);
        if (c?.type !== 'tool_use' || !c.id || a.toolIds.has(c.id)) continue;
        a.toolIds.add(c.id);
        const name = String(c.name || 'tool').slice(0, 60);
        a.toolCount++;
        a.tools[name] = (a.tools[name] || 0) + 1;
        a.steps.push({ ts, text: describeTool(name, c.input || {}) });
        if (a.steps.length > 8) a.steps.shift();
        if (SPAWN_TOOLS.has(name)) a.spawned.add(c.id);
      }
      const u = msg.usage, mid = msg.id || e.uuid;
      if (u && mid) { // a message can span several lines: count what it hasn't counted yet
        const prev = a.msgs.get(mid) || { in: 0, out: 0 };
        const inNow = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), outNow = u.output_tokens || 0;
        a.tokensIn += Math.max(0, inNow - prev.in);
        a.tokensOut += Math.max(0, outNow - prev.out);
        a.msgs.set(mid, { in: Math.max(inNow, prev.in), out: Math.max(outNow, prev.out) });
      }
    }
    if (a.msgs.size > 200) a.msgs = new Map([...a.msgs].slice(-100));
    if (a.toolIds.size > 2000) a.toolIds = new Set([...a.toolIds].slice(-1000));
    return end + 1;
  } finally { fs.closeSync(fd); }
}

export const newActivity = () => ({ agents: new Map() });

// Catch up with the folder and return the agents as the window shows them.
export function scanActivity(dir, cache = newActivity(), now = Date.now()) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^agent-[\w-]+\.jsonl$/.test(f)).map((f) => {
      let mtime = 0;
      try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
      return { id: f.slice(6, -6), mtime };
    });
  } catch { return { cache, agents: [] }; }
  files.sort((x, y) => y.mtime - x.mtime);
  const keep = files.slice(0, MAX_AGENTS);
  const ids = new Set(keep.map((f) => f.id));
  for (const id of cache.agents.keys()) if (!ids.has(id)) cache.agents.delete(id);
  let budget = BUDGET;
  for (const f of keep) {
    let a = cache.agents.get(f.id);
    if (!a) { a = newAgent(f.id); cache.agents.set(f.id, a); }
    readMeta(dir, a);
    if (f.mtime !== a.mtime && budget > 0) {
      budget -= readLines(dir, a, budget);
      if (a.offset >= (fs.statSync(path.join(dir, `agent-${f.id}.jsonl`), { throwIfNoEntry: false })?.size ?? 0)) a.mtime = f.mtime;
    }
    a.fileMtime = f.mtime;
  }
  // Who started whom: the agent whose transcript has the Agent call; otherwise the main session.
  const starter = new Map();
  for (const a of cache.agents.values()) for (const t of a.spawned) starter.set(t, a.id);
  const agents = [...cache.agents.values()].map((a) => {
    const m = a.meta;
    const status = m.finished ? 'done' : now - (a.fileMtime || 0) < RUNNING_MS ? 'running' : 'stopped';
    return {
      id: a.id, parent: (m.toolUseId && starter.get(m.toolUseId)) || 'main',
      type: text(m.agentType || 'subagent', 40), description: text(m.description, 120),
      model: a.model || text(m.model, 40), background: m.requestShape === 'background',
      status, startedAt: a.startedAt, lastAt: a.lastAt || a.fileMtime || 0,
      step: status === 'running' ? (a.steps.at(-1)?.text || 'Starting') : status === 'done' ? 'Done' : 'Stopped: no end recorded',
      steps: a.steps.slice().reverse(), toolCount: a.toolCount,
      topTools: Object.entries(a.tools).sort((x, y) => y[1] - x[1]).slice(0, 3),
      tokensIn: a.tokensIn, tokensOut: a.tokensOut, lastText: a.lastText,
    };
  });
  return { cache, agents };
}
