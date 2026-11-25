// Agent Deck daemon: one per machine.
// - Receives Claude Code hook events from src/hook.mjs on 127.0.0.1:<port>/hook
// - Keeps a live picture of every session on this machine
// - Streams it to widgets over WebSocket (/ws), local or remote (remote needs the token)
// - Holds permission requests and questions until a widget answers or the hold times out
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import {
  loadConfig, ensureHome, machineName, isLoopback, tokensMatch, STATE_PATH, LOG_PATH, PID_PATH, CONFIG_PATH,
} from './config.mjs';
import {
  newSession, applyEvent, publicView, describeApproval, describeTool, setStep, todosSummary, STATUS,
} from './state.mjs';
import { runningSessions, transcriptFor, readTail, lastActivity, contextUsage, contextWindow } from './claude-sessions.mjs';
import { newAgent, applyAgentEvent, agentView, agentStatus, AGENT_NAME, nextRun, cronJobs } from './agents.mjs';

const VERSION = '0.1.0';
const cfg = loadConfig();
const NAME = machineName(cfg);
const PORT = Number(cfg.port);
const BIND = cfg.bind;
// How long the panel can answer a prompt. Claude Code shows the same prompt in the terminal
// meanwhile, so a long hold costs nothing there. Capped below the decide hooks' 600 s timeout.
const holdFrom = (c) => Math.min(570, Math.max(5, Number(c.holdSeconds) || 300)) * 1000;
let HOLD_MS = holdFrom(cfg);
// A question held on PreToolUse is NOT shown in the terminal while held, so keep that short.
let PRETOOLUSE_HOLD_MS = Math.min(HOLD_MS, 90000);
// Which hook the panel answers a question (AskUserQuestion) on. While the PermissionRequest
// for AskUserQuestion is pending, Claude Code already shows the question in the terminal, so
// answering there never keeps someone at the terminal waiting. That was verified live (Claude
// Code 2.1.332) in these modes only. Any other mode (bypassPermissions, dontAsk, unknown or
// missing) answers on PreToolUse as before, which keeps the question out of the terminal
// while the panel holds it.
const PERMISSION_REQUEST_QUESTION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto']);
const questionHookFor = (input) => (PERMISSION_REQUEST_QUESTION_MODES.has(input.permission_mode) ? 'PermissionRequest' : 'PreToolUse');
// Development aid: AGENT_DECK_EVENT_LOG=/path.jsonl appends every raw hook payload there.
const EVENT_LOG = process.env.AGENT_DECK_EVENT_LOG || null;

ensureHome();
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  logStream.write(line);
  if (process.env.AGENT_DECK_VERBOSE) process.stdout.write(line);
};

if (!isLoopback(BIND) && !cfg.token) {
  console.error(`Refusing to listen on ${BIND} without a token. Run "agent-deck share" to set one up.`);
  process.exit(1);
}

/** @type {Map<string, any>} */
const sessions = new Map();
/** service agents (see agents.mjs), key -> state */
const agents = new Map();
/** pending id -> { key, resolve, timer, hookEvent, toolInput, suggestions, kind } */
const pendings = new Map();
/** question fingerprint -> time it was handed back to the terminal */
const releasedQuestions = new Map();
/** @type {Set<import('ws').WebSocket>} */
const widgets = new Set();

const pidAlive = (pid) => {
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// ---------- persistence (so a daemon restart doesn't forget running sessions) ----------
function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    for (const s of saved.sessions || []) {
      if (!s.ended && pidAlive(s.pid)) { s.pending = null; sessions.set(s.key, s); }
    }
    for (const a of saved.agents || []) if (a && a.key) agents.set(a.key, a);
    log(`restored ${sessions.size} session(s), ${agents.size} agent(s)`);
  } catch {}
}
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const list = [...sessions.values()].map((s) => ({ ...s, pending: null }));
    fs.writeFile(STATE_PATH, JSON.stringify({ sessions: list, agents: [...agents.values()] }), () => {});
  }, 500);
}

