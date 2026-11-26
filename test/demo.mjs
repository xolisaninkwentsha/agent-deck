// Feeds the local daemon a few fake sessions and two fake service agents, so you can see the
// panel without real agents.
// Usage: node test/demo.mjs        (Ctrl+C to stop; the fake sessions end on exit)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = (mode, input) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'hook.mjs'), mode], { env: process.env });
  let out = ''; p.stdout.on('data', (c) => { out += c; });
  p.on('close', () => resolve(out));
  p.stdin.end(JSON.stringify(input));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (id, cwd, event, extra = {}) => hook('observe', { session_id: id, cwd, hook_event_name: event, ...extra });

// Service agents report over POST /agent (what clients/python/modisa.py does).
const PORT = loadConfig().port;
const agent = (body) => fetch(`http://127.0.0.1:${PORT}/agent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
const at = (days, h, m) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.getTime(); };
async function demoAgents() {
  const fin = (ev) => agent({ agent: 'finance-agent-demo', ...ev });
  await fin({ event: 'start', name: 'finance-agent (demo)', description: 'Billing, collections and supplier bills; approvals in Google Chat', heartbeat: 5 });
  await fin({ event: 'schedule', schedule: [{ job: 'daily', next_run: at(1, 7, 47) }, { job: 'weekly', next_run: at(5, 7, 52) }] });
  await fin({ event: 'job_start', job: 'hourly' });
  await fin({ event: 'job_end', job: 'hourly', result: 'ok', summary: '2 payments matched, nothing to chase' });
  await fin({ event: 'job_start', job: 'daily', detail: 'morning run' });
  await fin({ event: 'step', text: 'Matching 14 payments to invoices' });
  await fin({ event: 'waiting', id: 'bill-1042', title: 'Approve supplier bill 1042 (R 18 400)', link: 'https://chat.google.com/room/DEMO/thread-1' });
  await fin({ event: 'waiting', id: 'remind-acme', title: 'Send the second reminder to Acme?', link: 'https://chat.google.com/room/DEMO/thread-2' });
  setInterval(() => fin({ event: 'heartbeat' }), 4000).unref();

  const fund = (ev) => agent({ agent: 'funding-agent-demo', ...ev });
  await fund({ event: 'start', name: 'funding agent (demo)', description: 'Fundraising round; drafts sent when an approver says so', heartbeat: 2 });
  await fund({ event: 'job_start', job: 'sync' });
  await fund({ event: 'job_end', job: 'sync', result: 'ok', summary: '3 new investor replies filed' });
  // ...and then no more heartbeats, so after 6 s it shows "Not responding".
}
// An agent that reports through OpenTelemetry (what an OTel SDK exporter sends), as OTLP/JSON.
const OTLP_PORT = loadConfig().otlpPort;
const otlp = (signal, body) => fetch(`http://127.0.0.1:${OTLP_PORT}/v1/${signal}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
const kv = (o) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: String(v) } }));
const ns = (ms) => String(BigInt(Math.round(ms)) * 1000000n);
const res = { attributes: kv({ 'service.name': 'invoices-agent-demo', 'service.version': '0.9.0', 'service.instance.id': 'demo-1' }) };
const span = (o) => ({ traceId: o.trace, spanId: o.id, parentSpanId: o.parent || '', name: o.name, kind: 1, startTimeUnixNano: ns(o.start), endTimeUnixNano: ns(o.end), attributes: kv(o.attrs || {}), events: (o.events || []).map((e) => ({ name: e.name, timeUnixNano: ns(o.end), attributes: kv(e.attrs) })), status: { code: o.status || 0 } });
const traces = (spans) => otlp('traces', { resourceSpans: [{ resource: res, scopeSpans: [{ scope: { name: 'demo' }, spans: spans.map(span) }] }] });
async function demoOtlpAgent() {
  const now = Date.now();
  // Two finished jobs (one failed), then one still running: its children have arrived, its root hasn't.
  await traces([
    { trace: '11'.repeat(16), id: '12'.repeat(8), parent: '13'.repeat(8), name: 'chat claude-sonnet-5-5', start: now - 3.6e6, end: now - 3.59e6, attrs: { 'job.name': 'reconcile', 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'claude-sonnet-5-5', 'gen_ai.usage.input_tokens': 18200, 'gen_ai.usage.output_tokens': 1450 } },
    { trace: '11'.repeat(16), id: '13'.repeat(8), name: 'invoke_agent reconcile', start: now - 3.6e6, end: now - 3.42e6, attrs: { 'job.name': 'reconcile', 'gen_ai.operation.name': 'invoke_agent' } },
    { trace: '21'.repeat(16), id: '23'.repeat(8), name: 'invoke_agent statements', start: now - 1.8e6, end: now - 1.79e6, status: 2, attrs: { 'job.name': 'statements', 'gen_ai.operation.name': 'invoke_agent', 'error.type': 'XeroAuthError' } },
    { trace: '31'.repeat(16), id: '32'.repeat(8), parent: '33'.repeat(8), name: 'chat claude-haiku-5-5', start: now - 40000, end: now - 30000, attrs: { 'job.name': 'chase-overdue', 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'claude-haiku-5-5', 'gen_ai.usage.input_tokens': 2400, 'gen_ai.usage.output_tokens': 310 } },
    { trace: '31'.repeat(16), id: '34'.repeat(8), parent: '33'.repeat(8), name: 'execute_tool xero_invoices', start: now - 30000, end: now - 25000, attrs: { 'job.name': 'chase-overdue', 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'xero_invoices' },
      events: [{ name: 'approval.requested', attrs: { 'approval.id': 'reminders-3', 'approval.title': 'Send 3 overdue reminders', 'url.full': 'https://chat.google.com/room/DEMO/thread-otel' } }] },
  ]);
  let beat = 0;
  const heartbeat = () => otlp('metrics', { resourceMetrics: [{ resource: res, scopeMetrics: [{ metrics: [{ name: 'agent.heartbeat', sum: { isMonotonic: true, aggregationTemporality: 2, dataPoints: [{ asInt: String(++beat), startTimeUnixNano: ns(now - 7.2e6), timeUnixNano: ns(Date.now()) }] } }] }] }] });
  await heartbeat();
  const t = setInterval(heartbeat, 10000);
  t.unref();
  setTimeout(() => clearInterval(t), 60000).unref(); // then it stops: "not responding" 3 minutes later
}

