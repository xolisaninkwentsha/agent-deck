// The activity window: one session's main thread and its subagents as an outline, live.
// It asks the session's daemon (this machine's or another's) with {type:'watch-activity', key}
// and redraws on every {type:'activity'} it gets back. Text goes in with textContent only.
'use strict';

const ui = { params: null, ws: null, connected: false, data: null, sel: null, runningOnly: false, retry: 0, timer: null, planOpen: true, docOpen: false };

// Bolt's state for a subagent, and for the main session (whose status is a session status).
const AGENT_BOLT = { running: 'working', done: 'idle', stopped: 'stop' };
const MAIN_BOLT = { working: 'working', background: 'working', approval: 'needs', question: 'needs', error: 'error' };
const MAIN_ST = { working: ['running', 'working'], background: ['running', 'background'], approval: ['needs', 'needs you'], question: ['needs', 'question'], error: ['error', 'error'], idle: ['idle', 'your turn'], ended: ['idle', 'ended'] };
const ORDER = { running: 0, done: 1, stopped: 2 };

const span = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
const boltOf = (key, st) => h('div', { class: 'm', 'data-s': st, style: `--tint:${boltTint(key)}`, html: BOLT_SVG });

// ---------- connection ----------
window.activity.onInit((p) => {
  ui.params = p;
  document.title = `Activity · ${p.title}`;
  document.getElementById('a-name').textContent = p.title;
  connect();
  render();
});
function connect() {
  const p = ui.params;
  const url = p.token ? `${p.hubUrl}?token=${encodeURIComponent(p.token)}` : p.hubUrl;
  let ws;
  try { ws = new WebSocket(url); } catch { retry(); return; }
  ui.ws = ws;
  ws.onopen = () => { ui.connected = true; ui.retry = 0; ws.send(JSON.stringify({ type: 'watch-activity', key: p.key })); };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'activity' && m.key === p.key) { ui.data = m; render(); }
  };
  ws.onclose = () => { ui.connected = false; render(); retry(); };
  ws.onerror = () => {};
}
function retry() {
  ui.retry = Math.min(ui.retry + 1, 6);
  clearTimeout(ui.timer);
  ui.timer = setTimeout(connect, 500 * 2 ** ui.retry);
}

// ---------- the outline ----------
// Depth first from the main session; among siblings, running first, then the most recent.
function rows(d) {
  const kids = new Map();
  for (const a of d.agents) (kids.get(a.parent) || kids.set(a.parent, []).get(a.parent)).push(a);
  for (const list of kids.values()) list.sort((x, y) => ORDER[x.status] - ORDER[y.status] || y.lastAt - x.lastAt);
  // Agents whose parent isn't in the list (it dropped out of the most recent 60) hang off the main session.
  const ids = new Set(d.agents.map((a) => a.id));
  for (const a of d.agents) if (a.parent !== 'main' && !ids.has(a.parent)) (kids.get('main') || kids.set('main', []).get('main')).push(a);
  // "Running only": keep running agents and the ones that lead to them (every child is visited).
  const live = new Set();
  const markLive = (a) => {
    const childLive = (kids.get(a.id) || []).map(markLive).some(Boolean);
    const isLive = a.status === 'running' || childLive;
    if (isLive) live.add(a.id);
    return isLive;
  };
  (kids.get('main') || []).forEach(markLive);
  const out = [{ main: true, depth: 0, last: [true] }];
  const walk = (id, depth, last) => {
    const list = (kids.get(id) || []).filter((a) => !ui.runningOnly || live.has(a.id));
    list.forEach((a, i) => { const isLast = i === list.length - 1; out.push({ a, depth, last: [...last, isLast] }); walk(a.id, depth + 1, [...last, isLast]); });
  };
  walk('main', 1, [true]);
  return out;
}
const prefix = (depth, last) => (depth === 0 ? '' : last.slice(1, -1).map((l) => (l ? '   ' : '│  ')).join('') + (last[last.length - 1] ? '└─ ' : '├─ '));

