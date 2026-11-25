// Unit tests for the relay's WhatsApp module: payloads, webhook parsing, signature check, sender.
import assert from 'node:assert/strict';
import { verifySignature, parseWebhook, promptMessage, textMessage, templateMessage, createSender } from '../relay/src/whatsapp.js';
import { MemoryStore } from '../relay/src/memory-store.js';
import { CODE_ALPHABET, newCode, findCode, newRef, sha256Hex, normalizeNumber, maskNumber } from '../relay/src/ids.js';
import { priceFor, reserve, release } from '../relay/src/credit.js';
import { createRelay } from '../relay/src/core.js';
import { parseEnv } from '../relay/src/env.js';

let passed = 0;
const check = (name) => { passed++; console.log(`  ✓ ${name}`); };

async function sign(body, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const hook = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'PN' }, ...value } }] }] });

async function main() {
  // signatures
  const body = '{"entry":[]}';
  const good = await sign(body, 'shh');
  assert.equal(await verifySignature(body, good, 'shh'), true);
  assert.equal(await verifySignature(body + ' ', good, 'shh'), false);
  assert.equal(await verifySignature(body, good, 'other'), false);
  assert.equal(await verifySignature(body, null, 'shh'), false);
  assert.equal(await verifySignature(body, '', 'shh'), false);
  assert.equal(await verifySignature(body, good.slice(7), 'shh'), false);
  assert.equal(await verifySignature(body, 'sha256=zz', 'shh'), false);
  assert.equal(await verifySignature(body, good.slice(0, -2), 'shh'), false);
  check('verifySignature accepts a valid HMAC and rejects tampered, missing or malformed ones');

  // parseWebhook
  const btn = parseWebhook(hook({ messages: [{ from: '27820000000', id: 'wamid.B', timestamp: '1700000000', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'r1:allow', title: 'Allow' } } }] }));
  assert.deepEqual(btn, { inbound: [{ id: 'wamid.B', from: '27820000000', ts: 1700000000000, buttonId: 'r1:allow' }], statuses: [] });
  const lst = parseWebhook(hook({ messages: [{ from: '27820000000', id: 'wamid.L', timestamp: '1700000001', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'r1:q0:o4', title: 'Five' } } }] }));
  assert.equal(lst.inbound[0].buttonId, 'r1:q0:o4');
  const tpl = parseWebhook(hook({ messages: [{ from: '27820000000', id: 'wamid.T', timestamp: '1700000002', type: 'button', button: { payload: 'r1:show', text: 'Show' } }] }));
  assert.equal(tpl.inbound[0].buttonId, 'r1:show');
  check('parseWebhook reads button, list and template-button replies');

  const txt = parseWebhook(hook({ messages: [{ from: '27820000000', id: 'wamid.X', timestamp: '1700000003', type: 'text', text: { body: '1 3' }, context: { id: 'wamid.Q' } }] }));
  assert.deepEqual(txt.inbound, [{ id: 'wamid.X', from: '27820000000', ts: 1700000003000, text: '1 3', contextId: 'wamid.Q' }]);
  const st = parseWebhook(hook({ statuses: [{ id: 'wamid.S', status: 'failed', recipient_id: '27820000000', timestamp: '1700000004' }] }));
  assert.deepEqual(st, { inbound: [], statuses: [{ id: 'wamid.S', status: 'failed', recipient: '27820000000' }] });
  check('parseWebhook reads text with context and statuses, ts in ms');

  const empty = { inbound: [], statuses: [] };
  for (const bad of [null, undefined, 'x', 5, [], {}, { entry: 'x' }, { entry: [null, 3, { changes: 'x' }, { changes: [null, { value: 'x' }, { value: { messages: 'x', statuses: 7 } }] }] }, { entry: [{ changes: [{ value: { messages: [null, 4, {}, { from: 1 }] } }] }] }]) {
    assert.deepEqual(parseWebhook(bad), empty);
  }
  check('parseWebhook never throws on malformed bodies');

  // promptMessage
  const approval = { kind: 'approval', project: 'deck', title: 'Run Bash', detail: 'npm test', questions: [] };
  const a = promptMessage('2782', 'r1', approval, 0);
  assert.equal(a.messaging_product, 'whatsapp');
  assert.equal(a.recipient_type, 'individual');
  assert.equal(a.to, '2782');
  assert.equal(a.type, 'interactive');
  assert.deepEqual(a.interactive.action.buttons.map((b) => b.reply.id), ['r1:allow', 'r1:deny']);
  assert.deepEqual(a.interactive.action.buttons.map((b) => b.reply.title), ['Allow', 'Deny']);
  assert.equal(a.interactive.body.text, 'deck · Claude wants to run bash\n\nnpm test');
  assert.equal(a.interactive.footer, undefined);
  check('approval gives Allow/Deny buttons, no footer');

  const plan = promptMessage('2782', 'r2', { kind: 'plan', project: 'deck', title: 'Plan', detail: 'Do it', questions: [] }, 0);
  assert.deepEqual(plan.interactive.action.buttons.map((b) => b.reply.id), ['r2:approve', 'r2:plan']);
  assert.deepEqual(plan.interactive.action.buttons.map((b) => b.reply.title), ['Approve', 'Keep planning']);
  assert.equal(plan.interactive.body.text, 'deck · Plan to approve\n\nDo it');
  assert.equal(plan.interactive.footer, undefined);
  check('plan gives Approve/Keep planning buttons');

  const q = (options, multiSelect = false) => ({ kind: 'question', project: 'deck', title: 'Q', detail: '', questions: [{ question: 'Which?', header: 'Pick', multiSelect, options }] });
  const q3 = promptMessage('2782', 'r1', q(['A', 'B', 'C']), 0);
  assert.equal(q3.interactive.type, 'button');
  assert.deepEqual(q3.interactive.action.buttons.map((b) => b.reply.id), ['r1:q0:o0', 'r1:q0:o1', 'r1:q0:o2']);
  assert.equal(q3.interactive.body.text, 'deck · Pick: Which?');
  assert.equal(q3.interactive.footer.text, 'Or reply with your own answer');
  const opts5 = ['One', 'Two', 'Three', 'Four', 'Five with a long label that exceeds the limit'];
  const q5 = promptMessage('2782', 'r1', q(opts5), 0);
  assert.equal(q5.interactive.type, 'list');
  assert.equal(q5.interactive.action.button, 'Choose');
  const rows = q5.interactive.action.sections[0].rows;
  assert.equal(rows.length, 5);
  assert.equal(rows[4].id, 'r1:q0:o4');
  assert.ok(rows.every((r) => r.title.length <= 24));
  assert.equal(rows[4].title.length, 24);
  assert.ok(rows[4].title.endsWith('…'));
  assert.equal(rows[4].description, opts5[4]);
  assert.equal(rows[0].description, undefined);
  assert.equal(q5.interactive.footer.text, 'Or reply with your own answer');
  const qm = promptMessage('2782', 'r1', q(['Alpha', 'Beta'], true), 0);
  assert.equal(qm.type, 'text');
  assert.ok(qm.text.body.includes('1. Alpha') && qm.text.body.includes('2. Beta'));
  assert.ok(qm.text.body.endsWith('Reply to this message with the numbers, e.g. 1 3'));
  const q11 = promptMessage('2782', 'r1', q(Array.from({ length: 11 }, (_, i) => `O${i}`)), 0);
  assert.equal(q11.type, 'text');
  assert.ok(q11.text.body.includes('11. O10'));
  const q10 = promptMessage('2782', 'r1', q(Array.from({ length: 10 }, (_, i) => `O${i}`)), 0);
  assert.equal(q10.interactive.action.sections[0].rows.length, 10);
  check('questions: buttons, list, and numbered text');

  const long = promptMessage('2782', 'r1', q(['x'.repeat(30), 'B']), 0);
  const t = long.interactive.action.buttons[0].reply.title;
  assert.ok(t.length <= 20 && t.endsWith('…'));
  assert.equal(t, 'x'.repeat(19) + '…');
  check('long option titles are cut with an ellipsis');

  const big = promptMessage('2782', 'r1', { ...approval, detail: 'd'.repeat(5000) }, 0);
  assert.ok(big.interactive.body.text.length <= 1024 && big.interactive.body.text.endsWith('…'));
  const bigQ = promptMessage('2782', 'r1', q(Array.from({ length: 12 }, () => 'y'.repeat(200)), true), 0);
  assert.ok(bigQ.text.body.length <= 1024);
  assert.ok(bigQ.text.body.endsWith('e.g. 1 3'));
  check('bodies are capped at 1024');

  // text and template
  assert.deepEqual(textMessage('2782', 'hi'), { messaging_product: 'whatsapp', recipient_type: 'individual', to: '2782', type: 'text', text: { body: 'hi' } });
  assert.deepEqual(textMessage('2782', 'hi', 'wamid.Q').context, { message_id: 'wamid.Q' });
  const tm = templateMessage('2782', 'r1', approval, { name: 'approval_nudge', lang: 'en' });
  assert.equal(tm.type, 'template');
  assert.equal(tm.template.name, 'approval_nudge');
  assert.deepEqual(tm.template.language, { code: 'en' });
  assert.deepEqual(tm.template.components[0], { type: 'body', parameters: [{ type: 'text', text: 'deck' }, { type: 'text', text: 'Run Bash' }] });
  assert.deepEqual(tm.template.components[1], { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'r1:show' }] });
  check('text and template messages');

  // sender
  const calls = [];
  const resp = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
  const mk = (impl) => createSender({ fetch: async (...a) => { calls.push(a); return impl(); }, token: 'TOK', phoneNumberId: 'PN', graphVersion: 'v21.0' });
  const ok = await mk(() => resp(200, { messages: [{ id: 'wamid.OUT' }] })).send({ a: 1 });
  assert.deepEqual(ok, { ok: true, id: 'wamid.OUT' });
  assert.equal(calls[0][0], 'https://graph.facebook.com/v21.0/PN/messages');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer TOK');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  assert.equal(calls[0][1].body, '{"a":1}');
  const bad = await mk(() => resp(400, { error: { message: 'secret detail' } })).send({});
  assert.equal(bad.ok, false);
  assert.ok(typeof bad.error === 'string' && bad.error.includes('400') && !bad.error.includes('secret'));
  const rej = await createSender({ fetch: async () => { throw new Error('boom'); }, token: 't', phoneNumberId: 'p', graphVersion: 'v1' }).send({});
  assert.equal(rej.ok, false);
  assert.equal(typeof rej.error, 'string');
  const noId = await mk(() => resp(200, {})).send({});
  assert.equal(noId.ok, false);
  const badJson = await mk(() => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } })).send({});
  assert.equal(badJson.ok, false);
  check('createSender returns ok/id, or ok:false without throwing');

  // store
  const mstore = new MemoryStore();
  assert.equal(await mstore.get('nope'), undefined);
  const origVal = { a: { n: 1 } };
  await mstore.put('b:2', origVal);
  origVal.a.n = 99;
  const stored = await mstore.get('b:2');
  assert.deepEqual(stored, { a: { n: 1 } });
  stored.a.n = 5;
  assert.deepEqual(await mstore.get('b:2'), { a: { n: 1 } });
  await mstore.put('b:1', 'x');
  await mstore.put('c:1', 'y');
  const lst2 = await mstore.list('b:');
  assert.ok(lst2 instanceof Map);
  assert.deepEqual([...lst2.keys()], ['b:1', 'b:2']);
  await mstore.delete('b:1');
  assert.equal(await mstore.get('b:1'), undefined);
  assert.equal((await mstore.list('b:')).size, 1);
  check('MemoryStore get/put/delete/list store clones and list by prefix in key order');

  // numbers
  assert.equal(normalizeNumber('+27 82 123-4567'), '27821234567');
  assert.equal(normalizeNumber('0027821234567'), '27821234567');
  assert.equal(normalizeNumber('082 123 4567'), null);
  assert.equal(normalizeNumber('+1 (415) 555-0100'), '14155550100');
  assert.equal(normalizeNumber('12'), null);
  assert.equal(normalizeNumber('27.82.123.4567'), '27821234567');
  assert.equal(normalizeNumber('27821234567'), '27821234567');
  assert.equal(normalizeNumber('+1234567'), null);
  assert.equal(normalizeNumber('+1234567890123456'), null);
  assert.equal(normalizeNumber('+12345678'), '12345678');
  assert.equal(normalizeNumber('+27abc821234567'), null);
  assert.equal(normalizeNumber('+27 (0)82 123 4567'), '27821234567');
  assert.equal(normalizeNumber('+27 ( 0 ) 82 123 4567'), '27821234567');
  assert.equal(normalizeNumber('+0821234567'), null);
  assert.equal(normalizeNumber('00 0821234567'), null);
  assert.equal(normalizeNumber(''), null);
  assert.equal(normalizeNumber(undefined), null);
  assert.equal(maskNumber('27821234567'), '+27•••••4567');
  check('normalizeNumber and maskNumber');

  // codes
  assert.equal(findCode('code: abcd-2345'), 'ABCD2345');
  assert.equal(findCode('hello'), null);
  assert.equal(findCode('ABCD 2345 please'), 'ABCD2345');
  assert.equal(findCode('abcd2345'), 'ABCD2345');
  assert.equal(findCode('xABCD2345'), null);
  assert.equal(findCode('ABCD23456'), null);
  assert.equal(findCode('ABCD-23456'), null);
  assert.equal(findCode('1ABCD-2345'), null);
  assert.equal(findCode('ABCD2345!'), 'ABCD2345');
  assert.equal(findCode('ABCI2345'), null);
  assert.equal(findCode('ABCDEFGHJ ABCD2345'), 'ABCD2345');
  for (let i = 0; i < 200; i++) assert.match(newCode(), /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  for (let i = 0; i < 200; i++) assert.match(newRef(), /^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/);
  assert.equal(CODE_ALPHABET, 'ABCDEFGHJKMNPQRSTUVWXYZ23456789');
  assert.notEqual(newCode(), newCode());
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  check('codes, refs and sha256Hex');

  // credit
  const cfg = { rates: { default: 10000, '27': 9500, '2771': 5000 }, markupPercent: 20, billing: 'trial' };
  assert.equal(priceFor('27821234567', cfg), 11400);
  assert.equal(priceFor('447000000000', cfg), 12000);
  assert.equal(priceFor('27711234567', cfg), 6000);
  assert.equal(priceFor('27821234567', { ...cfg, billing: 'off' }), 0);
  const acct = { balance: 20000, sent: [] };
  assert.deepEqual(reserve(acct, 11400, 1000, 60), { ok: true });
  assert.equal(acct.balance, 8600);
  assert.deepEqual(reserve(acct, 11400, 2000, 60), { ok: false, reason: 'no-credit' });
  assert.equal(acct.balance, 8600);
  assert.equal(acct.sent.length, 1);
  release(acct, 11400);
  assert.equal(acct.balance, 20000);
  assert.equal(acct.sent.length, 0);
  const rich = { balance: 1e9, sent: [] };
  for (let i = 0; i < 60; i++) assert.equal(reserve(rich, 1, 1000 + i, 60).ok, true);
  assert.deepEqual(reserve(rich, 1, 2000, 60), { ok: false, reason: 'rate-limited' });
  assert.equal(rich.balance, 1e9 - 60);
  assert.equal(reserve(rich, 1, 1000 + 3600000 + 1, 60).ok, true);
  const edge = { balance: 100, sent: [] };
  assert.equal(reserve(edge, 1, 5000, 1).ok, true);
  assert.deepEqual(reserve(edge, 1, 5000 + 3599999, 1), { ok: false, reason: 'rate-limited' });
  assert.deepEqual(reserve(edge, 1, 5000 + 3600000, 1), { ok: true });
  const zero = { balance: 0, sent: [] };
  assert.equal(reserve(zero, 0, 1, 2).ok, true);
  assert.equal(reserve(zero, 0, 2, 2).ok, true);
  assert.deepEqual(reserve(zero, 0, 3, 2), { ok: false, reason: 'rate-limited' });
  check('priceFor, reserve and release');

  // relay core: linking and status
  {
    const config = { botNumber: '27600000000', billing: 'trial', trialMicroUsd: 100000, rates: { default: 10000 }, markupPercent: 20, hourlyCap: 60, codeTtlMs: 600000, windowMs: 86400000, template: { name: 't', lang: 'en' } };
    const price = priceFor('27821234567', config);
    const setup = () => {
      const store = new MemoryStore();
      const sent = [];
      const sender = { send: async (p) => { sent.push(p); return { ok: true, id: 'w' + sent.length }; } };
      const clock = { t: 1700000000000 };
      const relay = createRelay({ store, sender, config, now: () => clock.t });
      return { store, sent, clock, relay };
    };
    const inbound = (id, from, text, ts) => ({ inbound: [{ id, from, text, ts }], statuses: [] });
    const KH = 'kh1';

    // hello + link-start + link
    let { store, sent, clock, relay } = setup();
    let r = await relay.hello(KH, { machine: 'laptop', version: '1' });
    assert.deepEqual(r, [{ type: 'status', linked: false, number: null, balanceMicroUsd: null, billing: 'trial', botNumber: '27600000000' }]);
    r = await relay.machineMessage(KH, { type: 'link-start', number: '+27 82 123 4567' });
    assert.equal(r.length, 1);
    assert.equal(r[0].type, 'link-code');
    assert.equal(r[0].botNumber, '27600000000');
    assert.equal(r[0].expiresAt, clock.t + 600000);
    assert.equal(sent.length, 0);
    const code = r[0].code;
    check('link-start returns a code and sends nothing');

    clock.t += 1000;
    const ts = clock.t;
    let routes = await relay.webhook(inbound('m1', '27821234567', `my code is ${code.slice(0, 4)}-${code.slice(4)} thanks`, ts));
    assert.equal(routes.length, 1);
    assert.equal(routes[0].keyHash, KH);
    assert.equal(routes[0].msg.type, 'status');
    assert.equal(routes[0].msg.linked, true);
    assert.equal(routes[0].msg.number, maskNumber('27821234567'));
    assert.equal(sent.length, 1);
    assert.match(sent[0].text.body, /Connected: laptop/);
    check('valid code links the machine and confirms');
    const acc = await store.get('account:27821234567');
    assert.equal(acc.balance, config.trialMicroUsd - price);
    assert.equal(acc.windowUntil, ts + 86400000);
    assert.deepEqual(acc.machines, [KH]);
    assert.equal((await store.get('machine:' + KH)).number, '27821234567');
    assert.equal(await store.get('code:' + code), undefined);
    check('trial credit minus the confirmation, 24h window');

    // dedupe and code reuse
    routes = await relay.webhook(inbound('m1', '27821234567', code, ts));
    assert.equal(routes.length, 0);
    routes = await relay.webhook(inbound('m2', '27821234567', code, ts));
    assert.equal(routes.length, 0);
    assert.equal(sent.length, 1);
    check('a code works once; duplicate inbound ids are skipped');

    // window tracking
    await relay.webhook(inbound('m3', '27821234567', 'hello', ts + 5000));
    assert.equal((await store.get('account:27821234567')).windowUntil, ts + 5000 + 86400000);
    check('inbound extends the window');

    // stop and unlink
    routes = await relay.webhook(inbound('m4', '27821234567', ' Stop ', ts + 6000));
    assert.deepEqual(routes, [{ keyHash: KH, msg: { type: 'status', linked: false, number: null, balanceMicroUsd: null, billing: 'trial', botNumber: '27600000000' } }]);
    assert.equal(sent.length, 2);
    assert.match(sent[1].text.body, /Disconnected\./);
    assert.deepEqual((await store.get('account:27821234567')).machines, []);
    assert.equal((await store.get('machine:' + KH)).number, null);
    check('stop unlinks every machine and says Disconnected.');

    // wrong number, expired, stray
    ({ store, sent, clock, relay } = setup());
    await relay.hello(KH, { machine: 'laptop', version: '1' });
    r = await relay.machineMessage(KH, { type: 'link-start', number: '27821234567' });
    routes = await relay.webhook(inbound('a1', '27829999999', r[0].code, clock.t));
    assert.equal(routes.length + sent.length, 0);
    assert.equal((await store.get('machine:' + KH)).number, null);
    check('a code from another number does nothing');
    clock.t += 11 * 60000;
    routes = await relay.webhook(inbound('a2', '27821234567', r[0].code, clock.t));
    assert.equal(routes.length + sent.length, 0);
    assert.equal(await store.get('account:27821234567'), undefined);
    check('an expired code does nothing');
    routes = await relay.webhook(inbound('a3', '27821234567', 'hi there', clock.t));
    assert.equal(routes.length + sent.length, 0);
    check('stray text is ignored and free');

    // unlink message
    ({ store, sent, clock, relay } = setup());
    await relay.hello(KH, { machine: 'laptop', version: '1' });
    r = await relay.machineMessage(KH, { type: 'link-start', number: '27821234567' });
    await relay.webhook(inbound('b1', '27821234567', r[0].code, clock.t));
    r = await relay.machineMessage(KH, { type: 'unlink' });
    assert.equal(r.length, 1);
    assert.equal(r[0].linked, false);
    assert.deepEqual((await store.get('account:27821234567')).machines, []);
    check('unlink returns an unlinked status');

    // rate limit, bad number
    r = await relay.machineMessage(KH, { type: 'link-start', number: 'nope' });
    assert.deepEqual(r, [{ type: 'error', op: 'link-start', reason: 'bad-number' }]);
    for (let i = 0; i < 3; i++) r = await relay.machineMessage(KH, { type: 'link-start', number: '27821234567' });
    assert.equal(r[0].type, 'link-code');
    r = await relay.machineMessage(KH, { type: 'link-start', number: '27821234567' });
    assert.deepEqual(r, [{ type: 'error', op: 'link-start', reason: 'rate-limited' }]);
    clock.t += 3600001;
    r = await relay.machineMessage(KH, { type: 'link-start', number: '27821234567' });
    assert.equal(r[0].type, 'link-code');
    check('link-start is limited to 5 per hour, bad numbers count');

    // queue
    ({ store, sent, clock, relay } = setup());
    await relay.queue('kq', { type: 'a' });
    await relay.queue('kq', { type: 'b' }, clock.t - 1);
    await relay.queue('kq', { type: 'c' }, clock.t + 1000);
    assert.equal((await store.get('outbox:kq'))[0].expiresAt, null);
    r = await relay.hello('kq', { machine: 'm', version: '1' });
    assert.deepEqual(r.slice(1), [{ type: 'a' }, { type: 'c' }]);
    assert.equal(await store.get('outbox:kq'), undefined);
    check('queue holds messages for hello, dropping expired ones');

    // failed send releases the charge (returned, and thrown)
    ({ store, sent, clock, relay } = setup());
    for (const bad of [async () => ({ ok: false, error: 'x' }), async () => { throw new Error('boom'); }]) {
      store = new MemoryStore();
      const failing = createRelay({ store, sender: { send: bad }, config, now: () => clock.t });
      await failing.hello(KH, { machine: 'laptop', version: '1' });
      r = await failing.machineMessage(KH, { type: 'link-start', number: '27821234567' });
      routes = await failing.webhook(inbound('c1', '27821234567', r[0].code, clock.t));
      const a = await store.get('account:27821234567');
      assert.equal(a.balance, config.trialMicroUsd);
      assert.equal(a.sent.length, 0);
      assert.equal(routes[0].msg.linked, true);
    }
    check('a failed or throwing send restores the balance');

    // race: another event changes the account during the send
    store = new MemoryStore();
    clock.t = 1700000000000;
    let raced = 0;
    const racing = {
      send: async () => {
        raced++;
        if (raced === 2) { // during the confirmation of the second send
          const a = await store.get('account:27821234567');
          a.windowUntil = 4242;
          a.balance -= price;
          a.sent.push(clock.t);
          await store.put('account:27821234567', a);
        }
        return { ok: true, id: 'r' + raced };
      },
    };
    relay = createRelay({ store, sender: racing, config, now: () => clock.t });
    await relay.hello(KH, { machine: 'laptop', version: '1' });
    r = await relay.machineMessage(KH, { type: 'link-start', number: '27821234567' });
    await relay.webhook(inbound('d1', '27821234567', r[0].code, clock.t));
    await store.put('account:27821234567', { ...(await store.get('account:27821234567')), machines: [KH] });
    await relay.webhook(inbound('d2', '27821234567', 'stop', clock.t));
    const ra = await store.get('account:27821234567');
    assert.equal(ra.windowUntil, 4242);
    assert.equal(ra.balance, config.trialMicroUsd - 3 * price);
    check('a concurrent change during a send is not overwritten');

    // money invariants: no second trial credit; billing off
    ({ store, sent, clock, relay } = setup());
    await relay.hello('k1', { machine: 'one', version: '1' });
    await relay.hello('k2', { machine: 'two', version: '1' });
    for (const [n, k] of [['d1', 'k1'], ['d2', 'k2']]) {
      r = await relay.machineMessage(k, { type: 'link-start', number: '27821234567' });
      await relay.webhook(inbound(n, '27821234567', r[0].code, clock.t));
    }
    let ma = await store.get('account:27821234567');
    assert.deepEqual(ma.machines, ['k1', 'k2']);
    assert.equal(ma.balance, config.trialMicroUsd - 2 * price);
    await relay.webhook(inbound('d3', '27821234567', 'stop', clock.t));
    r = await relay.machineMessage('k1', { type: 'link-start', number: '27821234567' });
    await relay.webhook(inbound('d4', '27821234567', r[0].code, clock.t));
    ma = await store.get('account:27821234567');
    assert.equal(ma.balance, config.trialMicroUsd - 4 * price);
    check('relinking never grants trial credit again');

    const off = setup();
    const offRelay = createRelay({ store: off.store, sender: { send: async () => ({ ok: true, id: 'o1' }) }, config: { ...config, billing: 'off' }, now: () => off.clock.t });
    await offRelay.hello(KH, { machine: 'laptop', version: '1' });
    r = await offRelay.machineMessage(KH, { type: 'link-start', number: '27821234567' });
    await offRelay.webhook(inbound('e1', '27821234567', r[0].code, off.clock.t));
    assert.equal((await off.store.get('account:27821234567')).balance, 0);
    check("billing 'off' creates the account with balance 0");
  }

  // relay core: prompts and answers
  {
    const config = { botNumber: '27600000000', billing: 'trial', trialMicroUsd: 1000000, rates: { default: 10000 }, markupPercent: 20, hourlyCap: 60, codeTtlMs: 600000, windowMs: 86400000, template: { name: 't', lang: 'en' } };
    const N = '27821234567';
    const N2 = '27829999999';
    const T0 = 1700000000000;
    const price = priceFor(N, config);
    const TOO_LATE = "Too late: it's waiting in the terminal.";
    const ALREADY = 'Already answered on the computer.';
    // A fresh relay with each [keyHash, number] linked; every "Connected" is one charged message.
    const setup = async (links = [['kh1', N]]) => {
      const store = new MemoryStore();
      const sent = [];
      const sender = { fail: false, send: async (p) => { if (sender.fail) return { ok: false, error: 'x' }; sent.push(p); return { ok: true, id: 'w' + sent.length }; } };
      const clock = { t: T0 };
      const relay = createRelay({ store, sender, config, now: () => clock.t });
      let n = 0;
      for (const [kh, number] of links) {
        await relay.hello(kh, { machine: kh, version: '1' });
        const [lc] = await relay.machineMessage(kh, { type: 'link-start', number });
        await relay.webhook({ inbound: [{ id: 'link' + n++, from: number, text: lc.code, ts: clock.t }], statuses: [] });
      }
      const ask = async (kh, pendingId, prompt, expiresAt = clock.t + 300000) => {
        const r = await relay.machineMessage(kh, { type: 'prompt', pendingId, expiresAt, prompt });
        return { r, ref: await store.get(`pending:${kh}:${pendingId}`) };
      };
      const tap = (id, buttonId, from = N) => relay.webhook({ inbound: [{ id, from, ts: clock.t, buttonId }], statuses: [] });
      const say = (id, text, contextId, from = N) => relay.webhook({ inbound: [{ id, from, ts: clock.t, text, ...(contextId ? { contextId } : {}) }], statuses: [] });
      const lastId = () => 'w' + sent.length;
      const balance = async (number = N) => (await store.get('account:' + number)).balance;
      return { store, sent, sender, clock, relay, ask, tap, say, lastId, balance };
    };
    const decideRoute = (keyHash, pendingId, decision, expiresAt) => ({ keyHash, msg: { type: 'decide', pendingId, decision }, expiresAt });
    const approval = { kind: 'approval', project: 'deck', title: 'Run command', detail: 'npm test', questions: [] };
    const planPrompt = { kind: 'plan', project: 'deck', title: 'Plan', detail: 'Do it', questions: [] };
    const question = (...questions) => ({ kind: 'question', project: 'deck', title: 'Question', detail: '', questions });
    const colour = { question: 'Colour?', header: 'Colour', multiSelect: false, options: ['Red', 'Green'] };
    const size = { question: 'Size?', header: 'Size', multiSelect: false, options: ['S', 'M', 'L', 'XL'] };
    const pick = { question: 'Which?', header: 'Pick', multiSelect: true, options: ['A', 'B', 'C'] };
    const stateOf = async (store, ref) => { const p = await store.get('prompt:' + ref); return [p.state, p.closedWhy]; };

    {
      const { store, sent, clock, relay, ask, tap, lastId } = await setup();
      const { r, ref } = await ask('kh1', 'p1', approval, T0 + 900000);
      assert.deepEqual(r, [{ type: 'prompt-sent', pendingId: 'p1' }]);
      assert.equal(sent.length, 2);
      assert.equal(sent[1].type, 'interactive');
      assert.deepEqual(sent[1].interactive.action.buttons.map((b) => b.reply.id), [`${ref}:allow`, `${ref}:deny`]);
      assert.deepEqual(await store.get('prompt:' + ref), { ref, keyHash: 'kh1', pendingId: 'p1', number: N, prompt: approval, qIndex: 0, answers: {}, expiresAt: T0 + 600000, state: 'open', closedWhy: null, closedAt: null, createdAt: T0 });
      assert.deepEqual(await store.get('msg:' + lastId()), { number: N, price, refunded: false, at: T0, ref, qIndex: 0 });
      clock.t += 5000;
      assert.deepEqual(await tap('t1', `${ref}:allow`), [decideRoute('kh1', 'p1', { behavior: 'allow' }, T0 + 600000)]);
      assert.equal(sent.length, 2);
      assert.deepEqual(await stateOf(store, ref), ['deciding', null]);
      assert.deepEqual(await relay.machineMessage('kh1', { type: 'decide-ack', pendingId: 'p1', ok: true }), []);
      assert.deepEqual(await stateOf(store, ref), ['closed', 'answered-phone']);
      assert.deepEqual(await tap('t2', `${ref}:deny`), []);
      assert.equal(sent.length, 2);
      await relay.machineMessage('kh1', { type: 'prompt', pendingId: 'p2', prompt: approval });
      assert.equal((await store.get('prompt:' + (await store.get('pending:kh1:p2')))).expiresAt, clock.t + 600000);
      check('prompt in window');
    }

    {
      const { store, sent, clock, ask, tap, balance } = await setup();
      const windowUntil = (await store.get('account:' + N)).windowUntil;
      clock.t = windowUntil - 300001;
      await ask('kh1', 'p0', approval);
      assert.equal(sent.at(-1).type, 'interactive');
      clock.t = windowUntil - 300000;
      const before = await balance();
      const { r, ref } = await ask('kh1', 'p1', approval);
      assert.deepEqual(r, [{ type: 'prompt-sent', pendingId: 'p1' }]);
      const tpl = sent.at(-1);
      assert.equal(tpl.type, 'template');
      assert.equal(tpl.template.name, 't');
      assert.deepEqual(tpl.template.components[1].parameters, [{ type: 'payload', payload: `${ref}:show` }]);
      assert.deepEqual(await tap('s1', `${ref}:show`), []);
      assert.equal(sent.at(-1).type, 'interactive');
      assert.deepEqual(sent.at(-1).interactive.action.buttons.map((b) => b.reply.id), [`${ref}:allow`, `${ref}:deny`]);
      assert.equal(await balance(), before - 2 * price);
      assert.deepEqual(await stateOf(store, ref), ['open', null]);
      check('prompt outside window');
    }

    {
      const { store, sent, ask, tap } = await setup();
      const { ref } = await ask('kh1', 'p1', planPrompt);
      assert.deepEqual(sent.at(-1).interactive.action.buttons.map((b) => b.reply.id), [`${ref}:approve`, `${ref}:plan`]);
      assert.deepEqual(await tap('t0', `${ref}:allow`), []);
      assert.deepEqual(await stateOf(store, ref), ['open', null]);
      assert.deepEqual(await tap('t1', `${ref}:plan`), [decideRoute('kh1', 'p1', { behavior: 'deny', message: 'Not yet: keep planning.' }, T0 + 300000)]);
      const { ref: ref2 } = await ask('kh1', 'p2', planPrompt);
      assert.deepEqual((await tap('t2', `${ref2}:approve`))[0].msg, { type: 'decide', pendingId: 'p2', decision: { behavior: 'allow' } });
      check('plan');
    }

    {
      const { store, sent, ask, tap, say, lastId } = await setup();
      const { ref } = await ask('kh1', 'p1', question(colour, size));
      const first = lastId();
      assert.deepEqual(sent.at(-1).interactive.action.buttons.map((b) => b.reply.id), [`${ref}:q0:o0`, `${ref}:q0:o1`]);
      assert.deepEqual(await tap('t1', `${ref}:q0:o1`), []);
      const second = lastId();
      assert.notEqual(second, first);
      assert.equal(sent.at(-1).interactive.type, 'list');
      assert.deepEqual(sent.at(-1).interactive.action.sections[0].rows.map((row) => row.id), [0, 1, 2, 3].map((i) => `${ref}:q1:o${i}`));
      assert.deepEqual(await store.get('msg:' + second), { number: N, price, refunded: false, at: T0, ref, qIndex: 1 });
      const count = sent.length;
      assert.deepEqual(await tap('t2', `${ref}:q0:o0`), []);
      assert.deepEqual(await say('x1', 'Blue', first), []);
      assert.equal(sent.length, count);
      assert.deepEqual((await store.get('prompt:' + ref)).answers, { 'Colour?': 'Green' });
      assert.deepEqual(await say('x2', '  Extra large ', second), [decideRoute('kh1', 'p1', { answers: { 'Colour?': 'Green', 'Size?': 'Extra large' } }, T0 + 300000)]);
      assert.equal(sent.length, count);
      check('two questions');
    }

    {
      const { sent, ask, say, lastId } = await setup();
      const answerTo = async (pendingId, q, text) => {
        await ask('kh1', pendingId, question(q));
        assert.equal(sent.at(-1).type, 'text');
        const routes = await say('x' + pendingId, text, lastId());
        assert.equal(routes.length, 1);
        assert.equal(routes[0].msg.pendingId, pendingId);
        return routes[0].msg.decision.answers[q.question];
      };
      assert.equal(await answerTo('p1', pick, '1 3'), 'A, C');
      assert.equal(await answerTo('p2', pick, 'blue please'), 'blue please');
      assert.equal(await answerTo('p3', pick, '3,1'), 'C, A');
      assert.equal(await answerTo('p4', pick, '1, 4'), '1, 4');
      const many = { question: 'Which file?', header: 'File', multiSelect: false, options: Array.from({ length: 12 }, (_, i) => `f${i + 1}`) };
      assert.equal(await answerTo('p5', many, ' 12 '), 'f12');
      check('multi-select');
    }

    {
      const { ask, say, lastId } = await setup();
      assert.notEqual(findCode('database'), null);
      await ask('kh1', 'p1', question(colour));
      assert.deepEqual(await say('x1', 'database', lastId()), [decideRoute('kh1', 'p1', { answers: { 'Colour?': 'database' } }, T0 + 300000)]);
      check('a typed answer that looks like a link code still answers');
    }

    {
      const { sent, clock, ask, say } = await setup();
      await ask('kh1', 'p1', question(colour));
      clock.t += 1000;
      await ask('kh1', 'p2', question(size));
      clock.t += 1000;
      await ask('kh1', 'p3', approval);
      clock.t += 1000;
      await ask('kh1', 'p4', question(pick), clock.t + 60000); // newest, but expires first
      clock.t += 60001;
      const count = sent.length;
      const brief = (routes) => routes.map((r) => [r.keyHash, r.msg.pendingId, r.msg.decision]);
      assert.deepEqual(brief(await say('x1', 'Purple', 'w1')), [['kh1', 'p2', { answers: { 'Size?': 'Purple' } }]]);
      assert.deepEqual(brief(await say('x2', 'Teal', 'wamid.unknown')), [['kh1', 'p1', { answers: { 'Colour?': 'Teal' } }]]);
      assert.deepEqual(await say('x3', 'yes'), []);
      assert.deepEqual(await say('x4', 'hello', undefined, N2), []);
      assert.equal(sent.length, count);
      check('typed text without context');
    }

    {
      const { ask, tap } = await setup([['k1', N], ['k2', N]]);
      const { ref: r1 } = await ask('k1', 'p1', approval);
      const { ref: r2 } = await ask('k2', 'p1', approval);
      assert.notEqual(r1, r2);
      assert.deepEqual(await tap('t2', `${r2}:allow`), [decideRoute('k2', 'p1', { behavior: 'allow' }, T0 + 300000)]);
      assert.deepEqual(await tap('t1', `${r1}:allow`), [decideRoute('k1', 'p1', { behavior: 'allow' }, T0 + 300000)]);
      check('two machines, one number');
    }

    {
      const { store, clock, relay, ask, balance } = await setup();
      clock.t = (await store.get('account:' + N)).windowUntil;
      const { ref } = await ask('kh1', 'p1', approval);
      const before = await balance();
      const show = { inbound: [{ id: 'dup1', from: N, ts: clock.t, buttonId: `${ref}:show` }], statuses: [] };
      await relay.webhook(show);
      await relay.webhook(show);
      const allow = { inbound: [{ id: 'dup2', from: N, ts: clock.t, buttonId: `${ref}:allow` }], statuses: [] };
      const routes = [...(await relay.webhook(allow)), ...(await relay.webhook(allow))];
      assert.deepEqual(routes, [decideRoute('kh1', 'p1', { behavior: 'allow' }, clock.t + 300000)]);
      assert.equal(await balance(), before - price);
      check('duplicate inbound id is ignored');
    }

    {
      const { store, sent, clock, relay, ask, tap } = await setup();
      let { ref } = await ask('kh1', 'p1', approval);
      assert.deepEqual(await relay.machineMessage('kh1', { type: 'prompt-closed', pendingId: 'p1', why: 'answered' }), []);
      assert.deepEqual(await stateOf(store, ref), ['closed', 'answered']);
      assert.deepEqual(await tap('t1', `${ref}:allow`), []);
      assert.equal(sent.at(-1).text.body, ALREADY);
      ({ ref } = await ask('kh1', 'p2', approval));
      await relay.machineMessage('kh1', { type: 'prompt-closed', pendingId: 'p2', why: 'timeout' });
      assert.deepEqual(await tap('t2', `${ref}:deny`), []);
      assert.equal(sent.at(-1).text.body, TOO_LATE);
      ({ ref } = await ask('kh1', 'p3', approval, clock.t + 60000));
      clock.t += 60001;
      let count = sent.length;
      assert.deepEqual(await tap('t3', `${ref}:allow`), []);
      assert.equal(sent.length, count + 1);
      assert.equal(sent.at(-1).text.body, TOO_LATE);
      ({ ref } = await ask('kh1', 'p4', approval));
      assert.equal((await tap('t4', `${ref}:allow`)).length, 1);
      await relay.machineMessage('kh1', { type: 'prompt-closed', pendingId: 'p4', why: 'answered' });
      assert.deepEqual(await stateOf(store, ref), ['deciding', null]);
      count = sent.length;
      assert.deepEqual(await tap('t5', `${ref}:allow`), []);
      assert.equal(sent.length, count);
      assert.deepEqual(await relay.machineMessage('kh1', { type: 'decide-ack', pendingId: 'p4', ok: false, reason: 'gone' }), []);
      assert.equal(sent.length, count + 1);
      assert.equal(sent.at(-1).text.body, TOO_LATE);
      assert.deepEqual(await stateOf(store, ref), ['closed', 'gone']);
      check('late taps');
    }

    {
      const { sent, relay, ask, say, lastId } = await setup();
      await ask('kh1', 'p1', question(colour));
      const qid = lastId();
      await relay.machineMessage('kh1', { type: 'prompt-closed', pendingId: 'p1', why: 'answered' });
      assert.deepEqual(await say('x1', 'Blue', qid), []);
      assert.equal(sent.at(-1).text.body, ALREADY);
      const count = sent.length;
      assert.deepEqual(await say('x2', 'Blue'), []);
      assert.equal(sent.length, count);
      check('a typed reply to a closed question gets the late reply; one without context is free');
    }

    {
      const { store, sent, ask, tap, balance } = await setup([['kh1', N], ['kh2', N2]]);
      const { ref } = await ask('kh1', 'p1', approval);
      const b1 = await balance(N);
      const b2 = await balance(N2);
      const count = sent.length;
      assert.deepEqual(await tap('t1', `${ref}:allow`, N2), []);
      assert.deepEqual(await tap('t2', `${ref}:allow`, '27820000001'), []);
      assert.equal(sent.length, count);
      assert.equal(await balance(N), b1);
      assert.equal(await balance(N2), b2);
      assert.deepEqual(await stateOf(store, ref), ['open', null]);
      check('a tap from a different number');
    }

    {
      const { sent, relay, ask, tap } = await setup();
      const { ref } = await ask('kh1', 'p1', approval);
      await relay.machineMessage('kh1', { type: 'unlink' });
      const count = sent.length;
      assert.deepEqual(await tap('t1', `${ref}:allow`), []);
      assert.equal(sent.length, count);
      check('a tap after its machine is unlinked is ignored');
    }

    {
      const { store, sent, ask, balance } = await setup();
      const acc = await store.get('account:' + N);
      acc.balance = price - 1;
      await store.put('account:' + N, acc);
      const count = sent.length;
      const { r, ref } = await ask('kh1', 'p1', approval);
      assert.deepEqual(r, [{ type: 'prompt-failed', pendingId: 'p1', reason: 'no-credit' }]);
      assert.equal(sent.length, count);
      assert.equal(await balance(), price - 1);
      assert.deepEqual(await stateOf(store, ref), ['closed', 'send-failed']);
      check('no credit');
    }

    {
      const { store, sender, ask } = await setup();
      sender.fail = true;
      const { r, ref } = await ask('kh1', 'p1', approval);
      assert.deepEqual(r, [{ type: 'prompt-failed', pendingId: 'p1', reason: 'send-failed' }]);
      assert.deepEqual(await stateOf(store, ref), ['closed', 'send-failed']);
      check('a refused send reports send-failed and closes the prompt');
    }

    {
      const { store, sent, relay } = await setup([]);
      await relay.hello('kx', { machine: 'x', version: '1' });
      for (const kh of ['kx', 'nobody']) {
        assert.deepEqual(await relay.machineMessage(kh, { type: 'prompt', pendingId: 'p1', expiresAt: T0 + 300000, prompt: approval }), [{ type: 'prompt-failed', pendingId: 'p1', reason: 'not-linked' }]);
      }
      assert.equal(sent.length, 0);
      assert.equal((await store.list('prompt:')).size, 0);
      assert.equal((await store.list('pending:')).size, 0);
      check('not linked');
    }

    {
      const { store, sender, ask, tap } = await setup();
      const { ref } = await ask('kh1', 'p1', question(colour, size));
      sender.fail = true;
      assert.deepEqual(await tap('t1', `${ref}:q0:o0`), []);
      assert.deepEqual(await stateOf(store, ref), ['closed', 'send-failed']);
      check('a next question that cannot be sent closes the prompt');
    }

    {
      const { store, relay, ask, balance, lastId } = await setup();
      const before = await balance();
      await ask('kh1', 'p1', approval);
      const id = lastId();
      assert.equal(await balance(), before - price);
      const failed = { inbound: [], statuses: [{ id, status: 'failed', recipient: N }] };
      assert.deepEqual(await relay.webhook(failed), []);
      assert.equal(await balance(), before);
      assert.equal((await store.get('msg:' + id)).refunded, true);
      await relay.webhook(failed);
      await relay.webhook({ inbound: [], statuses: [{ id, status: 'delivered', recipient: N }, { id: 'wamid.unknown', status: 'failed', recipient: N }] });
      assert.equal(await balance(), before);
      check('failed status refunds once');
    }

    {
      const { clock, relay, ask, tap } = await setup();
      const { ref } = await ask('kh1', 'p1', approval);
      const [route] = await tap('t1', `${ref}:allow`);
      await relay.queue(route.keyHash, route.msg, route.expiresAt);
      const out = await relay.hello('kh1', { machine: 'kh1', version: '1' });
      assert.equal(out[0].type, 'status');
      assert.deepEqual(out.slice(1), [{ type: 'decide', pendingId: 'p1', decision: { behavior: 'allow' } }]);
      const { ref: ref2 } = await ask('kh1', 'p2', approval, clock.t + 60000);
      const [late] = await tap('t2', `${ref2}:allow`);
      await relay.queue(late.keyHash, late.msg, late.expiresAt);
      clock.t += 60001;
      assert.deepEqual((await relay.hello('kh1', { machine: 'kh1', version: '1' })).slice(1), []);
      check('decide is queued for an offline machine');
    }

    {
      const { store, sent, sender, clock, relay, ask, tap, say, lastId } = await setup();
      // Closed records keep only the kind: no prompt text, no answers, and when they closed.
      const closedAs = async (ref, kind, why) => {
        const p = await store.get('prompt:' + ref);
        assert.deepEqual({ state: p.state, closedWhy: p.closedWhy, closedAt: p.closedAt, prompt: p.prompt, answers: p.answers }, { state: 'closed', closedWhy: why, closedAt: clock.t, prompt: { kind }, answers: {} });
        for (const text of ['npm test', 'Run command', 'Do it', 'Colour?', 'Size?', 'Green', 'Red', 'XL']) assert.ok(!JSON.stringify(p).includes(text), text);
      };
      const lateReply = async (id, buttonId, body) => {
        const count = sent.length;
        assert.deepEqual(await tap(id, buttonId), []);
        if (body === null) assert.equal(sent.length, count);
        else assert.equal(sent.at(-1).text.body, body);
      };
      // answered on the computer: a tap, and a typed reply to the question, both get "Already answered"
      let { ref } = await ask('kh1', 'p1', question(colour));
      const qid = lastId();
      clock.t += 1000;
      await relay.machineMessage('kh1', { type: 'prompt-closed', pendingId: 'p1', why: 'answered' });
      await closedAs(ref, 'question', 'answered');
      await lateReply('a1', `${ref}:q0:o0`, ALREADY);
      assert.deepEqual(await say('a2', 'Blue', qid), []);
      assert.equal(sent.at(-1).text.body, ALREADY);
      // timeout
      ({ ref } = await ask('kh1', 'p2', approval));
      clock.t += 1000;
      await relay.machineMessage('kh1', { type: 'prompt-closed', pendingId: 'p2', why: 'timeout' });
      await closedAs(ref, 'approval', 'timeout');
      await lateReply('b1', `${ref}:allow`, TOO_LATE);
      // the first send fails
      clock.t += 1000;
      sender.fail = true;
      ({ ref } = await ask('kh1', 'p3', approval));
      sender.fail = false;
      await closedAs(ref, 'approval', 'send-failed');
      await lateReply('c1', `${ref}:allow`, TOO_LATE);
      // the next question's send fails, after an answer was recorded
      ({ ref } = await ask('kh1', 'p4', question(colour, size)));
      clock.t += 1000;
      sender.fail = true;
      await tap('d1', `${ref}:q0:o1`);
      sender.fail = false;
      await closedAs(ref, 'question', 'send-failed');
      await lateReply('d2', `${ref}:q1:o0`, TOO_LATE);
      // answered on the phone and acked: later taps are silent
      ({ ref } = await ask('kh1', 'p5', question(colour, size)));
      await tap('e1', `${ref}:q0:o1`);
      assert.equal((await say('e2', 'XL', lastId())).length, 1);
      clock.t += 1000;
      await relay.machineMessage('kh1', { type: 'decide-ack', pendingId: 'p5', ok: true });
      await closedAs(ref, 'question', 'answered-phone');
      await lateReply('e3', `${ref}:q1:o3`, null);
      // the daemon refuses the decide
      ({ ref } = await ask('kh1', 'p6', planPrompt));
      await tap('f1', `${ref}:plan`);
      clock.t += 1000;
      await relay.machineMessage('kh1', { type: 'decide-ack', pendingId: 'p6', ok: false, reason: 'gone' });
      assert.equal(sent.at(-1).text.body, TOO_LATE);
      await closedAs(ref, 'plan', 'gone');
      await lateReply('f2', `${ref}:approve`, TOO_LATE);
      check('closing a prompt keeps no prompt text or answers, and late taps still get the right reply');
    }

    {
      const { store, sent, relay, ask, tap, balance } = await setup();
      const { ref } = await ask('kh1', 'p1', approval);
      const before = await balance();
      const count = sent.length;
      const repeat = async () => {
        const again = await ask('kh1', 'p1', approval);
        assert.deepEqual(again.r, [{ type: 'prompt-sent', pendingId: 'p1' }]);
        assert.equal(again.ref, ref);
        assert.equal(sent.length, count);
        assert.equal(await balance(), before);
        assert.equal((await store.list('prompt:')).size, 1);
      };
      await repeat(); // while open
      assert.equal((await tap('t1', `${ref}:allow`)).length, 1);
      await repeat(); // while deciding
      assert.deepEqual(await tap('t2', `${ref}:allow`), []);
      assert.deepEqual(await relay.machineMessage('kh1', { type: 'decide-ack', pendingId: 'p1', ok: true }), []);
      assert.deepEqual(await stateOf(store, ref), ['closed', 'answered-phone']);
      const fresh = await ask('kh1', 'p1', approval); // once closed, the pendingId can be sent afresh
      assert.deepEqual(fresh.r, [{ type: 'prompt-sent', pendingId: 'p1' }]);
      assert.notEqual(fresh.ref, ref);
      assert.equal(sent.length, count + 1);
      check('a repeated prompt for a pendingId still open or deciding is not sent or charged again');
    }

    // sweep: what the Durable Object's alarm runs every 10 minutes
    const H = 3600000;
    const D = 86400000;
    {
      const { store, sent, clock, relay, ask, tap } = await setup();
      const { ref: old } = await ask('kh1', 'p1', question(colour), clock.t + 300000);
      clock.t += 300001;
      const { ref: fresh } = await ask('kh1', 'p2', approval);
      const freshBefore = await store.get('prompt:' + fresh);
      assert.deepEqual(await relay.sweep(), { closed: 1, prompts: 0, codes: 0, seen: 0, msgs: 0, outbox: 0 });
      const swept = await store.get('prompt:' + old);
      assert.deepEqual([swept.state, swept.closedWhy, swept.closedAt], ['closed', 'timeout', clock.t]);
      assert.deepEqual(swept.prompt, { kind: 'question' });
      assert.deepEqual(swept.answers, {});
      assert.deepEqual(await store.get('prompt:' + fresh), freshBefore);
      assert.equal(await store.get('pending:kh1:p1'), old);
      await tap('s1', `${old}:q0:o0`);
      assert.equal(sent.at(-1).text.body, TOO_LATE);
      check('sweep closes and strips an expired open question, and leaves a fresh prompt alone');

      assert.equal((await tap('s2', `${fresh}:allow`)).length, 1);
      clock.t += H; // the old prompt closed exactly an hour ago; the deciding one has expired
      await relay.sweep();
      assert.ok(await store.get('prompt:' + old));
      assert.deepEqual(await stateOf(store, fresh), ['closed', 'timeout']);
      assert.deepEqual((await store.get('prompt:' + fresh)).prompt, { kind: 'approval' });
      clock.t += 1;
      assert.equal((await relay.sweep()).prompts, 1);
      assert.equal(await store.get('prompt:' + old), undefined);
      assert.equal(await store.get('pending:kh1:p1'), undefined);
      assert.ok(await store.get('prompt:' + fresh));
      assert.equal(await store.get('pending:kh1:p2'), fresh);
      // a pendingId sent afresh keeps its pending key when the old record goes
      const { ref: first } = await ask('kh1', 'p3', approval);
      await relay.machineMessage('kh1', { type: 'prompt-closed', pendingId: 'p3', why: 'answered' });
      clock.t += H + 1;
      const { ref: second } = await ask('kh1', 'p3', approval);
      assert.notEqual(second, first);
      await relay.sweep();
      assert.equal(await store.get('prompt:' + first), undefined);
      assert.equal(await store.get('pending:kh1:p3'), second);
      assert.equal((await store.get('prompt:' + second)).state, 'open');
      check('sweep times out a deciding prompt, and deletes closed prompts and their pending keys an hour later');
    }

    {
      const { store, clock, relay, say } = await setup(); // links kh1: seen:link0 and one msg: record at T0
      const keys = async (prefix) => [...(await store.list(prefix)).keys()];
      const [lc] = await relay.machineMessage('kh1', { type: 'link-start', number: N2 });
      await relay.queue('kq', { type: 'a' }, T0 + 1000);
      await relay.queue('kq', { type: 'b' });
      await relay.queue('kq', { type: 'c' }, T0 + 2000);
      await relay.queue('kz', { type: 'd' }, T0 + 1000);
      clock.t = T0 + 1000;
      assert.deepEqual(await relay.sweep(), { closed: 0, prompts: 0, codes: 0, seen: 0, msgs: 0, outbox: 2 });
      assert.deepEqual((await store.get('outbox:kq')).map((e) => e.msg.type), ['b', 'c']);
      assert.equal(await store.get('outbox:kz'), undefined);
      assert.ok(await store.get('code:' + lc.code));
      clock.t = T0 + 600000;
      assert.equal((await relay.sweep()).codes, 1);
      assert.equal(await store.get('code:' + lc.code), undefined);
      assert.deepEqual((await store.get('outbox:kq')).map((e) => e.msg.type), ['b']);
      check('sweep drops expired outbox entries (and empty outboxes) and expired link codes');

      clock.t = T0 + D / 2;
      await say('later', 'hello', undefined, N2);
      await relay.sendAndSave(N, textMessage(N, 'later'));
      clock.t = T0 + D;
      await relay.sweep();
      assert.deepEqual(await keys('seen:'), ['seen:later', 'seen:link0']);
      clock.t = T0 + D + 1;
      assert.equal((await relay.sweep()).seen, 1);
      assert.deepEqual(await keys('seen:'), ['seen:later']);
      assert.equal((await keys('msg:')).length, 2);
      clock.t = T0 + 7 * D + 1;
      const counts = await relay.sweep();
      assert.equal(counts.msgs, 1);
      assert.equal(counts.seen, 1);
      assert.deepEqual(await keys('seen:'), []);
      assert.deepEqual([...(await store.list('msg:')).values()].map((m) => m.at), [T0 + D / 2]);
      check('sweep deletes seen ids after a day and message records after 7 days');
    }
  }

  // parseEnv: the Worker's variables and secrets → the relay config
  {
    const base = { GRAPH_VERSION: 'v21.0', WA_TOKEN: 'tok', WA_PHONE_NUMBER_ID: '1234', WA_APP_SECRET: 'sec', WA_VERIFY_TOKEN: 'vt', BOT_NUMBER: '+27 60 000 0000' };
    const throwsNaming = (env, name) => assert.throws(() => parseEnv(env), (e) => e instanceof Error && e.message.includes(name), name);

    assert.deepEqual(parseEnv(base), {
      botNumber: '27600000000',
      billing: 'off',
      trialMicroUsd: 0,
      rates: { default: 0 },
      markupPercent: 0,
      hourlyCap: 60,
      codeTtlMs: 600000,
      windowMs: 86400000,
      template: { name: 'agent_deck_needs_you', lang: 'en' },
      whatsapp: { token: 'tok', phoneNumberId: '1234', appSecret: 'sec', verifyToken: 'vt', graphVersion: 'v21.0' },
    });
    const blank = { BILLING: '', TRIAL_MICRO_USD: '', RATES_JSON: '', MARKUP_PERCENT: '', HOURLY_CAP: '', TEMPLATE_NAME: '', TEMPLATE_LANG: '' };
    assert.deepEqual(parseEnv({ ...base, ...blank }), parseEnv(base));
    assert.equal(parseEnv({ ...base, WA_TOKEN: 'tok\n' }).whatsapp.token, 'tok');
    check('parseEnv defaults: billing off, no trial, zero rates, cap 60, the agent_deck_needs_you template');

    throwsNaming({}, 'GRAPH_VERSION');
    for (const name of ['GRAPH_VERSION', 'WA_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_APP_SECRET', 'WA_VERIFY_TOKEN', 'BOT_NUMBER']) {
      const env = { ...base };
      delete env[name];
      throwsNaming(env, name);
      throwsNaming({ ...base, [name]: '  ' }, name);
    }
    throwsNaming({ ...base, BOT_NUMBER: '0821234567' }, 'BOT_NUMBER');
    check('parseEnv throws naming a missing GRAPH_VERSION, WA_* secret or BOT_NUMBER');

    const full = parseEnv({ ...base, BILLING: 'trial', TRIAL_MICRO_USD: '500000', RATES_JSON: '{"default":9000,"27":5000}', MARKUP_PERCENT: '20', HOURLY_CAP: 30, TEMPLATE_NAME: 'mine', TEMPLATE_LANG: 'en_US' });
    assert.equal(full.billing, 'trial');
    assert.equal(full.trialMicroUsd, 500000);
    assert.deepEqual(full.rates, { default: 9000, '27': 5000 });
    assert.equal(full.markupPercent, 20);
    assert.equal(full.hourlyCap, 30);
    assert.deepEqual(full.template, { name: 'mine', lang: 'en_US' });
    assert.equal(parseEnv({ ...base, BILLING: 'on' }).billing, 'on');
    assert.equal(priceFor('27821234567', full), 6000);
    assert.equal(priceFor('447000000000', full), 10800);
    assert.equal(priceFor('27821234567', parseEnv({ ...base, BILLING: 'trial' })), 0);
    check('parseEnv reads RATES_JSON, BILLING, trial, markup, cap and template, so priceFor is always a number');

    for (const bad of ['nope', '[1]', 'null', '5', '{}', '{"default":-1}', '{"default":"9000"}', '{"default":null}', '{"default":1e999}', '{"default":1,"27":"x"}', '{"default":1,"27":-5}']) {
      throwsNaming({ ...base, RATES_JSON: bad }, 'RATES_JSON');
    }
    for (const bad of ['yes', 'ON', 'true']) throwsNaming({ ...base, BILLING: bad }, 'BILLING');
    for (const name of ['TRIAL_MICRO_USD', 'MARKUP_PERCENT', 'HOURLY_CAP']) {
      for (const bad of ['abc', '-1', 'Infinity', 'NaN']) throwsNaming({ ...base, [name]: bad }, name);
    }
    for (const env of [{ ...base, RATES_JSON: '{"default":"s3cr3t"' }, { ...base, RATES_JSON: '{"default":"s3cr3t"}' }, { ...base, BILLING: 's3cr3t' }, { ...base, HOURLY_CAP: 's3cr3t' }]) {
      assert.throws(() => parseEnv(env), (e) => !e.message.includes('s3cr3t'));
    }
    check('parseEnv rejects bad RATES_JSON, BILLING and numbers, naming the variable but never its value');
  }

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error('\nFAILED:', e.stack || e.message);
  process.exit(1);
});
