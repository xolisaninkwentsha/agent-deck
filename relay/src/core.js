// Relay core: linking a phone number to machines, status, charged sending, and prompts with the
// answers that come back from taps and typed replies. Web-standard APIs only.
import { textMessage, promptMessage, templateMessage } from './whatsapp.js';
import { newCode, findCode, newRef, normalizeNumber, maskNumber } from './ids.js';
import { priceFor, reserve, release } from './credit.js';

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const MSG_KEEP_MS = 7 * DAY_MS; // long enough for Meta's "failed" statuses and reply context
const MACHINE_IDLE_MS = 30 * DAY_MS; // an unlinked machine not seen this long is forgotten
const MAX_LINK_ATTEMPTS = 5;
const MAX_PROMPT_MS = 600000; // Claude Code's hook timeout
const WINDOW_MARGIN_MS = 300000; // under 5 min left in the 24 h window → template
const LIST_ROWS = 10; // more options than a list holds → numbered text (as whatsapp.js does)
const TOO_LATE = "Too late: it's waiting in the terminal.";
const ALREADY = 'Already answered on the computer.';
const CLOSED_HERE = 'Closed on the computer.'; // the hook was closed (No or Esc in the terminal)
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

// What a machine hears when its message couldn't be handled at all: a prompt is reported failed,
// so the daemon never waits on it. Anything else gets no reply.
export function errorReplies(msg) {
  if (!msg || msg.type !== 'prompt' || typeof msg.pendingId !== 'string' || !msg.pendingId) return [];
  return [{ type: 'prompt-failed', pendingId: msg.pendingId, reason: 'error', balanceMicroUsd: null }];
}

