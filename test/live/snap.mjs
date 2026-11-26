// Print what the live-test daemon knows about each session: status | step | pending kind.
//   node snap.mjs [port]
const port = process.argv[2] || process.env.MODISA_LIVE_PORT || 47690;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  for (const s of m.sessions) console.log(`${s.project} | ${s.status} | ${s.step} | pending: ${s.pending ? s.pending.kind : '-'}`);
  ws.close();
};
ws.onerror = () => { console.error(`no daemon on port ${port}`); process.exit(1); };
