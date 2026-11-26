// The relay's single Durable Object (idFromName('main')): it holds every daemon's WebSocket
// (hibernating between messages) and runs the relay core against its SQLite-backed storage.
//
// It is reachable only through the Worker's RELAY binding, never from the internet, so it trusts
// what the Worker forwards: `x-key-hash` on /link (the Worker sets it from the Authorization key and
// overwrites any copy the client sent), and the parsed body on /webhook (the Worker has already
// checked Meta's signature).
//
// First answer wins because of Durable Object input gates: while a storage call is in flight, no
// other event is delivered. The store adapter therefore calls ctx.storage directly and adds no other
// awaits, and nothing here uses allowConcurrency or otherwise opts out of input gates.
import { DurableObject } from 'cloudflare:workers';
import { createRelay, errorReplies } from './core.js';
import { createSender } from './whatsapp.js';
import { parseEnv } from './env.js';

const SWEEP_MS = 600000;
const MAX_FRAME_BYTES = 65536;
const KEY_HASH = /^[0-9a-f]{64}$/;
const WS_OPEN = 1;

// Error classes only: messages can quote input (JSON.parse) or carry values.
const logError = (where, e) => console.error(`relay: ${where} failed: ${(e && e.name) || 'Error'}`);

const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export class RelayDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // The daemon's keepalive "ping" is answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // Built per instance, which hibernation throws away, so it never outlives the object's memory.
  relay() {
    if (!this.core) {
      const config = parseEnv(this.env);
      const storage = this.ctx.storage;
      const store = {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: (key) => storage.delete(key),
        list: (prefix) => storage.list({ prefix }),
      };
      const sender = createSender({
        fetch: (url, init) => fetch(url, init),
        token: config.whatsapp.token,
        phoneNumberId: config.whatsapp.phoneNumberId,
        graphVersion: config.whatsapp.graphVersion,
      });
      this.core = createRelay({ store, sender, config, onError: logError });
    }
    return this.core;
  }

  async fetch(request) {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    const { pathname } = new URL(request.url);
    if (pathname === '/link') return this.link(request);
    if (pathname === '/webhook' && request.method === 'POST') return this.webhook(request);
    return text('not found', 404);
  }

  // One connection per machine: a newer one replaces any older one with the same key.
  link(request) {
    const keyHash = request.headers.get('x-key-hash') || '';
    if (!KEY_HASH.test(keyHash)) return text('bad request', 400);
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return text('websocket only', 426);
    const older = this.ctx.getWebSockets(keyHash);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [keyHash]);
    server.serializeAttachment({ keyHash });
    for (const ws of older) {
      try {
        ws.close(4000, 'replaced');
      } catch {}
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // The core handles each webhook item on its own; each route is delivered on its own too, so one
  // failure never drops the others.
  async webhook(request) {
    let relay;
    let routes;
    try {
      const parsed = await request.json();
      relay = this.relay();
      routes = await relay.webhook(parsed);
    } catch (e) {
      logError('webhook', e);
      return text('error', 500);
    }
    for (const route of routes) {
      try {
        await this.deliver(relay, route);
      } catch (e) {
        logError('deliver', e);
      }
    }
    return text('ok');
  }

  // To the machine's open socket if it has one, else its outbox for the next hello. A replaced
  // socket can still be listed while it closes, so only an OPEN one counts.
  async deliver(relay, { keyHash, msg, expiresAt }) {
    for (const ws of this.ctx.getWebSockets(keyHash)) {
      if (ws.readyState !== WS_OPEN) continue;
      try {
        ws.send(JSON.stringify(msg));
        return;
      } catch {}
    }
    await relay.queue(keyHash, msg, expiresAt);
  }

  // Text frames of JSON only. The machine is the socket's attachment, never anything in the message.
  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_FRAME_BYTES) return;
    if (new TextEncoder().encode(data).byteLength > MAX_FRAME_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const attachment = ws.deserializeAttachment();
    const keyHash = attachment && attachment.keyHash;
    if (typeof keyHash !== 'string' || !KEY_HASH.test(keyHash)) return;
    // The core already turns a prompt that throws into prompt-failed; this covers the rest (the
    // config can't be read, say), so the daemon never waits on a prompt nobody is handling.
    let replies;
    try {
      replies = await this.relay().machineMessage(keyHash, msg);
    } catch (e) {
      logError('machine message', e);
      replies = errorReplies(msg);
    }
    for (const reply of replies) {
      try {
        ws.send(JSON.stringify(reply));
      } catch {}
    }
  }

  // Answer the peer's close (the runtime may already have done so).
  async webSocketClose(ws, code, reason) {
    try {
      if (code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code)) ws.close(code, reason);
      else ws.close();
    } catch {}
  }

  async webSocketError(ws, e) {
    logError('websocket', e);
  }

  async alarm() {
    try {
      const counts = await this.relay().sweep();
      console.log(`relay: sweep ${JSON.stringify(counts)}`);
    } catch (e) {
      logError('sweep', e);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    }
  }
}
