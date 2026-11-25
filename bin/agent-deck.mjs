#!/usr/bin/env node
// agent-deck: set up and run Agent Deck.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  loadConfig, saveConfig, newToken, machineName, HOME, PID_PATH, LOG_PATH, CONFIG_PATH, ensureHome,
} from '../src/config.mjs';
import { install, uninstall, isInstalled, settingsPath } from '../src/install.mjs';

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
    return true;
  } catch { return false; }
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

then run "agent-deck widget" again. (Repeat after reinstalling node_modules.)`;
}

// On Linux the panel must run through XWayland to stay on top under GNOME Wayland, and
// Electron only honours that as a real command-line flag (see widget/main.cjs).
const X11_FLAGS = process.platform === 'linux' && !process.env.AGENT_DECK_WAYLAND ? ['--ozone-platform=x11'] : [];

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
    console.log(`Added Agent Deck hooks to ${file}`);
    if (backup) console.log(`Backup of your previous settings: ${backup}`);
    const ok = await ensureDaemon();
    console.log(ok ? `Daemon running on 127.0.0.1:${cfg.port}` : `Couldn't start the daemon; see ${LOG_PATH}`);
    console.log('\nNext:');
    console.log('  1. Sessions that were already open show as "watch only"; restart them to answer prompts from the panel.');
    console.log('  2. Open the panel:  agent-deck widget');
    console.log('  3. Want this machine visible from another computer?  agent-deck share');
  },

  async uninstall() {
    const { file, backup } = uninstall();
    stopDaemon();
    console.log(`Removed Agent Deck hooks from ${file}${backup ? ` (backup: ${backup})` : ''}. Daemon stopped.`);
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
    stopDaemon();
    await new Promise((r) => setTimeout(r, 400));
    console.log((await ensureDaemon()) ? 'Daemon restarted.' : `Couldn't start the daemon; see ${LOG_PATH}`);
  },

  async status() {
    const h = await health();
    console.log(`Hooks installed: ${isInstalled() ? 'yes' : 'no'} (${settingsPath()})`);
    console.log(h ? `Daemon: running as "${h.name}", ${h.sessions} session(s) tracked` : 'Daemon: not running');
    console.log(`Listening on: ${cfg.bind}:${cfg.port}${cfg.token ? ' (token set)' : ''}`);
    const hubs = cfg.hubs || [];
    console.log(`Remote machines in the panel: ${hubs.length ? hubs.map((x) => `${x.name} (${x.url})`).join(', ') : 'none'}`);
  },

  // Let another machine's panel see this machine.
  async share() {
    const bindArg = args.find((a) => !a.startsWith('-'));
    const addrs = lanAddresses();
    const bind = bindArg || '0.0.0.0';
    const token = cfg.token || newToken();
    saveConfig({ bind, token });
    stopDaemon();
    await new Promise((r) => setTimeout(r, 400));
    const ok = await ensureDaemon();
    const host = (bind !== '0.0.0.0' && bind) || addrs[0]?.address || '<this-machine-ip>';
    console.log(ok ? `Daemon now listening on ${bind}:${cfg.port} and requires a token from other machines.` : `Couldn't restart the daemon; see ${LOG_PATH}`);
    if (addrs.length) console.log('\nThis machine\'s addresses:\n' + addrs.map((a) => `  ${a.address}  (${a.name}${a.tailscale ? ', Tailscale' : ''})`).join('\n'));
    console.log('\nOn the other computer, run:');
    console.log(`  agent-deck add-hub ${machineName()} ws://${host}:${cfg.port} ${token}`);
    console.log('\nKeep this port off the public internet. Tailscale or your office LAN is the intended setup.');
  },

  async unshare() {
    saveConfig({ bind: '127.0.0.1' });
    await commands.restart();
    console.log('Daemon is local-only again.');
  },

  async 'add-hub'() {
    const [name, url, token] = args;
    if (!name || !url) { console.log('Usage: agent-deck add-hub <name> <ws://host:port> <token>'); process.exit(1); }
    const hubs = (cfg.hubs || []).filter((h) => h.name !== name);
    hubs.push({ name, url, token: token || null });
    saveConfig({ hubs });
    console.log(`Added "${name}". The panel picks it up within a few seconds.`);
  },

  async 'remove-hub'() {
    const [name] = args;
    saveConfig({ hubs: (cfg.hubs || []).filter((h) => h.name !== name) });
    console.log(`Removed "${name}".`);
  },

  async widget() {
    await ensureDaemon();
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

  // Start the panel when you log in.
  async autostart() {
    const on = args[0] !== 'off';
    const electron = (() => { try { return require('electron'); } catch { return null; } })();
    if (on && !electron) { console.log('Run "npm install" first.'); process.exit(1); }
    const main = path.join(ROOT, 'widget', 'main.cjs');
    if (process.platform === 'linux') {
      const file = path.join(os.homedir(), '.config', 'autostart', 'agent-deck.desktop');
      if (!on) { fs.rmSync(file, { force: true }); console.log('Autostart off.'); return; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Agent Deck\nExec="${electron}" "${main}"${X11_FLAGS.map((f) => ' ' + f).join('')}\nX-GNOME-Autostart-enabled=true\n`);
      console.log(`Autostart on (${file}).`);
    } else if (process.platform === 'darwin') {
      const file = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.botlhale.agent-deck.plist');
      if (!on) { fs.rmSync(file, { force: true }); console.log('Autostart off.'); return; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.botlhale.agent-deck</string>
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
    console.log(`Agent Deck: a small always-on-top panel for your Claude Code sessions.

  agent-deck install          add hooks to Claude Code and start the daemon
  agent-deck widget           open the panel
  agent-deck autostart [off]  open the panel when you log in
  agent-deck status           what's installed and running
  agent-deck share [ip]       let another computer's panel see this machine
  agent-deck unshare          make this machine local-only again
  agent-deck add-hub <name> <ws://host:port> <token>
  agent-deck remove-hub <name>
  agent-deck start|stop|restart
  agent-deck uninstall        remove the hooks and stop the daemon`);
  },
};

const fn = commands[command] || commands.help;
fn().catch((e) => { console.error(e.message); process.exit(1); });
