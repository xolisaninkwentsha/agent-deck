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
  loadConfig, ensureHome, machineName, isLoopback, tokensMatch, STATE_PATH, LOG_PATH, PID_PATH, CONFIG_PATH, HOME,
} from './config.mjs';
import { ownDevice, plainIp } from './tailscale.mjs';
import {
  newSession, applyEvent, publicView, describeApproval, describeTool, setStep, todosSummary, STATUS,
} from './state.mjs';
import { runningSessions, transcriptFor, readTail, lastActivity, contextUsage, contextWindow, scanUsage, usageSummary } from './claude-sessions.mjs';
import {
  newAgent, applyAgentEvent, agentView, agentStatus, expireJobs, AGENT_NAME, nextRun, cronJobs,
  otlpServiceName, newOtlpAgent, applyOtlpSpans, applyOtlpMetrics, applyOtlpLogs, otlpTick, wakeClock,
} from './agents.mjs';
import { decodeOtlp } from './otlp.mjs';
import zlib from 'node:zlib';

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

// ---------- waking from suspend ----------
// Nothing can arrive while the machine sleeps, so the agents' heartbeat clocks move on by the
// time asleep. Timers pause during suspend, so this runs on every tick, snapshot and agent event.
const TICK_MS = 2000;
const wake = wakeClock(Number(process.env.AGENT_DECK_WAKE_GAP_MS) || 30000, TICK_MS); // a gap this long = the machine slept
function checkWake(now = Date.now()) {
  const gap = wake.check(agents.values(), now);
  if (gap) log(`woke after ${Math.round(gap / 1000)} s: agent heartbeat clocks moved on`);
}

// ---------- paired devices (Tailscale) ----------
// Your own devices (same Tailscale user, not tagged servers) that you allowed to see this machine.
// They connect without a token: Tailscale vouches for who they are (tailscale.mjs). This daemon
// owns devices.json; panels change it only through messages from this machine.
const DEVICES_PATH = path.join(HOME, 'devices.json');
const devices = new Map(); // Tailscale StableID -> { id, dns, name, login, addedAt }
try { for (const d of JSON.parse(fs.readFileSync(DEVICES_PATH, 'utf8'))) if (d && typeof d.id === 'string') devices.set(d.id, d); } catch {}
const saveDevices = () => { ensureHome(); fs.writeFileSync(DEVICES_PATH, JSON.stringify([...devices.values()], null, 2) + '\n', { mode: 0o600 }); };
const allowDevice = (dev) => {
  devices.set(dev.id, { id: dev.id, dns: dev.dns, name: dev.name, login: dev.login, addedAt: Date.now() });
  saveDevices();
  log(`device allowed: ${dev.name} (${dev.login})`);
};
/** pairing request id -> { id, device, ip, port, shared, back, at, res, timer } */
const pairRequests = new Map();
const deniedUntil = new Map(); // device id -> no new request from it until then
const PAIR_HOLD_MS = Number(process.env.AGENT_DECK_PAIR_HOLD_MS) || 120000;
const localPanels = () => [...widgets].filter((w) => w.local && w.readyState === 1);
function finishPair(r, approved, reason = '') {
  if (!pairRequests.delete(r.id)) return;
  clearTimeout(r.timer);
  if (!r.res.writableEnded && !r.res.destroyed) {
    r.res.writeHead(200, { 'content-type': 'application/json' });
    r.res.end(JSON.stringify({ name: NAME, approved, reason, back: Boolean(r.back) }));
  }
  broadcast();
}

