// Agent Deck panel UI. All text from sessions is inserted with textContent, never as HTML.
'use strict';

const STATUS_LABEL = {
  approval: 'Needs approval', question: 'Asks a question', working: 'Working',
  background: 'Background work', idle: 'Your turn', error: 'Error', ended: 'Ended',
};
const STATUS_ORDER = { approval: 0, question: 0, error: 1, working: 2, background: 3, idle: 4, ended: 5 };
const AVATAR_COLORS = ['#4f7cff', '#ff6fa8', '#ff9f43', '#a678ff', '#2ec4b6', '#ffd23f', '#5ad1ff', '#ff7a6b'];
const ICONS = {
  shieldOn: '<svg viewBox="0 0 16 16"><path d="M8 1.5 2.5 3.5v4c0 3.3 2.3 5.9 5.5 7 3.2-1.1 5.5-3.7 5.5-7v-4z" fill="currentColor"/></svg>',
  shieldOff: '<svg viewBox="0 0 16 16"><path d="M8 1.5 2.5 3.5v4c0 3.3 2.3 5.9 5.5 7 3.2-1.1 5.5-3.7 5.5-7v-4z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  up: '<svg viewBox="0 0 16 16"><path d="M3.5 10 8 5.5 12.5 10" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  down: '<svg viewBox="0 0 16 16"><path d="M3.5 6 8 10.5 12.5 6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6"/></svg>',
  jump: '<svg viewBox="0 0 16 16"><path d="M6 3h7v7M13 3 5 11M3 6v7h7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  gear: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
};

const state = {
  hubs: [],            // [{ name, url, token, local, ws, connected, sessions: [], retry }]
  approvals: true,
  collapsed: false,
  expanded: new Set(), // session keys with details open
  seenPending: new Set(),
  drafts: {},          // pendingId -> { answers: {question: [labels]}, other: {question: text} }
  composing: false,    // an input method (IME) is composing text in an answer box
  seen: new Map(),     // session key -> { status, since, pending } from the last snapshot
  seenAgents: new Map(), // agent key -> { status, waiting: Set(ids) } from the last snapshot
  notified: new Map(), // session key -> time of its last notification
  notifyAfter: 30,     // seconds of work before "Done, your turn" is worth a notification
  settingsOpen: false,
  cfg: {},             // panel settings from the main process (rendererConfig in main.cjs)
  hubDraft: { name: '', address: '', token: '', error: '' }, // the "Add a machine" form
  ts: { devices: [], pairing: {} }, // your Tailscale devices (Settings), and Connect requests in flight
  seenPairs: new Set(),  // pairing requests already notified
  pairBack: {},          // request id -> "also show its sessions here"
};

// ---------- settings ----------
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme; // System: follow the desktop
}
function applyConfig(cfg) {
  state.cfg = cfg;
  state.settingsDirty = true;
  state.notifyAfter = cfg.notifyAfterSeconds || 30;
  applyTheme(cfg.theme);
}
function saveSetting(patch) {
  window.deck.saveSettings(patch);
  applyConfig({ ...state.cfg, ...patch });
  render();
}
const prettyKey = (accel) => String(accel || '').replace(/Control|CommandOrControl|CmdOrCtrl/g, 'Ctrl');

