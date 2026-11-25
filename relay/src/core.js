// Relay core: linking a phone number to machines, status, and charged sending.
// Web-standard APIs only. Task 6 extends this with prompts and answers.
import { textMessage } from './whatsapp.js';
import { newCode, findCode, normalizeNumber, maskNumber } from './ids.js';
import { priceFor, reserve, release } from './credit.js';

const HOUR_MS = 3600000;
const MAX_LINK_ATTEMPTS = 5;

export function createRelay({ store, sender, config, now = Date.now }) {
  const getAccount = (number) => store.get('account:' + number);
  const putAccount = (account) => store.put('account:' + account.number, account);

  function statusMsg(machine, account) {
    if (machine && machine.number && account) {
      return { type: 'status', linked: true, number: maskNumber(machine.number), balanceMicroUsd: account.balance, billing: config.billing, botNumber: config.botNumber };
    }
    return { type: 'status', linked: false, number: null, balanceMicroUsd: null, billing: config.billing, botNumber: config.botNumber };
  }

  // Reserve credit, send, and release on failure. The caller persists the account afterwards.
  async function sendCharged(account, payload, meta = {}) {
    const price = priceFor(account.number, config);
    const r = reserve(account, price, now(), config.hourlyCap);
    if (!r.ok) return { ok: false, reason: r.reason };
    const res = await sender.send(payload);
    if (!res.ok) {
      release(account, price);
      return { ok: false, reason: 'send-failed' };
    }
    await store.put('msg:' + res.id, { number: account.number, price, refunded: false, at: now(), ...meta });
    return { ok: true, id: res.id };
  }

  async function hello(keyHash, { machine, version } = {}) {
    let m = await store.get('machine:' + keyHash);
    if (!m) m = { keyHash, machine, number: null, linkedAt: null, linkAttempts: [] };
    else if (machine) m.machine = machine;
    await store.put('machine:' + keyHash, m);
    const account = m.number ? await getAccount(m.number) : null;
    const out = [statusMsg(m, account)];
    const box = (await store.get('outbox:' + keyHash)) || [];
    const t = now();
    for (const e of box) if (e.expiresAt === null || e.expiresAt === undefined || e.expiresAt > t) out.push(e.msg);
    if (box.length) await store.delete('outbox:' + keyHash);
    return out;
  }

  async function queue(keyHash, msg, expiresAt = Infinity) {
    const box = (await store.get('outbox:' + keyHash)) || [];
    box.push({ msg, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null });
    await store.put('outbox:' + keyHash, box);
  }

  async function linkStart(keyHash, msg) {
    const m = await store.get('machine:' + keyHash);
    if (!m) return [{ type: 'error', op: 'link-start', reason: 'unknown-machine' }];
    const t = now();
    const attempts = (m.linkAttempts || []).filter((a) => t - a < HOUR_MS);
    if (attempts.length >= MAX_LINK_ATTEMPTS) {
      m.linkAttempts = attempts;
      await store.put('machine:' + keyHash, m);
      return [{ type: 'error', op: 'link-start', reason: 'rate-limited' }];
    }
    attempts.push(t);
    m.linkAttempts = attempts;
    await store.put('machine:' + keyHash, m);
    const number = normalizeNumber(msg.number);
    if (!number) return [{ type: 'error', op: 'link-start', reason: 'bad-number' }];
    let code;
    for (let i = 0; i < 20; i++) {
      code = newCode();
      const existing = await store.get('code:' + code);
      if (!existing || existing.expiresAt <= t) break;
    }
    const expiresAt = t + config.codeTtlMs;
    await store.put('code:' + code, { keyHash, number, expiresAt });
    return [{ type: 'link-code', code, expiresAt, botNumber: config.botNumber }];
  }

  async function unlink(keyHash) {
    const m = await store.get('machine:' + keyHash);
    if (m && m.number) {
      const account = await getAccount(m.number);
      if (account) {
        account.machines = (account.machines || []).filter((k) => k !== keyHash);
        await putAccount(account);
      }
      m.number = null;
      m.linkedAt = null;
      await store.put('machine:' + keyHash, m);
    }
    return [statusMsg(null, null)];
  }

  async function machineMessage(keyHash, msg) {
    switch (msg && msg.type) {
      case 'hello': return hello(keyHash, { machine: msg.machine, version: msg.version });
      case 'link-start': return linkStart(keyHash, msg);
      case 'unlink': return unlink(keyHash);
      default: return [];
    }
  }

  async function handleStop(account) {
    const routes = [];
    for (const keyHash of account.machines) {
      const m = await store.get('machine:' + keyHash);
      if (m && m.number === account.number) {
        m.number = null;
        m.linkedAt = null;
        await store.put('machine:' + keyHash, m);
      }
      routes.push({ keyHash, msg: statusMsg(null, null) });
    }
    account.machines = [];
    await sendCharged(account, textMessage(account.number, 'Disconnected.'));
    await putAccount(account);
    return routes;
  }

  async function handleCode(item, code) {
    const rec = await store.get('code:' + code);
    const t = now();
    if (!rec || rec.expiresAt <= t || rec.number !== item.from) return [];
    const m = await store.get('machine:' + rec.keyHash);
    if (!m) return [];
    let account = await getAccount(item.from);
    if (!account) {
      account = { number: item.from, balance: config.billing === 'off' ? 0 : config.trialMicroUsd, sent: [], windowUntil: item.ts + config.windowMs, machines: [] };
    }
    if (m.number && m.number !== item.from) {
      const old = await getAccount(m.number);
      if (old) {
        old.machines = (old.machines || []).filter((k) => k !== rec.keyHash);
        await putAccount(old);
      }
    }
    m.number = item.from;
    m.linkedAt = t;
    if (!account.machines.includes(rec.keyHash)) account.machines.push(rec.keyHash);
    await store.put('machine:' + rec.keyHash, m);
    await store.delete('code:' + code);
    await sendCharged(account, textMessage(item.from, `Connected: ${m.machine}`));
    await putAccount(account);
    return [{ keyHash: rec.keyHash, msg: statusMsg(m, account) }];
  }

  async function webhook(parsed) {
    const routes = [];
    for (const item of (parsed && parsed.inbound) || []) {
      if (await store.get('seen:' + item.id)) continue;
      await store.put('seen:' + item.id, now());
      const account = await getAccount(item.from);
      if (account) {
        account.windowUntil = item.ts + config.windowMs;
        await putAccount(account);
      }
      const text = typeof item.text === 'string' ? item.text : '';
      if (account && account.machines.length && text.trim().toLowerCase() === 'stop') {
        routes.push(...(await handleStop(account)));
        continue;
      }
      const code = findCode(text);
      if (code) routes.push(...(await handleCode(item, code)));
    }
    return routes;
  }

  return { hello, machineMessage, webhook, queue, statusMsg, sendCharged };
}
