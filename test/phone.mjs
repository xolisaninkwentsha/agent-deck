// Tests for the daemon's phone client, against a fake relay.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { createPhone, DEFAULT_RELAY_URL } from '../src/phone.mjs';

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
    port = 47000 + Math.floor(Math.random() * 800);
    try {
      wss = new WebSocketServer({ port, host: '127.0.0.1' });
      await new Promise((res, rej) => { wss.once('listening', res); wss.once('error', rej); });
      break;
    } catch { /* port busy, retry */ }
  }
  const relay = { url: `ws://127.0.0.1:${port}`, auths: [], got: [], socks: [], connections: 0 };
  wss.on('connection', (ws, req) => {
    relay.connections++;
    relay.auths.push(req.headers.authorization);
    relay.socks.push(ws);
    ws.on('message', (d) => {
      const s = d.toString();
      if (s === 'ping') return ws.send('pong');
      relay.got.push(JSON.parse(s));
    });
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
async function linked(t, relay) {
  t.phone.start();
  await until(() => t.phone.view().connected, 'connect');
  relay.send(LINKED);
  await until(() => t.phone.view().linked, 'linked');
}
const pend = (o) => ({ id: 'p1', hookEvent: 'PreToolUse', toolName: 'Bash', toolInput: { command: 'ls' }, project: 'proj', questions: null, createdAt: 1_000_000, expiresAt: 1_000_000 + 90000, ...o });

async function main() {
  assert.equal(DEFAULT_RELAY_URL, '');

  // key
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    t.phone.start();
    await until(() => t.phone.view().connected, 'connect');
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
    await until(() => t.phone.view().connected, 'connect');
    t.phone.panelMessage({ type: 'phone-link', number: '  +27•••••4567 ' });
    await until(() => relay.of('link-start').length === 1, 'link-start');
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
    t.phone.start();
    await until(() => t.phone.view().connected, 'connect');
    t.phone.panelMessage({ type: 'phone-settings', enabled: 'yes', mode: 'bogus', relay: 'http://x' });
    let v = t.phone.view();
    assert.equal(v.enabled, false); assert.equal(v.mode, 'away'); assert.equal(v.relay, relay.url);
    t.phone.panelMessage({ type: 'phone-settings', enabled: true, mode: 'everything' });
    v = t.phone.view();
    assert.equal(v.enabled, true); assert.equal(v.mode, 'everything');
    const st = JSON.parse(fs.readFileSync(path.join(t.home, 'phone.json'), 'utf8'));
    assert.equal(st.enabled, true); assert.equal(st.mode, 'everything');
    t.phone.panelMessage({ type: 'phone-settings', relay: relay2.url });
    await until(() => relay2.connections === 1, 'reconnect to new relay');
    assert.equal(t.phone.view().relay, relay2.url);
    check('settings: invalid fields ignored, valid persisted, relay change reconnects');
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

  // decide
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    const acks = () => relay.of('decide-ack');
    t.phone.start();
    await until(() => t.phone.view().connected, 'connect');
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
    t.phone.start();
    await until(() => t.phone.view().connected, 'connect');
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
    await until(() => conns >= 2, 'retry after handshake timeout', 6000);
    assert.equal(t.phone.view().connected, false);
    check('handshake: a server that never upgrades times out and the client retries');
  }

  // relay url rules
  {
    const relay = await fakeRelay();
    const t = setup(relay);
    t.phone.start();
    await until(() => t.phone.view().connected, 'connect');
    for (const bad of ['ws://example.com/link', 'http://x', 'wss://', 'garbage']) {
      t.phone.panelMessage({ type: 'phone-settings', relay: bad });
      assert.equal(t.phone.view().relay, relay.url, bad);
      assert.equal(t.phone.view().error, 'bad-relay');
    }
    t.phone.panelMessage({ type: 'phone-settings', relay: ` ${relay.url}/link ` });
    assert.equal(t.phone.view().relay, `${relay.url}/link`);
    assert.equal(t.phone.view().error, '');
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
    t.phone.start();
    await until(() => t.phone.view().connected, 'connect');
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

  for (const c of cleanups.reverse()) await c();
  console.log(`${passed} checks passed`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
