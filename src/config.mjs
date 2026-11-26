// Shared configuration for the daemon, hook script and widget.
// Everything lives in ~/.modisa/ (override with MODISA_HOME).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveHome } from './legacy.mjs';

export const HOME = resolveHome();
export const CONFIG_PATH = path.join(HOME, 'config.json');
export const STATE_PATH = path.join(HOME, 'state.json');
export const LOG_PATH = path.join(HOME, 'daemon.log');
export const PID_PATH = path.join(HOME, 'daemon.pid');

export const DEFAULTS = {
  // Port the daemon listens on. Hooks always talk to 127.0.0.1:<port>.
  port: 47615,
  // Interface the daemon binds to. Keep 127.0.0.1 unless another machine's
  // widget should connect (then use your Tailscale/LAN IP or 0.0.0.0 and set a token).
  bind: '127.0.0.1',
  // Shared secret that remote widgets must present. Required when bind is not loopback.
  token: null,
  // How long the panel can answer a permission request or question. Claude Code shows the
  // same prompt in the terminal meanwhile; after this only the terminal can answer. Max 570.
  holdSeconds: 300,
  // Name shown on this machine's cards. Defaults to the hostname.
  name: null,
  // OpenTelemetry receiver (OTLP/HTTP) for agents that export telemetry; always 127.0.0.1/::1 only.
  // 4318 is the exporters' default endpoint. 0 turns it off.
  otlpPort: 4318,
  // An agent's heartbeat metric must advance within 3x this many seconds, or it's "not responding".
  otlpHeartbeatSeconds: 60,
  // Items waiting on you that an agent never resolves disappear after this long.
  otlpWaitingTtlHours: 168,
  // service.name values to ignore (Claude Code's own telemetry would duplicate the session cards).
  otlpIgnoreServices: ['claude-code'],
  // Context meter on each card: warn (amber) from this percentage of the window.
  contextWarnPercent: 80,
  // Context window per model-id prefix, if the built-in guess is wrong, e.g. {"claude-opus-5-5": 1000000}.
  contextWindows: {},
  // Widget only: daemons to connect to. The local one is always included.
  hubs: [],
  // Widget only: let the panel answer approvals and questions.
  approvalsInWidget: true,
  // Widget only: remembered window position.
  window: null,
  // Widget only: key that shows/hides the panel (Electron accelerator syntax).
  shortcut: 'Control+Alt+A',
  // 'gnome' once `modisa shortcut` made GNOME run it; the panel then doesn't grab it itself.
  shortcutVia: null,
  // Widget only: hidden with the tray icon / shortcut when it last closed.
  panelHidden: false,
  // Widget only: 'system', 'dark' or 'light'.
  theme: 'system',
  // Widget only: desktop notifications (also in the tray menu).
  notifications: true,
  // Widget only: "Done, your turn" only after a session worked at least this long.
  notifyAfterSeconds: 30,
};

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

export function loadConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  const cfg = { ...DEFAULTS, ...raw };
  if (process.env.MODISA_PORT) cfg.port = Number(process.env.MODISA_PORT);
  if (process.env.MODISA_BIND) cfg.bind = process.env.MODISA_BIND;
  return cfg;
}

export function saveConfig(patch) {
  ensureHome();
  let current = {};
  try { current = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  const next = { ...current, ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return { ...DEFAULTS, ...next };
}

export function machineName(cfg = loadConfig()) {
  return cfg.name || os.hostname();
}

export function isLoopback(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

export function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// ---------- other machines' daemons ("hubs"), for `modisa add-hub` and the panel's settings ----------
// Address: "100.101.102.103", "host:47615", "ws://host:47615" or "wss://…"; the port defaults to 47615.
export function hubUrl(input) {
  let s = String(input || '').trim();
  if (!s || /\s/.test(s)) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'ws://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if ((u.protocol !== 'ws:' && u.protocol !== 'wss:') || !u.hostname || u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '/ws') return null;
  return `${u.protocol}//${u.hostname}:${u.port || DEFAULTS.port}`; // hostname keeps IPv6 brackets
}
// Returns { ok, hubs } or { ok: false, error } in words the panel can show.
export function addHub(name, address, token) {
  name = String(name || '').trim();
  token = String(token || '').trim();
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) return { ok: false, error: 'Name: letters, digits, dot, dash or underscore' };
  const url = hubUrl(address);
  if (!url) return { ok: false, error: 'Address: an IP or host name, optionally with :port (or ws://host:port)' };
  if (token && !/^[A-Za-z0-9._~+/=-]{8,200}$/.test(token)) return { ok: false, error: 'Token: paste it exactly as "modisa share" printed it' };
  const hubs = (loadConfig().hubs || []).filter((h) => h.name !== name && hubUrl(h.url) !== url); // one entry per machine
  hubs.push({ name, url, token: token || null });
  saveConfig({ hubs });
  return { ok: true, hubs };
}
export function removeHub(name) {
  const hubs = (loadConfig().hubs || []).filter((h) => h.name !== name);
  saveConfig({ hubs });
  return { ok: true, hubs };
}

export function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