// ---------- broadcasting ----------
let broadcastTimer = null;
// Pairing requests and the device list go only to panels on this machine (local), never to
// another machine's panel.
function snapshot(local = false) {
  checkWake();
  const s = {
    type: 'snapshot', host: NAME, version: VERSION, holdSeconds: HOLD_MS / 1000,
    sessions: [...sessions.values()].filter((x) => !x.dismissed).map((x) => publicView(x, { warnPercent: Number(cfg.contextWarnPercent) || 80 })),
    agents: [...agents.values()].map((a) => agentView(a)),
  };
  if (local) {
    s.pairRequests = [...pairRequests.values()].map((r) => ({ id: r.id, name: r.device.name, dns: r.device.dns, login: r.device.login, ip: r.ip, port: r.port, shared: r.shared, at: r.at }));
    s.devices = [...devices.values()].map((d) => ({ ...d, connected: [...widgets].some((w) => w.deviceId === d.id) }));
  }
  return s;
}
function broadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    const remote = JSON.stringify(snapshot(false)), local = JSON.stringify(snapshot(true));
    for (const ws of widgets) if (ws.readyState === 1) ws.send(ws.local ? local : remote);
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
const usageAcc = new Map(); // session key -> running transcript totals (scanUsage); memory only
function refreshTranscript(s, now) {
  const file = s.transcript || (s.source === 'discovered' ? (s.transcript = transcriptFor(s.id, s.cwd)) : null);
  if (!file) return null;
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  // Model, tokens and tools for the card: catch up with what was written since last time.
  const acc = usageAcc.get(s.key);
  if (!acc || acc.offset < size) {
    const next = scanUsage(file, acc);
    usageAcc.set(s.key, next);
    const sum = usageSummary(next);
    if (JSON.stringify(sum) !== JSON.stringify(s.usage)) s.usage = sum;
  }
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
  checkWake(); // before this event moves any clock
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

// ---------- OpenTelemetry receiver (OTLP/HTTP) ----------
// Any agent exporting OTLP to localhost:4318 shows up as an agent card (one per service.name).
// Loopback only, whatever "share" sets; protobuf or JSON, optionally gzip. Metadata only:
// see agents.mjs for which attributes are read.
const OTLP_SIGNALS = { '/v1/traces': 'traces', '/v1/metrics': 'metrics', '/v1/logs': 'logs' };
const OTLP_MAX_BODY = 8 * 1024 * 1024;
const OTLP_MAX_INFLATED = 16 * 1024 * 1024;

function ingestOtlp(signal, groups) {
  const now = Date.now();
  checkWake(now); // before these items move any clock
  const ignore = new Set(Array.isArray(cfg.otlpIgnoreServices) ? cfg.otlpIgnoreServices : []);
  for (const g of groups) {
    const service = otlpServiceName(g.resource);
    if (ignore.has(service) || !g.items.length) continue;
    const key = `${NAME}:otlp:${service}`;
    let a = agents.get(key);
    if (!a) {
      if (agents.size >= MAX_AGENTS) continue;
      a = newOtlpAgent(key, service, NAME, g.resource);
      agents.set(key, a);
      log(`OTLP: service "${service}" reporting`);
    }
    if (signal === 'traces') applyOtlpSpans(a, g.items, now);
    else if (signal === 'metrics') applyOtlpMetrics(a, g.items, g.resource, now, Number(cfg.otlpHeartbeatSeconds) || 60);
    else applyOtlpLogs(a, g.items, now);
    a.lastStatus = agentStatus(a, now);
  }
  broadcast();
}

function handleOtlp(req, res) {
  const reply = (code, body = '', type = 'text/plain') => { if (!res.headersSent) { res.writeHead(code, { 'content-type': type }); res.end(body); } };
  if (!isLoopback(req.socket.remoteAddress)) return reply(403);
  const signal = OTLP_SIGNALS[(req.url || '').split('?')[0]];
  if (!signal) return reply(404);
  if (req.method !== 'POST') return reply(405);
  if (req.headers.origin !== undefined) { log(`OTLP: refused ${req.url} from a web page`); return reply(403); }
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const json = type === 'application/json';
  if (!json && type !== 'application/x-protobuf') return reply(415);
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > OTLP_MAX_BODY) { reply(413); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (size > OTLP_MAX_BODY) return;
    let body = Buffer.concat(chunks);
    try {
      if (/gzip/i.test(String(req.headers['content-encoding'] || ''))) body = zlib.gunzipSync(body, { maxOutputLength: OTLP_MAX_INFLATED });
      ingestOtlp(signal, decodeOtlp(signal, body, json));
    } catch (e) {
      // The error class only: a JSON parse error's message quotes the start of the body.
      log(`OTLP: bad ${signal} request (${e?.name || 'Error'}${e?.code ? ' ' + e.code : ''})`);
      return reply(400, json ? '{"error":"bad request"}' : '', json ? 'application/json' : 'text/plain');
    }
    // An empty Export*ServiceResponse.
    if (json) reply(200, '{}', 'application/json'); else reply(200, '', 'application/x-protobuf');
  });
  req.on('error', () => {});
}