function mainRow(d, row) {
  const m = d.main, [stClass, stText] = MAIN_ST[m.status] || ['idle', m.status];
  const sel = ui.sel === 'main';
  const tokens = m.tokensIn || m.tokensOut ? ` · ${count(m.tokensIn)} in · ${count(m.tokensOut)} out` : '';
  return [h('div', { class: 'o-row' + (sel ? ' sel' : ''), tabindex: '0', onclick: () => select('main'), onkeydown: keySelect('main') },
    h('span', { class: 'o-pre', text: prefix(row.depth, row.last) }), boltOf(d.key, MAIN_BOLT[m.status] || 'idle'),
    h('span', { class: 'o-what' }, h('b', { text: 'Main session' }), h('span', { class: 'sep', text: ' · ' }), m.step || ''),
    h('span', { class: `st ${stClass}`, text: stText }),
    h('span', {}), h('span', {}),
    h('span', { class: 'o-sub', text: `${shortModel(m.model)}${m.toolCount ? ` · ${m.toolCount} tools` : ''}${tokens}` })),
  sel ? detail({ model: m.model, tokensIn: m.tokensIn, tokensOut: m.tokensOut, toolCount: m.toolCount, topTools: m.topTools, steps: m.steps, lastText: m.lastText, status: m.status === 'idle' || m.status === 'ended' ? 'done' : 'running' }) : null];
}
function agentRow(a, row) {
  const sel = ui.sel === a.id, now = Date.now();
  const time = a.status === 'running' ? `⟳ ${span(now - a.startedAt)}` : a.status === 'done' ? `✓ ${span(a.lastAt - a.startedAt)}` : '◼ no end';
  return [h('div', { class: 'o-row' + (sel ? ' sel' : ''), tabindex: '0', onclick: () => select(a.id), onkeydown: keySelect(a.id), title: a.description },
    h('span', { class: 'o-pre', text: prefix(row.depth, row.last) }), boltOf(a.id, AGENT_BOLT[a.status] || 'idle'),
    h('span', { class: 'o-what' }, h('b', { text: a.type }), h('span', { class: 'sep', text: ' · ' }), a.description || 'subagent'),
    h('span', { class: `st ${a.status}`, text: time }),
    h('span', {}), h('span', {}),
    h('span', { class: 'o-sub', text: `${a.step}${a.toolCount ? ` · ${a.toolCount} tools` : ''}${a.tokensIn || a.tokensOut ? ` · ${count(a.tokensIn)} in · ${count(a.tokensOut)} out` : ''}` })),
  sel ? detail(a) : null];
}
function detail(a) {
  const tools = (a.topTools || []).map(([n, c]) => `${n} ${c}`).join(' · ');
  const parts = [h('div', { class: 'meta-line' },
    a.model ? h('span', { class: 'model', text: shortModel(a.model) }) : null,
    a.tokensIn || a.tokensOut ? h('span', { text: `${count(a.tokensIn)} in · ${count(a.tokensOut)} out` }) : null,
    a.toolCount ? h('span', { text: `${a.toolCount} tools${tools ? ': ' + tools : ''}` }) : null,
    a.background != null ? h('span', { text: a.background ? 'background' : 'foreground' }) : null)];
  if (a.status === 'stopped') parts.push(h('div', { class: 'd-sec k-stop' }, `Stopped: no end recorded. Last activity ${ago(a.lastAt)} ago.`));
  if (a.steps?.length) {
    parts.push(h('div', { class: 'd-sec k-steps' }, h('div', { class: 'd-head', text: 'Steps, newest first' }),
      h('div', { class: 'timeline' }, a.steps.map((x, i) => h('div', { class: 'd-row t-step ' + (i === 0 && a.status === 'running' ? 'now' : 'done'), title: i === 0 && a.status === 'running' ? 'In progress' : 'Done' },
        h('span', { class: 't-dot' }), h('span', { class: 'd-text', title: x.text, text: x.text }), h('span', { class: 'd-st', text: x.ts ? ago(x.ts) : '' }))))));
  }
  if (a.lastText) parts.push(h('div', { class: 'd-sec k-msg' }, h('div', { class: 'd-head', text: a.status === 'running' ? 'Latest message' : 'Last reply' }), h('div', { class: 'last-msg', text: a.lastText })));
  return h('div', { class: 'o-detail', onclick: (e) => e.stopPropagation() }, parts);
}
// The session's plan: its task list ticked off as it goes, and the latest plan document (folded).
const TASK_STATE = { completed: 'done', in_progress: 'now' };
function planSection(plan) {
  if (!plan) return null;
  const tasks = plan.tasks || [], done = tasks.filter((t) => t.status === 'completed').length;
  const head = h('div', { class: 'a-plan-head', onclick: () => { ui.planOpen = !ui.planOpen; render(); } },
    h('span', { class: 'd-head', text: 'Plan' }),
    tasks.length ? h('span', { class: 'a-plan-count', text: `${done} of ${tasks.length} done` }) : null,
    tasks.length ? h('span', { class: 'bar' }, h('span', { class: 'fill', style: { width: `${Math.round((done / tasks.length) * 100)}%` } })) : h('span', { class: 'spacer' }),
    h('span', { class: 'a-fold', text: ui.planOpen ? '▾' : '▸' }));
  if (!ui.planOpen) return h('section', { class: 'a-plan' }, head);
  const doc = plan.doc;
  const docLabel = doc ? `${{ approved: 'Approved', rejected: 'Rejected', proposed: 'Proposed' }[doc.state] || 'Plan'}${doc.at ? ` ${ago(doc.at)} ago` : ''}` : '';
  return h('section', { class: 'a-plan' }, head,
    tasks.length ? h('div', { class: 'timeline' }, tasks.map((t) => h('div', { class: `d-row t-step ${TASK_STATE[t.status] || ''}`, title: t.status.replace('_', ' ') },
      h('span', { class: 't-dot' }), h('span', { class: 'd-text', text: t.text })))) : null,
    doc && doc.text ? h('div', { class: 'a-doc' },
      h('button', { class: 'more', text: `${ui.docOpen ? 'Hide' : 'Show'} the plan document · ${docLabel}`, onclick: () => { ui.docOpen = !ui.docOpen; render(); } }),
      ui.docOpen ? h('div', { class: 'plan-doc full' }, planDoc(doc.text)) : null) : null);
}
function select(id) { ui.sel = ui.sel === id ? null : id; render(); }
const keySelect = (id) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(id); } };

