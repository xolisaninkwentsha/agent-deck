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
  notified: new Map(), // session key -> time of its last notification
  notifyAfter: 30,     // seconds of work before "Done, your turn" is worth a notification
};

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
    ws.send(JSON.stringify({ type: 'hello', approvals: state.approvals }));
    render();
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot') {
      hub.sessions = msg.sessions || [];
      if (msg.host) hub.host = msg.host;
      notifyNewPending(hub);
      notifyChanges(hub);
      render();
    }
  };
  ws.onclose = () => {
    hub.connected = false; hub.sessions = []; hub.primed = false;
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
        h('div', { class: 'side-btns' },
          hub.local && s.canJump ? h('button', { class: 'icon small', title: 'Jump to this session', html: ICONS.jump, onclick: (e) => { e.stopPropagation(); send(hub, { type: 'jump', key: s.key }); } }) : null,
          h('button', { class: 'icon small', title: 'Hide this card', html: ICONS.close, onclick: (e) => { e.stopPropagation(); send(hub, { type: 'dismiss', key: s.key }); } })))),
    s.pending && s.pending.kind === 'question' ? questionBox(hub, s, s.pending) : null,
    s.pending && s.pending.kind !== 'question' ? approvalBox(hub, s, s.pending) : null,
    open ? details(s) : null);
}

function render() {
  // Rebuilding the list replaces the answer boxes. Typed text survives in state.drafts;
  // remember which box had focus (and the caret) so it can be put back afterwards.
  // Only an in-progress IME composition defers the rebuild (compositionend re-renders).
  const focused = document.activeElement;
  const focusKey = focused && focused.classList.contains('other') ? focused.dataset.key : null;
  const caret = focusKey ? [focused.selectionStart, focused.selectionEnd] : null;
  const items = allSessions();
  const active = items.filter((x) => x.s.status !== 'ended');
  const needs = items.filter((x) => x.s.pending || x.s.status === 'approval' || x.s.status === 'question').length;

  document.getElementById('count').textContent = active.length ? String(active.length) : '';
  const live = document.getElementById('live-dot');
  live.className = 'live-dot' + (needs ? ' needs' : active.some((x) => x.s.status === 'working') ? ' busy' : '');
  const approvalsBtn = document.getElementById('btn-approvals');
  approvalsBtn.innerHTML = state.approvals ? ICONS.shieldOn : ICONS.shieldOff;
  approvalsBtn.title = state.approvals ? 'Approvals and questions come here first (click to send them to the terminal only)' : 'Approvals go to the terminal only (click to answer them here)';
  approvalsBtn.classList.toggle('on', state.approvals);
  document.getElementById('btn-collapse').innerHTML = state.collapsed ? ICONS.down : ICONS.up;

  const dots = document.getElementById('dots');
  dots.replaceChildren(...(state.collapsed ? items.map(({ s }) => h('span', { class: `mini st-${s.status}`, title: `${s.project}: ${s.step}` })) : []));

  if (!state.composing) {
    const list = document.getElementById('list');
    list.hidden = state.collapsed;
    if (!items.length) {
      const anyConnected = state.hubs.some((x) => x.connected);
      list.replaceChildren(h('div', { class: 'empty' },
        anyConnected ? 'No Claude Code sessions yet.' : 'Connecting to the Agent Deck daemon…',
        h('div', { class: 'hint', text: anyConnected ? 'Start one with "claude"; running sessions show up within a few seconds.' : 'Run "agent-deck start" if this doesn\'t clear.' })));
    } else {
      list.replaceChildren(...items.map(card));
    }
    // Put focus back only if that question is still open; an answered one is gone.
    const again = focusKey && [...list.querySelectorAll('input.other')].find((el) => el.dataset.key === focusKey);
    if (again) { again.focus(); try { again.setSelectionRange(caret[0], caret[1]); } catch {} }
  }

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
  state.collapsed = true;
  render();
});
window.deck.onApprovals((enabled) => setApprovals(enabled, false));
// A notification was clicked: jump to that session (this machine's sessions only).
window.deck.onJump((target) => {
  const hub = state.hubs.find((x) => x.url === target?.hubUrl);
  if (hub && hub.local) send(hub, { type: 'jump', key: target.key });
});

window.deck.config().then((cfg) => {
  state.approvals = cfg.approvalsInWidget;
  state.notifyAfter = cfg.notifyAfterSeconds || 30;
  document.body.classList.add('os-' + cfg.platform);
  setHubs(cfg.hubs);
});
window.deck.onConfigChanged((cfg) => setHubs(cfg.hubs));
render();
