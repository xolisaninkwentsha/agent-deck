// The daemon's phone client: one outgoing WebSocket to the relay, authenticated with a machine key.
// Links and unlinks a number, decides which held prompts go to the phone, and turns the relay's
// `decide` into a call back into the daemon. Logs never carry the key, prompt text or a full number.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { phoneSummary } from './phone-summary.mjs';

export const DEFAULT_RELAY_URL = '';

const PING_MS = 30000;
const DEAD_MS = 75000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;
const MIN_LEFT_MS = 60000; // a prompt with less than this left isn't sent
const AWAY_AFTER_MS = 120000; // a PermissionRequest unanswered this long counts as away
const PERMISSION_HOLD_MS = 570000; // a PermissionRequest hold extends to createdAt + this

const MODES = new Set(['away', 'everything']);
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** Trimmed relay URL if acceptable (wss://, or ws:// to loopback only), else null. '' passes as "none". */
function cleanRelay(r) {
  if (typeof r !== 'string') return null;
  const t = r.trim();
  if (t === '') return '';
  let u;
  try { u = new URL(t); } catch { return null; }
  if (!u.hostname) return null;
  if (u.protocol === 'wss:') return t;
  if (u.protocol === 'ws:' && LOOPBACK.has(u.hostname)) return t;
  return null;
}

/** Only the shapes the phone may produce; never `always` or anything extra. */
function cleanDecision(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (d.answers !== undefined) {
    const a = d.answers;
    if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
    const entries = Object.entries(a);
    if (entries.length > 20 || !entries.every(([, v]) => typeof v === 'string')) return null;
    return { answers: Object.fromEntries(entries) };
  }
  if (d.behavior === 'allow') return { behavior: 'allow' };
  if (d.behavior === 'deny') {
    if (d.message === undefined) return { behavior: 'deny' };
    if (typeof d.message !== 'string' || d.message.length > 200) return null;
    return { behavior: 'deny', message: d.message };
  }
  return null;
}

export function createPhone({
  home, machineName, log = () => {}, onChange = () => {}, decide, extendHold,
  relayUrl = process.env.AGENT_DECK_RELAY, WebSocketImpl = WebSocket, now = Date.now, version = '0.1.0',
  handshakeTimeout = 10000, awayAfterMs = AWAY_AFTER_MS,
}) {
  const file = path.join(home, 'phone.json');
  let state = null; // { key, relay, enabled, mode, lastStatus }
  let ws = null;
  let connected = false;
  let stopped = true;
  let backoff = BACKOFF_MIN_MS;
  let reconnectTimer = null;
  let pingTimer = null;
  let deadTimer = null;
  let code = null;
  let error = '';
  const sent = {}; // pendingId -> 'sent' | 'failed:<reason>'
  const inflight = new Set(); // sent to the relay, not yet acknowledged
  const events = new Map(); // pendingId -> hookEvent, for prompts sent or in flight

  const changed = () => { try { onChange(); } catch { log('phone: onChange failed'); } };
  const save = () => {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      log('phone: could not save phone.json');
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    }
  };
  const load = () => {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run or unreadable */ }
    const ok = Boolean(s) && typeof s === 'object';
    state = {
      key: ok && typeof s.key === 'string' && s.key.length === 43 ? s.key : crypto.randomBytes(32).toString('base64url'),
      relay: ok ? (cleanRelay(s.relay) ?? '') : '',
      enabled: ok && s.enabled === true,
      mode: ok && MODES.has(s.mode) ? s.mode : 'away',
      lastStatus: ok && s.lastStatus && typeof s.lastStatus === 'object' ? s.lastStatus : null,
    };
    save();
  };

  const rawRelay = () => (state?.relay || relayUrl || DEFAULT_RELAY_URL || '');
  const relayAddr = () => cleanRelay(rawRelay()) ?? '';
  const relayBad = () => cleanRelay(rawRelay()) === null;
  const status = () => state?.lastStatus || {};
  const linkedNow = () => status().linked === true;

  const send = (obj) => {
    if (!ws || !connected) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  };

  function view() {
    const st = status();
    return {
      relay: relayAddr(),
      connected,
      linked: st.linked === true,
      number: st.number ?? null,
      enabled: Boolean(state?.enabled),
      mode: state?.mode ?? 'away',
      code,
      balanceMicroUsd: st.balanceMicroUsd ?? null,
      billing: st.billing ?? null,
      botNumber: st.botNumber ?? null,
      error: error || (relayBad() ? 'bad-relay' : ''),
      sent: { ...sent },
    };
  }

  const clearTimers = () => {
    clearTimeout(reconnectTimer); reconnectTimer = null;
    clearInterval(pingTimer); pingTimer = null;
    clearTimeout(deadTimer); deadTimer = null;
  };
  const armDead = () => {
    clearTimeout(deadTimer);
    deadTimer = setTimeout(() => { try { ws?.terminate(); } catch { /* already gone */ } }, DEAD_MS);
  };

  function scheduleReconnect() {
    if (stopped || reconnectTimer || !relayAddr()) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
  }

  function connect() {
    if (stopped || ws) return;
    const url = relayAddr();
    if (!url) return;
    let sock;
    try {
      sock = new WebSocketImpl(url, { headers: { Authorization: 'Bearer ' + state.key }, handshakeTimeout });
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;
    armDead(); // a handshake that never completes is cut off too
    sock.on('open', () => {
      if (ws !== sock) return;
      connected = true;
      backoff = BACKOFF_MIN_MS;
      log('phone: connected');
      send({ type: 'hello', machine: machineName, version });
      pingTimer = setInterval(() => { try { sock.send('ping'); } catch { /* closing */ } }, PING_MS);
      armDead();
      changed();
    });
    sock.on('message', (data) => {
      if (ws !== sock) return;
      armDead();
      const text = data.toString();
      if (text === 'pong') return;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      try { onRelay(msg); } catch { log('phone: handler failed'); }
    });
    sock.on('error', () => { /* 'close' follows */ });
    sock.on('close', () => {
      if (ws !== sock) return;
      ws = null;
      const was = connected;
      connected = false;
      clearInterval(pingTimer); pingTimer = null;
      clearTimeout(deadTimer); deadTimer = null;
      inflight.clear(); // a reconnect re-sends; the relay dedupes
      if (was) log('phone: disconnected');
      changed();
      scheduleReconnect();
    });
  }

  function disconnect() {
    clearTimers();
    const sock = ws;
    ws = null;
    const was = connected;
    connected = false;
    inflight.clear();
    if (sock) { try { sock.terminate(); } catch { /* already gone */ } }
    if (was) log('phone: disconnected');
  }

  function onRelay(msg) {
    switch (msg.type) {
      case 'status': {
        const wasLinked = linkedNow();
        state.lastStatus = {
          linked: msg.linked === true,
          number: msg.number ?? null,
          balanceMicroUsd: msg.balanceMicroUsd ?? null,
          billing: msg.billing ?? null,
          botNumber: msg.botNumber ?? null,
        };
        if (msg.linked === true) {
          code = null;
          error = '';
          if (!wasLinked) { state.enabled = true; log('phone: linked'); }
        }
        save();
        changed();
        break;
      }
      case 'link-code':
        code = { code: msg.code, expiresAt: msg.expiresAt, botNumber: msg.botNumber };
        error = '';
        changed();
        break;
      case 'error':
        error = String(msg.reason ?? 'error');
        changed();
        break;
      case 'prompt-sent':
        if (!inflight.has(msg.pendingId) && !(msg.pendingId in sent)) break;
        inflight.delete(msg.pendingId);
        sent[msg.pendingId] = 'sent';
        log('phone: prompt sent');
        if (events.get(msg.pendingId) === 'PermissionRequest') {
          try { extendHold(msg.pendingId); } catch { log('phone: extendHold failed'); }
        }
        changed();
        break;
      case 'prompt-failed':
        inflight.delete(msg.pendingId);
        sent[msg.pendingId] = 'failed:' + String(msg.reason ?? 'unknown');
        log('phone: prompt failed');
        changed();
        break;
      case 'decide': {
        const id = msg.pendingId;
        const ack = (ok, reason) => send(reason ? { type: 'decide-ack', pendingId: id, ok, reason } : { type: 'decide-ack', pendingId: id, ok });
        const known = typeof id === 'string' && (sent[id] === 'sent' || inflight.has(id));
        if (!state.enabled || !linkedNow() || !known) { ack(false, 'unknown'); break; }
        const decision = cleanDecision(msg.decision);
        if (!decision) { ack(false, 'bad-decision'); break; }
        let r;
        try { r = decide(id, decision); } catch { r = { ok: false, reason: 'error' }; }
        if (r?.ok) ack(true); else ack(false, r?.reason ?? 'error');
        log('phone: decision received');
        break;
      }
      default:
        break;
    }
  }

  const isApprover = (away) => Boolean(
    state && linkedNow() && state.enabled && connected && (state.mode === 'everything' || away),
  );

  // presenceActive: a panel says the machine it runs on is in use, so the user is at a computer
  // and the 2-minute rule doesn't apply. "Send everything" still sends: the user chose it.
  function consider(list, away, presenceActive = false) {
    if (!connected || !linkedNow() || !state.enabled) return;
    const t = now();
    for (const p of list) {
      if (p.id in sent || inflight.has(p.id)) continue;
      if (p.expiresAt - t < MIN_LEFT_MS) continue;
      const permission = p.hookEvent === 'PermissionRequest';
      const unanswered = permission && !presenceActive && t - p.createdAt >= awayAfterMs;
      if (!(state.mode === 'everything' || away || unanswered)) continue;
      let prompt;
      try {
        prompt = phoneSummary({ toolName: p.toolName, toolInput: p.toolInput, project: p.project, questions: p.questions });
      } catch { continue; }
      const expiresAt = permission ? p.createdAt + PERMISSION_HOLD_MS : p.expiresAt;
      if (send({ type: 'prompt', pendingId: p.id, expiresAt, prompt })) {
        inflight.add(p.id);
        events.set(p.id, p.hookEvent);
      }
    }
  }

  function closed(pendingId, why) {
    const known = pendingId in sent || inflight.has(pendingId);
    if (known) send({ type: 'prompt-closed', pendingId, why });
    delete sent[pendingId];
    inflight.delete(pendingId);
    events.delete(pendingId);
    if (known) changed();
  }

  function panelMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'phone-link':
        if (typeof msg.number === 'string' && send({ type: 'link-start', number: msg.number.trim() })) {
          error = '';
        } else {
          error = 'relay-unreachable';
        }
        changed();
        break;
      case 'phone-unlink':
        if (send({ type: 'unlink' })) error = ''; else error = 'relay-unreachable';
        state.enabled = false;
        save();
        changed();
        break;
      case 'phone-cancel-link':
        code = null;
        changed();
        break;
      case 'phone-settings': {
        const before = relayAddr();
        if (typeof msg.enabled === 'boolean') state.enabled = msg.enabled;
        if (MODES.has(msg.mode)) state.mode = msg.mode;
        if (msg.relay !== undefined) {
          const r = cleanRelay(msg.relay);
          if (r === null) error = 'bad-relay'; else { state.relay = r; if (error === 'bad-relay') error = ''; }
        }
        if (relayAddr() !== before) {
          // A different relay means linking again; the old relay never sees the new key.
          state.key = crypto.randomBytes(32).toString('base64url');
          state.lastStatus = null;
          state.enabled = false;
          code = null;
          for (const k of Object.keys(sent)) delete sent[k];
          events.clear();
          if (!stopped) { disconnect(); backoff = BACKOFF_MIN_MS; save(); connect(); }
        }
        save();
        changed();
        break;
      }
      default:
        break;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    if (!state) load();
    backoff = BACKOFF_MIN_MS;
    connect();
  }

  function stop() {
    stopped = true;
    disconnect();
  }

  return { start, stop, view, isApprover, consider, closed, panelMessage };
}