// ---------- broadcasting ----------
let broadcastTimer = null;
function snapshot() {
  return {
    type: 'snapshot', host: NAME, version: VERSION, holdSeconds: HOLD_MS / 1000,
    sessions: [...sessions.values()].filter((s) => !s.dismissed).map((s) => publicView(s, { warnPercent: Number(cfg.contextWarnPercent) || 80 })),
    agents: [...agents.values()].map((a) => agentView(a)),
  };
}
function broadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    const msg = JSON.stringify(snapshot());
    for (const ws of widgets) if (ws.readyState === 1) ws.send(msg);
  }, 60);
  scheduleSave();
}
const approversConnected = () => [...widgets].some((w) => w.approvals);

// ---------- hook handling ----------
// The hook's parent may be Claude Code itself or a shell it started. Walk up a few
// levels to find the actual Claude Code process so we can tell when it exits.
const CLAUDE_CMD = /(^|\/)claude(\s|$)|claude-code|\/claude\/versions\/|(^|\/)claude\.exe/i;
function resolveClaudePid(pid) {
  for (let i = 0, cur = Number(pid); i < 5 && cur > 1; i++) {
    let out = '';
    try { out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(cur)], { encoding: 'utf8', timeout: 2000 }).trim(); } catch { return null; }
    const m = out.match(/^(\d+)\s+(.*)$/);
    if (!m) return null;
    if (CLAUDE_CMD.test(m[2])) return cur;
    cur = Number(m[1]);
  }
  return null;
}

function sessionFor(input, meta) {
  const key = `${NAME}:${input.session_id}`;
  let s = sessions.get(key);
  if (!s) {
    s = newSession(key, input, meta, NAME);
    s.pid = meta.pid ? resolveClaudePid(meta.pid) : null;
    s.pidTriedAt = Date.now();
    sessions.set(key, s);
  } else if (!s.pid && meta.pid && Date.now() - (s.pidTriedAt || 0) > 60000) {
    // Without a PID the session can't be seen to exit (it would linger up to 12 h), so try
    // again on later events, at most once a minute.
    s.pidTriedAt = Date.now();
    s.pid = resolveClaudePid(meta.pid);
  }
  return s;
}

function questionFingerprint(key, questions) {
  return key + ':' + crypto.createHash('sha1').update(JSON.stringify(questions || [])).digest('hex');
}

// Hold a blocking hook until a widget decides or the hold expires.
// Resolves with the hook's JSON output, or null to fall back to the terminal.
function hold(s, res, { kind, hookEvent, toolName, toolInput, suggestions, agentId }) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const holdMs = hookEvent === 'PreToolUse' ? PRETOOLUSE_HOLD_MS : HOLD_MS;
    const view = { id, kind, tool: toolName, createdAt: now, expiresAt: now + holdMs };
    if (kind === 'question') {
      view.questions = (toolInput?.questions || []).map((q) => ({
        question: q.question, header: q.header || '', multiSelect: Boolean(q.multiSelect),
        options: (q.options || []).map((o) => ({ label: o.label, description: o.description || '' })),
      }));
    } else {
      Object.assign(view, describeApproval(toolName, toolInput));
      view.canAlways = Array.isArray(suggestions) && suggestions.length > 0;
    }
    s.pending = view;
    s.status = kind === 'question' ? STATUS.QUESTION : STATUS.APPROVAL;
    s.statusTs = now;

    // settled: the prompt was already answered in the terminal (see settleHeld). The event that
    // showed it sets the status, so leave status and timestamps alone: bumping statusTs here
    // would make setStatus ignore that event.
    const finish = (output, why, { settled = false } = {}) => {
      if (!pendings.has(id)) return;
      const p = pendings.get(id);
      clearTimeout(p.timer);
      pendings.delete(id);
      if (s.pending && s.pending.id === id) {
        s.pending = null;
        if (!settled) {
          s.statusTs = s.stepTs = Date.now();
          if (output) {
            s.status = STATUS.WORKING;
            const denied = output.hookSpecificOutput?.decision?.behavior === 'deny';
            s.step = kind === 'question' ? 'Got your answer, continuing' : denied ? 'You denied: ' + view.title.toLowerCase() : 'Approved: ' + view.title.toLowerCase();
          } else if (why === 'hook closed') {
            // Claude Code dropped the hook: No or Esc in the terminal (Claude stops and waits
            // for you), or the session died (the PID check ends it).
            s.status = STATUS.IDLE;
            s.step = 'Interrupted in the terminal';
          } else {
            // Handed back to Claude Code: only the terminal prompt can answer now.
            s.status = kind === 'question' ? STATUS.QUESTION : STATUS.APPROVAL;
            s.step = 'Waiting for you in the terminal';
          }
        }
      }
      if (!output && !settled && kind === 'question' && hookEvent === 'PreToolUse') releasedQuestions.set(questionFingerprint(s.key, toolInput?.questions), Date.now());
      log(`pending ${id} (${kind}) finished: ${why}`);
      broadcast();
      resolve(output);
    };
    const timer = setTimeout(() => finish(null, 'timeout'), holdMs);
    pendings.set(id, { key: s.key, finish, timer, hookEvent, toolName, toolInput, suggestions, kind, agentId: agentId || null, createdAt: now });
    // If Claude Code gives up on the hook (or the session dies), drop the pending card.
    res.on('close', () => { if (pendings.has(id)) finish(null, 'hook closed'); });
    log(`holding ${kind} ${id} for ${s.key} (${toolName})`);
    broadcast();
  });
}

