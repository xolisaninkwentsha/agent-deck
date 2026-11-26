// Modisa used to be called "Agent Deck". This moves an install made under the old name:
// its data folder, its hook marker, its GNOME shortcut and its start-at-login entry.
// No dependencies, so the hook script can load it cheaply. Delete it once no install
// under the old name is left.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const OLD = 'agent-deck';
// Paths are worked out on each call, from the home folder at that moment.
export const newHome = () => path.join(os.homedir(), '.modisa');
export const oldHome = () => path.join(os.homedir(), `.${OLD}`);
export const OLD_MARK = OLD; // the trailing "# agent-deck" on hook commands
export const OLD_SHORTCUT_ENTRY = `/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/${OLD}/`;
export const oldAutostartFile = () => path.join(os.homedir(), '.config', 'autostart', `${OLD}.desktop`);
export const oldLaunchAgent = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `ai.botlhale.${OLD}.plist`);

// The data folder: MODISA_HOME if set, else ~/.modisa, or the old folder while it's the only one.
export function resolveHome(env = process.env) {
  if (env.MODISA_HOME) return env.MODISA_HOME;
  if (!fs.existsSync(newHome()) && fs.existsSync(oldHome())) return oldHome();
  return newHome();
}

export function needsHomeMove(env = process.env) {
  return !env.MODISA_HOME && fs.existsSync(oldHome()) && !fs.existsSync(newHome());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stopDaemonIn(dir) {
  let pid;
  try { pid = Number(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8')); process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    try { process.kill(pid, 0); } catch { return; }
  }
}

// Take the daemon's port, so a daemon a hook starts meanwhile finds it busy and exits.
// Connections are dropped at once: a hook then gives "no opinion" instead of waiting.
function holdPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer((socket) => socket.destroy());
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

// Move ~/.agent-deck to ~/.modisa with no daemon running on either. Every open session's
// hooks start a daemon when none answers, so the port is held while the folder moves.
// Paths in already-loaded modules still point at the old folder: run the command again
// in a fresh process afterwards. `whileHeld` is for tests.
export async function moveOldHome({ port = 47615, whileHeld = null } = {}) {
  const from = oldHome();
  const to = newHome();
  const backup = `${from}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.cpSync(from, backup, { recursive: true, filter: (src) => !fs.lstatSync(src).isSocket() });
  fs.chmodSync(backup, 0o700);
  for (let attempt = 0; attempt < 5; attempt++) {
    await stopDaemonIn(from);
    const held = await holdPort(port);
    if (!held) { await sleep(300); continue; }
    try {
      fs.renameSync(from, to);
      if (whileHeld) await whileHeld();
    } finally {
      await new Promise((r) => held.close(r));
    }
    return { from, to, backup };
  }
  throw new Error(`Couldn't move ${from}: something keeps using port ${port}. Stop it and run this again.`);
}

// A hook that raced the move can leave an old folder holding only a log. Remove that;
// anything else is left alone and reported.
export function cleanStrayOldHome() {
  const from = oldHome();
  if (!fs.existsSync(from) || !fs.existsSync(newHome())) return null;
  const entries = fs.readdirSync(from);
  if (entries.every((e) => /\.(log|out)$/.test(e))) { fs.rmSync(from, { recursive: true, force: true }); return 'removed'; }
  return `${from} still exists next to ${newHome()} and holds ${entries.join(', ')}. Modisa uses ${newHome()}; check the old one and remove it yourself.`;
}
