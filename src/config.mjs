// Shared configuration for the daemon, hook script and widget.
// Everything lives in ~/.agent-deck/ (override with AGENT_DECK_HOME).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = process.env.AGENT_DECK_HOME || path.join(os.homedir(), '.agent-deck');
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
  // How long a permission request or question waits for an answer in the panel
  // before falling back to the normal prompt in the terminal.
  holdSeconds: 90,
  // Name shown on this machine's cards. Defaults to the hostname.
  name: null,
  // Widget only: daemons to connect to. The local one is always included.
  hubs: [],
  // Widget only: let the panel answer approvals and questions.
  approvalsInWidget: true,
  // Widget only: remembered window position.
  window: null,
};

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

export function loadConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  const cfg = { ...DEFAULTS, ...raw };
  if (process.env.AGENT_DECK_PORT) cfg.port = Number(process.env.AGENT_DECK_PORT);
  if (process.env.AGENT_DECK_BIND) cfg.bind = process.env.AGENT_DECK_BIND;
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

export function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