// ---------- prompts answered in the terminal ----------
// Claude Code shows each prompt in the terminal too. Answering "Yes" there does not cancel
// our held hook, so watch for the events that prove the prompt is gone and drop the card.
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
function sameCall(p, input) {
  if (p.toolName !== input.tool_name) return false;
  if (p.toolName === 'ExitPlanMode') return true; // PostToolUse doesn't repeat the plan
  if (p.toolName === 'AskUserQuestion') return canon(p.toolInput?.questions) === canon(input.tool_input?.questions); // it adds answers
  return canon(p.toolInput) === canon(input.tool_input);
}
const SETTLING = new Set(['PostToolUse', 'PostToolUseFailure', 'Stop', 'UserPromptSubmit', 'SessionEnd']);
function settleHeld(s, event, input) {
  if (!SETTLING.has(event)) return;
  const post = event === 'PostToolUse' || event === 'PostToolUseFailure';
  for (const p of [...pendings.values()]) {
    if (p.key !== s.key || p.agentId !== (input.agent_id || null)) continue;
    if (post && !sameCall(p, input)) continue;
    p.finish(null, `answered in the terminal (${event})`, { settled: true });
  }
}

// After "No" or Esc in the terminal, Claude Code sends no hook event at all; the transcript
// gets "[Request interrupted by user ...]". Look for that when a session is shown waiting.
function interruptedInTranscript(s) {
  const file = s.transcript;
  if (!file || !path.isAbsolute(file) || !file.endsWith('.jsonl')) return false;
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (st.mtimeMs < s.statusTs || st.size === s.transcriptSeen) return false;
  s.transcriptSeen = st.size;
  const tail = readTail(file);
  if (!tail) return false;
  for (const line of tail.split('\n').reverse()) {
    if (!line.includes('[Request interrupted by user')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'user' && Date.parse(e.timestamp) >= s.statusTs - 1000) return true;
  }
  return false;
}

// ---------- what Claude Code itself says (~/.claude/sessions, see claude-sessions.mjs) ----------
const FILE_STATUS = { busy: STATUS.WORKING, idle: STATUS.IDLE, shell: STATUS.BACKGROUND };
const fileStatus = (r) => (r.status === 'waiting'
  ? (r.waitingFor === 'input needed' ? STATUS.QUESTION : STATUS.APPROVAL)
  : FILE_STATUS[r.status] || null);
const WATCH_STEP = {
  [STATUS.APPROVAL]: 'Needs approval in the terminal', [STATUS.QUESTION]: 'Question waiting in the terminal',
  [STATUS.IDLE]: 'Your turn', [STATUS.BACKGROUND]: 'Background work running',
};

// Read the end of a session's transcript if it grew since last time, and update the context
// meter from it. Returns the tail text (for the caller to use too), or null if nothing changed.
function refreshTranscript(s, now) {
  const file = s.transcript || (s.source === 'discovered' ? (s.transcript = transcriptFor(s.id, s.cwd)) : null);
  if (!file) return null;
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (size === s.transcriptSize) return null;
  s.transcriptSize = size;
  const tail = readTail(file, 262144); // large: api-request-blob entries can push usage out of a small tail
  const u = contextUsage(tail);
  if (u) s.context = { used: u.used, model: u.model, window: contextWindow(u.model, u.used, cfg.contextWindows), at: now };
  return tail || null;
}

