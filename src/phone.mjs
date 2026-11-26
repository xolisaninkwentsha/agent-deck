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
const validRelay = (r) => typeof r === 'string' && (r === '' || r.startsWith('ws://') || r.startsWith('wss://'));

export function createPhone({
  home, machineName, log = () => {}, onChange = () => {}, decide, extendHold,
  relayUrl = process.env.AGENT_DECK_RELAY, WebSocketImpl = WebSocket, now = Date.now, version = '0.1.0',
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

  const save = () => {
    fs.mkdirSync(home, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const load = () => {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run or unreadable */ }
    const ok = Boolean(s) && typeof s === 'object';
    state = {
      key: ok && typeof s.key === 'string' && s.key.length === 43 ? s.key : crypto.randomBytes(32).toString('base64url'),
      relay: ok && validRelay(s.relay) ? s.relay : '',
      enabled: ok && s.enabled === true,
      mode: ok && MODES.has(s.mode) ? s.mode : 'away',
      lastStatus: ok && s.lastStatus && typeof s.lastStatus === 'object' ? s.lastStatus : null,
    };
    save();
  };

  const relayAddr = () => (state?.relay || relayUrl || DEFAULT_RELAY_URL || '');
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
      error,
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
      sock = new WebSocketImpl(url, { headers: { Authorization: 'Bearer ' + state.key } });
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.on('open', () => {
      if (ws !== sock) return;
      connected = true;
      backoff = BACKOFF_MIN_MS;
      log('phone: connected');
      send({ type: 'hello', machine: machineName, version });
      pingTimer = setInterval(() => { try { sock.send('ping'); } catch { /* closing */ } }, PING_MS);
      armDead();
      onChange();
    });
    sock.on('message', (data) => {
      if (ws !== sock) return;
      armDead();
      const text = data.toString();
      if (text === 'pong') return;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg && typeof msg === 'object') onRelay(msg);
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
      onChange();
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
        onChange();
        break;
      }
      case 'link-code':
        code = { code: msg.code, expiresAt: msg.expiresAt, botNumber: msg.botNumber };
        error = '';
        onChange();
        break;
      case 'error':
        error = String(msg.reason ?? 'error');
        onChange();
        break;
      case 'prompt-sent':
        if (!inflight.has(msg.pendingId) && !(msg.pendingId in sent)) break;
        inflight.delete(msg.pendingId);
        sent[msg.pendingId] = 'sent';
        log('phone: prompt sent');
        if (events.get(msg.pendingId) === 'PermissionRequest') extendHold(msg.pendingId);
        onChange();
        break;
      case 'prompt-failed':
        inflight.delete(msg.pendingId);
        sent[msg.pendingId] = 'failed:' + String(msg.reason ?? 'unknown');
        log('phone: prompt failed');
        onChange();
        break;
      case 'decide': {
        let r;
        try { r = decide(msg.pendingId, msg.decision); } catch { r = { ok: false, reason: 'error' }; }
        const ack = { type: 'decide-ack', pendingId: msg.pendingId, ok: Boolean(r?.ok) };
        if (r?.reason !== undefined) ack.reason = r.reason;
        send(ack);
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

  function consider(list, away) {
    if (!connected || !linkedNow() || !state.enabled) return;
    const t = now();
    for (const p of list) {
      if (p.id in sent || inflight.has(p.id)) continue;
      if (p.expiresAt - t < MIN_LEFT_MS) continue;
      const permission = p.hookEvent === 'PermissionRequest';
      if (!(state.mode === 'everything' || away || (permission && t - p.createdAt >= AWAY_AFTER_MS))) continue;
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
    if (known) onChange();
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
        onChange();
        break;
      case 'phone-unlink':
        if (send({ type: 'unlink' })) error = ''; else error = 'relay-unreachable';
        state.enabled = false;
        save();
        onChange();
        break;
      case 'phone-cancel-link':
        code = null;
        onChange();
        break;
      case 'phone-settings': {
        const before = relayAddr();
        if (typeof msg.enabled === 'boolean') state.enabled = msg.enabled;
        if (MODES.has(msg.mode)) state.mode = msg.mode;
        if (validRelay(msg.relay)) state.relay = msg.relay;
        save();
        if (relayAddr() !== before && !stopped) {
          disconnect();
          backoff = BACKOFF_MIN_MS;
          connect();
        }
        onChange();
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
