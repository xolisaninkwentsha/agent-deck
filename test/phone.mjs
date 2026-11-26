// Tests for the daemon's phone client, against a fake relay, then a real daemon with the phone
// wired in (a real hook script, a fake relay, panels over WebSocket).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { createPhone, DEFAULT_RELAY_URL } from '../src/phone.mjs';
import { createRelay } from '../relay/src/core.js';
import { MemoryStore } from '../relay/src/memory-store.js';
import { parseWebhook } from '../relay/src/whatsapp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Never your own daemon (47615) or the live-test harness (47690).
const TAKEN = new Set([47615, 47690, Number(process.env.AGENT_DECK_LIVE_PORT) || 0]);
const randomPort = () => { let p; do p = 47000 + Math.floor(Math.random() * 900); while (TAKEN.has(p)); return p; };

let passed = 0;
const check = (name) => { passed++; console.log(`  ✓ ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(10); }
  assert.fail(`timed out waiting for ${what}`);
}

const cleanups = [];
async function fakeRelay() {
  let wss, port;
  for (;;) {
    port = randomPort();
    try {
      wss = new WebSocketServer({ port, host: '127.0.0.1' });
      await new Promise((res, rej) => { wss.once('listening', res); wss.once('error', rej); });
      break;
    } catch { /* port busy, retry */ }
  }
  // behave(ws, n): what to do with the n-th connection (1-based); reply(msg, ws): answer a message.
  const relay = { url: `ws://127.0.0.1:${port}`, auths: [], got: [], socks: [], connections: 0, opened: [], closed: [], behave: null, reply: null };
  wss.on('connection', (ws, req) => {
    const n = ++relay.connections;
    relay.opened[n - 1] = Date.now();
    relay.auths.push(req.headers.authorization);
    relay.socks.push(ws);
    ws.on('close', () => { relay.closed[n - 1] = Date.now(); });
    ws.on('message', (d) => {
      const s = d.toString();
      if (s === 'ping') return ws.send('pong');
      const m = JSON.parse(s);
      relay.got.push(m);
      if (relay.reply) relay.reply(m, ws);
    });
    if (relay.behave) relay.behave(ws, n);
  });
  relay.send = (o) => relay.socks.at(-1).send(JSON.stringify(o));
  relay.of = (type) => relay.got.filter((m) => m.type === type);
  relay.close = () => new Promise((res) => { for (const c of wss.clients) c.terminate(); wss.close(res); });
  cleanups.push(relay.close);
  return relay;
}

function setup(relay, over = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-phone-'));
  const t = { now: 1_000_000, decided: [], extended: [], changes: 0, logs: [] };
  const phone = createPhone({
    home, machineName: 'testbox', version: '9.9.9', relayUrl: relay.url,
    log: (m) => t.logs.push(m), onChange: () => { t.changes++; },
    decide: (id, d) => { t.decided.push([id, d]); return { ok: true }; },
    extendHold: (id) => t.extended.push(id),
    now: () => t.now, ...over,
  });
  cleanups.push(async () => { phone.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  Object.assign(t, { phone, home });
  return t;
}
const LINKED = { type: 'status', linked: true, number: '+27•••••4567', balanceMicroUsd: 5000, billing: 'trial', botNumber: '27600000000' };
const UNLINKED = { type: 'status', linked: false, number: null, balanceMicroUsd: null, billing: 'trial', botNumber: '27600000000' };
// The link is up only while linking or linked: start a link, then the relay says it's linked.
const startLink = (t, number = '+27820000000') => t.phone.panelMessage({ type: 'phone-link', number });
async function connecting(t) {
  t.phone.start();
  startLink(t);
  await until(() => t.phone.view().connected, 'connect');
}
async function linked(t, relay) {
  await connecting(t);
  relay.send(LINKED);
  await until(() => t.phone.view().linked, 'linked');
}
// A machine linked on an earlier run: phone.json says so, and start() connects by itself.
function linkedOnDisk(t, over = {}) {
  const st = { key: crypto.randomBytes(32).toString('base64url'), relay: '', enabled: true, mode: 'away', lastStatus: { ...LINKED, type: undefined }, ...over };
  fs.writeFileSync(path.join(t.home, 'phone.json'), JSON.stringify(st), { mode: 0o600 });
  return st;
}
const pend = (o) => ({ id: 'p1', hookEvent: 'PreToolUse', toolName: 'Bash', toolInput: { command: 'ls' }, project: 'proj', questions: null, createdAt: 1_000_000, expiresAt: 1_000_000 + 90000, ...o });

// ---------- the real relay core behind a WebSocket server, driven by the real phone client ----------
// Connections are keyed by the hash of the Bearer key, as the Worker and relay-do.js do; each
// connection's messages are handled one at a time, in order, as the Durable Object does.
const META_NUMBER_ID = 'PN-TEST';
async function realRelay(config) {
  const store = new MemoryStore();
  const outbound = []; // what would have gone to WhatsApp
  const sender = { send: async (p) => { outbound.push(p); return { ok: true, id: 'wamid.out' + outbound.length }; } };
  const relay = createRelay({ store, sender, config });
  const port = await freePort(['127.0.0.1']);
  const socks = new Map(); // keyHash -> open socket
  const server = { url: `ws://127.0.0.1:${port}/link`, store, outbound, connections: 0 };
  const wss = new WebSocketServer({
    port, host: '127.0.0.1', path: '/link',
    verifyClient: (info) => /^Bearer [A-Za-z0-9_-]{43}$/.test(info.req.headers.authorization || ''),
  });
  await new Promise((res, rej) => { wss.once('listening', res); wss.once('error', rej); });
  wss.on('connection', (ws, req) => {
    server.connections++;
    const keyHash = crypto.createHash('sha256').update(req.headers.authorization.slice(7)).digest('hex');
    const older = socks.get(keyHash);
    socks.set(keyHash, ws);
    if (older) older.close(4000, 'replaced');
    let chain = Promise.resolve();
    ws.on('message', (d) => {
      const s = d.toString();
      if (s === 'ping') return ws.send('pong');
      chain = chain.then(async () => {
        for (const reply of await relay.machineMessage(keyHash, JSON.parse(s))) ws.send(JSON.stringify(reply));
      });
    });
    ws.on('close', () => { if (socks.get(keyHash) === ws) socks.delete(keyHash); });
  });
  // Meta's webhook as the Worker forwards it: parsed for our number, then routed to the machines.
  server.inbound = async (message) => {
    const body = { object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: META_NUMBER_ID }, messages: [message] } }] }] };
    for (const { keyHash, msg, expiresAt } of await relay.webhook(parseWebhook(body, META_NUMBER_ID))) {
      const ws = socks.get(keyHash);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else await relay.queue(keyHash, msg, expiresAt);
    }
  };
  server.close = () => new Promise((res) => { for (const c of wss.clients) c.terminate(); wss.close(() => res()); });
  cleanups.push(server.close);
  return server;
}

async function integration() {
  const PRICE = 1000; // test values, not anyone's real rates
  const TRIAL = 50000;
  const config = { botNumber: '27600000000', billing: 'trial', trialMicroUsd: TRIAL, rates: { default: PRICE }, markupPercent: 0, hourlyCap: 60, codeTtlMs: 600000, windowMs: 86400000, template: { name: 't', lang: 'en' } };
  const server = await realRelay(config);
  const t = setup({ url: server.url }, { now: Date.now });
  const from = '27821234567';
  const ts = () => String(Math.floor(Date.now() / 1000));

  t.phone.start();
  await sleep(200);
  assert.equal(server.connections, 0);
  startLink(t, '+27 82 123 4567');
  await until(() => t.phone.view().code, 'a link code from the relay core');
  const { code } = t.phone.view().code;
  assert.match(code, /^[A-Z0-9]{8}$/);
  await server.inbound({ from, id: 'wamid.in1', timestamp: ts(), type: 'text', text: { body: code } });
  await until(() => t.phone.view().linked, 'linked through the relay core');
  let v = t.phone.view();
  assert.deepEqual([v.enabled, v.number, v.billing, v.botNumber, v.balanceMicroUsd], [true, '+27•••••4567', 'trial', '27600000000', TRIAL - PRICE]);
  assert.equal(server.outbound.at(-1).text.body, 'Connected: testbox');

  const now = Date.now();
  t.phone.consider([pend({ id: 'int1', createdAt: now, expiresAt: now + 90000, toolInput: { command: 'npm publish --token=npm_abcdefghijklmnop1234' } })], true);
  await until(() => t.phone.view().sent.int1 === 'sent', 'prompt-sent from the relay core');
  assert.equal(t.phone.view().balanceMicroUsd, TRIAL - 2 * PRICE, 'Settings shows the charge');
  const msg = server.outbound.at(-1);
  assert.equal(msg.type, 'interactive');
  assert.ok(!JSON.stringify(msg).includes('abcdefghijklmnop'), 'masked before it left the machine');
  const allow = msg.interactive.action.buttons.find((b) => b.reply.title === 'Allow').reply.id;
  await server.inbound({ from, id: 'wamid.in2', timestamp: ts(), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: allow, title: 'Allow' } } });
  await until(() => t.decided.length === 1, 'the decide reached the phone client');
  assert.deepEqual(t.decided[0], ['int1', { behavior: 'allow' }]);
  const ref = await server.store.get('pending:' + crypto.createHash('sha256').update(JSON.parse(fs.readFileSync(path.join(t.home, 'phone.json'), 'utf8')).key).digest('hex') + ':int1');
  for (let i = 0; i < 100 && (await server.store.get('prompt:' + ref)).state !== 'closed'; i++) await sleep(10);
  assert.deepEqual([(await server.store.get('prompt:' + ref)).closedWhy], ['answered-phone'], 'the decide-ack closed it on the relay');
  v = t.phone.view();
  assert.equal(v.balanceMicroUsd, (await server.store.get('account:' + from)).balance);
  check('integration: link with a code, prompt, tap Allow, decide reaches the client, credit follows (real relay core)');
  t.phone.stop();
}