// A session with no hooks: everything comes from its session file and transcript.
function syncDiscovered(s, r, now, tail) {
  let changed = false;
  if (tail) {
    const act = lastActivity(tail);
    if (act.tool) { s.toolStep = describeTool(act.tool.name, act.tool.input); setStep(s, s.toolStep, now, act.tool.name); }
    if (act.text) s.lastMessage = String(act.text).replace(/\s+/g, ' ').trim().slice(0, 160);
    if (act.todos) s.todos = todosSummary(act.todos);
    changed = true;
  }
  const st = fileStatus(r);
  if (st && st !== s.status) { s.status = st; s.statusTs = now; changed = true; }
  const step = WATCH_STEP[s.status] || s.toolStep || 'Working';
  if (step !== s.step) { s.step = step; s.stepTs = now; changed = true; }
  return changed;
}

// A session with hooks: correct our picture when Claude Code says a prompt is no longer open.
// That covers "Yes" on a long-running command and plan feedback, where no hook event comes.
// Only PermissionRequest holds: while a PreToolUse question is held the terminal shows no
// prompt, so Claude Code says "busy" although the question is still unanswered.
function reconcile(s, r, now) {
  if (!r.status || r.status === 'waiting' || !r.statusUpdatedAt) return false;
  let changed = false;
  for (const p of [...pendings.values()]) {
    if (p.key === s.key && p.hookEvent === 'PermissionRequest' && r.statusUpdatedAt > p.createdAt + 1000) {
      p.finish(null, `answered in the terminal (Claude Code says ${r.status})`, { settled: true });
      changed = true;
    }
  }
  if (!s.pending && (s.status === STATUS.APPROVAL || s.status === STATUS.QUESTION) && r.statusUpdatedAt > s.statusTs + 1000) {
    s.status = FILE_STATUS[r.status] || STATUS.IDLE;
    s.step = 'Answered in the terminal';
    s.statusTs = s.stepTs = now;
    changed = true;
  }
  return changed;
}

function syncFromClaude(now, tails) {
  let changed = false;
  const seen = new Set();
  for (const r of runningSessions()) {
    const key = `${NAME}:${r.sessionId}`;
    seen.add(key);
    let s = sessions.get(key);
    if (!s) {
      s = newSession(key, { session_id: r.sessionId, cwd: r.cwd }, { pid: r.pid, ts: r.startedAt }, NAME);
      s.source = 'discovered';
      sessions.set(key, s);
      changed = true;
      log(`found a session without hooks: ${key} in ${r.cwd}`);
    }
    if (!s.pid) s.pid = r.pid;
    if (r.name && s.name !== r.name) { s.name = r.name; changed = true; }
    if (s.ended) continue;
    // A session found this tick hasn't had its transcript read yet; others were read already.
    const tail = tails.has(key) ? tails.get(key) : refreshTranscript(s, now);
    changed = (s.source === 'discovered' ? syncDiscovered(s, r, now, tail) : reconcile(s, r, now)) || changed;
  }
  // Claude Code removes the file when the session exits.
  for (const s of sessions.values()) {
    if (s.source === 'discovered' && !s.ended && !seen.has(s.key)) {
      s.ended = true; s.status = STATUS.ENDED; s.step = 'Session ended'; s.statusTs = now; changed = true;
    }
  }
  return changed;
}

function buildOutput(p, decision) {
  const { hookEvent, toolName, toolInput, suggestions, kind } = p;
  if (kind === 'question') {
    const updatedInput = { ...toolInput, answers: decision.answers || {} };
    if (hookEvent === 'PreToolUse') {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } };
    }
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput } } };
  }
  if (decision.behavior === 'deny') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: decision.message || 'Denied from Agent Deck.' } } };
  }
  const d = { behavior: 'allow' };
  if (toolName === 'ExitPlanMode') d.updatedInput = toolInput || {};
  if (decision.always && Array.isArray(suggestions) && suggestions.length) d.updatedPermissions = suggestions;
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } };
}

