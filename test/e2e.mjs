// End-to-end test: real hook script -> real daemon -> fake widget over WebSocket.
// Runs in a throwaway AGENT_DECK_HOME on a spare port.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-test-'));
const PORT = 47000 + Math.floor(Math.random() * 900);
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ port: PORT, holdSeconds: 5, name: 'testbox' }));
const env = { ...process.env, AGENT_DECK_HOME: HOME, AGENT_DECK_PORT: String(PORT) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓ ' + name); };

function hook(mode, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'src', 'hook.mjs'), mode], { env });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(input));
  });
}

const S = 'sess-1';
const base = (event, extra = {}) => ({ session_id: S, cwd: '/work/voice-api', transcript_path: '/tmp/t.jsonl', hook_event_name: event, ...extra });

async function main() {
  console.log(`daemon home ${HOME}, port ${PORT}`);

  // 1. First hook call starts the daemon on its own.
  let r = await hook('observe', base('SessionStart', { source: 'startup' }));
  assert.equal(r.code, 0);
  ok('hook exits cleanly and starts the daemon on demand');

  // 2. Widget connects and receives the session.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let snap = null;
  const waiters = [];
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'snapshot') { snap = m; waiters.splice(0).forEach((f) => f()); } });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', approvals: true }));
  const next = () => new Promise((r) => waiters.push(r));
  const until = async (pred, label) => {
    for (let i = 0; i < 40; i++) { if (snap && pred(snap)) return snap; await Promise.race([next(), sleep(100)]); }
    throw new Error('timed out waiting for: ' + label + '\n' + JSON.stringify(snap, null, 2));
  };
  const sess = () => snap.sessions.find((s) => s.id === S);
  await until((m) => m.sessions.some((s) => s.id === S), 'session in snapshot');
  assert.equal(sess().project, 'voice-api');
  assert.equal(snap.host, 'testbox');
  ok('widget sees the new session with project name and machine name');

  // 3. Prompt + tool calls update status and current step.
  await hook('observe', base('UserPromptSubmit', { prompt: 'Add streaming support to the speech API' }));
  await hook('observe', base('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/work/voice-api/src/stream.py' }, tool_use_id: 't1' }));
  await until(() => sess()?.step === 'Editing stream.py', 'edit step');
  assert.equal(sess().status, 'working');
  assert.equal(sess().title, 'Add streaming support to the speech API');
  ok('current step and title update from tool calls');

  // 4. Task progress.
  await hook('observe', base('TaskCreated', { task_id: 'a', task_subject: 'Write tests' }));
  await hook('observe', base('TaskCreated', { task_id: 'b', task_subject: 'Wire endpoint' }));
  await hook('observe', base('TaskCompleted', { task_id: 'a', task_subject: 'Write tests' }));
  await until(() => sess()?.progress?.total === 2 && sess().progress.done === 1, 'progress');
  ok('task progress counts (1/2)');

  // 5. Permission request answered from the widget.
  const pending = hook('decide', base('PermissionRequest', {
    tool_name: 'Bash', tool_input: { command: 'rm -rf build' },
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build' }], behavior: 'allow', destination: 'localSettings' }],
  }));
  await until(() => sess()?.pending?.kind === 'approval', 'approval pending');
  assert.equal(sess().status, 'approval');
  assert.equal(sess().pending.detail, 'rm -rf build');
  assert.equal(sess().pending.canAlways, true);
  ws.send(JSON.stringify({ type: 'decide', pendingId: sess().pending.id, decision: { behavior: 'allow', always: true } }));
  r = await pending;
  const out = JSON.parse(r.out);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(out.hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(out.hookSpecificOutput.decision.updatedPermissions[0].type, 'addRules');
  ok('approval: widget "Always allow" returns allow + permission rule to Claude Code');

  // 6. Deny.
  const pending2 = hook('decide', base('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: '/etc/hosts' } }));
  await until(() => sess()?.pending?.tool === 'Write', 'approval 2');
  ws.send(JSON.stringify({ type: 'decide', pendingId: sess().pending.id, decision: { behavior: 'deny' } }));
  r = await pending2;
  assert.equal(JSON.parse(r.out).hookSpecificOutput.decision.behavior, 'deny');
  ok('approval: deny');

  // 7. Question answered from the widget on PreToolUse (bypassPermissions mode, where the
  //    PermissionRequest route is unverified).
  const questions = [{ question: 'Which audio format?', header: 'Format', multiSelect: false, options: [{ label: 'Opus', description: 'small' }, { label: 'WAV', description: 'raw' }] }];
  const pending3 = hook('decide', base('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions }, tool_use_id: 'q1', permission_mode: 'bypassPermissions' }));
  await until(() => sess()?.pending?.kind === 'question', 'question pending');
  let lastQ = sess().pending.id;
  assert.equal(sess().status, 'question');
  assert.equal(sess().pending.questions[0].options[1].label, 'WAV');
  ws.send(JSON.stringify({ type: 'decide', pendingId: sess().pending.id, decision: { answers: { 'Which audio format?': 'Opus' } } }));
  r = await pending3;
  const qo = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(qo.permissionDecision, 'allow');
  assert.deepEqual(qo.updatedInput.answers, { 'Which audio format?': 'Opus' });
  assert.deepEqual(qo.updatedInput.questions, questions);
  ok('question (bypass mode): answered on PreToolUse as allow + updatedInput.answers');

  // 7b. In a verified mode the PreToolUse for a question passes straight through...
  let t = Date.now();
  r = await hook('decide', base('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions }, tool_use_id: 'q5', permission_mode: 'default' }));
  assert.equal(r.out, '');
  assert.ok(Date.now() - t < 1500, 'PreToolUse question in default mode should not be held');
  await until(() => sess()?.pending === null, 'no pending after a pass-through PreToolUse');
  ok('question (default mode): PreToolUse is not held, so the terminal shows the question at once');

  // 7c. ...and the question is answered on its PermissionRequest instead.
  const pq = hook('decide', base('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions }, permission_mode: 'default' }));
  await until(() => sess()?.pending?.kind === 'question', 'question pending on PermissionRequest');
  const pqId = sess().pending.id;
  ws.send(JSON.stringify({ type: 'decide', pendingId: pqId, decision: { answers: { 'Which audio format?': 'WAV' } } }));
  r = await pq;
  const pqo = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(pqo.hookEventName, 'PermissionRequest');
  assert.equal(pqo.decision.behavior, 'allow');
  assert.deepEqual(pqo.decision.updatedInput, { questions, answers: { 'Which audio format?': 'WAV' } });
  ok('question (default mode): answered on PermissionRequest as allow + updatedInput.answers');

  // 7d. "Terminal" on a PermissionRequest question hands it back at once.
  const pq2 = hook('decide', base('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ ...questions[0], question: 'Again?' }] }, permission_mode: 'default' }));
  await until(() => sess()?.pending?.kind === 'question' && sess().pending.id !== pqId, 'second PermissionRequest question');
  t = Date.now();
  ws.send(JSON.stringify({ type: 'release', pendingId: sess().pending.id }));
  r = await pq2;
  assert.equal(r.out, '');
  assert.ok(Date.now() - t < 1500);
  ok('question (default mode): "Terminal" releases the PermissionRequest straight away');

  // 8. (No permission_mode, as from an older Claude Code: PreToolUse route.)
  //    "Answer in terminal" releases with no output; a follow-up PermissionRequest for the same question isn't held again.
  const pending4 = hook('decide', base('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions }, tool_use_id: 'q2' }));
  await until(() => sess()?.pending?.kind === 'question' && sess().pending.id !== lastQ, 'question 2');
  ws.send(JSON.stringify({ type: 'release', pendingId: sess().pending.id }));
  r = await pending4;
  assert.equal(r.out, '');
  const t0 = Date.now();
  r = await hook('decide', base('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions } }));
  assert.equal(r.out, '');
  assert.ok(Date.now() - t0 < 1500, 'released question should not be held twice');
  ok('"Answer in terminal" hands the prompt back immediately, without holding twice');

  // 9. Hold timeout falls back to the terminal.
  const t1 = Date.now();
  r = await hook('decide', base('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'make deploy' } }));
  assert.equal(r.out, '');
  assert.ok(Date.now() - t1 >= 4800, 'should wait for the hold');
  await until(() => sess()?.step === 'Waiting for you in the terminal', 'terminal fallback step');
  ok('unanswered request times out after holdSeconds and falls back to the terminal');

  // 10. Background tasks and subagents.
  await hook('observe', base('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run dev', run_in_background: true, description: 'Dev server' }, tool_response: { backgroundTaskId: 'bg1' }, tool_use_id: 't9' }));
  await hook('observe', base('SubagentStart', { agent_id: 'ag1', agent_type: 'Explore' }));
  await until(() => sess()?.background.length === 1 && sess().subagents.length === 1, 'bg + subagent');
  await hook('observe', base('SubagentStop', { agent_id: 'ag1', agent_type: 'Explore' }));
  await hook('observe', base('Stop', { last_assistant_message: 'Streaming is wired up; dev server is running.', background_tasks: [{ id: 'bg1', type: 'shell', status: 'running', description: 'Dev server', command: 'npm run dev' }, { id: 'bg2', type: 'subagent', status: 'running', description: 'Reviewing PR', agent_type: 'reviewer' }] }));
  await until(() => sess()?.status === 'background', 'background status');
  assert.equal(sess().background.length, 2);
  assert.equal(sess().subagents.length, 0);
  assert.match(sess().step, /Waiting on 2 background tasks/);
  ok('background tasks from Stop and subagents tracked');

  await hook('observe', base('Stop', { last_assistant_message: 'All done.', background_tasks: [] }));
  await until(() => sess()?.status === 'idle', 'idle');
  ok('turn finished with nothing running = idle, your turn');

  // 11. No widget with approvals: decide hooks return immediately.
  ws.send(JSON.stringify({ type: 'approvals', enabled: false }));
  await sleep(100);
  const t2 = Date.now();
  r = await hook('decide', base('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.equal(r.out, '');
  assert.ok(Date.now() - t2 < 1500);
  ok('with approvals off in the panel, Claude Code is never held up');

  // 12. Remote widgets need the token (only checked when daemon binds non-loopback, so just
  //     confirm the hook endpoint rejects nothing locally and session end cleans up).
  await hook('observe', base('SessionEnd', { reason: 'exit' }));
  await until(() => sess()?.status === 'ended', 'ended');
  ok('session end shows as ended');

  ws.close();
  const pid = Number(fs.readFileSync(path.join(HOME, 'daemon.pid'), 'utf8'));
  process.kill(pid, 'SIGTERM');
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error('\nFAILED:', e.message);
  try { process.kill(Number(fs.readFileSync(path.join(HOME, 'daemon.pid'), 'utf8')), 'SIGTERM'); } catch {}
  console.error(fs.existsSync(path.join(HOME, 'daemon.log')) ? fs.readFileSync(path.join(HOME, 'daemon.log'), 'utf8').slice(-3000) : '');
  process.exit(1);
});