// ---------- a real daemon with the phone wired in ----------
async function runCleanups() {
  for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch { /* best effort */ } }
}
function within(promise, ms, what) {
  let t;
  const late = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(t));
}
// A port free on every given address (the daemon exits quietly when its port is busy).
async function freePort(hosts) {
  for (;;) {
    const port = randomPort();
    const free = await Promise.all(hosts.map((host) => new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(port, host, () => s.close(() => res(true)));
    })));
    if (free.every(Boolean)) { TAKEN.add(port); return port; }
  }
}

// The relay as a daemon sees it: /link, refusing any key but the machine's, answering hello with a linked status.
const RELAY_STATUS = { type: 'status', linked: true, number: '+27•••••4567', balanceMicroUsd: 1000000, billing: 'trial', botNumber: '27000000000' };
async function linkRelay(key) {
  const port = await freePort(['127.0.0.1']);
  const relay = { url: `ws://127.0.0.1:${port}/link`, got: [], socks: [], connections: 0, refused: 0 };
  const wss = new WebSocketServer({
    port, host: '127.0.0.1', path: '/link',
    verifyClient: (info) => {
      const ok = info.req.headers.authorization === 'Bearer ' + key;
      if (!ok) relay.refused++;
      return ok;
    },
  });
  await new Promise((res, rej) => { wss.once('listening', res); wss.once('error', rej); });
  wss.on('connection', (ws) => {
    relay.connections++;
    relay.socks.push(ws);
    ws.on('message', (d) => {
      const s = d.toString();
      if (s === 'ping') return ws.send('pong');
      const m = JSON.parse(s);
      relay.got.push(m);
      if (m.type === 'hello') ws.send(JSON.stringify(RELAY_STATUS));
    });
  });
  relay.send = (o) => relay.socks.at(-1).send(JSON.stringify(o));
  relay.of = (type, id) => relay.got.filter((m) => m.type === type && (id === undefined || m.pendingId === id));
  relay.close = () => new Promise((res) => { for (const c of wss.clients) c.terminate(); wss.close(() => res()); });
  cleanups.push(relay.close);
  return relay;
}

// A daemon in a throwaway AGENT_DECK_HOME, linked to `relay` through a pre-written phone.json
// (its key is the one the relay accepts; enabled, "only when I'm away"). No relay: no phone at all.
const daemons = [];
async function startDaemon({ name, key, relay, bind, token, env = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-phone-daemon-'));
  const port = await freePort(bind ? ['127.0.0.1', bind] : ['127.0.0.1']);
  const claude = path.join(home, 'claude'); // a fake ~/.claude: none of this machine's real sessions
  fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'crontab'), '');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, name, otlpPort: 0, ...(bind ? { bind, token } : {}) }));
  if (relay) fs.writeFileSync(path.join(home, 'phone.json'), JSON.stringify({ key, relay: relay.url, enabled: true, mode: 'away', lastStatus: { linked: true, number: '+27•••••4567', balanceMicroUsd: 1000000, billing: 'trial', botNumber: '27000000000' } }), { mode: 0o600 });
  const awayFile = path.join(home, 'away.json');
  const d = { home, port, name, awayFile, logFile: path.join(home, 'daemon.log') };
  d.away = (idleMs) => fs.writeFileSync(awayFile, JSON.stringify({ idleMs, locked: false }));
  d.away(1000);
  d.env = {
    ...process.env, AGENT_DECK_HOME: home, AGENT_DECK_PORT: String(port), CLAUDE_CONFIG_DIR: claude,
    AGENT_DECK_CRONTAB: path.join(home, 'crontab'), AGENT_DECK_AWAY_FILE: awayFile, ...env,
  };
  if (relay) d.env.AGENT_DECK_RELAY = relay.url;
  else delete d.env.AGENT_DECK_RELAY;
  for (const k of ['AGENT_DECK_DISABLE', 'AGENT_DECK_BIND', 'AGENT_DECK_VERBOSE', 'AGENT_DECK_EVENT_LOG']) delete d.env[k];
  d.child = spawn(process.execPath, [path.join(ROOT, 'src', 'daemon.mjs')], { env: d.env, stdio: 'ignore' });
  const exited = new Promise((r) => d.child.once('exit', r));
  const running = () => d.child.exitCode === null && d.child.signalCode === null;
  cleanups.push(async () => {
    if (running()) d.child.kill('SIGTERM');
    await Promise.race([exited, sleep(3000)]);
    if (running()) d.child.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  });
  daemons.push(d);
  let health = null;
  for (let i = 0; i < 50 && !health; i++) {
    try { health = await (await fetch(`http://127.0.0.1:${port}/health`)).json(); } catch { await sleep(100); }
  }
  assert.equal(health?.name, name, 'the test daemon answers on its own port');
  return d;
}

function panel(url) {
  const ws = new WebSocket(url);
  const p = { ws, snap: null };
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'snapshot') p.snap = m; });
  ws.on('error', () => {});
  p.opened = new Promise((r) => ws.once('open', r));
  p.send = (o) => ws.send(JSON.stringify(o));
  p.close = () => new Promise((r) => {
    if (ws.readyState === WebSocket.CLOSED) return r();
    ws.once('close', r);
    ws.close();
  });
  cleanups.push(p.close);
  return p;
}

// From test/e2e.mjs, with the daemon's env passed in.
const hookKids = new Set();
function hook(env, mode, input) {
  let child;
  const done = new Promise((resolve) => {
    child = spawn(process.execPath, [path.join(ROOT, 'src', 'hook.mjs'), mode], { env });
    hookKids.add(child);
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', (code) => { hookKids.delete(child); resolve({ code, out }); });
    child.stdin.end(JSON.stringify(input));
  });
  done.child = child; // lets a test kill a held hook the way Claude Code does
  return done;
}
const ask = (d, extra) => hook(d.env, 'decide', {
  session_id: 'phone-sess', cwd: '/work/voice-api', hook_event_name: 'PermissionRequest', permission_mode: 'default', tool_name: 'Bash', ...extra,
});
const decisionOf = (r) => JSON.parse(r.out).hookSpecificOutput.decision;