async function handleHook(body, res) {
  const { event, input = {}, meta = {}, mode } = body;
  if (EVENT_LOG) fs.appendFile(EVENT_LOG, JSON.stringify(body) + '\n', () => {});
  if (!input.session_id) return null;
  const s = sessionFor(input, meta);
  if (s.source === 'discovered') { s.source = 'hooks'; log(`hooks now reporting for ${s.key}`); } // hooks take over
  settleHeld(s, event, input); // first, so the event's own status isn't blocked by a stale card
  applyEvent(s, event, input, meta);

  let output = null;
  if (mode === 'decide') {
    const tool = input.tool_name;
    const isQuestion = tool === 'AskUserQuestion';
    if (isQuestion && event !== questionHookFor(input)) {
      // Questions are answered on one hook only; the other just lets Claude Code carry on.
      broadcast();
      return null;
    }
    let skip = !approversConnected();
    if (isQuestion && event === 'PreToolUse') {
      const fp = questionFingerprint(s.key, input.tool_input?.questions);
      const released = releasedQuestions.get(fp);
      if (released && Date.now() - released < 120000) skip = true; // already handed to the terminal
    }
    if (event === 'PreToolUse' && !isQuestion) skip = true; // only questions are handled on PreToolUse
    if (!skip) {
      output = await hold(s, res, {
        kind: isQuestion ? 'question' : 'approval',
        hookEvent: event, toolName: tool, toolInput: input.tool_input, suggestions: input.permission_suggestions,
        agentId: input.agent_id,
      });
    } else if (isQuestion || event === 'PermissionRequest') {
      // Nobody can answer from a panel, so Claude Code is about to ask in the terminal.
      const now = Date.now();
      s.status = isQuestion ? STATUS.QUESTION : STATUS.APPROVAL;
      s.statusTs = now;
      s.step = isQuestion
        ? 'Question waiting in the terminal: ' + String(input.tool_input?.questions?.[0]?.question || '').slice(0, 60)
        : 'Waiting in the terminal: ' + describeApproval(tool, input.tool_input).title.toLowerCase();
      s.stepTs = now;
    }
  }
  broadcast();
  return output;
}

// ---------- service agents (POST /agent) ----------
const MAX_AGENTS = 100;
const AGENT_FORGET_MS = 30 * 24 * 3600 * 1000; // not heard from in 30 days: drop it
function handleAgent(body) {
  const name = String(body?.agent || '');
  if (!AGENT_NAME.test(name)) return { ok: false, error: 'agent name must be letters, digits, dot, dash or underscore' };
  const key = `${NAME}:${name}`;
  let a = agents.get(key);
  if (!a) {
    if (agents.size >= MAX_AGENTS) return { ok: false, error: 'too many agents' };
    a = newAgent(key, name, NAME); agents.set(key, a); log(`agent "${name}" reporting`);
  }
  if (!applyAgentEvent(a, body)) return { ok: false, error: `unknown event "${body.event}"` };
  if (body.event === 'start') refreshSchedules().catch(() => {});
  a.lastStatus = agentStatus(a);
  broadcast();
  return { ok: true };
}

// An agent's cron jobs come from the crontab (the agents don't have to report them), unless
// the agent sends its own "schedule". AGENT_DECK_CRONTAB=/file reads a file instead (tests).
function readCrontab() {
  if (process.env.AGENT_DECK_CRONTAB) return fs.promises.readFile(process.env.AGENT_DECK_CRONTAB, 'utf8').catch(() => '');
  return new Promise((resolve) => execFile('crontab', ['-l'], { timeout: 3000 }, (err, out) => resolve(err ? '' : out)));
}
async function refreshSchedules() {
  const crontab = await readCrontab();
  let changed = false;
  for (const a of agents.values()) {
    if (!a.cwd || a.scheduleFrom === 'agent') continue;
    const schedule = cronJobs(crontab, a.cwd).map((j) => ({ job: j.job, nextRun: nextRun(j.cron) })).filter((s) => s.nextRun);
    if (JSON.stringify(schedule) !== JSON.stringify(a.schedule)) { a.schedule = schedule; a.scheduleFrom = 'crontab'; changed = true; }
  }
  if (changed) broadcast();
}
setInterval(() => refreshSchedules().catch(() => {}), 60000).unref();

