// The daemon's phone client: one outgoing WebSocket to the relay, authenticated with a machine key.
// Links and unlinks a number, decides which held prompts go to the phone, and turns the relay's
// `decide` into a call back into the daemon. Logs never carry the key, prompt text or a full number.
//
// The link is up only while phone approvals can be in use: while a link is in progress (from
// phone-link until linked, cancelled, refused or the code's time is up) or while this machine is
// linked. An install that never links never contacts a relay.
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
const STABLE_MS = 30000; // the backoff resets only once a connection has stayed up this long
const REPLACED_BACKOFF_MS = 300000; // closed as "replaced" (4000): this key is in use on another computer
const LINK_WINDOW_MS = 630000; // a code is valid for 10 minutes; 30 s more for its reply to arrive
const REPLY_MS = 20000; // a prompt, link-start or unlink the relay hasn't answered by now has failed
const MIN_LEFT_MS = 60000; // a prompt with less than this left isn't sent
const AWAY_AFTER_MS = 120000; // a PermissionRequest unanswered this long counts as away
const PERMISSION_HOLD_MS = 570000; // a PermissionRequest hold extends to createdAt + this
const CLOSE_REPLACED = 4000;

const MODES = new Set(['away', 'everything']);
const BILLING = new Set(['off', 'trial', 'on']);
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