async function daemonChecks() {
  cleanups.push(() => { for (const k of hookKids) k.kill(); });
  const key = crypto.randomBytes(32).toString('base64url');
  const relay = await linkRelay(key);
  // The 2-minute rule is 1 s here, so the presence check below needn't wait two minutes.
  const d = await startDaemon({ name: 'phone-box', key, relay, env: { AGENT_DECK_PHONE_AWAY_AFTER_MS: '1000' } });
  const url = `ws://127.0.0.1:${d.port}/ws`;

  // Wait for the link through a local panel, then close it: the first checks run with no panel.
  const w = panel(url);
  await w.opened;
  w.send({ type: 'hello', approvals: false });
  await until(() => w.snap?.phone?.linked && w.snap.phone.connected && w.snap.phone.enabled, 'the daemon linked to the fake relay', 8000);
  assert.equal(relay.of('hello').length, 1);
  assert.equal(relay.refused, 0);
  await until(() => w.snap?.localActive === true, 'the first away read (at the desk)', 6000); // null until then
  await w.close();

  // no panel, away
  d.away(400000);
  const secret = 'fake_token_0123456789abcdefXYZ';
  const h1 = ask(d, { tool_input: { command: `curl -H "Authorization: Bearer ${secret}" https://api.example.com/v1/charges` } });
  await until(() => relay.of('prompt').length === 1, 'a prompt on the relay', 8000);
  const m1 = relay.of('prompt')[0];
  assert.equal(m1.prompt.kind, 'approval');
  assert.equal(m1.prompt.project, 'voice-api');
  assert.match(m1.prompt.detail, /^curl -H "Authorization: Bearer ••••" https:\/\/api\.example\.com/);
  assert.ok(!JSON.stringify(m1).includes(secret), 'the secret never reaches the relay');
  relay.send({ type: 'decide', pendingId: m1.pendingId, decision: { behavior: 'allow' } });
  const r1 = await within(h1, 5000, 'the hook answered from the phone');
  assert.equal(decisionOf(r1).behavior, 'allow');
  await until(() => relay.of('decide-ack', m1.pendingId).length === 1, 'decide-ack');
  assert.equal(relay.of('decide-ack', m1.pendingId)[0].ok, true);
  check('no panel, away: held, prompt with masked detail on the relay, the relay\'s allow answers the hook');

  // no panel, at desk
  d.away(1000);
  let sentSoFar = relay.of('prompt').length;
  const t2 = Date.now();
  const r2 = await within(ask(d, { tool_input: { command: 'ls -la' } }), 5000, 'the at-desk hook');
  assert.equal(r2.out, '');
  assert.ok(Date.now() - t2 < 1500, 'returned at once');
  await sleep(2500); // a tick: nothing goes to the relay later either
  assert.equal(relay.of('prompt').length, sentSoFar);
  check('no panel, at desk: the hook returns at once with no output, the relay gets nothing');

  // always is ignored
  d.away(400000);
  const h3 = ask(d, {
    tool_input: { command: 'rm -rf build' },
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }], behavior: 'allow', destination: 'localSettings' }],
  });
  await until(() => relay.of('prompt').length === sentSoFar + 1, 'the second prompt', 8000);
  const m3 = relay.of('prompt').at(-1);
  // The wrong shape for this prompt (answers to a permission) is refused, and it stays held.
  relay.send({ type: 'decide', pendingId: m3.pendingId, decision: { answers: { 'Which?': 'yes' } } });
  await until(() => relay.of('decide-ack', m3.pendingId).length === 1, 'decide-ack for the wrong kind');
  assert.deepEqual(relay.of('decide-ack', m3.pendingId)[0], { type: 'decide-ack', pendingId: m3.pendingId, ok: false, reason: 'bad-decision' });
  relay.send({ type: 'decide', pendingId: m3.pendingId, decision: { behavior: 'allow', always: true } });
  const d3 = decisionOf(await within(h3, 5000, 'the hook answered with always'));
  assert.equal(d3.behavior, 'allow');
  assert.ok(!('updatedPermissions' in d3), 'no permission rule from the phone');
  check('always is ignored: allow with always:true from the relay adds no updatedPermissions');

  // A question answered from the phone; allow/deny alone is refused for a question.
  const questions = [{ question: 'Which audio format?', header: 'Format', multiSelect: false, options: [{ label: 'Opus', description: 'small' }, { label: 'WAV', description: 'raw' }] }];
  const hq = ask(d, { tool_name: 'AskUserQuestion', tool_input: { questions } });
  await until(() => relay.of('prompt').at(-1)?.prompt?.kind === 'question', 'the question on the relay', 8000);
  const mq = relay.of('prompt').at(-1);
  assert.deepEqual(mq.prompt.questions, [{ question: 'Which audio format?', header: 'Format', multiSelect: false, options: ['Opus', 'WAV'] }]);
  relay.send({ type: 'decide', pendingId: mq.pendingId, decision: { behavior: 'allow' } });
  await until(() => relay.of('decide-ack', mq.pendingId).length === 1, 'decide-ack for allow on a question');
  assert.equal(relay.of('decide-ack', mq.pendingId)[0].reason, 'bad-decision');
  relay.send({ type: 'decide', pendingId: mq.pendingId, decision: { answers: { 'Which audio format?': 'Opus' } } });
  const dq = decisionOf(await within(hq, 5000, 'the question answered from the phone'));
  assert.equal(dq.behavior, 'allow');
  assert.deepEqual(dq.updatedInput, { questions, answers: { 'Which audio format?': 'Opus' } });
  check('decisions are checked against the prompt: answers only for questions, allow/deny only for permissions');

  // prompt-closed tells the relay how each prompt ended
  assert.deepEqual(relay.of('prompt-closed', m1.pendingId).map((x) => x.why), ['answered']);
  sentSoFar = relay.of('prompt').length;
  const h4 = ask(d, { tool_input: { command: 'make deploy' } });
  await until(() => relay.of('prompt').length === sentSoFar + 1, 'the third prompt', 8000);
  const m4 = relay.of('prompt').at(-1);
  h4.child.kill(); // Claude Code drops the hook
  await until(() => relay.of('prompt-closed', m4.pendingId).length === 1, 'prompt-closed after the hook closed');
  assert.equal(relay.of('prompt-closed', m4.pendingId)[0].why, 'gone');
  check('prompt-closed: answered on the phone -> answered, hook closed -> gone');

  // hold extended
  const w2 = panel(url);
  await w2.opened;
  w2.send({ type: 'hello', approvals: false });
  await until(() => w2.snap?.phone?.linked, 'the panel sees the link');
  sentSoFar = relay.of('prompt').length;
  const h5 = ask(d, { tool_input: { command: 'npm publish' } });
  await until(() => relay.of('prompt').length === sentSoFar + 1, 'the fourth prompt', 8000);
  const m5 = relay.of('prompt').at(-1);
  const pend5 = () => w2.snap?.sessions?.find((s) => s.pending?.id === m5.pendingId)?.pending;
  assert.equal(pend5()?.phone, undefined, 'not marked sent before the relay says so');
  relay.send({ type: 'prompt-sent', pendingId: m5.pendingId });
  await until(() => pend5()?.phone === 'sent' && Math.abs(pend5().expiresAt - (pend5().createdAt + 570000)) < 1000, 'the hold extended and marked sent');
  assert.equal(m5.expiresAt, pend5().createdAt + 570000);
  assert.equal(w2.snap.localActive, false);
  assert.equal(w2.snap.phone.sent[m5.pendingId], 'sent');
  check('hold extended: after prompt-sent the local snapshot\'s pending expiresAt = createdAt + 570 s, marked sent');

  // A panel closing while the phone can still answer doesn't hand the prompt back (the answer below proves it).
  const w3 = panel(url);
  await w3.opened;
  await w3.close();
  await sleep(200);

  // a decision delivered after a reconnect still answers
  const hellos = relay.of('hello').length;
  relay.socks.at(-1).terminate();
  await until(() => relay.of('hello').length === hellos + 1, 'hello after the reconnect', 8000);
  assert.ok(pend5(), 'the PermissionRequest stays held while the relay link is down');
  relay.send({ type: 'decide', pendingId: m5.pendingId, decision: { behavior: 'deny', message: 'Not from the train' } });
  const d5 = decisionOf(await within(h5, 5000, 'the hook answered after the reconnect'));
  assert.deepEqual(d5, { behavior: 'deny', message: 'Not from the train' });
  check('a decision delivered after a reconnect still answers');
  check('a panel closing doesn\'t release a prompt the phone can answer');

  // presence
  const p2 = panel(url);
  await p2.opened;
  p2.send({ type: 'hello', approvals: false });
  await until(() => w2.snap?.localActive === false && w2.snap.phone.connected && w2.snap.phone.linked && w2.snap.phone.enabled, 'away, phone ready');
  p2.send({ type: 'presence', active: true });
  await sleep(200);
  const t6 = Date.now();
  const r6 = await within(ask(d, { tool_input: { command: 'git push' } }), 5000, 'the hook while another machine is in use');
  assert.equal(r6.out, '');
  assert.ok(Date.now() - t6 < 1500, 'returned at once');
  p2.send({ type: 'presence', active: false });
  await sleep(200);
  const h7 = ask(d, { tool_input: { command: 'git push --force' } });
  await until(() => w2.snap?.sessions?.some((s) => s.pending?.detail === 'git push --force'), 'held again once presence is inactive');
  w2.send({ type: 'release', pendingId: w2.snap.sessions.find((s) => s.pending?.detail === 'git push --force').pending.id });
  assert.equal((await within(h7, 5000, 'the released hook')).out, '');
  check('presence: another panel reporting active means not away, so the hook isn\'t held');

  // Back at the desk with no panel approving: a PreToolUse question held for the phone goes back
  // to the terminal on the next tick (the terminal doesn't show it while it's held).
  d.away(400000);
  const deskQ = [{ question: 'Deploy to which stage?', header: 'Stage', multiSelect: false, options: [{ label: 'dev' }, { label: 'prod' }] }];
  const h8 = ask(d, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', permission_mode: 'bypassPermissions', tool_use_id: 'q-desk', tool_input: { questions: deskQ } });
  await until(() => relay.of('prompt').at(-1)?.prompt?.questions?.[0]?.question === 'Deploy to which stage?', 'the PreToolUse question on the relay', 8000);
  const m8 = relay.of('prompt').at(-1);
  d.away(1000);
  // The tick re-reads away at most every 10 s, then hands the question back on that tick.
  assert.equal((await within(h8, 15000, 'the question handed back to the terminal')).out, '');
  await until(() => relay.of('prompt-closed', m8.pendingId).length === 1, 'prompt-closed for the released question');
  assert.equal(relay.of('prompt-closed', m8.pendingId)[0].why, 'timeout');
  check('back at the desk: a PreToolUse question held for the phone is handed to the terminal on the next away check');

  // At the desk, with a panel approving: the 2-minute rule (1 s here) sends a PermissionRequest to
  // the phone, but not while another machine's panel reports it's in use.
  const ap = panel(url);
  await ap.opened;
  ap.send({ type: 'hello', approvals: true });
  p2.send({ type: 'presence', active: true });
  await sleep(200);
  sentSoFar = relay.of('prompt').length;
  const h9 = ask(d, { tool_input: { command: 'terraform apply' } });
  const pend9 = () => w2.snap?.sessions?.find((s) => s.pending?.detail === 'terraform apply')?.pending;
  await until(() => pend9(), 'held for the approving panel');
  await sleep(5000); // well past 1 s, two ticks or more
  assert.equal(relay.of('prompt').length, sentSoFar, 'not sent while another panel reports active');
  p2.send({ type: 'presence', active: false });
  await until(() => relay.of('prompt').length === sentSoFar + 1, 'sent by the 2-minute rule once nobody reports active', 8000);
  assert.equal(relay.of('prompt').at(-1).pendingId, pend9().id);
  ap.send({ type: 'decide', pendingId: pend9().id, decision: { behavior: 'allow' } });
  assert.equal(decisionOf(await within(h9, 5000, 'the panel\'s answer')).behavior, 'allow');
  await ap.close();
  check('presence: no 2-minute rule while another panel reports active (sent once it stops)');

  // A failed send doesn't leave a PreToolUse question hidden from the terminal, even while the
  // phone still counts as an approver.
  d.away(400000);
  const failQ = [{ question: 'Which region?', header: 'Region', multiSelect: false, options: [{ label: 'af-south-1' }, { label: 'eu-west-1' }] }];
  const h10 = ask(d, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', permission_mode: 'bypassPermissions', tool_use_id: 'q-fail', tool_input: { questions: failQ } });
  await until(() => relay.of('prompt').at(-1)?.prompt?.questions?.[0]?.question === 'Which region?', 'the question on the relay', 8000);
  const m10 = relay.of('prompt').at(-1);
  relay.send({ type: 'prompt-failed', pendingId: m10.pendingId, reason: 'no-credit' });
  assert.equal((await within(h10, 6000, 'the question handed back after a failed send')).out, '');
  await until(() => relay.of('prompt-closed', m10.pendingId).length === 1, 'prompt-closed for the failed question');
  assert.equal(relay.of('prompt-closed', m10.pendingId)[0].why, 'timeout');
  check('a failed send hands a PreToolUse question back to the terminal on the next tick');

  // The relay accepted it, then it died (the next question couldn't be sent, or Meta said failed).
  const lateQ = [{ question: 'Which branch?', header: 'Branch', multiSelect: false, options: [{ label: 'main' }, { label: 'dev' }] }];
  const h10b = ask(d, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', permission_mode: 'bypassPermissions', tool_use_id: 'q-late-fail', tool_input: { questions: lateQ } });
  await until(() => relay.of('prompt').at(-1)?.prompt?.questions?.[0]?.question === 'Which branch?', 'the question on the relay', 8000);
  const m10b = relay.of('prompt').at(-1);
  relay.send({ type: 'prompt-sent', pendingId: m10b.pendingId, balanceMicroUsd: 999000 });
  await sleep(1500);
  assert.equal(hookKids.has(h10b.child), true, 'still held while it is on the phone');
  relay.send({ type: 'prompt-failed', pendingId: m10b.pendingId, reason: 'send-failed', balanceMicroUsd: 999000 });
  assert.equal((await within(h10b, 6000, 'the question handed back after it failed on the phone')).out, '');
  check('a prompt that fails after prompt-sent hands a PreToolUse question back too');

  const log = fs.readFileSync(d.logFile, 'utf8');
  for (const text of [secret, 'curl', 'npm publish', 'git push', 'terraform', 'Which region']) assert.ok(!log.includes(text), `daemon log has ${text}`);
  check('daemon log carries no prompt text');

  // No relay configured: a held PreToolUse question goes back to the terminal on the next tick
  // once the last panel turns approvals off; away detection that can't tell gives localActive null.
  const dn = await startDaemon({ name: 'phone-none' });
  const np = panel(`ws://127.0.0.1:${dn.port}/ws`);
  await np.opened;
  np.send({ type: 'hello', approvals: true });
  await until(() => np.snap?.localActive === true, 'at the desk in the snapshot', 6000);
  assert.equal(np.snap.phone.relay, '');
  assert.equal(np.snap.phone.connected, false);
  const noRelayQ = [{ question: 'Squash the commits?', header: 'Squash', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }];
  const h11 = hook(dn.env, 'decide', { session_id: 'none-sess', cwd: '/work/voice-api', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', permission_mode: 'bypassPermissions', tool_use_id: 'q-none', tool_input: { questions: noRelayQ } });
  await until(() => np.snap?.sessions?.some((s) => s.pending?.kind === 'question'), 'the question held for the panel');
  np.send({ type: 'approvals', enabled: false });
  assert.equal((await within(h11, 3500, 'the question handed back within a tick')).out, '');
  check('no relay: approvals turned off hands a held PreToolUse question back within a tick');
  fs.rmSync(dn.awayFile);
  await until(() => np.snap?.localActive === null, 'localActive null once away is unknown', 15000);
  check('away unknown (no away file): the local snapshot has localActive null');

  // local only
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  if (!lan) {
    console.log('  - skipped "local only": no LAN address on this machine');
  } else {
    const key2 = crypto.randomBytes(32).toString('base64url');
    const relay2 = await linkRelay(key2);
    const TOKEN = 'y'.repeat(32);
    const d2 = await startDaemon({ name: 'phone-lan', key: key2, relay: relay2, bind: lan, token: TOKEN });
    const local = panel(`ws://127.0.0.1:${d2.port}/ws`);
    const remote = panel(`ws://${lan}:${d2.port}/ws?token=${TOKEN}`);
    await Promise.all([local.opened, remote.opened]);
    local.send({ type: 'hello', approvals: false });
    remote.send({ type: 'hello', approvals: false });
    await until(() => local.snap?.phone?.linked && local.snap.phone.connected, 'the LAN daemon linked', 8000);
    await until(() => remote.snap, 'a snapshot on the remote panel');
    assert.ok(!('phone' in remote.snap) && !('localActive' in remote.snap), 'phone state only goes to this machine\'s panels');

    // "Sent to your phone" shows on this machine's cards in another machine's panel too.
    d2.away(400000);
    const h12 = ask(d2, { tool_input: { command: 'docker system prune' } });
    await until(() => relay2.of('prompt').length === 1, 'the LAN daemon\'s prompt on its relay', 8000);
    const m12 = relay2.of('prompt')[0];
    relay2.send({ type: 'prompt-sent', pendingId: m12.pendingId });
    const remotePending = () => remote.snap?.sessions?.find((s) => s.pending?.id === m12.pendingId)?.pending;
    await until(() => remotePending()?.phone === 'sent', 'sent shown on the remote panel\'s card');
    assert.ok(!('phone' in remote.snap) && !('localActive' in remote.snap), 'still no phone state on the remote panel');
    relay2.send({ type: 'decide', pendingId: m12.pendingId, decision: { behavior: 'allow' } });
    assert.equal(decisionOf(await within(h12, 5000, 'the LAN daemon\'s hook answered')).behavior, 'allow');
    check('pending.phone reaches remote panels; the phone view and localActive stay local');

    remote.send({ type: 'phone-link', number: '+27820000000' });
    remote.send({ type: 'phone-settings', mode: 'everything', enabled: false });
    remote.send({ type: 'phone-unlink' });
    await sleep(500);
    assert.equal(relay2.of('link-start').length, 0, 'a remote panel can\'t start a link');
    assert.equal(relay2.of('unlink').length, 0, 'or unlink');
    assert.equal(local.snap.phone.mode, 'away', 'or change settings');
    assert.equal(local.snap.phone.enabled, true);
    local.send({ type: 'phone-link', number: '+27820000000' });
    await until(() => relay2.of('link-start').length === 1, 'link-start from the local panel');
    assert.equal(relay2.of('link-start')[0].number, '+27820000000');
    check('local only: phone-* from a remote panel are ignored; the local panel\'s phone-link reaches the relay');
    await sleep(200);
    const log2 = fs.readFileSync(d2.logFile, 'utf8');
    for (const text of ['+27', '820000000']) assert.ok(!log2.includes(text), `daemon log has ${text}`);
    check('daemon log carries no phone number after a link');
  }
}

async function main() {
  assert.equal(DEFAULT_RELAY_URL, '');

  // key
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    await connecting(t);
    const file = path.join(t.home, 'phone.json');
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(st.key.length, 43);
    assert.equal(st.enabled, false);
    assert.equal(st.mode, 'away');
    await until(() => relay.auths.length === 1, 'upgrade');
    assert.equal(relay.auths[0], 'Bearer ' + st.key);
    await until(() => relay.of('hello').length === 1, 'hello');
    assert.deepEqual(relay.of('hello')[0], { type: 'hello', machine: 'testbox', version: '9.9.9' });
    check('key: phone.json 0600, 43-char key, relay sees Bearer <key>, hello sent');
    t.phone.stop();
    const again = createPhone({ home: t.home, machineName: 'x', log() {}, onChange() {}, decide() {}, extendHold() {}, relayUrl: relay.url });
    again.start();
    again.panelMessage({ type: 'phone-link', number: '+27820000000' });
    await until(() => relay.auths.length === 2, 'second connect');
    assert.equal(relay.auths[1], 'Bearer ' + st.key);
    again.stop();
    check('key: reused on restart');
    for (const l of t.logs) assert.ok(!l.includes(st.key));
  }

  // no relay configured
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-phone-'));
    const phone = createPhone({ home, machineName: 'm', log() {}, onChange() {}, decide() {}, extendHold() {}, relayUrl: '' });
    phone.start();
    await sleep(50);
    assert.equal(phone.view().relay, '');
    assert.equal(phone.view().connected, false);
    phone.stop();
    fs.rmSync(home, { recursive: true, force: true });
    check('no relay configured: no connection, view().relay is empty');
  }

  // link
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    t.phone.start();
    t.phone.panelMessage({ type: 'phone-link', number: '  +27•••••4567 ' });
    await until(() => relay.of('link-start').length === 1, 'link-start');
    assert.deepEqual(relay.got.map((m) => m.type), ['hello', 'link-start'], 'phone-link connects, says hello, then asks for a code');
    assert.equal(relay.of('link-start')[0].number, '+27•••••4567');
    relay.send({ type: 'link-code', code: 'ABCD2345', expiresAt: 123, botNumber: '27600000000' });
    await until(() => t.phone.view().code, 'code');
    assert.deepEqual(t.phone.view().code, { code: 'ABCD2345', expiresAt: 123, botNumber: '27600000000' });
    relay.send(LINKED);
    await until(() => t.phone.view().linked, 'linked');
    const v = t.phone.view();
    assert.equal(v.code, null);
    assert.equal(v.enabled, true);
    assert.equal(v.number, '+27•••••4567');
    assert.equal(v.balanceMicroUsd, 5000);
    assert.equal(v.billing, 'trial');
    assert.deepEqual(Object.keys(v).sort(), ['balanceMicroUsd', 'billing', 'botNumber', 'code', 'connected', 'enabled', 'error', 'linked', 'mode', 'number', 'relay', 'sent'].sort());
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.home, 'phone.json'), 'utf8')).enabled, true);
    assert.ok(t.changes > 0);
    check('link: link-start sent, link-code -> view().code, status linked -> linked and enabled');

    relay.send({ type: 'error', op: 'link-start', reason: 'rate-limited' });
    await until(() => t.phone.view().error === 'rate-limited', 'error');
    t.phone.panelMessage({ type: 'phone-link', number: '+27820000000' });
    await until(() => relay.of('link-start').length === 2, 'second link-start');
    relay.send({ type: 'link-code', code: 'ZZZZ2222', expiresAt: 1, botNumber: 'b' });
    await until(() => t.phone.view().code, 'code2');
    assert.equal(t.phone.view().error, '');
    t.phone.panelMessage({ type: 'phone-cancel-link' });
    assert.equal(t.phone.view().code, null);
    check('link: error shown and cleared by link-code; cancel clears code');

    t.phone.panelMessage({ type: 'phone-unlink' });
    await until(() => relay.of('unlink').length === 1, 'unlink');
    assert.equal(t.phone.view().enabled, false);
    t.phone.panelMessage({ type: 'bogus' });
    check('unlink: sends unlink, disables; unknown message ignored');
  }

  // link while offline
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    t.phone.panelMessage({ type: 'phone-link', number: '+27•••••4567' });
    assert.equal(t.phone.view().error, 'relay-unreachable');
    check('link: not connected gives relay-unreachable');
  }

  // settings
  {
    const relay = await fakeRelay();
    const relay2 = await fakeRelay();
    const t = setup(relay);
    await connecting(t);
    t.phone.panelMessage({ type: 'phone-settings', enabled: 'yes', mode: 'bogus', relay: 'http://x' });
    let v = t.phone.view();
    assert.equal(v.enabled, false); assert.equal(v.mode, 'away'); assert.equal(v.relay, relay.url);
    t.phone.panelMessage({ type: 'phone-settings', enabled: true, mode: 'everything' });
    v = t.phone.view();
    assert.equal(v.enabled, true); assert.equal(v.mode, 'everything');
    const st = JSON.parse(fs.readFileSync(path.join(t.home, 'phone.json'), 'utf8'));
    assert.equal(st.enabled, true); assert.equal(st.mode, 'everything');
    t.phone.panelMessage({ type: 'phone-settings', relay: relay2.url });
    assert.equal(t.phone.view().relay, relay2.url);
    await until(() => relay.socks[0].readyState === WebSocket.CLOSED, 'the old relay dropped');
    await sleep(200);
    assert.equal(relay2.connections, 0, 'the new relay isn\'t contacted until a link starts');
    startLink(t);
    await until(() => relay2.connections === 1, 'the next link uses the new relay');
    check('settings: invalid fields ignored, valid persisted; a relay change drops the link and the next link uses the new relay');
  }

  // rules
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    await linked(t, relay);
    t.phone.panelMessage({ type: 'phone-settings', enabled: true });
    t.phone.consider([pend({ id: 'a1' })], true);
    await until(() => relay.of('prompt').length === 1, 'prompt a1');
    const m = relay.of('prompt')[0];
    assert.equal(m.pendingId, 'a1');
    assert.equal(m.expiresAt, 1_000_000 + 90000);
    assert.equal(typeof m.prompt, 'object');
    t.phone.consider([pend({ id: 'a1' })], true);
    await sleep(50);
    assert.equal(relay.of('prompt').length, 1);
    relay.send({ type: 'prompt-sent', pendingId: 'a1' });
    await until(() => t.phone.view().sent.a1 === 'sent', 'sent a1');
    t.phone.consider([pend({ id: 'a1' })], true);
    await sleep(50);
    assert.equal(relay.of('prompt').length, 1);
    const pr = pend({ id: 'b1', hookEvent: 'PermissionRequest', expiresAt: 1_000_000 + 300000 });
    t.phone.consider([pr], false);
    await sleep(50);
    assert.equal(relay.of('prompt').filter((x) => x.pendingId === 'b1').length, 0);
    t.now += 120000;
    t.phone.consider([pr], false);
    await until(() => relay.of('prompt').some((x) => x.pendingId === 'b1'), 'b1 after 2 min');
    assert.equal(relay.of('prompt').find((x) => x.pendingId === 'b1').expiresAt, 1_000_000 + 570000);
    t.phone.consider([pend({ id: 'c1', createdAt: t.now - 200000, expiresAt: t.now + 80000 })], false);
    await sleep(50);
    assert.equal(relay.of('prompt').filter((x) => x.pendingId === 'c1').length, 0);
    t.phone.consider([pend({ id: 'd1', createdAt: t.now - 40000, expiresAt: t.now + 50000 })], true);
    await sleep(50);
    assert.equal(relay.of('prompt').filter((x) => x.pendingId === 'd1').length, 0);
    check('rules: away at once, 2-minute rule, 60 s floor, PermissionRequest expiry');
    t.phone.panelMessage({ type: 'phone-settings', mode: 'everything' });
    t.phone.consider([pend({ id: 'e1', createdAt: t.now, expiresAt: t.now + 90000 })], false);
    await until(() => relay.of('prompt').some((x) => x.pendingId === 'e1'), 'e1');
    check('rules: everything sends at once');
    relay.send({ type: 'prompt-failed', pendingId: 'e1', reason: 'no-credit' });
    await until(() => t.phone.view().sent.e1 === 'failed:no-credit', 'failed');
    check('rules: prompt-failed recorded');
    t.phone.consider([pend({ id: 'f1', createdAt: t.now, expiresAt: t.now + 90000 })], false);
    await until(() => relay.of('prompt').some((x) => x.pendingId === 'f1'), 'f1');
    const before = relay.of('prompt-closed').length;
    t.phone.closed('f1', 'answered');
    await until(() => relay.of('prompt-closed').length === before + 1, 'prompt-closed');
    assert.deepEqual(relay.of('prompt-closed').at(-1), { type: 'prompt-closed', pendingId: 'f1', why: 'answered' });
    t.phone.closed('a1', 'timeout');
    await until(() => relay.of('prompt-closed').length === before + 2, 'prompt-closed a1');
    assert.equal(t.phone.view().sent.a1, undefined);
    t.phone.closed('never-sent', 'gone');
    await sleep(50);
    assert.equal(relay.of('prompt-closed').length, before + 2);
    check('closed: sent for known prompts only, clears sent');
    for (const l of t.logs) assert.ok(!l.includes('"ls"') && !/\+27\d{9}/.test(l), l);
    check('logs carry no prompt text or number');
  }

  // extend
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    await linked(t, relay);
    t.phone.panelMessage({ type: 'phone-settings', enabled: true });
    t.phone.consider([pend({ id: 'x1', hookEvent: 'PermissionRequest', expiresAt: 1_000_000 + 300000 }), pend({ id: 'x2' })], true);
    await until(() => relay.of('prompt').length === 2, 'two prompts');
    relay.send({ type: 'prompt-sent', pendingId: 'x1' });
    relay.send({ type: 'prompt-sent', pendingId: 'x2' });
    await until(() => t.phone.view().sent.x2 === 'sent' && t.phone.view().sent.x1 === 'sent', 'both sent');
    assert.deepEqual(t.extended, ['x1']);
    check('extend: extendHold once for PermissionRequest, not for PreToolUse');
  }

  // presence: another machine's panel in use means no 2-minute rule; "everything" still sends
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    await linked(t, relay);
    const pr = pend({ id: 'w1', hookEvent: 'PermissionRequest', expiresAt: 1_000_000 + 300000 });
    t.now += 120000;
    t.phone.consider([pr], false, true);
    await sleep(50);
    assert.equal(relay.of('prompt').length, 0, 'not sent while a panel reports active');
    t.phone.consider([pr], false, false);
    await until(() => relay.of('prompt').some((x) => x.pendingId === 'w1'), 'sent by the 2-minute rule once nobody is active');
    t.phone.panelMessage({ type: 'phone-settings', mode: 'everything' });
    t.phone.consider([pend({ id: 'w2', createdAt: t.now, expiresAt: t.now + 90000 })], false, true);
    await until(() => relay.of('prompt').some((x) => x.pendingId === 'w2'), '"everything" sends whatever the presence');
    check('presence: no 2-minute rule while a panel reports active; "everything" still sends');
  }

  // decide
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    const acks = () => relay.of('decide-ack');
    await connecting(t);
    // unlinked: refused
    relay.send({ type: 'decide', pendingId: 'p9', decision: { behavior: 'allow' } });
    await until(() => acks().length === 1, 'ack unlinked');
    assert.deepEqual(acks()[0], { type: 'decide-ack', pendingId: 'p9', ok: false, reason: 'unknown' });
    relay.send(LINKED);
    await until(() => t.phone.view().linked, 'linked');
    // never sent: refused
    relay.send({ type: 'decide', pendingId: 'nope', decision: { behavior: 'allow' } });
    await until(() => acks().length === 2, 'ack unknown');
    assert.equal(acks()[1].reason, 'unknown');
    assert.deepEqual(t.decided, []);
    check('decide: unknown pendingId or unlinked -> ok:false unknown, callback not called');

    t.phone.consider([pend({ id: 'p9' }), pend({ id: 'p8' }), pend({ id: 'p7' }), pend({ id: 'p6' })], true);
    await until(() => relay.of('prompt').length === 4, 'prompts');
    // in flight counts as known
    relay.send({ type: 'decide', pendingId: 'p9', decision: { behavior: 'allow', always: true, extra: 1 } });
    await until(() => acks().length === 3, 'ack ok');
    assert.deepEqual(t.decided, [['p9', { behavior: 'allow' }]]);
    assert.deepEqual(acks()[2], { type: 'decide-ack', pendingId: 'p9', ok: true });
    check('decide: callback gets {behavior:allow} only, never always; ack ok');

    relay.send({ type: 'decide', pendingId: 'p8', decision: { behavior: 'maybe' } });
    await until(() => acks().length === 4, 'ack bad');
    assert.equal(acks()[3].reason, 'bad-decision');
    relay.send({ type: 'decide', pendingId: 'p8', decision: { behavior: 'deny', message: 'x'.repeat(201) } });
    relay.send({ type: 'decide', pendingId: 'p8', decision: { answers: { q: 1 } } });
    relay.send({ type: 'decide', pendingId: 'p8', decision: null });
    await until(() => acks().length === 7, 'acks bad');
    assert.ok(acks().slice(3).every((a) => !a.ok && a.reason === 'bad-decision'));
    assert.equal(t.decided.length, 1);
    relay.send({ type: 'decide', pendingId: 'p8', decision: { behavior: 'deny', message: 'no' } });
    relay.send({ type: 'decide', pendingId: 'p7', decision: { answers: { q: 'a' }, always: true } });
    await until(() => t.decided.length === 3, 'valid shapes');
    assert.deepEqual(t.decided[1], ['p8', { behavior: 'deny', message: 'no' }]);
    assert.deepEqual(t.decided[2], ['p7', { answers: { q: 'a' } }]);
    check('decide: bad shapes -> bad-decision; deny and answers pass with only allowed fields');

    t.phone.panelMessage({ type: 'phone-settings', enabled: false });
    relay.send({ type: 'decide', pendingId: 'p6', decision: { behavior: 'allow' } });
    await until(() => acks().length === 10, 'ack disabled');
    assert.equal(acks().at(-1).reason, 'unknown');
    assert.equal(t.decided.length, 3);
    check('decide: disabled -> unknown, callback not called');
  }

  // throwing callbacks and failed writes do not crash
  {
    const relay = await fakeRelay();
    const t = setup(relay, {
      decide: () => { throw new Error('boom'); },
      extendHold: () => { throw new Error('boom'); },
    });
    await linked(t, relay);
    t.phone.panelMessage({ type: 'phone-settings', enabled: true });
    t.phone.consider([pend({ id: 'z1', hookEvent: 'PermissionRequest', expiresAt: 1_000_000 + 300000 })], true);
    await until(() => relay.of('prompt').length === 1, 'prompt');
    relay.send({ type: 'prompt-sent', pendingId: 'z1' });
    await until(() => t.logs.some((l) => l.includes('extendHold failed')), 'extendHold failure logged');
    assert.equal(t.phone.view().sent.z1, 'sent');
    relay.send({ type: 'decide', pendingId: 'z1', decision: { behavior: 'allow' } });
    await until(() => relay.of('decide-ack').length === 1, 'ack');
    assert.equal(relay.of('decide-ack')[0].ok, false);
    check('throwing extendHold/decide are logged and do not crash');
  }
  {
    const relay = await fakeRelay();
    let boom = false;
    const t = setup(relay, { onChange: () => { if (boom) throw new Error('boom'); } });
    await connecting(t);
    boom = true;
    relay.send(LINKED);
    await until(() => t.phone.view().linked, 'linked despite throwing onChange');
    assert.ok(t.logs.some((l) => l.includes('onChange failed')));
    // a failed write is logged, not thrown, and leaves no tmp file
    fs.rmSync(t.home, { recursive: true, force: true });
    fs.writeFileSync(t.home, 'not a directory');
    t.phone.panelMessage({ type: 'phone-settings', mode: 'everything' });
    assert.ok(t.logs.some((l) => l.includes('could not save')));
    fs.rmSync(t.home, { force: true });
    check('throwing onChange and failed save are logged and do not crash');
  }

  // handshake that never completes
  {
    let conns = 0;
    const socks = [];
    const srv = net.createServer((sock) => { conns++; socks.push(sock); sock.on('error', () => {}); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => { for (const x of socks) x.destroy(); srv.close(r); }));
    const t = setup({ url: `ws://127.0.0.1:${srv.address().port}` }, { handshakeTimeout: 200 });
    t.phone.start();
    startLink(t);
    await until(() => conns >= 2, 'retry after handshake timeout', 6000);
    assert.equal(t.phone.view().connected, false);
    assert.equal(t.phone.view().error, 'relay-unreachable', 'a link that can\'t connect says so');
    check('handshake: a server that never upgrades times out and the client retries');
  }

  // relay url rules
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    await connecting(t);
    for (const bad of ['ws://example.com/link', 'http://x', 'wss://', 'garbage']) {
      t.phone.panelMessage({ type: 'phone-settings', relay: bad });
      assert.equal(t.phone.view().relay, relay.url, bad);
      assert.equal(t.phone.view().error, 'bad-relay');
    }
    t.phone.panelMessage({ type: 'phone-settings', relay: ` ${relay.url}/link ` });
    assert.equal(t.phone.view().relay, `${relay.url}/link`);
    assert.equal(t.phone.view().error, '');
    startLink(t);
    await until(() => relay.connections === 2, 'reconnect with loopback ws');
    t.phone.panelMessage({ type: 'phone-settings', relay: 'wss://relay.example.com/link' });
    assert.equal(t.phone.view().relay, 'wss://relay.example.com/link');
    t.phone.stop();
    const bad = setup(relay, { relayUrl: 'ws://example.com/x' });
    bad.phone.start();
    await sleep(50);
    assert.equal(bad.phone.view().relay, '');
    assert.equal(bad.phone.view().error, 'bad-relay');
    assert.equal(bad.phone.view().connected, false);
    check('relay url: wss and loopback ws accepted; ws to other hosts, junk rejected with bad-relay');
  }

  // relay change rotates the key
  {
    const relay = await fakeRelay();
    const relay2 = await fakeRelay();
    const t = setup(relay);
    await linked(t, relay);
    assert.equal(t.phone.view().enabled, true);
    await until(() => relay.auths.length === 1, 'auth');
    t.phone.panelMessage({ type: 'phone-settings', relay: relay2.url });
    await sleep(200);
    assert.equal(relay2.connections, 0, 'unlinked by the change: no connection to the new relay yet');
    startLink(t);
    await until(() => relay2.connections === 1, 'second relay');
    assert.notEqual(relay2.auths[0], relay.auths[0]);
    const v = t.phone.view();
    assert.equal(v.linked, false); assert.equal(v.enabled, false); assert.equal(v.number, null);
    const st = JSON.parse(fs.readFileSync(path.join(t.home, 'phone.json'), 'utf8'));
    assert.equal(relay2.auths[0], 'Bearer ' + st.key);
    assert.equal(st.lastStatus, null);
    check('relay change: new key, unlinked, disabled');
  }

  // isApprover
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    assert.equal(t.phone.isApprover(true), false);
    await connecting(t);
    assert.equal(t.phone.isApprover(true), false);
    relay.send(LINKED);
    await until(() => t.phone.view().linked, 'linked');
    assert.equal(t.phone.isApprover(true), true);
    assert.equal(t.phone.isApprover(false), false);
    t.phone.panelMessage({ type: 'phone-settings', mode: 'everything' });
    assert.equal(t.phone.isApprover(false), true);
    t.phone.panelMessage({ type: 'phone-settings', enabled: false });
    assert.equal(t.phone.isApprover(true), false);
    t.phone.panelMessage({ type: 'phone-settings', enabled: true });
    for (const s of relay.socks) s.terminate();
    await until(() => !t.phone.view().connected, 'disconnect');
    assert.equal(t.phone.isApprover(true), false);
    assert.equal(t.phone.view().linked, true);
    check('isApprover: false when unlinked, disabled, disconnected, or away-mode and not away');
  }

  // reconnect
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    await linked(t, relay);
    t.phone.panelMessage({ type: 'phone-settings', enabled: true });
    t.phone.consider([pend({ id: 'r1' })], true);
    await until(() => relay.of('prompt').length === 1, 'prompt');
    relay.socks.at(-1).close();
    await until(() => relay.connections === 2, 'reconnect', 5000);
    await until(() => relay.of('hello').length === 2, 'second hello');
    await until(() => t.phone.view().connected, 'connected again');
    t.phone.consider([pend({ id: 'r1' })], true);
    await until(() => relay.of('prompt').length === 2, 're-sent prompt');
    check('reconnect: server close -> client reconnects, hello again, in-flight re-sent');
  }

  // stop
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    await linked(t, relay);
    t.phone.stop();
    assert.equal(t.phone.view().connected, false);
    await sleep(1500);
    assert.equal(relay.connections, 1);
    check('stop: closes and does not reconnect');
  }

  // ---------- the link is up only while linking or linked ----------
  const closedOn = (relay, i) => relay.socks[i]?.readyState === WebSocket.CLOSED;
  {
    const relay = await fakeRelay();
    const t = setup(relay, { backoffMinMs: 50 });
    t.phone.start();
    await sleep(300);
    assert.equal(relay.connections, 0, 'a relay is configured, but nothing is linked or linking');
    assert.deepEqual([t.phone.view().connected, t.phone.view().error], [false, '']);
    startLink(t);
    await until(() => relay.of('link-start').length === 1, 'phone-link connects');
    t.phone.panelMessage({ type: 'phone-cancel-link' });
    await until(() => closedOn(relay, 0), 'the link dropped after cancel');
    await sleep(300);
    assert.equal(relay.connections, 1, 'and stays down');
    assert.equal(t.phone.view().connected, false);
    check('relay link: none until phone-link; phone-link connects; cancel disconnects for good');
  }
  {
    const relay = await fakeRelay();
    const t = setup(relay, { backoffMinMs: 50, linkWindowMs: 2000 }); // room for connect + link-code on a slow runner
    t.phone.start();
    startLink(t);
    await until(() => relay.of('link-start').length === 1, 'link-start');
    relay.send({ type: 'link-code', code: 'ABCD2345', expiresAt: t.now + 600000, botNumber: '27600000000' });
    await until(() => t.phone.view().code, 'code');
    await until(() => closedOn(relay, 0), 'the link dropped when the code\'s time ran out', 6000);
    await sleep(300);
    assert.equal(relay.connections, 1);
    assert.equal(t.phone.view().code.code, 'ABCD2345', 'the code stays, shown as expired');
    check('relay link: dropped when the link code\'s time runs out');
  }
  {
    const relay = await fakeRelay();
    relay.reply = (m, ws) => { if (m.type === 'unlink') ws.send(JSON.stringify(UNLINKED)); };
    const t = setup(relay, { backoffMinMs: 50 });
    await linked(t, relay);
    t.phone.panelMessage({ type: 'phone-unlink' });
    await until(() => closedOn(relay, 0), 'the link dropped after unlink');
    await sleep(300);
    assert.equal(relay.connections, 1);
    assert.deepEqual([t.phone.view().linked, t.phone.view().enabled], [false, false]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.home, 'phone.json'), 'utf8')).lastStatus.linked, false);
    // A relay that never answers the unlink: forgotten here after the reply deadline anyway.
    const quiet = await fakeRelay();
    const q = setup(quiet, { backoffMinMs: 50, replyMs: 200 });
    await linked(q, quiet);
    q.phone.panelMessage({ type: 'phone-unlink' });
    await until(() => closedOn(quiet, 0) && !q.phone.view().linked, 'unlinked locally after no answer', 3000);
    await sleep(300);
    assert.equal(quiet.connections, 1);
    check('relay link: dropped after unlink (on the relay\'s answer, or after 20 s without one)');
  }
  {
    // Linked on an earlier run: start() connects. A hello answered "unlinked" ("stop" while away) drops it.
    const relay = await fakeRelay();
    let hello = LINKED;
    relay.reply = (m, ws) => { if (m.type === 'hello') ws.send(JSON.stringify(hello)); };
    const t = setup(relay, { backoffMinMs: 50 });
    linkedOnDisk(t);
    t.phone.start();
    await until(() => t.phone.view().connected && t.phone.view().linked, 'connected at start');
    hello = UNLINKED;
    relay.socks[0].terminate();
    await until(() => relay.connections === 2 && closedOn(relay, 1), 'reconnected, told unlinked, dropped');
    await sleep(300);
    assert.equal(relay.connections, 2);
    assert.equal(t.phone.view().linked, false);
    // junk in phone.json's lastStatus never counts as linked
    const junk = setup(relay, { backoffMinMs: 50 });
    linkedOnDisk(junk, { lastStatus: { linked: 'yes', number: 5, billing: 'gold' } });
    junk.phone.start();
    await sleep(300);
    assert.equal(relay.connections, 2);
    assert.deepEqual([junk.phone.view().linked, junk.phone.view().number, junk.phone.view().billing], [false, null, null]);
    check('relay link: a machine linked on disk connects at start; an unlinked status drops it');
  }
  {
    // Close code 4000: a newer connection with this key took over.
    const relay = await fakeRelay();
    const t = setup(relay, { backoffMinMs: 50, replacedBackoffMs: 700 });
    await linked(t, relay);
    const t0 = Date.now();
    relay.socks[0].close(4000, 'replaced');
    await until(() => t.phone.view().error === 'in-use-elsewhere', 'in-use-elsewhere');
    await sleep(300);
    assert.equal(relay.connections, 1, 'not straight back (the normal backoff here is 50 ms)');
    await until(() => relay.connections === 2, 'back after the long wait', 3000);
    assert.ok(Date.now() - t0 >= 650, 'waited the in-use backoff');
    assert.equal(t.phone.view().error, 'in-use-elsewhere', 'still shown until the link has stayed up');
    check('replaced (4000): error in-use-elsewhere and a long backoff (5 min by default)');
  }
  {
    // Accept, then close at once: the backoff keeps growing, since no connection stays up 30 s.
    const relay = await fakeRelay();
    relay.behave = (ws) => ws.close();
    const t = setup(relay, { backoffMinMs: 40, backoffMaxMs: 5000 });
    linkedOnDisk(t);
    t.phone.start();
    await sleep(1000);
    t.phone.stop();
    // 0, 40, 120, 280, 600 ms (then 1240): about 5. Reset on every open would make it about 20.
    assert.ok(relay.connections >= 3 && relay.connections <= 7, `connections: ${relay.connections}`);
    check('backoff: not reset by a connection that closes straight away');
  }
  {
    // A connection that stays up (150 ms here) resets it: the next try comes after the minimum.
    const relay = await fakeRelay();
    relay.behave = (ws, n) => { if (n <= 4) ws.close(); else if (n === 5) setTimeout(() => ws.close(), 400); };
    const t = setup(relay, { backoffMinMs: 40, backoffMaxMs: 5000, stableMs: 150 });
    linkedOnDisk(t);
    t.phone.start();
    await until(() => relay.connections === 6, 'the sixth connection', 6000);
    const gap = relay.opened[5] - relay.closed[4];
    assert.ok(gap < 400, `reconnected ${gap} ms after a stable connection closed (640 ms without the reset)`);
    check('backoff: reset once a connection has stayed up (30 s by default)');
  }

  // ---------- prompts the relay never answers; balances; relay fields ----------
  {
    const relay = await fakeRelay();
    const t = setup(relay, { replyMs: 200 });
    await linked(t, relay);
    t.phone.consider([pend({ id: 'n1' }), pend({ id: 'n2', hookEvent: 'PermissionRequest', expiresAt: 1_000_000 + 300000 })], true);
    await until(() => relay.of('prompt').length === 2, 'two prompts');
    relay.send({ type: 'prompt-sent', pendingId: 'n2' });
    const before = t.changes;
    await until(() => t.phone.view().sent.n1 === 'failed:no-reply', 'no-reply after the deadline', 3000);
    assert.ok(t.changes > before, 'onChange told');
    await sleep(300);
    assert.equal(t.phone.view().sent.n2, 'sent', 'a confirmed prompt never times out');
    relay.send({ type: 'prompt-sent', pendingId: 'n1' });
    await until(() => t.phone.view().sent.n1 === 'sent', 'a late prompt-sent: the phone has it after all');
    check('a prompt with no prompt-sent or prompt-failed in 20 s is failed:no-reply');

    relay.send({ type: 'prompt-failed', pendingId: 'n2', reason: 'send-failed' });
    await until(() => t.phone.view().sent.n2 === 'failed:send-failed', 'failed after sent');
    relay.send({ type: 'prompt-failed', pendingId: 'ghost', reason: 'send-failed' });
    t.phone.closed('n1', 'answered');
    relay.send({ type: 'prompt-failed', pendingId: 'n1', reason: 'send-failed' });
    relay.send({ type: 'prompt-sent', pendingId: 'n2' });
    await sleep(150);
    assert.deepEqual(t.phone.view().sent, { n2: 'failed:send-failed' }, 'nothing kept for unknown or closed prompts; a failure isn\'t undone');
    check('prompt-failed after prompt-sent marks it failed; unknown or closed ids leave nothing');
  }
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    await linked(t, relay);
    const onDisk = () => JSON.parse(fs.readFileSync(path.join(t.home, 'phone.json'), 'utf8')).lastStatus.balanceMicroUsd;
    t.phone.consider([pend({ id: 'm1' })], true);
    await until(() => relay.of('prompt').length === 1, 'prompt');
    relay.send({ type: 'prompt-sent', pendingId: 'm1', balanceMicroUsd: 4880 });
    await until(() => t.phone.view().balanceMicroUsd === 4880, 'the credit drops after prompt-sent');
    assert.equal(onDisk(), 4880);
    relay.send({ type: 'decide', pendingId: 'm1', decision: { behavior: 'allow' }, balanceMicroUsd: 4760 });
    await until(() => t.phone.view().balanceMicroUsd === 4760, 'and after decide');
    relay.send({ type: 'prompt-failed', pendingId: 'other', reason: 'no-credit', balanceMicroUsd: 0 });
    await until(() => t.phone.view().balanceMicroUsd === 0, 'and after prompt-failed');
    for (const bad of ['lots', null, Infinity, { n: 1 }]) relay.send({ type: 'prompt-sent', pendingId: 'm1', balanceMicroUsd: bad });
    await sleep(100);
    assert.equal(t.phone.view().balanceMicroUsd, 0);
    assert.equal(onDisk(), 0);
    check('credit: prompt-sent, decide and prompt-failed update the balance in view() and phone.json');
  }
  {
    // M3: a link that completes long after this machine asked doesn't turn approvals on by itself.
    const relay = await fakeRelay();
    const t = setup(relay);
    t.phone.start();
    startLink(t);
    await until(() => relay.of('link-start').length === 1, 'link-start');
    t.now += 11 * 60000;
    relay.send(LINKED);
    await until(() => t.phone.view().linked, 'linked');
    assert.equal(t.phone.view().enabled, false);
    check('a link that completes over 10 minutes after this machine\'s link-start leaves approvals off');
  }
  {
    // M4: fields from the relay are type-checked before they're kept or shown.
    const relay = await fakeRelay();
    const t = setup(relay);
    await connecting(t);
    relay.send({ type: 'link-code', code: 12345, expiresAt: 1 });
    relay.send({ type: 'link-code', code: 'ABCD2345', expiresAt: 'soon', botNumber: { x: 1 } });
    await until(() => t.phone.view().code, 'a code');
    assert.deepEqual(t.phone.view().code, { code: 'ABCD2345', expiresAt: t.now + 600000, botNumber: null });
    relay.send({ type: 'error', reason: 'x'.repeat(500) });
    await until(() => t.phone.view().error === 'error', 'a long reason is replaced');
    relay.send({ type: 'error', reason: '<b>hi</b>' });
    await sleep(50);
    assert.equal(t.phone.view().error, 'error');
    relay.send({ type: 'status', linked: true, number: 27821234567, balanceMicroUsd: '5000', billing: 'gold', botNumber: ['x'] });
    await until(() => t.phone.view().linked, 'linked');
    const v = t.phone.view();
    assert.deepEqual([v.number, v.balanceMicroUsd, v.billing, v.botNumber], [null, null, null, null]);
    t.phone.consider([pend({ id: 'k1' })], true);
    await until(() => relay.of('prompt').length === 1, 'prompt');
    relay.send({ type: 'prompt-failed', pendingId: 'k1', reason: 'a b; c' });
    await until(() => t.phone.view().sent.k1, 'failed');
    assert.equal(t.phone.view().sent.k1, 'failed:unknown');
    check('relay fields are type-checked: number, botNumber and code strings, balance a number, billing known, reasons short words');
  }

  await integration();

  await daemonChecks();

  await runCleanups();
  console.log(`${passed} checks passed`);
}
main().then(() => process.exit(0), async (e) => {
  console.error(e);
  for (const d of daemons) {
    try { console.error(`--- ${d.name} daemon.log (end)\n` + fs.readFileSync(d.logFile, 'utf8').slice(-3000)); } catch { /* no log */ }
  }
  await runCleanups(); // held hooks and test daemons must not outlive a failed run
  process.exit(1);
});