// ---------- widget commands ----------
function handleWidgetMessage(ws, msg) {
  switch (msg.type) {
    case 'hello':
      ws.approvals = Boolean(msg.approvals);
      ws.send(JSON.stringify(snapshot()));
      break;
    case 'approvals':
      ws.approvals = Boolean(msg.enabled);
      break;
    case 'decide': {
      const p = pendings.get(msg.pendingId);
      if (p) p.finish(buildOutput(p, msg.decision || {}), 'answered in widget');
      break;
    }
    case 'release': {
      const p = pendings.get(msg.pendingId);
      if (p) p.finish(null, 'release');
      break;
    }
    case 'dismiss': {
      const s = sessions.get(msg.key);
      if (s) { if (s.ended) sessions.delete(s.key); else s.dismissed = true; broadcast(); }
      break;
    }
    case 'jump': {
      const s = sessions.get(msg.key);
      if (s) jumpTo(s);
      break;
    }
    case 'dismiss-agent':
      // Comes back with the agent's next event.
      if (agents.delete(msg.key)) broadcast();
      break;
  }
}

// Best effort: bring the session's terminal or editor to the front on this machine.
function jumpTo(s) {
  const run = (cmd, args) => execFile(cmd, args, { timeout: 4000 }, (err) => err && log(`jump: ${cmd} failed: ${err.message}`));
  if (s.tmuxPane) {
    run('tmux', ['select-window', '-t', s.tmuxPane]);
    run('tmux', ['select-pane', '-t', s.tmuxPane]);
    run('tmux', ['switch-client', '-t', s.tmuxPane]);
  }
  const tp = (s.termProgram || '').toLowerCase();
  if (tp === 'vscode') { run('code', [s.cwd]); return; }
  if (process.platform === 'darwin') {
    const apps = { apple_terminal: 'Terminal', 'iterm.app': 'iTerm', ghostty: 'Ghostty', warpterminal: 'Warp', wezterm: 'WezTerm' };
    if (apps[tp]) run('open', ['-a', apps[tp]]);
  }
}

// ---------- housekeeping ----------
setInterval(() => {
  const now = Date.now();
  let changed = false;
  const tails = new Map();
  for (const s of sessions.values()) {
    if (s.ended) continue;
    const before = s.context?.used;
    const tail = refreshTranscript(s, now);
    if (tail !== null) tails.set(s.key, tail);
    if (s.context?.used !== before) changed = true;
  }
  try { changed = syncFromClaude(now, tails) || changed; } catch (e) { log('reading ~/.claude/sessions failed: ' + e.message); }
  for (const s of sessions.values()) {
    if (!s.ended && !pidAlive(s.pid)) {
      s.ended = true; s.status = STATUS.ENDED; s.step = 'Session ended'; s.statusTs = now; changed = true;
    }
    if (!s.ended && !s.pending && (s.status === STATUS.APPROVAL || s.status === STATUS.QUESTION) && interruptedInTranscript(s)) {
      s.status = STATUS.IDLE; s.step = 'Interrupted in the terminal'; s.statusTs = s.stepTs = now; changed = true;
    }
    if (s.ended && !s.pending && now - s.statusTs > 20000) { sessions.delete(s.key); changed = true; }
    else if (!s.ended && now - s.lastAt > 12 * 3600 * 1000 && !s.pid) { sessions.delete(s.key); changed = true; }
  }
  for (const [fp, t] of releasedQuestions) if (now - t > 300000) releasedQuestions.delete(fp);
  // Agents whose heartbeat stopped turn "not responding" with no event to tell us: check here.
  for (const a of [...agents.values()]) {
    if (now - (a.lastSeen || 0) > AGENT_FORGET_MS) { agents.delete(a.key); changed = true; continue; }
    const st = agentStatus(a, now);
    if (st !== a.lastStatus) { if (a.lastStatus) log(`agent "${a.name}" is now ${st}`); a.lastStatus = st; changed = true; }
  }
  if (changed) broadcast();
}, 2000).unref();

// ---------- server ----------
// A web page in a browser on this machine can reach 127.0.0.1 too. Our own clients (hook.mjs,
// the Python client, the panel) never send a web Origin, so refuse anything that does:
// POSTs with any Origin or a non-JSON body (which would skip the CORS preflight), and
// WebSockets from any origin but the panel's own file:// page.
function refusedPost(req, res) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (req.headers.origin !== undefined) { log(`refused ${req.url} from a web page (Origin ${String(req.headers.origin).slice(0, 80)})`); res.writeHead(403).end(); return true; }
  if (type !== 'application/json') { log(`refused ${req.url}: content-type "${type}"`); res.writeHead(415).end(); return true; }
  return false;
}
// The Electron panel sends exactly "file://" (checked). Not "null": a sandboxed iframe on any
// web page sends that.
const PANEL_ORIGINS = new Set(['file://']);

