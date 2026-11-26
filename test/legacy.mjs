// Moving an install made under Modisa's old name: the data folder, hooks and the cut-over race.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = '.agent-deck';
let passed = 0;
const check = (name) => { passed++; console.log(`  ✓ ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-test-'));

// A child environment with its own home folder and none of our variables.
function envFor(home, extra = {}) {
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('MODISA_') && !(k in extra)) delete env[k];
  return env;
}
function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function until(fn, what, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Runs the hook script without blocking this process (a server here may need to answer it).
function runHook(mode, home, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'src', 'hook.mjs'), mode], { env: envFor(home) });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', () => resolve(out));
    p.stdin.end(JSON.stringify(input));
  });
}
function writeOldHome(home, cfg) {
  fs.mkdirSync(path.join(home, OLD), { recursive: true });
  fs.writeFileSync(path.join(home, OLD, 'config.json'), JSON.stringify({ otlpPort: 0, name: 'legacy-test', ...cfg }));
  fs.writeFileSync(path.join(home, OLD, 'keep.txt'), 'mine');
}
// Runs a function with HOME pointing elsewhere (os.homedir() follows it).
async function withHome(home, fn) {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(); } finally { process.env.HOME = saved; }
}

async function main() {
  const legacy = await import('../src/legacy.mjs');

  // ---------- which folder is used ----------
  const resolveIn = (home, extra) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import('${path.join(ROOT, 'src', 'legacy.mjs')}').then((m) => console.log(m.resolveHome()))`], { env: envFor(home, extra), encoding: 'utf8' }).stdout.trim();
  const h1 = tmp();
  assert.equal(resolveIn(h1), path.join(h1, '.modisa'));
  fs.mkdirSync(path.join(h1, OLD));
  assert.equal(resolveIn(h1), path.join(h1, OLD));
  fs.mkdirSync(path.join(h1, '.modisa'));
  assert.equal(resolveIn(h1), path.join(h1, '.modisa'));
  assert.equal(resolveIn(h1, { MODISA_HOME: '/elsewhere' }), '/elsewhere');
  check('the data folder is ~/.modisa, or the old one while it is the only one; MODISA_HOME wins');

  // The hook script reads its port from the old folder while that is the only one.
  const h2 = tmp();
  const hookPort = await freePort();
  writeOldHome(h2, { port: hookPort });
  let got = null;
  const fake = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got = JSON.parse(b); res.end('{}'); }); });
  await new Promise((r) => fake.listen(hookPort, '127.0.0.1', r));
  await runHook('observe', h2, { hook_event_name: 'SessionStart', session_id: 's1' });
  await new Promise((r) => fake.close(r));
  assert.equal(got?.event, 'SessionStart');
  check('hooks still find the daemon through the old folder before it moves');

  // ---------- hooks in Claude Code's settings ----------
  const h3 = tmp();
  process.env.CLAUDE_CONFIG_DIR = path.join(h3, '.claude');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  const settingsFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  // The user's own hooks, in the order they come back (ours are added after them).
  const mine = [
    { event: 'PreToolUse', matcher: 'Bash', hook: { type: 'command', command: 'echo mine' } },
    { event: 'PreToolUse', matcher: '*', hook: { type: 'command', command: 'echo also-mine' } },
    { event: 'Stop', matcher: undefined, hook: { type: 'command', command: "node '/home/me/modisa-tools/hook.mjs' observe" } },
    { event: 'Stop', matcher: undefined, hook: { type: 'command', command: "node '/home/me/agent-deck-notes/hook.mjs' observe # agent-deck notes" } },
  ];
  const old = (mode) => ({ type: 'command', command: `'/usr/bin/node' '/opt/app/src/hook.mjs' ${mode} # agent-deck`, ...(mode === 'decide' ? { timeout: 600 } : { async: true }) });
  fs.writeFileSync(settingsFile, JSON.stringify({
    model: 'x',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [mine[0].hook] }, { matcher: '*', hooks: [old('observe'), mine[1].hook] }],
      Stop: [{ hooks: [mine[2].hook] }, { hooks: [mine[3].hook] }, { hooks: [old('observe')] }],
      SessionStart: [{ hooks: [old('observe')] }],
      PermissionRequest: [{ matcher: '*', hooks: [old('decide')] }],
    },
  }, null, 2));
  const { install, uninstall } = await import('../src/install.mjs');
  const flatten = () => {
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const out = [];
    for (const [event, groups] of Object.entries(s.hooks || {})) for (const g of groups) for (const hook of g.hooks) out.push({ event, matcher: g.matcher, hook });
    return { s, out };
  };
  const ending = (list, mark) => list.filter((x) => x.hook.command.endsWith(`# ${mark}`)).length;
  const others = (list) => list.filter((x) => !/# (modisa|agent-deck)$/.test(x.hook.command));
  install();
  let { s, out } = flatten();
  assert.equal(ending(out, 'modisa'), 14);
  assert.equal(ending(out, 'agent-deck'), 0);
  assert.deepEqual(others(out), mine);
  assert.equal(s.model, 'x');
  install();
  ({ out } = flatten());
  assert.equal(ending(out, 'modisa'), 14);
  check('install replaces old-name hooks with 14 "# modisa" ones, keeps the user\'s own hooks exactly, and runs twice cleanly');
  uninstall();
  ({ out } = flatten());
  assert.deepEqual(out, mine);
  check('uninstall removes only Modisa\'s hooks; a path containing either name is not enough to look like ours');

  // ---------- moving the folder while a daemon runs on it ----------
  const h4 = tmp();
  const port = await freePort();
  writeOldHome(h4, { port });
  const oldDaemon = spawn(process.execPath, [path.join(ROOT, 'src', 'daemon.mjs')], { env: envFor(h4, { MODISA_HOME: path.join(h4, OLD) }), stdio: 'ignore' });
  await until(() => health(port), 'the old daemon');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'modisa.mjs'), 'restart'], { env: envFor(h4), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Moved .*\.agent-deck to .*\.modisa/);
  assert.match(r.stdout, /Daemon restarted\./);
  assert.ok(!fs.existsSync(path.join(h4, OLD)), 'the old folder is gone');
  assert.equal(fs.readFileSync(path.join(h4, '.modisa', 'keep.txt'), 'utf8'), 'mine');
  const backups = fs.readdirSync(h4).filter((f) => f.startsWith(`${OLD}.backup-`));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(h4, backups[0], 'keep.txt'), 'utf8'), 'mine');
  await until(() => !alive(oldDaemon.pid), 'the old daemon to exit');
  await until(() => health(port), 'the new daemon');
  const newPid = Number(fs.readFileSync(path.join(h4, '.modisa', 'daemon.pid'), 'utf8'));
  assert.notEqual(newPid, oldDaemon.pid);
  spawnSync(process.execPath, [path.join(ROOT, 'src', 'hook.mjs'), 'observe'], { env: envFor(h4), input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's2' }) });
  assert.ok(!fs.existsSync(path.join(h4, OLD)), 'a hook afterwards does not bring the old folder back');
  const again = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'modisa.mjs'), 'restart'], { env: envFor(h4), encoding: 'utf8' });
  assert.doesNotMatch(again.stdout, /Moved/);
  await until(() => health(port), 'the daemon after a plain restart');
  try { process.kill(Number(fs.readFileSync(path.join(h4, '.modisa', 'daemon.pid'), 'utf8')), 'SIGTERM'); } catch {}
  check('restart stops the daemon on the old folder, moves it (with a copy) and starts one on ~/.modisa');

  // ---------- while the folder moves, the port is held ----------
  const h5 = tmp();
  const port5 = await freePort();
  writeOldHome(h5, { port: port5 });
  let daemonExit = null;
  let hookMs = null;
  await withHome(h5, () => legacy.moveOldHome({
    port: port5,
    whileHeld: async () => {
      const d = spawn(process.execPath, [path.join(ROOT, 'src', 'daemon.mjs')], { env: envFor(h5), stdio: 'ignore' });
      daemonExit = await new Promise((resolve) => { const t = setTimeout(() => { d.kill(); resolve('still running'); }, 8000); d.on('exit', (code) => { clearTimeout(t); resolve(code); }); });
      const t0 = Date.now();
      const said = await runHook('decide', h5, { hook_event_name: 'PermissionRequest', session_id: 's3' });
      hookMs = Date.now() - t0;
      assert.equal(said, '', 'the hook gives no opinion');
    },
  }));
  assert.equal(daemonExit, 0, 'a daemon started mid-move finds the port busy and exits');
  assert.ok(hookMs < 3000, `a waiting hook isn't held (${hookMs} ms)`);
  assert.ok(!fs.existsSync(path.join(h5, OLD)));
  assert.ok(await withHome(h5, () => !legacy.needsHomeMove()));
  check('mid-move, a daemon a hook starts exits at once and a hook gives no opinion without waiting');

  // ---------- leftovers ----------
  const h6 = tmp();
  fs.mkdirSync(path.join(h6, '.modisa'));
  fs.mkdirSync(path.join(h6, OLD));
  fs.writeFileSync(path.join(h6, OLD, 'daemon.out'), 'x');
  assert.equal(await withHome(h6, () => legacy.cleanStrayOldHome()), 'removed');
  assert.ok(!fs.existsSync(path.join(h6, OLD)));
  fs.mkdirSync(path.join(h6, OLD));
  fs.writeFileSync(path.join(h6, OLD, 'config.json'), '{}');
  assert.match(await withHome(h6, () => legacy.cleanStrayOldHome()), /still exists .* holds config\.json/);
  assert.ok(fs.existsSync(path.join(h6, OLD, 'config.json')));
  check('an old folder left holding only a log is removed; one holding anything else is kept and reported');

  console.log(`\n${passed} checks passed`);
}

try { await main(); } catch (e) {
  console.error('\nFAILED:', e.stack || e.message);
  process.exit(1);
}