// Fields from the relay (or from phone.json, which holds the relay's last status) are checked
// before they're kept or shown.
const text = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const word = (v, fallback) => (typeof v === 'string' && /^[a-z0-9-]{1,40}$/i.test(v) ? v : fallback);
const money = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function cleanStatus(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  return {
    linked: s.linked === true,
    number: text(s.number, 32),
    balanceMicroUsd: money(s.balanceMicroUsd),
    billing: BILLING.has(s.billing) ? s.billing : null,
    botNumber: text(s.botNumber, 32),
  };
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
  relayUrl = process.env.MODISA_RELAY, WebSocketImpl = WebSocket, now = Date.now, version = '0.1.0',
  handshakeTimeout = 10000, awayAfterMs = AWAY_AFTER_MS,
  // Timings, injectable for tests.
  backoffMinMs = BACKOFF_MIN_MS, backoffMaxMs = BACKOFF_MAX_MS, stableMs = STABLE_MS,
  replacedBackoffMs = REPLACED_BACKOFF_MS, linkWindowMs = LINK_WINDOW_MS, replyMs = REPLY_MS,
}) {
  const file = path.join(home, 'phone.json');
  let state = null; // { key, relay, enabled, mode, lastStatus }
  let ws = null;
  let connected = false;
  let stopped = true;
  let backoff = backoffMinMs;
  let reconnectTimer = null;
  let pingTimer = null;
  let deadTimer = null;
  let stableTimer = null;
  let code = null;
  let error = '';
  let linking = null; // { number, sent } from phone-link until linked, cancelled, refused or timed out
  let linkTimer = null; // the end of the link window
  let linkReplyTimer = null; // no link-code for a sent link-start
  let unlinkTimer = null; // no unlinked status for a sent unlink
  let linkStartedAt = null; // when this machine last sent link-start (now())
  const sent = Object.create(null); // pendingId -> 'sent' | 'failed:<reason>'
  const inflight = new Set(); // sent to the relay, not yet confirmed or refused
  const replyTimers = new Map(); // pendingId -> timer: in flight with no prompt-sent/prompt-failed yet
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
      lastStatus: ok ? cleanStatus(s.lastStatus) : null, // its `linked` decides whether to connect
    };
    save();
  };

  const rawRelay = () => (state?.relay || relayUrl || DEFAULT_RELAY_URL || '');
  const relayAddr = () => cleanRelay(rawRelay()) ?? '';
  const relayBad = () => cleanRelay(rawRelay()) === null;
  const status = () => state?.lastStatus || {};
  const linkedNow = () => status().linked === true;
  const wanted = () => !stopped && Boolean(relayAddr()) && (linking !== null || linkedNow());

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

  // ---- the connection ----

  const clearTimers = () => {
    clearTimeout(reconnectTimer); reconnectTimer = null;
    clearInterval(pingTimer); pingTimer = null;
    clearTimeout(deadTimer); deadTimer = null;
    clearTimeout(stableTimer); stableTimer = null;
  };
  const armDead = () => {
    clearTimeout(deadTimer);
    deadTimer = setTimeout(() => { try { ws?.terminate(); } catch { /* already gone */ } }, DEAD_MS);
  };

  // In flight means "the relay owes us an answer"; a dropped connection re-sends instead.
  function settle(id) {
    clearTimeout(replyTimers.get(id));
    replyTimers.delete(id);
    inflight.delete(id);
  }
  function dropInflight() {
    for (const t of replyTimers.values()) clearTimeout(t);
    replyTimers.clear();
    inflight.clear(); // a reconnect re-sends; the relay dedupes
  }

  // The next try after the current backoff (which then doubles), or after `wait` if given.
  function scheduleReconnect(wait) {
    if (!wanted() || reconnectTimer) return;
    if (wait === undefined) {
      wait = backoff;
      backoff = Math.min(backoff * 2, backoffMaxMs);
    }
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
  }

  function connect() {
    if (ws || !wanted()) return;
    const url = relayAddr();
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
      if (error === 'relay-unreachable') error = '';
      log('phone: connected');
      send({ type: 'hello', machine: machineName, version });
      if (linking && !code) linking.sent = false; // its link-code went to a connection that's gone
      sendLinkStart();
      pingTimer = setInterval(() => { try { sock.send('ping'); } catch { /* closing */ } }, PING_MS);
      armDead();
      // Only a connection that stays up resets the backoff, so accept-then-close can't loop fast.
      stableTimer = setTimeout(() => {
        stableTimer = null;
        backoff = backoffMinMs;
        if (error === 'in-use-elsewhere') { error = ''; changed(); }
      }, stableMs);
      changed();
    });
    sock.on('message', (data) => {
      if (ws !== sock) return;
      armDead();
      const raw = data.toString();
      if (raw === 'pong') return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      try { onRelay(msg); } catch { log('phone: handler failed'); }
    });
    sock.on('error', () => { /* 'close' follows */ });
    sock.on('close', (closeCode) => {
      if (ws !== sock) return;
      ws = null;
      const was = connected;
      connected = false;
      clearInterval(pingTimer); pingTimer = null;
      clearTimeout(deadTimer); deadTimer = null;
      clearTimeout(stableTimer); stableTimer = null;
      dropInflight();
      if (was) log('phone: disconnected');
      if (closeCode === CLOSE_REPLACED) {
        // The relay keeps one connection per key: a newer one with this key took over.
        error = 'in-use-elsewhere';
        log('phone: this machine key is in use on another computer');
        changed();
        scheduleReconnect(replacedBackoffMs);
        return;
      }
      if (!was && linking && !error) error = 'relay-unreachable';
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
    dropInflight();
    if (sock) { try { sock.terminate(); } catch { /* already gone */ } }
    if (was) log('phone: disconnected');
  }

  // Connect when the link is wanted, drop it when it isn't.
  function sync() {
    if (wanted()) { if (!ws && !reconnectTimer) connect(); } else if (ws || reconnectTimer) { disconnect(); changed(); }
  }

  // ---- linking ----

  function endLinking() {
    clearTimeout(linkTimer); linkTimer = null;
    clearTimeout(linkReplyTimer); linkReplyTimer = null;
    linking = null;
  }
  function armLinkWindow() {
    clearTimeout(linkTimer);
    linkTimer = setTimeout(() => {
      linkTimer = null;
      linking = null;
      clearTimeout(linkReplyTimer); linkReplyTimer = null;
      log('phone: link window ended');
      changed();
      sync(); // the code (still shown, as expired) is no use now
    }, linkWindowMs);
  }
  function sendLinkStart() {
    if (!linking || linking.sent) return;
    if (!send({ type: 'link-start', number: linking.number })) return;
    linking.sent = true;
    linkStartedAt = now();
    clearTimeout(linkReplyTimer);
    linkReplyTimer = setTimeout(() => {
      linkReplyTimer = null;
      if (linking && !code && !error) { error = 'relay-unreachable'; changed(); }
    }, replyMs);
  }

  // The relay's answers about prompts carry the account's balance after the charge. True if it moved.
  function mergeBalance(msg) {
    const b = money(msg.balanceMicroUsd);
    if (b === null || !state.lastStatus?.linked || state.lastStatus.balanceMicroUsd === b) return false;
    state.lastStatus.balanceMicroUsd = b;
    save();
    return true;
  }

  function onRelay(msg) {
    switch (msg.type) {
      case 'status': {
        const st = cleanStatus(msg);
        const wasLinked = linkedNow();
        state.lastStatus = st;
        if (st.linked && !wasLinked) {
          // Approvals turn on by themselves only for a link this machine asked for just now.
          if (linkStartedAt !== null && now() - linkStartedAt <= LINK_WINDOW_MS) state.enabled = true;
          endLinking();
          code = null;
          error = '';
          log('phone: linked');
        }
        if (!st.linked) { clearTimeout(unlinkTimer); unlinkTimer = null; }
        save();
        changed();
        sync(); // unlinked, with no link in progress: the connection goes
        break;
      }
      case 'link-code': {
        const c = text(msg.code, 16);
        if (!c || !linking) break;
        // Never shown as valid for longer than this machine keeps the link up for it.
        const expiresAt = Math.min(money(msg.expiresAt) ?? Infinity, now() + 600000);
        code = { code: c, expiresAt, botNumber: text(msg.botNumber, 32) };
        error = '';
        clearTimeout(linkReplyTimer); linkReplyTimer = null;
        armLinkWindow(); // the code's 10 minutes start now
        changed();
        break;
      }
      case 'error':
        error = word(msg.reason, 'error');
        if (msg.op === 'link-start') { endLinking(); sync(); } // refused: this attempt is over
        changed();
        break;
      case 'prompt-sent': {
        const id = msg.pendingId;
        const moved = mergeBalance(msg);
        // In flight, or given up on for want of a reply (the phone has it after all).
        if (typeof id !== 'string' || !(inflight.has(id) || sent[id] === 'failed:no-reply')) { if (moved) changed(); break; }
        settle(id);
        sent[id] = 'sent';
        log('phone: prompt sent');
        if (events.get(id) === 'PermissionRequest') {
          try { extendHold(id); } catch { log('phone: extendHold failed'); }
        }
        changed();
        break;
      }
      case 'prompt-failed': {
        const id = msg.pendingId;
        const moved = mergeBalance(msg);
        // Also after prompt-sent: the next question couldn't be sent, or Meta reported it failed.
        if (typeof id !== 'string' || !(inflight.has(id) || Object.hasOwn(sent, id))) { if (moved) changed(); break; }
        settle(id);
        sent[id] = 'failed:' + word(msg.reason, 'unknown');
        log('phone: prompt failed');
        changed();
        break;
      }
      case 'decide': {
        const id = msg.pendingId;
        if (mergeBalance(msg)) changed();
        const ack = (ok, reason) => send(reason ? { type: 'decide-ack', pendingId: id, ok, reason } : { type: 'decide-ack', pendingId: id, ok });
        const known = typeof id === 'string' && (sent[id] === 'sent' || inflight.has(id));
        if (!state.enabled || !linkedNow() || !known) { ack(false, 'unknown'); break; }
        const decision = cleanDecision(msg.decision);
        if (!decision) { ack(false, 'bad-decision'); break; }
        let r;
        try { r = decide(id, decision); } catch { r = { ok: false, reason: 'error' }; }
        if (r?.ok) ack(true); else ack(false, word(r?.reason, 'error'));
        log('phone: decision received');
        break;
      }
      default:
        break;
    }
  }

  // ---- prompts ----

  const isApprover = (away) => Boolean(
    state && linkedNow() && state.enabled && connected && (state.mode === 'everything' || away),
  );

  // presenceActive: a panel says the machine it runs on is in use, so the user is at a computer
  // and the 2-minute rule doesn't apply. "Send everything" still sends: the user chose it.
  function consider(list, away, presenceActive = false) {
    if (!connected || !linkedNow() || !state.enabled) return;
    const t = now();
    for (const p of list) {
      if (Object.hasOwn(sent, p.id) || inflight.has(p.id)) continue;
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
        const id = p.id;
        inflight.add(id);
        events.set(id, p.hookEvent);
        // No prompt-sent or prompt-failed in time: count it as failed, so a held question goes
        // back to the terminal instead of waiting on a relay that has gone quiet.
        replyTimers.set(id, setTimeout(() => {
          replyTimers.delete(id);
          if (!inflight.delete(id)) return;
          sent[id] = 'failed:no-reply';
          log('phone: no reply from the relay for a prompt');
          changed();
        }, replyMs));
      }
    }
  }

  function closed(pendingId, why) {
    const known = Object.hasOwn(sent, pendingId) || inflight.has(pendingId);
    if (known) send({ type: 'prompt-closed', pendingId, why });
    settle(pendingId);
    delete sent[pendingId];
    events.delete(pendingId);
    if (known) changed();
  }

  // ---- the local panel ----

  function panelMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'phone-link': {
        const number = typeof msg.number === 'string' ? msg.number.trim() : '';
        if (!number || number.length > 40) { error = 'bad-number'; changed(); break; }
        if (stopped || !relayAddr()) { error = 'relay-unreachable'; changed(); break; }
        linking = { number, sent: false };
        code = null;
        error = '';
        armLinkWindow();
        if (connected) sendLinkStart();
        else if (!ws) { clearTimeout(reconnectTimer); reconnectTimer = null; backoff = backoffMinMs; connect(); } // the user is waiting: no backoff
        changed();
        break;
      }
      case 'phone-unlink':
        endLinking();
        if (send({ type: 'unlink' })) {
          error = '';
          // The relay answers with an unlinked status, which drops the connection. If it doesn't,
          // forget the link here anyway: the user asked to disconnect.
          clearTimeout(unlinkTimer);
          unlinkTimer = setTimeout(() => {
            unlinkTimer = null;
            if (!linkedNow()) return;
            state.lastStatus = { ...state.lastStatus, linked: false, number: null, balanceMicroUsd: null };
            save();
            changed();
            sync();
          }, replyMs);
        } else {
          error = 'relay-unreachable';
        }
        state.enabled = false;
        save();
        changed();
        break;
      case 'phone-cancel-link':
        endLinking();
        code = null;
        changed();
        sync();
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
          // A different relay means linking again; the old relay never sees the new key, and the
          // new one isn't contacted until a link starts.
          state.key = crypto.randomBytes(32).toString('base64url');
          state.lastStatus = null;
          state.enabled = false;
          code = null;
          endLinking();
          for (const k of Object.keys(sent)) delete sent[k];
          events.clear();
          disconnect();
          backoff = backoffMinMs;
          if (error === 'in-use-elsewhere') error = '';
        }
        save();
        changed();
        sync();
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
    backoff = backoffMinMs;
    sync();
  }

  function stop() {
    stopped = true;
    endLinking();
    clearTimeout(unlinkTimer); unlinkTimer = null;
    disconnect();
  }

  return { start, stop, view, isApprover, consider, closed, panelMessage };
}
