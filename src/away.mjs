// Away detection: idle time and screen-lock state on GNOME (via gdbus) and macOS (via ioreg).
// localAway() never throws and every subprocess has a 2 s timeout.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const TIMEOUT_MS = 2000;

export function parseGnomeIdle(stdout) {
  const m = /\(\s*(?:uint64\s+)?(\d+)\s*,?\s*\)/.exec(String(stdout ?? ''));
  return m ? Number(m[1]) : null;
}

export function parseGnomeLocked(stdout) {
  const m = /\(\s*(true|false)\s*,?\s*\)/.exec(String(stdout ?? ''));
  return m ? m[1] === 'true' : null;
}

export function parseMacIdle(stdout) {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(stdout ?? ''));
  return m ? Math.floor(Number(m[1]) / 1e6) : null;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
        resolve(err ? null : stdout);
      });
    } catch { resolve(null); }
  });
}

const gdbus = (dest, objectPath, method) =>
  run('gdbus', ['call', '--session', '--dest', dest, '--object-path', objectPath, '--method', method]);

async function readState() {
  if (process.env.AGENT_DECK_AWAY_FILE) {
    try {
      const j = JSON.parse(fs.readFileSync(process.env.AGENT_DECK_AWAY_FILE, 'utf8'));
      return {
        idleMs: Number.isFinite(j?.idleMs) ? j.idleMs : null,
        locked: typeof j?.locked === 'boolean' ? j.locked : null,
      };
    } catch { return { idleMs: null, locked: null }; }
  }
  if (process.platform === 'linux') {
    const [idle, lock] = await Promise.all([
      gdbus('org.gnome.Mutter.IdleMonitor', '/org/gnome/Mutter/IdleMonitor/Core', 'org.gnome.Mutter.IdleMonitor.GetIdletime'),
      gdbus('org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver.GetActive'),
    ]);
    return { idleMs: idle == null ? null : parseGnomeIdle(idle), locked: lock == null ? null : parseGnomeLocked(lock) };
  }
  if (process.platform === 'darwin') {
    const out = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4']);
    return { idleMs: out == null ? null : parseMacIdle(out), locked: null };
  }
  return { idleMs: null, locked: null };
}

export async function localAway({ idleAfterMs = 300000 } = {}) {
  let idleMs = null, locked = null;
  try { ({ idleMs, locked } = await readState()); } catch { /* never throw */ }
  const known = idleMs !== null || locked !== null;
  return { away: locked === true || (idleMs ?? 0) >= idleAfterMs, known, idleMs, locked };
}
