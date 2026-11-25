// Agent Deck daemon: one per machine.
// - Receives Claude Code hook events from src/hook.mjs on 127.0.0.1:<port>/hook
// - Keeps a live picture of every session on this machine
// - Streams it to widgets over WebSocket (/ws), local or remote (remote needs the token)
// - Holds permission requests and questions until a widget answers or the hold times out
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import {
  loadConfig, ensureHome, machineName, isLoopback, tokensMatch, STATE_PATH, LOG_PATH, PID_PATH,
} from './config.mjs';
import {
  newSession, applyEvent, publicView, describeApproval, STATUS,
} from './state.mjs';

const VERSION = '0.1.0';
const cfg = loadConfig();
const NAME = machineName(cfg);
const PORT = Number(cfg.port);
const BIND = cfg.bind;
const HOLD_MS = Math.max(5, Number(cfg.holdSeconds) || 90) * 1000;
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
    log(`restored ${sessions.size} session(s)`);
  } catch {}
}
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const list = [...sessions.values()].map((s) => ({ ...s, pending: null }));
    fs.writeFile(STATE_PATH, JSON.stringify({ sessions: list }), () => {});
  }, 500);
}

// ---------- broadcasting ----------
let broadcastTimer = null;
function snapshot() {
  return {
    type: 'snapshot', host: NAME, version: VERSION, holdSeconds: HOLD_MS / 1000,
    sessions: [...sessions.values()].filter((s) => !s.dismissed).map(publicView),
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
    sessions.set(key, s);
  }
  return s;
}

function questionFingerprint(key, questions) {
  return key + ':' + crypto.createHash('sha1').update(JSON.stringify(questions || [])).digest('hex');
}

// Hold a blocking hook until a widget decides or the hold expires.
// Resolves with the hook's JSON output, or null to fall back to the terminal.
function hold(s, res, { kind, hookEvent, toolName, toolInput, suggestions }) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    const view = { id, kind, tool: toolName, createdAt: now, expiresAt: now + HOLD_MS };
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

    const finish = (output, why) => {
      if (!pendings.has(id)) return;
      const p = pendings.get(id);
      clearTimeout(p.timer);
      pendings.delete(id);
      if (s.pending && s.pending.id === id) {
        s.pending = null;
        s.statusTs = Date.now();
        if (output) {
          s.status = STATUS.WORKING;
          const denied = output.hookSpecificOutput?.decision?.behavior === 'deny';
          s.step = kind === 'question' ? 'Got your answer, continuing' : denied ? 'You denied: ' + view.title.toLowerCase() : 'Approved: ' + view.title.toLowerCase();
          s.stepTs = s.statusTs;
        } else {
          // Handed back to Claude Code: the normal prompt now shows in the terminal.
          s.status = kind === 'question' ? STATUS.QUESTION : STATUS.APPROVAL;
          s.step = 'Waiting for you in the terminal';
          s.stepTs = s.statusTs;
        }
      }
      if (!output && kind === 'question') releasedQuestions.set(questionFingerprint(s.key, toolInput?.questions), Date.now());
      log(`pending ${id} (${kind}) finished: ${why}`);
      broadcast();
      resolve(output);
    };
    const timer = setTimeout(() => finish(null, 'timeout'), HOLD_MS);
    pendings.set(id, { key: s.key, finish, timer, hookEvent, toolName, toolInput, suggestions, kind });
    // If Claude Code gives up on the hook (or the session dies), drop the pending card.
    res.on('close', () => { if (pendings.has(id)) finish(null, 'hook closed'); });
    log(`holding ${kind} ${id} for ${s.key} (${toolName})`);
    broadcast();
  });
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
    if (isQuestion) {
      const fp = questionFingerprint(s.key, input.tool_input?.questions);
      const released = releasedQuestions.get(fp);
      if (released && Date.now() - released < 120000) skip = true; // already handed to the terminal
    }
    if (event === 'PreToolUse' && !isQuestion) skip = true; // only questions are handled on PreToolUse
    if (!skip) {
      output = await hold(s, res, {
        kind: isQuestion ? 'question' : 'approval',
        hookEvent: event, toolName: tool, toolInput: input.tool_input, suggestions: input.permission_suggestions,
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
  let changed = false;
  const now = Date.now();
  for (const s of sessions.values()) {
    if (!s.ended && !pidAlive(s.pid)) {
      s.ended = true; s.status = STATUS.ENDED; s.step = 'Session ended'; s.statusTs = now; changed = true;
    }
    if (s.ended && !s.pending && now - s.statusTs > 20000) { sessions.delete(s.key); changed = true; }
    else if (!s.ended && now - s.lastAt > 12 * 3600 * 1000 && !s.pid) { sessions.delete(s.key); changed = true; }
  }
  for (const [fp, t] of releasedQuestions) if (now - t > 300000) releasedQuestions.delete(fp);
  if (changed) broadcast();
}, 5000).unref();

// ---------- server ----------
function handleRequest(req, res) {
  const remote = req.socket.remoteAddress;
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: NAME, version: VERSION, sessions: sessions.size }));
    return;
  }
  if (req.method === 'POST' && req.url === '/hook') {
    if (!isLoopback(remote)) { res.writeHead(403).end(); return; }
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
