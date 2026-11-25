// Drive the test panel over the Chrome DevTools Protocol.
//   node cdp.mjs <port> eval '<js expression>'
//   node cdp.mjs <port> shot <out.png>
const [port, cmd, arg] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
// CDP_URL=activity picks a window by its page URL (e.g. the activity window); default: the first page.
const page = targets.find((t) => t.type === 'page' && (!process.env.CDP_URL || t.url.includes(process.env.CDP_URL)));
if (!page) { console.error('no page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const my = ++id;
  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== my) return;
    ws.removeEventListener('message', onMsg);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id: my, method, params }));
});
if (cmd === 'eval') {
  const r = await call('Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true, userGesture: true });
  console.log(r.exceptionDetails ? 'EXCEPTION ' + JSON.stringify(r.exceptionDetails) : JSON.stringify(r.result.value, null, 1));
} else if (cmd === 'shot') {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(arg, Buffer.from(r.data, 'base64'));
  console.log('saved ' + arg);
}
ws.close();
process.exit(0);
