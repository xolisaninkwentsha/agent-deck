// A fake relay for the live harness (dev only): node test/live/fake-relay.mjs <port>
// Point the harness daemon at it with AGENT_DECK_RELAY=ws://127.0.0.1:<port>/link.
//   hello      -> an unlinked status
//   link-start -> a link-code, then ~3 s later a linked status (as if you had sent the code)
//   prompt     -> prompt-sent
//   unlink     -> an unlinked status
// It checks only that an Authorization: Bearer header is present.
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2]) || 47691;
const BOT = '27000000000';
const wss = new WebSocketServer({
  port, host: '127.0.0.1', path: '/link',
  verifyClient: ({ req }) => /^Bearer \S+/.test(req.headers.authorization || ''),
});

const unlinked = { type: 'status', linked: false, number: null, balanceMicroUsd: null, billing: null, botNumber: BOT };
const linked = { type: 'status', linked: true, number: '+27•••••4567', balanceMicroUsd: 1500000, billing: 'trial', botNumber: BOT };

wss.on('connection', (ws) => {
  const put = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  let linkTimer = null;
  ws.on('close', () => clearTimeout(linkTimer));
  ws.on('message', (data) => {
    const text = data.toString();
    if (text === 'ping') { ws.send('pong'); return; }
    let msg; try { msg = JSON.parse(text); } catch { return; }
    switch (msg.type) {
      case 'hello': put(unlinked); break;
      case 'link-start':
        put({ type: 'link-code', code: 'ABCD2345', expiresAt: Date.now() + 10 * 60 * 1000, botNumber: BOT });
        clearTimeout(linkTimer);
        linkTimer = setTimeout(() => put(linked), 3000);
        break;
      case 'prompt': put({ type: 'prompt-sent', pendingId: msg.pendingId }); break;
      case 'unlink': clearTimeout(linkTimer); put(unlinked); break;
      default: break;
    }
  });
});
wss.on('listening', () => console.log(`fake relay on ws://127.0.0.1:${port}/link`));