function handleRequest(req, res) {
  const remote = req.socket.remoteAddress;
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: NAME, version: VERSION, sessions: sessions.size }));
    return;
  }
  if (req.method === 'POST' && req.url === '/agent') {
    // Service agents report from this machine only, like hooks.
    if (!isLoopback(remote)) { res.writeHead(403).end(); return; }
    if (refusedPost(req, res)) return;
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
    req.on('end', () => {
      let out;
      try { out = handleAgent(JSON.parse(raw)); } catch (e) { out = { ok: false, error: 'bad JSON' }; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/hook') {
    if (!isLoopback(remote)) { res.writeHead(403).end(); return; }
    if (refusedPost(req, res)) return;
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on('end', async () => {
      let output = null;
      try { output = await handleHook(JSON.parse(raw), res); } catch (e) { log('hook error: ' + e.stack); }
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ output }));
      }
    });
    return;
  }
  res.writeHead(404).end();
}

// Hooks always arrive on loopback. If sharing on a specific address, listen there too.
const ANY = ['0.0.0.0', '::'];
const binds = isLoopback(BIND) || ANY.includes(BIND) ? [BIND] : ['127.0.0.1', BIND];
const servers = binds.map(() => {
  const srv = http.createServer(handleRequest);
  srv.requestTimeout = 0;
  srv.headersTimeout = 15000;
  return srv;
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1e6 });
function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const remote = req.socket.remoteAddress;
  const origin = req.headers.origin;
  if (origin !== undefined && !PANEL_ORIGINS.has(origin)) {
    log(`rejected a WebSocket from a web page (Origin ${String(origin).slice(0, 80)})`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!isLoopback(remote) && !tokensMatch(url.searchParams.get('token') || '', cfg.token || '')) {
    log(`rejected widget from ${remote}: bad token`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.approvals = false;
    widgets.add(ws);
    log(`widget connected from ${remote} (${widgets.size} total)`);
    ws.on('message', (data) => {
      try { handleWidgetMessage(ws, JSON.parse(String(data))); } catch (e) { log('widget msg error: ' + e.message); }
    });
    ws.on('close', () => {
      widgets.delete(ws);
      log(`widget disconnected (${widgets.size} left)`);
      // Nobody left to answer: hand pending prompts back to the terminal right away.
      if (!approversConnected()) for (const p of [...pendings.values()]) p.finish(null, 'no widgets');
    });
    ws.send(JSON.stringify(snapshot()));
  });
}

// Settings the panel can change while the daemon runs (port, bind, token and name need a restart).
fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  const next = loadConfig();
  const hold = holdFrom(next);
  if (hold !== HOLD_MS) {
    HOLD_MS = hold;
    PRETOOLUSE_HOLD_MS = Math.min(HOLD_MS, 90000);
    log(`panel can now answer for ${HOLD_MS / 1000}s (new prompts)`);
  }
  cfg.contextWarnPercent = next.contextWarnPercent;
  cfg.contextWindows = next.contextWindows;
  broadcast();
}).unref();

loadState();
let listening = 0;
servers.forEach((srv, i) => {
  srv.on('upgrade', handleUpgrade);
  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { log(`port ${PORT} busy on ${binds[i]}, another daemon is running`); process.exit(0); }
    log('server error: ' + e.message);
    process.exit(1);
  });
  srv.listen(PORT, binds[i], () => {
    if (++listening < servers.length) return;
    fs.writeFileSync(PID_PATH, String(process.pid));
    log(`Agent Deck daemon v${VERSION} "${NAME}" on ${binds.join(' + ')}:${PORT} (hold ${HOLD_MS / 1000}s)`);
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  for (const p of [...pendings.values()]) p.finish(null, 'shutdown');
  try { if (fs.readFileSync(PID_PATH, 'utf8') === String(process.pid)) fs.unlinkSync(PID_PATH); } catch {}
  setTimeout(() => process.exit(0), 100);
});
