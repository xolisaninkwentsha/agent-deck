#!/usr/bin/env node
// modisa: set up and run Modisa.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  loadConfig, saveConfig, newToken, machineName, HOME, PID_PATH, LOG_PATH, CONFIG_PATH, ensureHome, addHub, removeHub,
} from '../src/config.mjs';
import { install, uninstall, isInstalled, settingsPath } from '../src/install.mjs';
import {
  needsHomeMove, moveOldHome, cleanStrayOldHome, oldHome, OLD_SHORTCUT_ENTRY, oldAutostartFile, oldLaunchAgent,
} from '../src/legacy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const [, , command = 'help', ...args] = process.argv;
const cfg = loadConfig();

function health(port = cfg.port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function startDaemonDetached() {
  ensureHome();
  const out = fs.openSync(path.join(HOME, 'daemon.out'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'daemon.mjs')], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
}

async function ensureDaemon() {
  if (await health()) return true;
  startDaemonDetached();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await health()) return true;
  }
  return false;
}

function stopDaemon() {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8'));
    process.kill(pid, 'SIGTERM');
    return pid;
  } catch { return false; }
}
// Stop it and wait until it has exited (up to 5 s), so a restart never finds the old one still answering.
async function stopDaemonAndWait() {
  const pid = stopDaemon();
  if (!pid) return false;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { process.kill(pid, 0); } catch { return true; }
  }
  return true;
}

// Ubuntu 23.10+ blocks unprivileged user namespaces, so Electron needs its
// chrome-sandbox helper to be setuid root. Spot that before launching.
function linuxSandboxProblem(electronPath) {
  if (process.platform !== 'linux') return null;
  let restricted = false;
  try { restricted = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1'; } catch {}
  if (!restricted) return null;
  const helper = path.join(path.dirname(electronPath), 'chrome-sandbox');
  try {
    const st = fs.statSync(helper);
    if (st.uid === 0 && (st.mode & 0o4755) === 0o4755) return null;
  } catch { return null; }
  return `Ubuntu blocks Electron's normal sandbox, so its helper must be owned by root. Run once:

  sudo chown root:root '${helper}'
  sudo chmod 4755 '${helper}'

then run "modisa widget" again. (Repeat after reinstalling node_modules.)`;
}

// On Linux the panel must run through XWayland to stay on top under GNOME Wayland, and
// Electron only honours that as a real command-line flag (see widget/main.cjs).
const X11_FLAGS = process.platform === 'linux' && !process.env.MODISA_WAYLAND ? ['--ozone-platform=x11'] : [];

// Send a word to the running panel (widget/main.cjs listens on HOME/panel.sock).
// Resolves with the panel's answer ("shown"/"hidden"), or null if no panel is running.
function tellPanel(word) {
  return new Promise((resolve) => {
    let out = '';
    const c = net.connect(path.join(HOME, 'panel.sock'));
    c.setEncoding('utf8');
    c.on('connect', () => c.write(word + '\n'));
    c.on('data', (d) => { out += d; });
    c.on('end', () => resolve(out.trim() || 'ok'));
    c.on('error', () => resolve(null));
    setTimeout(() => { c.destroy(); resolve(out.trim() || null); }, 1500).unref();
  });
}

// Electron accelerator ("Control+Alt+A") -> GNOME binding ("<Control><Alt>a").
function gnomeBinding(accel) {
  const MOD = { control: '<Control>', ctrl: '<Control>', commandorcontrol: '<Control>', cmdorctrl: '<Control>', alt: '<Alt>', shift: '<Shift>', super: '<Super>', meta: '<Super>' };
  const parts = String(accel).split('+');
  const key = parts.pop();
  return parts.map((m) => MOD[m.toLowerCase()] || '').join('') + key.toLowerCase();
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ name, address: a.address, tailscale: a.address.startsWith('100.') || /tailscale|utun/.test(name) });
    }
  }
  return out.sort((x, y) => Number(y.tailscale) - Number(x.tailscale));
}