function settingsView() {
  const c = state.cfg;
  const row = (label, hint, control) => h('div', { class: 'set-row' },
    h('div', { class: 'set-label' }, h('div', { text: label }), hint ? h('div', { class: 'set-hint', text: hint }) : null), control);
  const toggle = (on, onChange) => h('button', { class: 'switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(on), onclick: () => onChange(!on) }, h('span', { class: 'knob' }));
  const select = (value, options, onChange, unit = '') => {
    if (!options.some(([v]) => String(v) === String(value))) options = [[value, String(value) + unit], ...options]; // a value set by hand
    return h('select', {
      class: 'set-select',
      onchange: (e) => { const v = e.target.value; onChange(/^\d+$/.test(v) ? Number(v) : v); },
    }, options.map(([v, label]) => h('option', { value: String(v), text: label, selected: String(v) === String(value) })));
  };
  const linuxNoGnome = c.platform === 'linux' && c.shortcutVia !== 'gnome';
  return h('div', { class: 'settings' },
    row('Answer approvals and questions here', 'Off: the panel only watches', toggle(state.approvals, (v) => setApprovals(v, true))),
    row('Panel can answer for', 'The terminal shows the prompt meanwhile. This machine only.',
      select(c.holdSeconds, [[60, '1 min'], [120, '2 min'], [300, '5 min'], [540, '9 min']], (v) => saveSetting({ holdSeconds: v }), ' s')),
    row('Notifications', null, toggle(c.notifications !== false, (v) => saveSetting({ notifications: v }))),
    row('Notify "done" after', 'of work, so quick replies stay quiet',
      select(c.notifyAfterSeconds, [[10, '10 s'], [30, '30 s'], [60, '1 min'], [120, '2 min']], (v) => saveSetting({ notifyAfterSeconds: v }), ' s')),
    row('Context warning at', null, select(c.contextWarnPercent, [[70, '70%'], [80, '80%'], [90, '90%']], (v) => saveSetting({ contextWarnPercent: v }), '%')),
    row('Theme', null, select(c.theme || 'system', [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']], (v) => saveSetting({ theme: v }))),
    row('Show/hide shortcut', linuxNoGnome ? 'Run "agent-deck shortcut" so it works in every app' : null,
      h('span', { class: 'set-value', text: c.shortcut ? prettyKey(c.shortcut) + (c.shortcutVia === 'gnome' ? ' (GNOME)' : '') : 'none' })),
    ...machinesView(row));
}

// Other machines whose sessions and agents this panel shows ("hubs"), and how to share this one.
// The typed form lives in state.hubDraft, so a settings rebuild doesn't lose it.
const ADD_HUB_LINE = /^\s*(?:agent-deck\s+add-hub\s+)?([A-Za-z0-9._-]+)\s+(wss?:\/\/\S+)\s+(\S+)\s*$/;
function machinesView(row) {
  const d = state.hubDraft;
  const field = (key, placeholder) => h('input', {
    class: 'set-input', 'data-field': key, placeholder, value: d[key], spellcheck: 'false', autocomplete: 'off',
    oninput: (e) => {
      const line = ADD_HUB_LINE.exec(e.target.value); // the whole line from "agent-deck share" pasted anywhere
      if (line) {
        [d.name, d.address, d.token] = line.slice(1);
        for (const k of ['name', 'address', 'token']) document.querySelector(`.set-input[data-field="${k}"]`).value = d[k];
      } else d[key] = e.target.value;
    },
    onkeydown: (e) => { if (e.key === 'Enter') addMachine(); },
  });
  const remotes = state.hubs.filter((x) => !x.local);
  const shared = state.cfg.shareAddress;
  return [
    h('div', { class: 'section-head', text: 'Other machines' }),
    ...remotes.map((x) => row(x.name, `${x.url.replace(/\/ws$/, '')} · ${x.connected ? 'connected' : 'not connected'}`,
      h('button', { class: 'btn ghost', text: 'Remove', onclick: () => window.deck.removeHub(x.name) }))),
    ...tailscaleRows(row),
    h('div', { class: 'set-row add-hub' },
      h('div', { class: 'set-label' },
        h('div', { text: 'Add a machine' }),
        h('div', { class: 'set-hint', text: 'Paste the line "agent-deck share" printed on it, or fill in its name, address and token.' }),
        h('div', { class: 'add-fields' }, field('name', 'name'), field('address', 'address, e.g. 100.101.102.103'), field('token', 'token')),
        d.error ? h('div', { class: 'set-error', text: d.error }) : null),
      h('button', { class: 'btn allow', text: 'Add', onclick: addMachine })),
    h('div', { class: 'set-row' },
      h('div', { class: 'set-label' },
        h('div', { text: 'Share this machine' }),
        h('div', { class: 'set-hint', text: d.sharing ? 'Restarting Agent Deck\'s daemon…'
          : shared ? `Shared on ${shared}. Copy the line and paste it into the other panel's "Add a machine".`
            : 'Lets your other computers\' panels see this one, over Tailscale. Restarts the daemon: a prompt the panel is holding goes back to the terminal.' }),
        d.shareError ? h('div', { class: 'set-error', text: d.shareError }) : null),
      shared && !d.sharing ? h('button', { class: 'btn', text: d.copied ? 'Copied' : 'Copy line', onclick: () => copied(true) }) : null,
      h('button', { class: 'switch' + (shared ? ' on' : ''), role: 'switch', 'aria-checked': String(Boolean(shared)), disabled: d.sharing ? 'true' : null, onclick: () => share(!shared) },
        h('span', { class: 'knob' }))),
    ...allowedRows(row),
  ];
}
async function share(on) {
  const d = state.hubDraft;
  if (d.sharing) return;
  Object.assign(d, { sharing: true, shareError: '' });
  state.settingsDirty = true;
  render();
  const r = await window.deck.share(on);
  Object.assign(d, { sharing: false, shareError: r.ok ? '' : r.error });
  state.settingsDirty = true;
  render();
}
// ---------- pairing over Tailscale ----------
const localHub = () => state.hubs.find((x) => x.local);
// Your own Tailscale devices, found when Settings opens. Connect asks that machine; its panel answers.
async function loadDevices() {
  state.ts = { ...state.ts, loading: true, error: '' };
  state.settingsDirty = true; render();
  const r = await window.deck.tailscaleDevices();
  state.ts = { ...state.ts, loading: false, devices: r.ok ? r.devices : [], error: r.ok ? '' : r.error };
  state.settingsDirty = true; render();
}
async function pairWith(dev) {
  const letBack = Boolean(state.cfg.shareAddress && state.ts.letBack?.[dev.ip]); // you ticked "and let it see this one"
  state.ts.pairing = { ...state.ts.pairing, [dev.ip]: 'waiting' };
  state.settingsDirty = true; render();
  const r = await window.deck.pair(dev.ip, letBack);
  // Only what you ticked here: it accepted, so let it in (the daemon checks it with Tailscale).
  if (r.ok && r.back && letBack) send(localHub(), { type: 'allow-device', ip: dev.ip });
  state.ts.pairing = { ...state.ts.pairing, [dev.ip]: r.ok ? '' : r.error };
  if (r.ok) await loadDevices(); else { state.settingsDirty = true; render(); }
}
function tailscaleRows(row) {
  const t = state.ts;
  const rows = [h('div', { class: 'sub-head' }, h('span', { text: 'Your devices on Tailscale' }),
    h('button', { class: 'btn ghost small', text: t.loading ? 'Looking…' : 'Refresh', onclick: () => loadDevices() }))];
  if (t.error) return [...rows, h('div', { class: 'set-hint pad', text: t.error })];
  const devs = (t.devices || []);
  if (!devs.length && !t.loading) rows.push(h('div', { class: 'set-hint pad', text: 'No other devices of yours on this tailnet.' }));
  for (const d of devs) {
    const waiting = t.pairing?.[d.ip] === 'waiting', err = t.pairing?.[d.ip];
    const hint = !d.online ? 'offline'
      : d.added ? 'added'
        : waiting ? `waiting for Allow on ${d.dns}…`
          : d.agentDeck ? 'Agent Deck is shared there'
            : d.outdated ? 'Agent Deck there is older: git pull and restart it there'
              : 'Agent Deck not found: turn on "Share this machine" there';
    const connectable = d.online && d.agentDeck && !d.added && !waiting;
    rows.push(row(d.dns, err && err !== 'waiting' ? err : hint, connectable ? h('div', { class: 'connect' },
      // Offer the other way round only when you tick it (and this machine is shared, so it could connect).
      state.cfg.shareAddress ? h('label', { class: 'pair-back', title: `Also let ${d.dns} see this machine` },
        h('input', { type: 'checkbox', checked: t.letBack?.[d.ip] ? 'checked' : null, onchange: (e) => { t.letBack = { ...t.letBack, [d.ip]: e.target.checked }; } }), ' both ways') : null,
      h('button', { class: 'btn allow', text: 'Connect', onclick: () => pairWith(d) })) : null));
  }
  return rows;
}
// Machines allowed to see this one (paired). Remove disconnects them at once.
function allowedRows(row) {
  const devs = localHub()?.devices || [];
  if (!devs.length) return [];
  return [h('div', { class: 'sub-head' }, h('span', { text: 'Can see this machine' })),
    ...devs.map((d) => row(d.dns || d.name, `${d.login}${d.connected ? ' · connected now' : ''}`,
      h('button', { class: 'btn ghost', text: 'Remove', onclick: () => send(localHub(), { type: 'remove-device', id: d.id }) })))];
}
// Another of your machines asks to see this one: a card above everything, and a notification.
function notifyPairRequests(hub) {
  for (const r of hub.pairRequests) {
    if (state.seenPairs.has(r.id)) continue;
    state.seenPairs.add(r.id);
    window.deck.notify(`${r.name} wants to see this machine`, 'Open Agent Deck to allow or deny it.', {});
  }
}
// "Also show its sessions here" only when that machine is shared and not already in this panel
// (adding it again would replace a working entry, e.g. one with a token).
const canAddBack = (r) => r.shared && !state.hubs.some((x) => !x.local && x.url === `ws://${r.ip}:${r.port}/ws`);
function pairCards() {
  const hub = localHub();
  return (hub?.pairRequests || []).map((r) => {
    if (!(r.id in state.pairBack)) state.pairBack[r.id] = true;
    return h('div', { class: 'card pair' },
      h('div', { class: 'pair-title', text: `${r.name} wants to see this machine` }),
      h('div', { class: 'set-hint', text: `${r.login} on Tailscale. If you allow it, anything running on that device can see your sessions and agents here and answer their approvals and questions.` }),
      canAddBack(r) ? h('label', { class: 'pair-back' },
        h('input', { type: 'checkbox', checked: state.pairBack[r.id] ? 'checked' : null, onchange: (e) => { state.pairBack[r.id] = e.target.checked; } }),
        ` Also show ${r.dns}'s sessions here`) : null,
      h('div', { class: 'btns' },
        h('button', { class: 'btn allow', text: 'Allow', onclick: () => decidePair(r, true) }),
        h('button', { class: 'btn deny', text: 'Deny', onclick: () => decidePair(r, false) })));
  });
}
function decidePair(r, allow) {
  const back = allow && canAddBack(r) && state.pairBack[r.id];
  send(localHub(), { type: 'pair-decide', id: r.id, allow, back });
  if (back) window.deck.addHub(r.dns, `${r.ip}:${r.port}`, ''); // it allows this machine in return
}

function copied(yes) {
  if (yes) { window.deck.copyShareLine(); setTimeout(() => copied(false), 2000); }
  state.hubDraft.copied = yes;
  state.settingsDirty = true;
  render();
}
async function addMachine() {
  const d = state.hubDraft;
  const r = await window.deck.addHub(d.name, d.address, d.token);
  state.hubDraft = r.ok ? { name: '', address: '', token: '', error: '' } : { ...d, error: r.error };
  state.settingsDirty = true;
  render();
}

// ---------- tiny DOM helper ----------
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v; // only used with our own constant ICONS
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') Object.assign(el.style, v);
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const colorFor = (key) => { let x = 0; for (const ch of key) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return AVATAR_COLORS[x % AVATAR_COLORS.length]; };
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`; if (s < 3600) return `${Math.round(s / 60)}m`; return `${Math.round(s / 3600)}h`;
};

// ---------- connections ----------
function connect(hub) {
  const url = hub.token ? `${hub.url}?token=${encodeURIComponent(hub.token)}` : hub.url;
  let ws;
  try { ws = new WebSocket(url); } catch { scheduleReconnect(hub); return; }
  hub.ws = ws;
  ws.onopen = () => {
    hub.connected = true; hub.retry = 0;
    state.settingsDirty = true; // "connected" in Settings → Other machines
    ws.send(JSON.stringify({ type: 'hello', approvals: state.approvals }));
    render();
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot') {
      hub.sessions = msg.sessions || [];
      hub.agents = msg.agents || [];
      if (msg.host) hub.host = msg.host;
      if (hub.local) { // pairing requests and allowed devices come only from this machine's own daemon
        const sig = JSON.stringify(msg.devices || []);
        if (sig !== hub.devicesSig) { hub.devicesSig = sig; state.settingsDirty = true; }
        hub.devices = msg.devices || [];
        hub.pairRequests = msg.pairRequests || [];
        notifyPairRequests(hub);
      }
      notifyNewPending(hub);
      notifyAgents(hub); // before notifyChanges, which marks the hub primed
      notifyChanges(hub);
      render();
    }
  };
  ws.onclose = () => {
    if (hub.connected) state.settingsDirty = true;
    hub.connected = false; hub.sessions = []; hub.agents = []; hub.primed = false;
    render();
    if (!hub.removed) scheduleReconnect(hub);
  };
  ws.onerror = () => {};
}
function scheduleReconnect(hub) {
  hub.retry = Math.min((hub.retry || 0) + 1, 6);
  clearTimeout(hub.timer);
  hub.timer = setTimeout(() => connect(hub), 500 * 2 ** hub.retry);
}
function send(hub, msg) { if (hub.ws && hub.ws.readyState === 1) hub.ws.send(JSON.stringify(msg)); }

function setHubs(list) {
  const byUrl = new Map(state.hubs.map((x) => [x.url + '|' + x.token, x]));
  const next = [];
  for (const cfg of list) {
    const id = cfg.url + '|' + cfg.token;
    const existing = byUrl.get(id);
    if (existing) { existing.name = cfg.name; next.push(existing); byUrl.delete(id); }
    else { const hub = { ...cfg, sessions: [], connected: false }; next.push(hub); connect(hub); }
  }
  for (const gone of byUrl.values()) { gone.removed = true; clearTimeout(gone.timer); try { gone.ws.close(); } catch {} }
  state.hubs = next;
  render();
}

function notifyNewPending(hub) {
  for (const s of hub.sessions) {
    const p = s.pending;
    if (!p || state.seenPending.has(p.id)) continue;
    state.seenPending.add(p.id);
    const what = p.kind === 'question' ? (p.questions?.[0]?.question || 'Claude has a question') : `${p.title}: ${p.detail || ''}`;
    state.notified.set(s.key, Date.now());
    window.deck.notify(`${s.project}${hub.local ? '' : ' · ' + hub.name}`, what, { key: s.key, hubUrl: hub.url });
  }
}

// Service agents: notify when one stops responding, errors, or puts something new in front of you.
// A click on "needs you" opens the item's link (a Chat thread or email).
function notifyAgents(hub) {
  const now = Date.now();
  for (const a of hub.agents || []) {
    // An agent that turns up after the first snapshot is new: everything it has is news.
    const prev = state.seenAgents.get(a.key) || { status: null, waiting: new Set() };
    const ids = new Set(a.waiting.map((w) => w.id));
    state.seenAgents.set(a.key, { status: a.status, waiting: ids });
    if (!hub.primed) continue;
    let body = null, target = { key: a.key, hubUrl: hub.url };
    const fresh = a.waiting.filter((w) => !prev.waiting?.has(w.id));
    if (a.status === 'not_responding' && prev.status !== 'not_responding') body = `Isn't responding: no heartbeat for ${ago(a.lastHeartbeat)}`;
    else if (a.status === 'error' && prev.status !== 'error') body = a.lastError?.message || 'Stopped with an error';
    else if (fresh.length) { body = `Needs you: ${fresh[0].title}` + (fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''); target = { link: fresh[0].link }; }
    if (!body || now - (state.notified.get(a.key) || 0) < 10000) continue;
    state.notified.set(a.key, now);
    window.deck.notify(`${a.displayName}${hub.local ? '' : ' · ' + hub.name}`, body, target);
  }
}

// Notify when a session finishes a real stretch of work, needs you in the terminal, or errors.
// The first snapshot from a hub only records where things stand, so reconnecting is quiet.
function notifyChanges(hub) {
  const now = Date.now();
  for (const s of hub.sessions) {
    const prev = state.seen.get(s.key);
    if (!prev || prev.status !== s.status) state.seen.set(s.key, { status: s.status, since: now, pending: Boolean(s.pending) });
    else prev.pending = Boolean(s.pending);
    if (!hub.primed || !prev || prev.status === s.status) continue;
    let body = null;
    if (prev.status === 'working' && (s.status === 'idle' || s.status === 'background')) {
      if (now - prev.since >= state.notifyAfter * 1000) body = 'Done, your turn' + (s.lastMessage ? ': ' + s.lastMessage.slice(0, 140) : '');
    } else if ((s.status === 'approval' || s.status === 'question') && !s.pending && !prev.pending) {
      const what = String(s.step || '').replace(/^(question )?waiting in the terminal:?\s*/i, '').replace(/^needs approval in the terminal$/i, '');
      body = (s.status === 'question' ? 'Question for you in the terminal' : 'Needs your approval in the terminal') + (what ? `: ${what}` : '');
    } else if (s.status === 'error') {
      body = s.step || 'Stopped with an error';
    }
    if (!body || now - (state.notified.get(s.key) || 0) < 10000) continue;
    state.notified.set(s.key, now);
    const name = `${s.project}${s.title ? ' · ' + s.title : ''}${hub.local ? '' : ' · ' + hub.name}`;
    window.deck.notify(name, body, { key: s.key, hubUrl: hub.url });
  }
  hub.primed = true;
}

// ---------- actions ----------
const decide = (hub, pendingId, decision) => send(hub, { type: 'decide', pendingId, decision });
const release = (hub, pendingId) => send(hub, { type: 'release', pendingId });

function setApprovals(enabled, tellMain) {
  state.approvals = Boolean(enabled);
  state.settingsDirty = true;
  if (tellMain) window.deck.setApprovals(state.approvals);
  for (const hub of state.hubs) send(hub, { type: 'approvals', enabled: state.approvals });
  render();
}
const toggleApprovals = () => setApprovals(!state.approvals, true);

// ---------- rendering ----------
function allSessions() {
  const out = [];
  for (const hub of state.hubs) for (const s of hub.sessions) out.push({ hub, s });
  out.sort((a, b) => (STATUS_ORDER[a.s.status] ?? 9) - (STATUS_ORDER[b.s.status] ?? 9) || b.s.lastAt - a.s.lastAt);
  return out;
}

function avatar(s) {
  return h('div', { class: `avatar st-${s.status}`, style: { background: colorFor(s.key) } },
    h('span', { class: 'eye l' }), h('span', { class: 'eye r' }), h('span', { class: 'mouth' }));
}

const tokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);

// How full the session's context window is (amber from the warning threshold, red near full).
function contextMeter(c) {
  if (!c) return null;
  return h('span', {
    class: 'ctx' + (c.percent >= 95 ? ' full' : c.warn ? ' warn' : ''),
    title: `${tokens(c.used)} of ${tokens(c.window)} tokens in context${c.model ? ` (${c.model})` : ''}`,
  },
    h('span', { class: 'ctx-bar' }, h('span', { class: 'ctx-fill', style: { width: c.percent + '%' } })),
    h('span', { text: `ctx ${c.percent}%` }));
}

function progressRow(s) {
  const p = s.progress;
  const label = h('span', { class: `status st-${s.status}`, text: STATUS_LABEL[s.status] || s.status });
  const ctx = s.status === 'ended' ? null : contextMeter(s.context);
  if (!p || !p.total) return h('div', { class: 'meta' }, label, s.background.length ? h('span', { class: 'bg-count', text: `${s.background.length} in background` }) : null, ctx);
  const pct = Math.round((p.done / p.total) * 100);
  return h('div', { class: 'meta' },
    h('span', { class: 'frac', text: `${p.done}/${p.total}` }), label,
    h('span', { class: 'bar' }, h('span', { class: 'fill', style: { width: pct + '%' } })), ctx);
}

function approvalBox(hub, s, p) {
  const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
  return h('div', { class: 'pending', onclick: (e) => e.stopPropagation() },
    h('div', { class: 'p-title', text: p.title }),
    p.detail ? h('pre', { class: 'p-detail', text: p.detail }) : null,
    h('div', { class: 'btns' },
      h('button', { class: 'btn allow', text: 'Allow', onclick: () => decide(hub, p.id, { behavior: 'allow' }) }),
      p.canAlways ? h('button', { class: 'btn', text: 'Always', title: 'Allow and stop asking for this', onclick: () => decide(hub, p.id, { behavior: 'allow', always: true }) }) : null,
      h('button', { class: 'btn deny', text: 'Deny', onclick: () => decide(hub, p.id, { behavior: 'deny' }) }),
      h('button', { class: 'btn ghost', text: 'Terminal', title: 'Answer in the terminal instead', onclick: () => release(hub, p.id) })),
    h('div', { class: 'countdown', 'data-expires': p.expiresAt, text: countdownText(left) }));
}
// Claude Code shows the prompt in the terminal too; after this the panel can no longer answer.
const countdownText = (left) => `Answer here or in the terminal · ${left >= 60 ? Math.ceil(left / 60) + ' min' : left + 's'} left here`;

function questionBox(hub, s, p) {
  const draft = state.drafts[p.id] || (state.drafts[p.id] = { answers: {}, other: {} });
  const qs = p.questions || [];
  const single = qs.length === 1 && !qs[0].multiSelect;
  const complete = () => qs.every((q) => (draft.answers[q.question] || []).length || (draft.other[q.question] || '').trim());
  const submit = () => {
    const answers = {};
    for (const q of qs) {
      const other = (draft.other[q.question] || '').trim();
      answers[q.question] = other || (draft.answers[q.question] || []).join(', ');
    }
    decide(hub, p.id, { answers });
  };
  const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
  return h('div', { class: 'pending', onclick: (e) => e.stopPropagation() },
    qs.map((q) => h('div', { class: 'question' },
      q.header ? h('span', { class: 'chip', text: q.header }) : null,
      h('div', { class: 'q-text', text: q.question }),
      h('div', { class: 'options' }, q.options.map((o) => {
        const chosen = (draft.answers[q.question] || []).includes(o.label);
        return h('button', {
          class: 'opt' + (chosen ? ' chosen' : ''), title: o.description || '', text: o.label,
          onclick: () => {
            const cur = draft.answers[q.question] || [];
            draft.answers[q.question] = q.multiSelect ? (chosen ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label];
            draft.other[q.question] = '';
            if (single) submit(); else render();
          },
        });
      })),
      h('input', {
        class: 'other', placeholder: 'Or type an answer…', value: draft.other[q.question] || '',
        'data-key': `${p.id}|${q.question}`,
        oninput: (e) => { draft.other[q.question] = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing && complete()) submit(); },
        oncompositionstart: () => { state.composing = true; },
        oncompositionend: () => { state.composing = false; render(); },
      }))),
    h('div', { class: 'btns' },
      single ? null : h('button', { class: 'btn allow', text: 'Send', onclick: () => complete() && submit() }),
      h('button', { class: 'btn ghost', text: 'Terminal', title: 'Answer in the terminal instead', onclick: () => release(hub, p.id) })),
    h('div', { class: 'countdown', 'data-expires': p.expiresAt, text: countdownText(left) }));
}

function details(s) {
  const rows = [];
  if (s.lastMessage) rows.push(h('div', { class: 'last-msg', text: s.lastMessage }));
  if (s.background.length) {
    rows.push(h('div', { class: 'd-head', text: 'Background' }));
    for (const b of s.background) rows.push(h('div', { class: 'd-row' }, h('span', { class: 'd-type', text: b.type }), h('span', { class: 'd-text', text: b.command || b.description || b.id }), h('span', { class: 'd-st', text: b.status })));
  }
  if (s.subagents.length) {
    rows.push(h('div', { class: 'd-head', text: 'Subagents' }));
    for (const a of s.subagents) rows.push(h('div', { class: 'd-row' }, h('span', { class: 'd-type', text: 'agent' }), h('span', { class: 'd-text', text: a.type }), h('span', { class: 'd-st', text: ago(a.startedAt) })));
  }
  if (s.steps.length) {
    rows.push(h('div', { class: 'd-head', text: 'Steps' }));
    for (const st of s.steps.slice(-8).reverse()) rows.push(h('div', { class: 'd-row' }, h('span', { class: 'd-text', text: st.text }), h('span', { class: 'd-st', text: ago(st.ts) })));
  }
  rows.push(h('div', { class: 'd-cwd', text: s.cwd }));
  return h('div', { class: 'details' }, rows);
}

// Claude Code's permission mode, when it isn't the default (Shift+Tab in the session changes it).
const MODES = {
  acceptEdits: ['accept edits', 'Accept edits: file edits run without asking; commands still ask'],
  plan: ['plan', 'Plan mode: Claude plans and asks before making changes'],
  auto: ['auto', 'Auto mode: Claude Code decides which actions need your approval'],
  bypassPermissions: ['bypass', 'Bypass permissions: Claude Code won\'t ask before running tools'],
  dontAsk: ['don\'t ask', 'Don\'t ask: tools that would need approval are refused instead'],
};
function modeBadge(mode) {
  if (!mode || mode === 'default') return null;
  const [label, title] = MODES[mode] || [mode, `Permission mode: ${mode}`];
  return h('span', { class: 'mode' + (mode === 'bypassPermissions' ? ' bypass' : ''), text: label, title });
}

function card({ hub, s }) {
  const open = state.expanded.has(s.key);
  const multi = state.hubs.length > 1;
  const name = s.title ? `${s.project} · ${s.title}` : s.project;
  const attention = s.pending || s.status === 'approval' || s.status === 'question';
  return h('div', {
    class: `card st-${s.status}${attention ? ' attention' : ''}${open ? ' open' : ''}`,
    onclick: () => { open ? state.expanded.delete(s.key) : state.expanded.add(s.key); render(); },
  },
    h('div', { class: 'row' },
      avatar(s),
      h('div', { class: 'body' },
        h('div', { class: 'name', title: name, text: name }),
        h('div', { class: 'step', title: s.step, text: s.step }),
        progressRow(s)),
      h('div', { class: 'side' },
        multi ? h('span', { class: 'host', text: hub.name }) : null,
        s.watchOnly ? h('span', { class: 'watch', text: 'watch only', title: 'Started before Agent Deck\'s hooks were installed. Restart the session to answer from here.' }) : null,
        modeBadge(s.permissionMode),
        h('div', { class: 'side-btns' },
          hub.local && s.canJump ? h('button', { class: 'icon small', title: 'Jump to this session', html: ICONS.jump, onclick: (e) => { e.stopPropagation(); send(hub, { type: 'jump', key: s.key }); } }) : null,
          h('button', { class: 'icon small', title: 'Hide this card', html: ICONS.close, onclick: (e) => { e.stopPropagation(); send(hub, { type: 'dismiss', key: s.key }); } })))),
    s.pending && s.pending.kind === 'question' ? questionBox(hub, s, s.pending) : null,
    s.pending && s.pending.kind !== 'question' ? approvalBox(hub, s, s.pending) : null,
    open ? details(s) : null);
}

// ---------- service agents ----------
const AGENT_LABEL = { idle: 'Idle', working: 'Working', waiting: 'Waiting on you', error: 'Error', not_responding: 'Not responding' };
const AGENT_DOT = { working: 'st-working', waiting: 'st-approval', error: 'st-error', not_responding: 'st-error', idle: 'st-idle' };
function allAgents() {
  const out = [];
  for (const hub of state.hubs) for (const a of hub.agents || []) out.push({ hub, a });
  return out.sort((x, y) => x.a.displayName.localeCompare(y.a.displayName));
}
const span = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
function when(ts) {
  const d = new Date(ts), now = new Date();
  const hm = d.toTimeString().slice(0, 5);
  const day = d.toDateString() === now.toDateString() ? '' : d.getTime() - now.getTime() < 6 * 86400000 ? d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ';
  return `${day}${hm} (in ${span(ts - now.getTime())})`;
}
function agentLine(a) {
  if (a.status === 'not_responding') return `No heartbeat for ${ago(a.lastHeartbeat)} (expected every ${span(a.heartbeat * 1000)})`;
  if (a.status === 'error' && a.lastError) return a.lastError.message;
  if (a.job) return a.job.job + (a.step ? ` · ${a.step}` : a.job.detail ? ` · ${a.job.detail}` : '') + (a.jobsRunning > 1 ? ` (+${a.jobsRunning - 1})` : '');
  if (a.nextJob) return `Idle · next: ${a.nextJob.job} ${when(a.nextJob.nextRun)}`;
  return a.step || a.description || 'Idle';
}
function agentDetails(a) {
  const rows = [];
  const openLink = (link) => (e) => { e.preventDefault(); e.stopPropagation(); window.deck.openLink(link); };
  if (a.description) rows.push(h('div', { class: 'last-msg', text: a.description }));
  if (a.waiting.length) {
    rows.push(h('div', { class: 'd-head', text: 'Waiting on you (answer in Chat)' }));
    for (const w of a.waiting) {
      rows.push(h('div', { class: 'd-row' },
        w.link ? h('a', { class: 'd-text link', href: '#', title: w.link, text: w.title, onclick: openLink(w.link) }) : h('span', { class: 'd-text', text: w.title }),
        h('span', { class: 'd-st', text: ago(w.at) })));
    }
  }
  if (a.recent.length) {
    rows.push(h('div', { class: 'd-head', text: 'Recent jobs' }));
    for (const j of a.recent.slice(0, 6)) {
      rows.push(h('div', { class: 'd-row' },
        h('span', { class: 'd-type' + (j.result === 'ok' ? '' : ' bad'), text: j.result === 'ok' ? '✓' : '✗' }),
        h('span', { class: 'd-text', title: j.summary, text: j.job + (j.summary ? ` · ${j.summary}` : '') }),
        h('span', { class: 'd-st', text: ago(j.at) + (j.durationMs != null ? ` · ${span(j.durationMs)}` : '') })));
    }
  }
  if (a.tokensToday && a.tokensToday.total) {
    const t = a.tokensToday;
    rows.push(h('div', { class: 'd-head', text: 'Tokens today' }));
    rows.push(h('div', { class: 'd-row' }, h('span', { class: 'd-text', text: `${t.total.toLocaleString()} (in ${t.input.toLocaleString()} · out ${t.output.toLocaleString()})` })));
    for (const [model, n] of t.models.slice(0, 4)) rows.push(h('div', { class: 'd-row' }, h('span', { class: 'd-text', text: model }), h('span', { class: 'd-st', text: n.toLocaleString() })));
  }
  if (a.errors && a.errors.length) {
    rows.push(h('div', { class: 'd-head', text: 'Last errors' }));
    for (const e of a.errors) rows.push(h('div', { class: 'd-row' }, h('span', { class: 'd-text bad', text: e.type + (e.job ? ` · ${e.job}` : '') }), h('span', { class: 'd-st', text: ago(e.at) })));
    if (a.crashLoop && a.lastError) rows.push(h('div', { class: 'd-row' }, h('span', { class: 'd-text bad', text: a.lastError.message })));
  } else if (a.lastError) {
    rows.push(h('div', { class: 'd-head', text: 'Last error' }));
    rows.push(h('div', { class: 'd-row' }, h('span', { class: 'd-text bad', title: a.lastError.message, text: a.lastError.message }), h('span', { class: 'd-st', text: ago(a.lastError.at) })));
  }
  if (a.schedule.length) {
    rows.push(h('div', { class: 'd-head', text: 'Schedule' }));
    for (const s of a.schedule.slice(0, 6)) rows.push(h('div', { class: 'd-row' }, h('span', { class: 'd-text', text: s.job }), h('span', { class: 'd-st', text: when(s.nextRun) })));
  }
  const restarts = a.restarts ? ` · restarted ${a.restarts}× (last ${ago(a.startedAt)} ago)` : '';
  rows.push(h('div', { class: 'd-cwd', text: (a.heartbeat ? `Heartbeat every ${span(a.heartbeat * 1000)}, last ${ago(a.lastHeartbeat)} ago` : `Last heard from ${ago(a.lastSeen)} ago`) + restarts }));
  return h('div', { class: 'details' }, rows);
}
function agentCard({ hub, a }) {
  const open = state.expanded.has(a.key);
  const attention = a.status === 'waiting' || a.status === 'error' || a.status === 'not_responding';
  const last = a.lastJob ? h('span', { class: 'ag-last', title: a.lastJob.summary, text: `last: ${a.lastJob.job} ${a.lastJob.result === 'ok' ? '✓' : '✗'} ${ago(a.lastJob.at)}` }) : null;
  return h('div', {
    class: `card agent ag-${a.status}${attention ? ' attention' : ''}${open ? ' open' : ''}`,
    onclick: () => { open ? state.expanded.delete(a.key) : state.expanded.add(a.key); render(); },
  },
    h('div', { class: 'row' },
      h('div', { class: `avatar bot ag-${a.status}`, style: { background: colorFor(a.key) } }, h('span', { class: 'eye l' }), h('span', { class: 'eye r' }), h('span', { class: 'mouth' })),
      h('div', { class: 'body' },
        h('div', { class: 'name', title: a.displayName, text: a.displayName }),
        h('div', { class: 'step', title: agentLine(a), text: agentLine(a) }),
        h('div', { class: 'meta' },
          h('span', { class: `status ag-${a.status}`, text: (AGENT_LABEL[a.status] || a.status) + (a.status === 'waiting' ? ` · ${a.waiting.length}` : '') }),
          a.waiting.length && a.status !== 'waiting' ? h('span', { class: 'ag-wait', text: `${a.waiting.length} waiting` }) : null,
          last)),
      h('div', { class: 'side' },
        state.hubs.length > 1 ? h('span', { class: 'host', text: hub.name }) : null,
        a.source === 'otlp' ? h('span', { class: 'watch', text: 'OTLP', title: 'Reports through OpenTelemetry' }) : null,
        h('div', { class: 'side-btns' },
          h('button', { class: 'icon small', title: 'Hide this agent until it reports again', html: ICONS.close, onclick: (e) => { e.stopPropagation(); send(hub, { type: 'dismiss-agent', key: a.key }); } })))),
    open ? agentDetails(a) : null);
}

function render() {
  // Rebuilding the list replaces the answer boxes. Typed text survives in state.drafts;
  // remember which box had focus (and the caret) so it can be put back afterwards.
  // Only an in-progress IME composition defers the rebuild (compositionend re-renders).
  const focused = document.activeElement;
  const focusKey = focused && focused.classList.contains('other') ? focused.dataset.key : null;
  const focusField = focused && focused.classList.contains('set-input') ? focused.dataset.field : null;
  const caret = focusKey || focusField ? [focused.selectionStart, focused.selectionEnd] : null;
  const items = allSessions();
  const active = items.filter((x) => x.s.status !== 'ended');
  const agentItems = allAgents();
  const needs = items.filter((x) => x.s.pending || x.s.status === 'approval' || x.s.status === 'question').length
    + agentItems.filter(({ a }) => a.status === 'waiting' || a.status === 'error' || a.status === 'not_responding').length;

  document.getElementById('count').textContent = active.length ? String(active.length) : '';
  const live = document.getElementById('live-dot');
  live.className = 'live-dot' + (needs ? ' needs' : active.some((x) => x.s.status === 'working') ? ' busy' : '');
  const approvalsBtn = document.getElementById('btn-approvals');
  approvalsBtn.innerHTML = state.approvals ? ICONS.shieldOn : ICONS.shieldOff;
  approvalsBtn.title = state.approvals ? 'Approvals and questions come here first (click to send them to the terminal only)' : 'Approvals go to the terminal only (click to answer them here)';
  approvalsBtn.classList.toggle('on', state.approvals);
  document.getElementById('btn-collapse').innerHTML = state.collapsed ? ICONS.down : ICONS.up;
  const gear = document.getElementById('btn-settings');
  gear.innerHTML = ICONS.gear;
  gear.classList.toggle('on', state.settingsOpen);
  gear.title = state.settingsOpen ? 'Back to sessions' : 'Settings';

  const dots = document.getElementById('dots');
  dots.replaceChildren(...(state.collapsed ? [
    ...items.map(({ s }) => h('span', { class: `mini st-${s.status}`, title: `${s.project}: ${s.step}` })),
    ...agentItems.map(({ a }) => h('span', { class: `mini square ${AGENT_DOT[a.status] || ''}`, title: `${a.displayName}: ${agentLine(a)}` })),
  ] : []));

  if (!state.composing) {
    const list = document.getElementById('list');
    list.hidden = state.collapsed;
    if (state.settingsOpen) {
      // Rebuild only when a setting changed: a snapshot re-render would close an open dropdown.
      if (state.settingsDirty || !list.querySelector('.settings')) {
        list.replaceChildren(settingsView());
        const again = focusField && list.querySelector(`.set-input[data-field="${focusField}"]`);
        if (again) { again.focus(); try { again.setSelectionRange(caret[0], caret[1]); } catch {} }
      }
      state.settingsDirty = false;
    } else {
      const anyConnected = state.hubs.some((x) => x.connected);
      const sessionsPart = items.length ? items.map(card) : [h('div', { class: 'empty' },
        anyConnected ? 'No Claude Code sessions yet.' : 'Connecting to the Agent Deck daemon…',
        h('div', { class: 'hint', text: anyConnected ? 'Start one with "claude"; running sessions show up within a few seconds.' : 'Run "agent-deck start" if this doesn\'t clear.' }))];
      // Service agents get their own section below the Claude Code sessions.
      const agentsPart = agentItems.length ? [h('div', { class: 'section-head', text: 'Agents' }), ...agentItems.map(agentCard)] : [];
      list.replaceChildren(...sessionsPart, ...agentsPart);
    }
    // Put focus back only if that question is still open; an answered one is gone.
    const again = focusKey && [...list.querySelectorAll('input.other')].find((el) => el.dataset.key === focusKey);
    if (again) { again.focus(); try { again.setSelectionRange(caret[0], caret[1]); } catch {} }
  }

  document.getElementById('requests').replaceChildren(...pairCards());

  const footer = document.getElementById('hubs');
  footer.hidden = state.collapsed || state.hubs.length < 2;
  footer.replaceChildren(...state.hubs.map((x) => h('span', { class: 'hub' + (x.connected ? ' up' : ''), title: x.url, text: x.name })));

  requestAnimationFrame(() => window.deck.resize(document.body.scrollHeight));
}

// Countdowns and "ago" labels tick without a full re-render.
setInterval(() => {
  for (const el of document.querySelectorAll('.countdown')) {
    const left = Math.max(0, Math.round((Number(el.dataset.expires) - Date.now()) / 1000));
    el.textContent = countdownText(left);
  }
}, 1000);

// ---------- startup ----------
document.getElementById('btn-approvals').addEventListener('click', toggleApprovals);
document.getElementById('btn-collapse').addEventListener('click', () => { state.collapsed = !state.collapsed; render(); });
document.getElementById('btn-close').innerHTML = ICONS.close;
document.getElementById('btn-close').title = 'Quit Agent Deck (to only hide it: Ctrl+Alt+A or the tray icon)';
document.getElementById('btn-close').addEventListener('click', () => window.deck.quit());
// Esc collapses the panel (leaving an answer box first if one has focus).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.activeElement?.classList.contains('other')) { document.activeElement.blur(); return; }
  if (state.settingsOpen) state.settingsOpen = false; else state.collapsed = true;
  render();
});
document.getElementById('btn-settings').addEventListener('click', () => {
  state.settingsOpen = !state.settingsOpen;
  if (state.settingsOpen) state.collapsed = false;
  render();
  if (state.settingsOpen) loadDevices();
});
window.deck.onApprovals((enabled) => setApprovals(enabled, false));
// A notification was clicked: open the agent item's link, or jump to the session (this machine only).
window.deck.onJump((target) => {
  if (target?.link) { window.deck.openLink(target.link); return; }
  const hub = state.hubs.find((x) => x.url === target?.hubUrl);
  if (hub && hub.local) send(hub, { type: 'jump', key: target.key });
});

window.deck.config().then((cfg) => {
  state.approvals = cfg.approvalsInWidget;
  applyConfig(cfg);
  document.body.classList.add('os-' + cfg.platform);
  setHubs(cfg.hubs);
});
window.deck.onConfigChanged((cfg) => { applyConfig(cfg); setHubs(cfg.hubs); });
render();
