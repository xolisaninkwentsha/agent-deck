// WhatsApp Cloud API (Graph) helpers for the relay: message payloads, webhook parsing,
// signature check and a small sender. Web-standard APIs only, so this runs in Node and Workers.

const LIMITS = { body: 1024, button: 20, rowTitle: 24, rowDesc: 72, footer: 60, buttons: 3, rows: 10 };
const FOOTER = 'Or reply with your own answer';
const MULTI_HINT = 'Reply to this message with the numbers, e.g. 1 3';

// Cut to at most n characters; a cut string ends in an ellipsis that counts toward n.
function cut(s, n) {
  const chars = Array.from(String(s ?? ''));
  return chars.length <= n ? chars.join('') : chars.slice(0, n - 1).join('') + '…';
}

const base = (to) => ({ messaging_product: 'whatsapp', recipient_type: 'individual', to });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' && v ? v : undefined);

// ---- signature ----

const HEX64 = /^[0-9a-f]{64}$/i;

export async function verifySignature(rawBody, header, appSecret) {
  try {
    if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
    const theirs = header.slice(7).toLowerCase();
    if (!HEX64.test(theirs)) return false;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
    const ours = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
    let diff = 0;
    for (let i = 0; i < ours.length; i++) diff |= ours.charCodeAt(i) ^ theirs.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

// ---- webhook ----

export function parseWebhook(body) {
  const inbound = [];
  const statuses = [];
  if (!isObj(body)) return { inbound, statuses };
  for (const entry of arr(body.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      const value = isObj(change) ? change.value : null;
      if (!isObj(value)) continue;
      for (const m of arr(value.messages)) {
        if (!isObj(m) || typeof m.id !== 'string' || typeof m.from !== 'string') continue;
        const item = { id: m.id, from: m.from, ts: (Number(m.timestamp) || 0) * 1000 };
        if (m.type === 'text' && isObj(m.text) && typeof m.text.body === 'string') item.text = m.text.body;
        if (m.type === 'interactive' && isObj(m.interactive)) {
          const r = m.interactive.type === 'list_reply' ? m.interactive.list_reply : m.interactive.button_reply;
          if (isObj(r) && str(r.id)) item.buttonId = r.id;
        }
        if (m.type === 'button' && isObj(m.button) && str(m.button.payload)) item.buttonId = m.button.payload;
        if (isObj(m.context) && str(m.context.id)) item.contextId = m.context.id;
        inbound.push(item);
      }
      for (const s of arr(value.statuses)) {
        if (!isObj(s) || typeof s.id !== 'string' || typeof s.status !== 'string') continue;
        statuses.push({ id: s.id, status: s.status, recipient: typeof s.recipient_id === 'string' ? s.recipient_id : '' });
      }
    }
  }
  return { inbound, statuses };
}

// ---- messages ----

function buttons(to, text, list, footer) {
  const interactive = {
    type: 'button',
    body: { text },
    action: { buttons: list.map(([id, title]) => ({ type: 'reply', reply: { id, title: cut(title, LIMITS.button) } })) },
  };
  if (footer) interactive.footer = { text: footer };
  return { ...base(to), type: 'interactive', interactive };
}

function listMessage(to, text, options, ref, qIndex, footer) {
  const rows = options.map((label, i) => {
    const row = { id: `${ref}:q${qIndex}:o${i}`, title: cut(label, LIMITS.rowTitle) };
    if (Array.from(String(label)).length > LIMITS.rowTitle) row.description = cut(label, LIMITS.rowDesc);
    return row;
  });
  const interactive = { type: 'list', body: { text }, action: { button: 'Choose', sections: [{ title: 'Options', rows }] } };
  if (footer) interactive.footer = { text: footer };
  return { ...base(to), type: 'interactive', interactive };
}

export function promptMessage(to, ref, prompt, qIndex) {
  const project = prompt.project;
  if (prompt.kind === 'approval') {
    const text = cut(`${project} · Claude wants to ${String(prompt.title ?? '').toLowerCase()}\n\n${prompt.detail ?? ''}`, LIMITS.body);
    return buttons(to, text, [[`${ref}:allow`, 'Allow'], [`${ref}:deny`, 'Deny']]);
  }
  if (prompt.kind === 'plan') {
    const text = cut(`${project} · Plan to approve\n\n${prompt.detail ?? ''}`, LIMITS.body);
    return buttons(to, text, [[`${ref}:approve`, 'Approve'], [`${ref}:plan`, 'Keep planning']]);
  }
  const q = arr(prompt.questions)[qIndex] ?? {};
  const options = arr(q.options).map(String);
  const head = `${project} · ${q.header}: ${q.question}`;
  if (q.multiSelect || options.length > LIMITS.rows) {
    const numbered = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
    const room = LIMITS.body - MULTI_HINT.length - 2;
    return { ...base(to), type: 'text', text: { body: `${cut(`${head}\n\n${numbered}`, room)}\n\n${MULTI_HINT}` } };
  }
  const text = cut(head, LIMITS.body);
  if (options.length <= LIMITS.buttons) {
    return buttons(to, text, options.map((o, i) => [`${ref}:q${qIndex}:o${i}`, o]), FOOTER);
  }
  return listMessage(to, text, options, ref, qIndex, FOOTER);
}

export function textMessage(to, body, replyTo) {
  const m = { ...base(to), type: 'text', text: { body } };
  if (replyTo) m.context = { message_id: replyTo };
  return m;
}

export function templateMessage(to, ref, prompt, tpl) {
  return {
    ...base(to),
    type: 'template',
    template: {
      name: tpl.name,
      language: { code: tpl.lang },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: prompt.project }, { type: 'text', text: prompt.title }] },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `${ref}:show` }] },
      ],
    },
  };
}

// ---- sender ----

export function createSender({ fetch: doFetch, token, phoneNumberId, graphVersion }) {
  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;
  return {
    async send(payload) {
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) return { ok: false, error: `graph ${res.status}` };
        const data = await res.json();
        const id = data?.messages?.[0]?.id;
        return typeof id === 'string' ? { ok: true, id } : { ok: false, error: 'graph response had no message id' };
      } catch (e) {
        return { ok: false, error: `send failed: ${e?.name || 'error'}` };
      }
    },
  };
}