const commands = {
  async install() {
    const { file, backup } = install();
    console.log(`Added Modisa hooks to ${file}`);
    if (backup) console.log(`Backup of your previous settings: ${backup}`);
    const ok = await ensureDaemon();
    console.log(ok ? `Daemon running on 127.0.0.1:${cfg.port}` : `Couldn't start the daemon; see ${LOG_PATH}`);
    console.log('\nNext:');
    console.log('  1. Sessions that were already open show as "watch only"; restart them to answer prompts from the panel.');
    console.log('  2. Open the panel:  modisa widget');
    console.log('  3. Want this machine visible from another computer?  modisa share');
  },

  async uninstall() {
    const { file, backup } = uninstall();
    stopDaemon();
    console.log(`Removed Modisa hooks from ${file}${backup ? ` (backup: ${backup})` : ''}. Daemon stopped.`);
  },

  async daemon() {
    await import('../src/daemon.mjs');
  },

  async start() {
    console.log((await ensureDaemon()) ? 'Daemon running.' : `Couldn't start the daemon; see ${LOG_PATH}`);
  },

  async stop() {
    console.log(stopDaemon() ? 'Daemon stopped.' : 'Daemon was not running.');
  },

  async restart() {
    await stopDaemonAndWait();
    console.log((await ensureDaemon()) ? 'Daemon restarted.' : `Couldn't start the daemon; see ${LOG_PATH}`);
  },

  async status() {
    const h = await health();
    console.log(`Hooks installed: ${isInstalled() ? 'yes' : 'no'} (${settingsPath()})`);
    console.log(h ? `Daemon: running as "${h.name}", ${h.sessions} session(s) tracked` : 'Daemon: not running');
    console.log(`Listening on: ${cfg.bind}:${cfg.port}${cfg.token ? ' (token set)' : ''}`);
    const hubs = cfg.hubs || [];
    console.log(`Remote machines in the panel: ${hubs.length ? hubs.map((x) => `${x.name} (${x.url})`).join(', ') : 'none'}`);
    if (needsHomeMove()) console.log(`Data folder: ${oldHome()}, from Modisa's old name. "modisa restart" moves it to ~/.modisa.`);
  },

  // Let another machine's panel see this machine.
  async share() {
    const bindArg = args.find((a) => !a.startsWith('-'));
    const addrs = lanAddresses();
    const bind = bindArg || '0.0.0.0';
    const token = cfg.token || newToken();
    saveConfig({ bind, token });
    await stopDaemonAndWait();
    const ok = await ensureDaemon();
    const host = (bind !== '0.0.0.0' && bind) || addrs[0]?.address || '<this-machine-ip>';
    console.log(ok ? `Daemon now listening on ${bind}:${cfg.port} and requires a token from other machines.` : `Couldn't restart the daemon; see ${LOG_PATH}`);
    if (addrs.length) console.log('\nThis machine\'s addresses:\n' + addrs.map((a) => `  ${a.address}  (${a.name}${a.tailscale ? ', Tailscale' : ''})`).join('\n'));
    console.log('\nOn the other computer, run:');
    console.log(`  modisa add-hub ${machineName()} ws://${host}:${cfg.port} ${token}`);
    console.log('\nKeep this port off the public internet. Tailscale or your office LAN is the intended setup.');
  },

  async unshare() {
    saveConfig({ bind: '127.0.0.1' });
    await commands.restart();
    console.log('Daemon is local-only again.');
  },

  async 'add-hub'() {
    const [name, url, token] = args;
    if (!name || !url) { console.log('Usage: modisa add-hub <name> <ws://host:port> <token>   (or add it in the panel: Settings)'); process.exit(1); }
    const r = addHub(name, url, token);
    if (!r.ok) { console.log(r.error); process.exit(1); }
    console.log(`Added "${name}" (${r.hubs.at(-1).url}). The panel picks it up within a few seconds.`);
  },

  async 'remove-hub'() {
    const [name] = args;
    removeHub(name);
    console.log(`Removed "${name}".`);
  },

  async widget() {
    await ensureDaemon();
    // Already open: bring it forward. A second copy would only quit (one panel per machine).
    if (await tellPanel('show') !== null) { console.log('The panel is already open.'); return; }
    let electron;
    try { electron = require('electron'); } catch {
      console.log('Electron is not installed. Run "npm install" in ' + ROOT);
      process.exit(1);
    }
    const problem = linuxSandboxProblem(electron);
    if (problem) { console.log(problem); process.exit(1); }
    ensureHome();
    const logFile = path.join(HOME, 'widget.log');
    const out = fs.openSync(logFile, 'a');
    const child = spawn(electron, [path.join(ROOT, 'widget', 'main.cjs'), ...X11_FLAGS, ...args], { detached: true, stdio: ['ignore', out, out] });
    // Catch it if the panel dies straight away instead of reporting success.
    const died = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 2500);
      child.once('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
    });
    if (died) {
      const tail = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-8).join('\n');
      console.log(`The panel exited right away (${died.signal || 'code ' + died.code}). Last lines of ${logFile}:\n${tail}`);
      process.exit(1);
    }
    child.unref();
    console.log('Panel opened.');
  },

  // Show or hide the running panel (bind this to a key; see `modisa shortcut`).
  async toggle() {
    const r = await tellPanel('toggle');
    if (r === null) return commands.widget(); // no panel running: open one
    console.log(`Panel ${r}.`);
  },
  async show() {
    const r = await tellPanel('show');
    if (r === null) return commands.widget();
    console.log(`Panel ${r}.`);
  },
  async hide() {
    const r = await tellPanel('hide');
    console.log(r === null ? 'No panel is running.' : `Panel ${r}.`);
  },

  // GNOME on Wayland doesn't let an app grab a key everywhere, so let GNOME run `modisa toggle`.
  async shortcut() {
    const off = args[0] === 'off';
    if (process.platform !== 'linux') { console.log(`The panel registers ${cfg.shortcut} itself on this system.`); return; }
    const SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
    const ENTRY = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/modisa/';
    const KEY = `${SCHEMA}.custom-keybinding:${ENTRY}`;
    const gs = (...a) => execFileSync('gsettings', a, { encoding: 'utf8' }).trim();
    let list;
    try { list = gs('get', SCHEMA, 'custom-keybindings'); } catch {
      console.log('Couldn\'t run gsettings. This command is for GNOME; elsewhere the panel registers the shortcut itself.');
      process.exit(1);
    }
    let entries = (list.match(/'[^']*'/g) || []).map((s) => s.slice(1, -1));
    if (entries.includes(OLD_SHORTCUT_ENTRY)) { // made under Modisa's old name
      entries = entries.filter((p) => p !== OLD_SHORTCUT_ENTRY);
      gs('set', SCHEMA, 'custom-keybindings', `[${entries.map((p) => `'${p}'`).join(', ')}]`);
      for (const k of ['name', 'command', 'binding']) gs('reset', `${SCHEMA}.custom-keybinding:${OLD_SHORTCUT_ENTRY}`, k);
    }
    if (off) {
      gs('set', SCHEMA, 'custom-keybindings', `[${entries.filter((p) => p !== ENTRY).map((p) => `'${p}'`).join(', ')}]`);
      for (const k of ['name', 'command', 'binding']) gs('reset', KEY, k);
      saveConfig({ shortcutVia: null });
      console.log(`Removed the GNOME shortcut. The panel grabs ${cfg.shortcut} itself again (only while an X11 window such as VS Code has focus).`);
      return;
    }
    // gsettings parses values as GVariant text: pass strings as double-quoted literals.
    const str = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    gs('set', KEY, 'name', str('Modisa'));
    gs('set', KEY, 'command', str(`'${process.execPath}' '${path.join(ROOT, 'bin', 'modisa.mjs')}' toggle`));
    gs('set', KEY, 'binding', str(gnomeBinding(cfg.shortcut)));
    if (!entries.includes(ENTRY)) gs('set', SCHEMA, 'custom-keybindings', `[${[...entries, ENTRY].map((p) => `'${p}'`).join(', ')}]`);
    saveConfig({ shortcutVia: 'gnome' });
    console.log(`GNOME now runs "modisa toggle" on ${gs('get', KEY, 'binding')} (Settings > Keyboard > Custom Shortcuts > Modisa).`);
    console.log('Remove it with: modisa shortcut off');
  },

  // Start the panel when you log in.
  async autostart() {
    const on = args[0] !== 'off';
    const electron = (() => { try { return require('electron'); } catch { return null; } })();
    if (on && !electron) { console.log('Run "npm install" first.'); process.exit(1); }
    const main = path.join(ROOT, 'widget', 'main.cjs');
    // Entries made under Modisa's old name go either way.
    fs.rmSync(oldAutostartFile(), { force: true });
    if (fs.existsSync(oldLaunchAgent())) {
      try { execFileSync('launchctl', ['unload', oldLaunchAgent()], { stdio: 'ignore' }); } catch {}
      fs.rmSync(oldLaunchAgent(), { force: true });
    }
    if (process.platform === 'linux') {
      const file = path.join(os.homedir(), '.config', 'autostart', 'modisa.desktop');
      if (!on) { fs.rmSync(file, { force: true }); console.log('Autostart off.'); return; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Modisa\nExec="${electron}" "${main}"${X11_FLAGS.map((f) => ' ' + f).join('')}\nX-GNOME-Autostart-enabled=true\n`);
      console.log(`Autostart on (${file}).`);
    } else if (process.platform === 'darwin') {
      const file = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.botlhale.modisa.plist');
      if (!on) { fs.rmSync(file, { force: true }); console.log('Autostart off.'); return; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.botlhale.modisa</string>
  <key>ProgramArguments</key><array><string>${electron}</string><string>${main}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`);
      console.log(`Autostart on (${file}). It starts at your next login.`);
    } else {
      console.log('Autostart is set up for Linux and macOS only.');
    }
  },

  async config() {
    console.log(CONFIG_PATH);
    console.log(JSON.stringify({ ...cfg, token: cfg.token ? '(set)' : null }, null, 2));
  },

  async help() {
    console.log(`Modisa: a small always-on-top panel for your Claude Code sessions.

  modisa install          add hooks to Claude Code and start the daemon
  modisa widget           open the panel
  modisa toggle|show|hide show or hide the running panel
  modisa shortcut [off]   GNOME: run "toggle" on Ctrl+Alt+A wherever you are
  modisa autostart [off]  open the panel when you log in
  modisa status           what's installed and running
  modisa share [ip]       let another computer's panel see this machine
  modisa unshare          make this machine local-only again
  modisa add-hub <name> <ws://host:port> <token>
  modisa remove-hub <name>
  modisa start|stop|restart
  modisa uninstall        remove the hooks and stop the daemon`);
  },
};

// An install made under Modisa's old name keeps its data in ~/.agent-deck. install and
// restart move it (they restart the daemon anyway), then run again in a fresh process,
// because this one's paths were fixed when it loaded.
if (command === 'install' || command === 'restart') {
  if (needsHomeMove()) {
    try {
      const { from, to, backup } = await moveOldHome({ port: cfg.port });
      console.log(`Moved ${from} to ${to} (a copy is in ${backup}).`);
    } catch (e) { console.error(e.message); process.exit(1); }
    process.exit(spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit' }).status ?? 1);
  }
  const stray = cleanStrayOldHome();
  if (stray && stray !== 'removed') console.log(stray);
}

const fn = commands[command] || commands.help;
fn().catch((e) => { console.error(e.message); process.exit(1); });