async function removeDemoAgents() {
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      for (const a of m.agents || []) if (a.name.endsWith('-demo')) ws.send(JSON.stringify({ type: 'dismiss-agent', key: a.key }));
      setTimeout(() => { ws.close(); resolve(); }, 200);
    };
    ws.onerror = () => resolve();
  });
}

const A = ['demo-a', '/home/you/code/voice-api'];
const B = ['demo-b', '/home/you/code/mymzansi-demo'];
const C = ['demo-c', '/home/you/code/speech-pricing'];
const D = ['demo-d', '/home/you/code/asr-eval'];

async function main() {
  for (const [id, cwd] of [A, B, C, D]) await ev(id, cwd, 'SessionStart', { source: 'startup' });

  await ev(...A, 'UserPromptSubmit', { prompt: 'Add streaming transcription endpoint' });
  for (const [i, t] of ['Read the API spec', 'Add WebSocket route', 'Chunk audio frames', 'Write tests', 'Update docs'].entries()) {
    await ev(...A, 'TaskCreated', { task_id: 'a' + i, task_subject: t });
  }
  for (const i of [0, 1, 2]) await ev(...A, 'TaskCompleted', { task_id: 'a' + i });
  await ev(...A, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'uvicorn app:app --reload', run_in_background: true, description: 'API dev server' }, tool_response: { backgroundTaskId: 'bg-a' } });
  await ev(...A, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/home/you/code/voice-api/tests/test_stream.py' } });

  await ev(...B, 'UserPromptSubmit', { prompt: 'Polish the onboarding flow' });
  await ev(...B, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run build', description: 'Build the app' } });

  await ev(...C, 'UserPromptSubmit', { prompt: 'Compare per-minute costs for the voice agent' });
  await ev(...C, 'SubagentStart', { agent_id: 'sa1', agent_type: 'Explore' });
  await ev(...C, 'PreToolUse', { tool_name: 'WebSearch', tool_input: { query: 'telephony per minute pricing South Africa' } });

  await ev(...D, 'UserPromptSubmit', { prompt: 'Re-run the WER benchmark on the new isiZulu set' });
  await ev(...D, 'Stop', { last_assistant_message: 'Benchmark finished: WER 11.8% (was 13.1%). Results are in reports/wer.md.', background_tasks: [] });

  // These two wait for an answer in the panel (or fall back to the terminal).
  const approval = hook('decide', { session_id: B[0], cwd: B[1], hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist && npm run deploy:staging' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run deploy:staging' }], behavior: 'allow', destination: 'localSettings' }] });
  await sleep(150);
  const question = hook('decide', { session_id: C[0], cwd: C[1], hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which pricing model should the sheet assume?', header: 'Pricing', multiSelect: false, options: [{ label: 'Per minute', description: '' }, { label: 'Per call', description: '' }, { label: 'Tiered', description: '' }] }] } });

  await demoAgents();
  await demoOtlpAgent();

  approval.then((out) => console.log('approval answer:', out || '(handed to terminal)'));
  question.then((out) => console.log('question answer:', out || '(handed to terminal)'));
  console.log('Demo sessions are live. Ctrl+C to end them.');

  const end = async () => {
    for (const [id, cwd] of [A, B, C, D]) await ev(id, cwd, 'SessionEnd', { reason: 'exit' });
    await removeDemoAgents();
    process.exit(0);
  };
  process.on('SIGINT', end);
  process.on('SIGTERM', end);
  if (process.env.DEMO_SECONDS) setTimeout(end, Number(process.env.DEMO_SECONDS) * 1000);
  await new Promise(() => {});
}
main();
