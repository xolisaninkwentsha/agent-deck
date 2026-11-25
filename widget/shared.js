// Shared by the panel (renderer.js) and the activity window (activity.js): loaded first, as a
// classic script, so these are plain globals for both. All text goes in with textContent, never as HTML.
'use strict';

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
      else if (k === 'style' && typeof v === 'string') el.setAttribute('style', v); // custom properties
      else if (k === 'style') Object.assign(el.style, v);
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`; if (s < 3600) return `${Math.round(s / 60)}m`; return `${Math.round(s / 3600)}h`;
};

// Bolt, the robot on every card. His state follows the session's; each session gets its own head
// tint so cards stay easy to tell apart. (Our own constant markup; nothing from a session goes in.)
const BOLT_SVG = `<svg viewBox="0 0 64 64" class="bolt" aria-hidden="true">
  <g class="fx-z"><text x="47" y="15">z</text><text x="53" y="9">z</text></g>
  <g class="smoke"><circle cx="45" cy="11" r="3"/><circle cx="49" cy="6.5" r="2.2"/><circle cx="52" cy="3" r="1.6"/></g>
  <line class="stalk" x1="32" y1="9" x2="32" y2="15"/><circle class="bulb" cx="32" cy="7" r="3.2"/>
  <rect class="bolt-ear" x="12.5" y="23" width="4" height="8" rx="1.5"/><rect class="bolt-ear" x="47.5" y="23" width="4" height="8" rx="1.5"/>
  <rect class="headbox" x="16" y="14" width="32" height="25" rx="8"/><rect class="screen" x="20" y="18.5" width="24" height="16" rx="4.5"/>
  <g class="eyes-open"><rect x="24.5" y="22.5" width="4.5" height="7" rx="2"/><rect x="35" y="22.5" width="4.5" height="7" rx="2"/></g>
  <g class="eyes-shut"><rect x="24" y="26" width="5.5" height="1.8" rx=".9"/><rect x="34.5" y="26" width="5.5" height="1.8" rx=".9"/></g>
  <text class="eyes-q" x="32" y="31">?</text>
  <g class="eyes-x"><path d="M24.5 23l5 5m0-5l-5 5M34.5 23l5 5m0-5l-5 5"/></g>
  <rect class="neck" x="28" y="39" width="8" height="3" rx="1"/><rect class="torso" x="19" y="42" width="26" height="18" rx="6"/>
  <g class="gear"><circle cx="32" cy="51" r="5"/><circle cx="32" cy="51" r="2"/></g>
  <path class="arm" d="M19 47q-6 3-6 9"/><g class="arm-right"><path class="arm" d="M45 47q6 3 6 9"/></g>
  <g class="wave"><path class="arm" d="M45 47q7-3 8-11"/><circle class="hand" cx="53" cy="35" r="2.6"/></g>
</svg>`;
const BOLT_TINTS = ['#c9d3e2', '#b9def2', '#c4e5d2', '#dcd0f2', '#f0d9bb', '#efc8d3', '#d3dfa6', '#bccdf5'];
const boltTint = (key) => { let x = 0; for (const ch of key) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return BOLT_TINTS[x % BOLT_TINTS.length]; };

function shortModel(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?/.exec(String(id || ''));
  if (!m) return String(id || '').slice(0, 18);
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}${/\[1m\]/i.test(id) ? ' 1M' : ''}`;
}

const count = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(n < 10000 ? 1 : 0)}k` : String(n));
