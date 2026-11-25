// Relay core: linking a phone number to machines, status, charged sending, and prompts with the
// answers that come back from taps and typed replies. Web-standard APIs only.
import { textMessage, promptMessage, templateMessage } from './whatsapp.js';
import { newCode, findCode, newRef, normalizeNumber, maskNumber } from './ids.js';
import { priceFor, reserve, release } from './credit.js';

const HOUR_MS = 3600000;
const MAX_LINK_ATTEMPTS = 5;
const MAX_PROMPT_MS = 600000; // Claude Code's hook timeout
const WINDOW_MARGIN_MS = 300000; // under 5 min left in the 24 h window → template
const LIST_ROWS = 10; // more options than a list holds → numbered text (as whatsapp.js does)
const TOO_LATE = "Too late: it's waiting in the terminal.";
const ALREADY = 'Already answered on the computer.';
const KINDS = ['approval', 'plan', 'question'];
const CLOSE_WHY = ['answered', 'timeout', 'gone'];
const CHOICES = {
  approval: { allow: { behavior: 'allow' }, deny: { behavior: 'deny' } },
  plan: { approve: { behavior: 'allow' }, plan: { behavior: 'deny', message: 'Not yet: keep planning.' } },
};

function validPrompt(p) {
  if (!p || !KINDS.includes(p.kind)) return false;
  if (p.kind !== 'question') return true;
  return Array.isArray(p.questions) && p.questions.length > 0 && p.questions.every((q) => q && typeof q.question === 'string' && Array.isArray(q.options));
}

// A numbered question (multi-select or over 10 options) takes "1 3" or "1, 3" as its labels.
// Anything else, or a number out of range, is the user's own answer.
function typedAnswer(q, text) {
  const options = q.options.map(String);
  if ((q.multiSelect || options.length > LIST_ROWS) && /^\d+(?:[\s,]+\d+)*$/.test(text)) {
    const picks = [...new Set(text.split(/[\s,]+/).map(Number))];
    if (picks.every((n) => n >= 1 && n <= options.length)) return picks.map((n) => options[n - 1]).join(', ');
  }
  return text;
}