// onError(where, error) hears about a message or webhook item that threw; it must not log values.
export function createRelay({ store, sender, config, now = Date.now, onError = () => {} }) {
  const getAccount = (number) => store.get('account:' + number);
  const putAccount = (account) => store.put('account:' + account.number, account);
  // The account's balance as it stands now, for the daemon's Settings; null when there's no account.
  const balanceOf = async (number) => {
    const account = number ? await getAccount(number) : null;
    return account ? account.balance : null;
  };

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
    m.lastSeen = now(); // the sweep forgets unlinked machines that stop saying hello
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

  // Replies carry the balance after the send, so Settings shows what the prompt cost.
  async function sendPrompt(keyHash, msg) {
    const { pendingId, prompt } = msg;
    const m = await store.get('machine:' + keyHash);
    const account = m && m.number ? await getAccount(m.number) : null;
    const failed = async (reason) => [{ type: 'prompt-failed', pendingId, reason, balanceMicroUsd: await balanceOf(account && m.number) }];
    const sentOk = async () => [{ type: 'prompt-sent', pendingId, balanceMicroUsd: await balanceOf(m.number) }];
    if (!account) return failed('not-linked');
    if (typeof pendingId !== 'string' || !pendingId || !validPrompt(prompt)) return failed('send-failed');
    // A repeat of a prompt still open or deciding is already on the phone: no second send or charge.
    const existing = await promptFor(keyHash, pendingId);
    if (existing && existing.state !== 'closed') return sentOk();
    const t = now();
    const expiresAt = Math.min(Number.isFinite(msg.expiresAt) ? msg.expiresAt : Infinity, t + MAX_PROMPT_MS);
    const ref = newRef();
    const number = m.number;
    await store.put(promptKey(ref), { ref, keyHash, pendingId, number, prompt, qIndex: 0, answers: {}, expiresAt, state: 'open', closedWhy: null, closedAt: null, createdAt: t });
    await store.put(pendingKey(keyHash, pendingId), ref);
    const payload = t < account.windowUntil - WINDOW_MARGIN_MS
      ? promptMessage(number, ref, prompt, 0)
      : templateMessage(number, ref, prompt, config.template);
    const res = await sendAndSave(number, payload, { ref, qIndex: 0 });
    if (!res.ok) {
      await closeIfOpen(ref, 'send-failed');
      return failed(res.reason);
    }
    return sentOk();
  }

  // A prompt that threw part-way is closed if it got stored, so a repeat of its pendingId is sent
  // afresh and a tap on it gets "Too late", and the daemon hears that it failed.
  async function sendPromptSafely(keyHash, msg) {
    try {
      return await sendPrompt(keyHash, msg);
    } catch (e) {
      onError('prompt', e);
      try {
        const p = typeof msg.pendingId === 'string' ? await promptFor(keyHash, msg.pendingId) : undefined;
        if (p && p.state === 'open') await close(p, 'error');
      } catch (e2) {
        onError('prompt clean-up', e2);
      }
      return errorReplies(msg);
    }
  }

  // Every close goes through here. Prompt text and answers aren't kept once a prompt closes; only
  // its kind stays, for late-tap replies.
  async function close(p, why) {
    p.state = 'closed';
    p.closedWhy = why;
    p.closedAt = now();
    p.prompt = { kind: p.prompt.kind };
    p.answers = {};
    await store.put(promptKey(p.ref), p);
  }

  // Re-reads the prompt, since a send may have let another event change it. True if this closed it.
  async function closeIfOpen(ref, why) {
    const p = await store.get(promptKey(ref));
    if (!p || p.state !== 'open') return false;
    await close(p, why);
    return true;
  }

  // The daemon's copy of a prompt that died after it was accepted: the next question couldn't be
  // sent, or Meta reported a message of it failed. Queued until the prompt's own expiry.
  async function failedRoute(p, reason) {
    return { keyHash: p.keyHash, msg: { type: 'prompt-failed', pendingId: p.pendingId, reason, balanceMicroUsd: await balanceOf(p.number) }, expiresAt: p.expiresAt };
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

  // A decide the daemon refused (the hook had just gone, usually) closes as 'refused': it and any
  // later tap get "Too late".
  async function decideAck(keyHash, msg) {
    const p = await promptFor(keyHash, msg.pendingId);
    if (!p || p.state !== 'deciding') return [];
    await close(p, msg.ok === true ? 'answered-phone' : 'refused');
    if (msg.ok !== true) await sendAndSave(p.number, textMessage(p.number, TOO_LATE));
    return [];
  }

  async function machineMessage(keyHash, msg) {
    switch (msg && msg.type) {
      case 'hello': return hello(keyHash, { machine: msg.machine, version: msg.version });
      case 'link-start': return linkStart(keyHash, msg);
      case 'unlink': return unlink(keyHash);
      case 'prompt': return sendPromptSafely(keyHash, msg);
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
    const closed = p.state === 'closed';
    const body = closed && p.closedWhy === 'answered' ? ALREADY : closed && p.closedWhy === 'gone' ? CLOSED_HERE : TOO_LATE;
    await sendAndSave(p.number, textMessage(p.number, body));
    return true;
  }

  async function decide(p, decision) {
    p.state = 'deciding';
    await store.put(promptKey(p.ref), p);
    return [{ keyHash: p.keyHash, msg: { type: 'decide', pendingId: p.pendingId, decision, balanceMicroUsd: await balanceOf(p.number) }, expiresAt: p.expiresAt }];
  }

  // Records the current question's answer, then sends the next question or decides with all of them.
  // A next question that can't be sent closes the prompt, and the daemon is told.
  async function answer(p, value) {
    const qs = p.prompt.questions;
    p.answers[qs[p.qIndex].question] = value;
    if (p.qIndex + 1 >= qs.length) return decide(p, { answers: p.answers });
    p.qIndex++;
    await store.put(promptKey(p.ref), p);
    const res = await sendAndSave(p.number, promptMessage(p.number, p.ref, p.prompt, p.qIndex), { ref: p.ref, qIndex: p.qIndex });
    if (!res.ok && (await closeIfOpen(p.ref, 'send-failed'))) return [await failedRoute(p, res.reason)];
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

  // A Meta "failed" status refunds that message once. If the message belonged to a prompt that is
  // still open, the phone never got it: the prompt closes and its daemon is told.
  async function failedStatus(id) {
    const rec = await store.get('msg:' + id);
    if (!rec || rec.refunded) return [];
    const account = await getAccount(rec.number);
    if (account) {
      account.balance += rec.price;
      await putAccount(account);
    }
    rec.refunded = true;
    await store.put('msg:' + id, rec);
    if (!rec.ref) return [];
    const p = await store.get(promptKey(rec.ref));
    return p && (await closeIfOpen(p.ref, 'send-failed')) ? [await failedRoute(p, 'send-failed')] : [];
  }

  async function inboundItem(item) {
    if (await store.get('seen:' + item.id)) return [];
    await store.put('seen:' + item.id, now());
    const account = await getAccount(item.from);
    if (account) {
      // Webhooks can arrive out of order: an older message never shortens the window.
      account.windowUntil = Math.max(account.windowUntil || 0, item.ts + config.windowMs);
      await putAccount(account);
    }
    if (item.buttonId) return handleTap(item);
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (account && account.machines.length && text.toLowerCase() === 'stop') return handleStop(account);
    const code = findCode(text);
    const linked = code ? await handleCode(item, code) : null;
    if (linked) return linked;
    return account && text ? handleText(item, text) : [];
  }

  // Each item is handled on its own, so one that throws doesn't lose the routes of the others.
  async function webhook(parsed) {
    const routes = [];
    for (const item of (parsed && parsed.inbound) || []) {
      try {
        routes.push(...(await inboundItem(item)));
      } catch (e) {
        onError('webhook message', e);
      }
    }
    for (const s of (parsed && parsed.statuses) || []) {
      if (s.status !== 'failed') continue;
      try {
        routes.push(...(await failedStatus(s.id)));
      } catch (e) {
        onError('webhook status', e);
      }
    }
    return routes;
  }

  // ---- clean-up (the Durable Object's alarm) ----

  // Expired prompts are closed, which strips their text. Closed ones stay an hour so late taps still
  // get "Too late", then go with their pending key, unless a newer prompt has taken that key over.
  // Returns counts only, for the log.
  async function sweep(nowMs = now()) {
    const counts = { closed: 0, prompts: 0, codes: 0, seen: 0, msgs: 0, outbox: 0, machines: 0 };
    // A machine that never linked (or unlinked) and hasn't said hello for 30 days goes, with its
    // outbox. A linked one stays: its number owns it.
    for (const [key, m] of await store.list('machine:')) {
      if (!m || m.number || m.lastSeen >= nowMs - MACHINE_IDLE_MS) continue;
      await store.delete(key);
      await store.delete('outbox:' + key.slice('machine:'.length));
      counts.machines++;
    }
    for (const p of (await store.list('prompt:')).values()) {
      if ((p.state === 'open' || p.state === 'deciding') && p.expiresAt < nowMs) {
        await close(p, 'timeout');
        counts.closed++;
      } else if (p.state === 'closed' && p.closedAt < nowMs - HOUR_MS) {
        await store.delete(promptKey(p.ref));
        const pk = pendingKey(p.keyHash, p.pendingId);
        if ((await store.get(pk)) === p.ref) await store.delete(pk);
        counts.prompts++;
      }
    }
    for (const [key, rec] of await store.list('code:')) {
      if (!rec || !(rec.expiresAt > nowMs)) {
        await store.delete(key);
        counts.codes++;
      }
    }
    for (const [key, at] of await store.list('seen:')) {
      if (!(at >= nowMs - DAY_MS)) {
        await store.delete(key);
        counts.seen++;
      }
    }
    for (const [key, rec] of await store.list('msg:')) {
      if (!rec || !(rec.at >= nowMs - MSG_KEEP_MS)) {
        await store.delete(key);
        counts.msgs++;
      }
    }
    for (const [key, box] of await store.list('outbox:')) {
      const list = Array.isArray(box) ? box : [];
      const keep = list.filter((e) => e && (e.expiresAt === null || e.expiresAt === undefined || e.expiresAt > nowMs));
      if (keep.length === list.length && list.length) continue;
      counts.outbox += list.length - keep.length;
      if (keep.length) await store.put(key, keep);
      else await store.delete(key);
    }
    return counts;
  }

  return { hello, machineMessage, webhook, queue, statusMsg, sendAndSave, sweep };
}