function startOtlp() {
  const port = cfg.otlpPort === undefined ? 4318 : Number(cfg.otlpPort);
  if (!port) return;
  // Both loopback addresses: exporters default to http://localhost:4318, which may resolve to ::1.
  for (const host of ['127.0.0.1', '::1']) {
    const srv = http.createServer(handleOtlp);
    srv.headersTimeout = 15000;
    srv.on('error', (e) => log(`OTLP receiver not listening on [${host}]:${port}: ${e.code || e.message}`)); // never exits the daemon
    srv.listen(port, host, () => log(`OTLP receiver on [${host}]:${port}`));
  }
}

// ---------- widget commands ----------
function handleWidgetMessage(ws, msg) {
  switch (msg.type) {
    case 'hello':
      ws.approvals = Boolean(msg.approvals);
      ws.send(JSON.stringify(snapshot(ws.local)));
      break;
    // Pairing: only a panel on this machine may answer a request or change the device list.
    case 'pair-decide': {
      const r = ws.local && pairRequests.get(msg.id);
      if (!r) break;
      if (msg.allow) { allowDevice(r.device); r.back = Boolean(msg.back) && r.shared; finishPair(r, true); }
      else { deniedUntil.set(r.device.id, Date.now() + 10 * 60000); log(`pairing denied: ${r.device.name}`); finishPair(r, false, 'denied'); }
      break;
    }
    case 'allow-device': // this panel paired with that machine, which asked to see this one too
      if (!ws.local) break;
      ownDevice(String(msg.ip || '')).then((dev) => { if (dev) { allowDevice(dev); broadcast(); } });
      break;
    case 'remove-device':
      if (!ws.local || !devices.delete(msg.id)) break;
      saveDevices();
      log(`device removed: ${msg.id}`);
      for (const w of widgets) if (w.deviceId === msg.id) w.close(4001, 'removed');
      broadcast();
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
  checkWake(now);
  const tails = new Map();
  for (const s of sessions.values()) {
    if (s.ended) continue;
    const before = s.context?.used, usageBefore = s.usage;
    const tail = refreshTranscript(s, now);
    if (tail !== null) tails.set(s.key, tail);
    if (s.context?.used !== before || s.usage !== usageBefore) changed = true;
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
  for (const key of usageAcc.keys()) if (!sessions.has(key)) usageAcc.delete(key);
  // Agents whose heartbeat stopped turn "not responding" with no event to tell us: check here.
  for (const a of [...agents.values()]) {
    if (now - (a.lastSeen || 0) > AGENT_FORGET_MS) { agents.delete(a.key); changed = true; continue; }
    if (a.otlp) {
      if (otlpTick(a, now, { waitingTtlMs: (Number(cfg.otlpWaitingTtlHours) || 168) * 3600 * 1000 })) changed = true;
    } else {
      const maxJobMs = Number(process.env.AGENT_DECK_JOB_MAX_MS) || (Number(cfg.agentJobMaxHours) || 12) * 3600 * 1000;
      if (expireJobs(a, now, maxJobMs)) { log(`agent "${a.name}": a job reported no end, marked failed`); changed = true; }
    }
    const st = agentStatus(a, now);
    if (st !== a.lastStatus) { if (a.lastStatus) log(`agent "${a.name}" is now ${st}`); a.lastStatus = st; changed = true; }
  }
  if (changed) broadcast();
}, TICK_MS).unref();

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
  if (req.url === '/pair' && (req.method === 'GET' || req.method === 'POST')) {
    handlePair(req, res).catch((e) => { log('pair error: ' + e.message); if (!res.headersSent) res.writeHead(500).end(); });
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

// Pairing between your own machines over Tailscale (reachable only while this one is shared).
// GET: "is Agent Deck here, and am I paired?". POST: ask to be allowed; held until a panel on
// this machine answers (or PAIR_HOLD_MS). Only your own devices get any answer but 403.
async function handlePair(req, res) {
  const remote = req.socket.remoteAddress;
  if (isLoopback(remote)) { res.writeHead(400).end(); return; } // pairing is between machines
  if (req.method === 'POST' && refusedPost(req, res)) return;
  const dev = await ownDevice(remote);
  if (!dev) { log(`pairing refused from ${plainIp(remote)}: not one of your Tailscale devices`); res.writeHead(403).end(); return; }
  const reply = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: NAME, ...o })); };
  if (req.method === 'GET') { reply({ agentDeck: true, version: VERSION, paired: devices.has(dev.id) }); return; }
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { raw += c; if (raw.length > 2048) req.destroy(); });
  await new Promise((resolve) => req.on('end', resolve));
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400).end(); return; }
  if (devices.has(dev.id)) { reply({ approved: true }); return; }
  if ((deniedUntil.get(dev.id) || 0) > Date.now()) { reply({ approved: false, reason: 'denied a moment ago; try again in a few minutes' }); return; }
  if (!localPanels().length) { reply({ approved: false, reason: `no Agent Deck panel is open on ${NAME} to approve it` }); return; }
  if (pairRequests.size >= 3 || [...pairRequests.values()].some((x) => x.device.id === dev.id)) { reply({ approved: false, reason: 'a request is already waiting there' }); return; }
  const port = Number.isInteger(body.port) && body.port > 0 && body.port < 65536 ? body.port : PORT;
  const r = { id: crypto.randomUUID(), device: dev, ip: plainIp(remote), port, shared: body.shared === true, at: Date.now(), res };
  r.timer = setTimeout(() => finishPair(r, false, 'no answer in time'), PAIR_HOLD_MS);
  res.on('close', () => { if (pairRequests.delete(r.id)) { clearTimeout(r.timer); broadcast(); } }); // the asker gave up
  pairRequests.set(r.id, r);
  log(`pairing request from ${dev.name} (${dev.login})`);
  broadcast();
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
async function handleUpgrade(req, socket, head) {
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
  let deviceId = null;
  if (!isLoopback(remote) && !tokensMatch(url.searchParams.get('token') || '', cfg.token || '')) {
    // No (right) token: a paired Tailscale device gets in on its identity. Anything else is refused.
    socket.on('error', () => {}); // a reset while Tailscale answers mustn't crash the daemon
    const dev = devices.size ? await ownDevice(remote).catch(() => null) : null;
    if (!dev || !devices.has(dev.id)) {
      log(`rejected widget from ${plainIp(remote)}: no token and not a paired device`);
      if (!socket.destroyed) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); }
      return;
    }
    if (socket.destroyed) return;
    deviceId = dev.id;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.approvals = false;
    ws.local = isLoopback(remote);
    ws.deviceId = deviceId;
    widgets.add(ws);
    log(`widget connected from ${remote}${deviceId ? ` (paired device ${devices.get(deviceId)?.name})` : ''} (${widgets.size} total)`);
    ws.on('message', (data) => {
      try { handleWidgetMessage(ws, JSON.parse(String(data))); } catch (e) { log('widget msg error: ' + (e instanceof SyntaxError ? 'SyntaxError' : e.message)); } // a parse error quotes the message
    });
    ws.on('close', () => {
      widgets.delete(ws);
      log(`widget disconnected (${widgets.size} left)`);
      // Nobody left to answer: hand pending prompts back to the terminal right away.
      if (!approversConnected()) for (const p of [...pendings.values()]) p.finish(null, 'no widgets');
      if (ws.deviceId) broadcast(); // "connected" in the local panel's device list
    });
    ws.send(JSON.stringify(snapshot(ws.local)));
    if (deviceId) broadcast();
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
startOtlp();
let listening = 0;
servers.forEach((srv, i) => {
  srv.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head).catch((e) => { log('upgrade error: ' + e.message); socket.destroy(); }));
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
