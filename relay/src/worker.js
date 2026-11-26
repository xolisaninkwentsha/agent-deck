// The relay's Worker: Meta's webhook, the daemons' /link WebSocket, and /health. Everything with
// state goes to the one Durable Object, RelayDO ('main'). Config is parsed only on the routes that
// need it, so /health and a refused /link work before any secret is set.
import { parseEnv } from './env.js';
import { verifySignature, parseWebhook } from './whatsapp.js';
import { sha256Hex } from './ids.js';

export { RelayDO } from './relay-do.js';

const MAX_BODY_BYTES = 1048576;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/i; // a 32-byte machine key in base64url

// Error classes only: messages can quote input (JSON.parse) or carry values.
const logError = (where, e) => console.error(`relay: ${where} failed: ${(e && e.name) || 'Error'}`);

const text = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers } });

const relay = (env) => env.RELAY.get(env.RELAY.idFromName('main'));

// parseEnv's messages name the variable and never its value, so they are safe to log.
function config(env) {
  try {
    return parseEnv(env);
  } catch (e) {
    console.error(`relay: config error: ${e.message}`);
    return null;
  }
}
const notConfigured = () => text('relay is not configured', 500);

// Compares digests, so the time taken says nothing about where the strings differ.
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// The raw text Meta signed, or null if it is over the cap.
async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

// Meta's one-off check when the webhook URL is saved.
async function verify(url, env) {
  const params = url.searchParams;
  const token = params.get('hub.verify_token');
  if (params.get('hub.mode') !== 'subscribe' || !token) return text('forbidden', 403);
  const cfg = config(env);
  if (!cfg) return notConfigured();
  if (!(await safeEqual(token, cfg.whatsapp.verifyToken))) return text('forbidden', 403);
  return text(params.get('hub.challenge') || '');
}

async function inbound(request, env) {
  const cfg = config(env);
  if (!cfg) return notConfigured();
  const raw = await readBody(request);
  if (raw === null) return text('too large', 413);
  if (!(await verifySignature(raw, request.headers.get('x-hub-signature-256'), cfg.whatsapp.appSecret))) return text('bad signature', 401);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return text('bad json', 400);
  }
  const parsed = parseWebhook(body, cfg.whatsapp.phoneNumberId);
  if (parsed.inbound.length || parsed.statuses.length) {
    try {
      const res = await relay(env).fetch('https://relay.internal/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      if (!res.ok) console.error(`relay: webhook forward failed: status ${res.status}`);
    } catch (e) {
      logError('webhook forward', e);
    }
  }
  // 200 even if the forward failed: Meta retries for up to 7 days but seen: lasts 1, so a 5xx could replay a stale "stop" or typed reply.
  return text('ok');
}

// The key identifies the machine; only its hash goes on, in x-key-hash, which this sets (replacing
// any the client sent). The Durable Object trusts that header because only this Worker reaches it.
async function link(request, env) {
  const m = BEARER.exec(request.headers.get('authorization') || '');
  if (!m) return text('unauthorized', 401);
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return text('websocket only', 426, { upgrade: 'websocket' });
  if (!config(env)) return notConfigured();
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  headers.set('x-key-hash', await sha256Hex(m[1]));
  return relay(env).fetch(new Request(request, { headers }));
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const { pathname } = url;
      const { method } = request;
      if (pathname === '/health' && method === 'GET') return text('ok');
      if (pathname === '/whatsapp/webhook' && method === 'GET') return await verify(url, env);
      if (pathname === '/whatsapp/webhook' && method === 'POST') return await inbound(request, env);
      if (pathname === '/link' && method === 'GET') return await link(request, env);
      return text('not found', 404);
    } catch (e) {
      logError('request', e);
      return text('error', 500);
    }
  },
};
