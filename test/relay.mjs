// Unit tests for the relay's WhatsApp module: payloads, webhook parsing, signature check, sender.
import assert from 'node:assert/strict';
import { verifySignature, parseWebhook, promptMessage, textMessage, templateMessage, createSender } from '../relay/src/whatsapp.js';
import { MemoryStore } from '../relay/src/memory-store.js';
import { CODE_ALPHABET, newCode, findCode, newRef, sha256Hex, normalizeNumber, maskNumber } from '../relay/src/ids.js';
import { priceFor, reserve, release } from '../relay/src/credit.js';

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

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error('\nFAILED:', e.stack || e.message);
  process.exit(1);
});