export function createRelay({ store, sender, config, now = Date.now }) {
  const getAccount = (number) => store.get('account:' + number);
  const putAccount = (account) => store.put('account:' + account.number, account);

  function statusMsg(machine, account) {
    if (machine && machine.number && account) {
      return { type: 'status', linked: true, number: maskNumber(machine.number), balanceMicroUsd: account.balance, billing: config.billing, botNumber: config.botNumber };
    }
    return { type: 'status', linked: false, number: null, balanceMicroUsd: null, billing: config.billing, botNumber: config.botNumber };
  }

  // Every charged send goes through here. The reservation is persisted before the send and the
  // release after a failure re-reads the account, so a concurrent event during the fetch is never
  // overwritten. Callers must persist their own account changes BEFORE calling and never write a
  // stale account copy afterwards.
  async function sendAndSave(number, payload, meta = {}) {
    const account = await getAccount(number);
    if (!account) return { ok: false, reason: 'not-linked' };
    const price = priceFor(number, config);
    const r = reserve(account, price, now(), config.hourlyCap);
    await putAccount(account);
    if (!r.ok) return { ok: false, reason: r.reason };
    let res;
    try {
      res = await sender.send(payload);
    } catch {
      res = { ok: false };
    }
    if (!res || !res.ok) {
      const fresh = (await getAccount(number)) || account;
      release(fresh, price);
      await putAccount(fresh);
      return { ok: false, reason: 'send-failed' };
    }
    await store.put('msg:' + res.id, { number, price, refunded: false, at: now(), ...meta });
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

  // ---- prompts ----

  const promptKey = (ref) => 'prompt:' + ref;
  const pendingKey = (keyHash, pendingId) => `pending:${keyHash}:${pendingId}`;

  async function sendPrompt(keyHash, msg) {
    const { pendingId, prompt } = msg;
    const failed = (reason) => [{ type: 'prompt-failed', pendingId, reason }];
    const m = await store.get('machine:' + keyHash);
    const account = m && m.number ? await getAccount(m.number) : null;
    if (!account) return failed('not-linked');
    if (typeof pendingId !== 'string' || !pendingId || !validPrompt(prompt)) return failed('send-failed');
    const t = now();
    const expiresAt = Math.min(Number.isFinite(msg.expiresAt) ? msg.expiresAt : Infinity, t + MAX_PROMPT_MS);
    const ref = newRef();
    const number = m.number;
    await store.put(promptKey(ref), { ref, keyHash, pendingId, number, prompt, qIndex: 0, answers: {}, expiresAt, state: 'open', closedWhy: null, createdAt: t });
    await store.put(pendingKey(keyHash, pendingId), ref);
    const payload = t < account.windowUntil - WINDOW_MARGIN_MS
      ? promptMessage(number, ref, prompt, 0)
      : templateMessage(number, ref, prompt, config.template);
    const res = await sendAndSave(number, payload, { ref, qIndex: 0 });
    if (!res.ok) {
      await closeIfOpen(ref, 'send-failed');
      return failed(res.reason);
    }
    return [{ type: 'prompt-sent', pendingId }];
  }

  // Re-reads the prompt, since a send may have let another event change it.
  async function closeIfOpen(ref, why) {
    const p = await store.get(promptKey(ref));
    if (!p || p.state !== 'open') return;
    p.state = 'closed';
    p.closedWhy = why;
    await store.put(promptKey(ref), p);
  }

  async function promptFor(keyHash, pendingId) {
    const ref = await store.get(pendingKey(keyHash, pendingId));
    return ref ? store.get(promptKey(ref)) : undefined;
  }

  // Answered at the computer, timed out or gone. A prompt already deciding is settled by the ack.
  async function promptClosed(keyHash, msg) {
    const ref = await store.get(pendingKey(keyHash, msg.pendingId));
    if (ref) await closeIfOpen(ref, CLOSE_WHY.includes(msg.why) ? msg.why : 'gone');
    return [];
  }

  async function decideAck(keyHash, msg) {
    const p = await promptFor(keyHash, msg.pendingId);
    if (!p || p.state !== 'deciding') return [];
    p.state = 'closed';
    p.closedWhy = msg.ok === true ? 'answered-phone' : 'gone';
    await store.put(promptKey(p.ref), p);
    if (msg.ok !== true) await sendAndSave(p.number, textMessage(p.number, TOO_LATE));
    return [];
  }

  async function machineMessage(keyHash, msg) {
    switch (msg && msg.type) {
      case 'hello': return hello(keyHash, { machine: msg.machine, version: msg.version });
      case 'link-start': return linkStart(keyHash, msg);
      case 'unlink': return unlink(keyHash);
      case 'prompt': return sendPrompt(keyHash, msg);
      case 'prompt-closed': return promptClosed(keyHash, msg);
      case 'decide-ack': return decideAck(keyHash, msg);
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
    await putAccount(account);
    await sendAndSave(account.number, textMessage(account.number, 'Disconnected.'));
    return routes;
  }

  // null when the text holds no valid code for this sender, so it can still be a typed answer.
  async function handleCode(item, code) {
    const rec = await store.get('code:' + code);
    const t = now();
    if (!rec || rec.expiresAt <= t || rec.number !== item.from) return null;
    const m = await store.get('machine:' + rec.keyHash);
    if (!m) return null;
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
    await putAccount(account);
    await sendAndSave(item.from, textMessage(item.from, `Connected: ${m.machine}`));
    return [{ keyHash: rec.keyHash, msg: statusMsg(m, await getAccount(item.from)) }];
  }

  // ---- answers ----

  // The sender must be the prompt's number and still own the machine the prompt came from.
  async function owns(p, from) {
    if (!p || p.number !== from) return false;
    const m = await store.get('machine:' + p.keyHash);
    return Boolean(m && m.number === from);
  }

  // True when the prompt can't take an answer. A tap that lost to the computer, or came after
  // the hold, gets one reply; a repeat of a phone answer (deciding, answered-phone) gets none.
  async function late(p) {
    if (p.state === 'deciding' || p.closedWhy === 'answered-phone') return true;
    if (p.state === 'open' && now() <= p.expiresAt) return false;
    const body = p.state === 'closed' && p.closedWhy === 'answered' ? ALREADY : TOO_LATE;
    await sendAndSave(p.number, textMessage(p.number, body));
    return true;
  }

  async function decide(p, decision) {
    p.state = 'deciding';
    await store.put(promptKey(p.ref), p);
    return [{ keyHash: p.keyHash, msg: { type: 'decide', pendingId: p.pendingId, decision }, expiresAt: p.expiresAt }];
  }

  // Records the current question's answer, then sends the next question or decides with all of them.
  async function answer(p, value) {
    const qs = p.prompt.questions;
    p.answers[qs[p.qIndex].question] = value;
    if (p.qIndex + 1 >= qs.length) return decide(p, { answers: p.answers });
    p.qIndex++;
    await store.put(promptKey(p.ref), p);
    const res = await sendAndSave(p.number, promptMessage(p.number, p.ref, p.prompt, p.qIndex), { ref: p.ref, qIndex: p.qIndex });
    if (!res.ok) await closeIfOpen(p.ref, 'send-failed');
    return [];
  }

  async function handleTap(item) {
    const at = item.buttonId.indexOf(':');
    if (at <= 0) return [];
    const p = await store.get(promptKey(item.buttonId.slice(0, at)));
    if (!(await owns(p, item.from)) || (await late(p))) return [];
    const choice = item.buttonId.slice(at + 1);
    if (choice === 'show') {
      await sendAndSave(p.number, promptMessage(p.number, p.ref, p.prompt, p.qIndex), { ref: p.ref, qIndex: p.qIndex });
      return [];
    }
    const table = CHOICES[p.prompt.kind];
    if (table && Object.hasOwn(table, choice)) return decide(p, { ...table[choice] });
    const m = /^q(\d+):o(\d+)$/.exec(choice);
    if (p.prompt.kind !== 'question' || !m || Number(m[1]) !== p.qIndex) return [];
    const options = p.prompt.questions[p.qIndex].options;
    const i = Number(m[2]);
    return i < options.length ? answer(p, String(options[i])) : [];
  }

  async function newestOpenQuestion(number) {
    const t = now();
    let best;
    for (const p of (await store.list('prompt:')).values()) {
      if (p.number !== number || p.state !== 'open' || p.prompt.kind !== 'question' || t > p.expiresAt) continue;
      if (!best || p.createdAt > best.createdAt) best = p;
    }
    return best;
  }

  // Typed text answers a question: the one it replies to (which must be the current one), else
  // the newest open question for that number. Text for an approval or plan, or with no target,
  // is ignored for free.
  async function handleText(item, text) {
    const ctx = item.contextId ? await store.get('msg:' + item.contextId) : null;
    let p;
    if (ctx && ctx.ref) {
      p = await store.get(promptKey(ctx.ref));
      if (!(await owns(p, item.from)) || p.prompt.kind !== 'question' || (await late(p))) return [];
      if (ctx.qIndex !== p.qIndex) return [];
    } else {
      p = await newestOpenQuestion(item.from);
      if (!(await owns(p, item.from))) return [];
    }
    return answer(p, typedAnswer(p.prompt.questions[p.qIndex], text));
  }

  // A Meta "failed" status refunds that message once.
  async function refund(id) {
    const rec = await store.get('msg:' + id);
    if (!rec || rec.refunded) return;
    const account = await getAccount(rec.number);
    if (account) {
      account.balance += rec.price;
      await putAccount(account);
    }
    rec.refunded = true;
    await store.put('msg:' + id, rec);
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
      if (item.buttonId) {
        routes.push(...(await handleTap(item)));
        continue;
      }
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (account && account.machines.length && text.toLowerCase() === 'stop') {
        routes.push(...(await handleStop(account)));
        continue;
      }
      const code = findCode(text);
      const linked = code ? await handleCode(item, code) : null;
      if (linked) routes.push(...linked);
      else if (account && text) routes.push(...(await handleText(item, text)));
    }
    for (const s of (parsed && parsed.statuses) || []) if (s.status === 'failed') await refund(s.id);
    return routes;
  }

  return { hello, machineMessage, webhook, queue, statusMsg, sendAndSave };
}