function render() {
  const tree = document.getElementById('a-tree');
  const scrolled = tree.scrollTop;
  const d = ui.data;
  const counts = document.getElementById('a-counts');
  if (!d || d.gone) {
    counts.replaceChildren();
    tree.replaceChildren(h('div', { class: 'a-empty', text: d?.gone ? 'This session has ended.' : ui.connected ? 'Reading the session…' : 'Connecting to Modisa…' }));
    return;
  }
  const n = (st) => d.agents.filter((a) => a.status === st).length;
  counts.replaceChildren(...[h('span', { class: 'c-run', text: `${n('running')} running` }), h('span', { class: 'c-done', text: `${n('done')} done` }),
    n('stopped') ? h('span', { class: 'c-stop', text: `${n('stopped')} stopped` }) : null].filter(Boolean)); // replaceChildren would print "null"
  const list = rows(d);
  const out = [planSection(d.main.plan)];
  for (const row of list) out.push(...(row.main ? mainRow(d, row) : agentRow(row.a, row)));
  if (!d.agents.length) out.push(h('div', { class: 'a-empty', text: 'No subagents in this session yet. They appear here as soon as one starts.' }));
  else if (ui.runningOnly && list.length === 1) out.push(h('div', { class: 'a-empty', text: 'Nothing running right now.' }));
  tree.replaceChildren(...out.filter(Boolean));
  tree.scrollTop = scrolled;
}

document.getElementById('a-filter').addEventListener('click', (e) => {
  ui.runningOnly = !ui.runningOnly;
  e.currentTarget.setAttribute('aria-pressed', String(ui.runningOnly));
  render();
});
setInterval(() => { if (ui.data) render(); }, 5000); // elapsed times
render();
