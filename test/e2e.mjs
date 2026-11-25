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
// A fake ~/.claude, so the daemon doesn't pick up the real sessions on this machine.
const CLAUDE = path.join(HOME, 'claude');
fs.mkdirSync(path.join(CLAUDE, 'sessions'), { recursive: true });
const env = { ...process.env, AGENT_DECK_HOME: HOME, AGENT_DECK_PORT: String(PORT), CLAUDE_CONFIG_DIR: CLAUDE };
const sleepers = []; // stand-ins for running Claude Code processes
const fakeProcess = () => { const p = spawn('sleep', ['120']); sleepers.push(p); return p; };
const sessionFile = (pid, fields) => fs.writeFileSync(path.join(CLAUDE, 'sessions', `${pid}.json`), JSON.stringify({ pid, ...fields }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓ ' + name); };

function hook(mode, input) {
  let child;
  const done = new Promise((resolve) => {
    child = spawn(process.execPath, [path.join(ROOT, 'src', 'hook.mjs'), mode], { env });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
  done.child = child; // lets a test kill a held hook the way Claude Code does
  return done;
}

const S = 'sess-1';
const TRANSCRIPT = path.join(HOME, 'transcript.jsonl');
fs.writeFileSync(TRANSCRIPT, '');
const base = (event, extra = {}) => ({ session_id: S, cwd: '/work/voice-api', transcript_path: TRANSCRIPT, hook_event_name: event, ...extra });

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
  const until = async (pred, label, tries = 40) => {
    for (let i = 0; i < tries; i++) { if (snap && pred(snap)) return snap; await Promise.race([next(), sleep(100)]); }
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

  // 9b. "Yes" in the terminal doesn't cancel the hook; the matching PostToolUse must clear the card.
  const callInput = { command: 'npm run build', description: 'Build' };
  const heldYes = hook('decide', base('PermissionRequest', { tool_name: 'Bash', tool_input: callInput, permission_mode: 'default' }));
  await until(() => sess()?.pending?.detail === 'npm run build', 'held build approval');
  t = Date.now();
  await hook('observe', base('PostToolUse', { tool_name: 'Bash', tool_input: { description: 'Build', command: 'npm run build' }, tool_response: {}, tool_use_id: 'b1' }));
  r = await heldYes;
  assert.equal(r.out, '');
  assert.ok(Date.now() - t < 1500, 'the held hook should be let go at once');
  await until(() => sess()?.pending === null && sess().status === 'working', 'card cleared and working');
  ok('answered "Yes" in the terminal: the matching PostToolUse clears the card and shows working');

  // 9c. A question answered in the terminal: PostToolUse repeats the questions and adds answers.
  const heldQ = hook('decide', base('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions }, permission_mode: 'default' }));
  await until(() => sess()?.pending?.kind === 'question', 'held question');
  await hook('observe', base('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions, answers: { 'Which audio format?': 'Opus' } }, tool_response: {}, tool_use_id: 'q9' }));
  assert.equal((await heldQ).out, '');
  await until(() => sess()?.pending === null && sess().status === 'working', 'question card cleared');
  ok('question answered in the terminal clears the card');

  // 9d. The turn ending (Stop) also clears a card whose prompt can no longer be open.
  const heldStop = hook('decide', base('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: '/work/voice-api/a.txt' }, permission_mode: 'default' }));
  await until(() => sess()?.pending?.tool === 'Write', 'held write approval');
  await hook('observe', base('Stop', { last_assistant_message: 'ok', background_tasks: [] }));
  assert.equal((await heldStop).out, '');
  await until(() => sess()?.pending === null && sess().status === 'idle', 'idle after Stop');
  ok('Stop clears a held card');

  // 9e. "No"/Esc in the terminal: Claude Code kills the hook and sends nothing else.
  const heldNo = hook('decide', base('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' }, permission_mode: 'default' }));
  await until(() => sess()?.pending?.detail === 'rm -rf dist', 'held rm approval');
  heldNo.child.kill('SIGKILL');
  await until(() => sess()?.pending === null && sess().status === 'idle' && sess().step === 'Interrupted in the terminal', 'idle after hook killed');
  ok('hook killed by Claude Code ("No" in the terminal) shows your turn, not "needs approval"');

  // 9f. A question waiting in the terminal stays a question when Claude Code's
  //     permission_prompt notification arrives (it sends one for questions too).
  const heldQ2 = hook('decide', base('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions }, permission_mode: 'default' }));
  await until(() => sess()?.pending?.kind === 'question', 'held question 2');
  ws.send(JSON.stringify({ type: 'release', pendingId: sess().pending.id }));
  await heldQ2;
  await hook('observe', base('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }));
  await sleep(300);
  await until(() => sess()?.status === 'question', 'still a question');
  ok('permission_prompt notification keeps a waiting question labelled as a question');

  // 9g. "No" after the card went back to the terminal: no hook is alive and no event comes,
  //     only the transcript shows it. The daemon must notice within its housekeeping tick.
  fs.appendFileSync(TRANSCRIPT, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }) + '\n');
  await until(() => sess()?.status === 'idle' && sess().step === 'Interrupted in the terminal', 'transcript interrupt noticed', 60);
  ok('"No" in the terminal after the hand-off is picked up from the transcript');

  // 9h. A session with no hooks, found in Claude Code's own session files, shows watch-only.
  const old = fakeProcess();
  fs.mkdirSync(path.join(CLAUDE, 'projects', '-work-old-app'), { recursive: true });
  fs.writeFileSync(path.join(CLAUDE, 'projects', '-work-old-app', 'disc-1.jsonl'), [
    { type: 'user', message: { role: 'user', content: 'tidy the logs' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Cleaning up the log handling.' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/work/old-app/logs.py' } }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const oldFile = (fields) => sessionFile(old.pid, { sessionId: 'disc-1', cwd: '/work/old-app', name: 'tidy-old-logs', startedAt: Date.now(), ...fields });
  oldFile({ status: 'busy', statusUpdatedAt: Date.now() });
  const disc = () => snap.sessions.find((x) => x.id === 'disc-1');
  await until(() => disc()?.step === 'Editing logs.py', 'discovered session', 60);
  assert.equal(disc().watchOnly, true);
  assert.equal(disc().title, 'tidy-old-logs');
  assert.equal(disc().project, 'old-app');
  assert.equal(disc().status, 'working');
  assert.equal(disc().lastMessage, 'Cleaning up the log handling.');
  ok('session without hooks: found in ~/.claude/sessions, watch-only, step from its transcript');

  oldFile({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: Date.now() });
  await until(() => disc()?.status === 'approval' && disc().step === 'Needs approval in the terminal', 'watch-only approval', 60);
  ok('session without hooks: shows when Claude Code waits for a permission in the terminal');

  await hook('observe', { session_id: 'disc-1', cwd: '/work/old-app', hook_event_name: 'UserPromptSubmit', prompt: 'carry on' });
  await until(() => disc()?.watchOnly === false && disc().status === 'working', 'hooks took over');
  assert.equal(disc().title, 'tidy-old-logs');
  old.kill();
  await until(() => disc()?.status === 'ended', 'discovered session ended', 60);
  ok('session without hooks: a hook event takes it over; it ends when its process exits');

  // 9i. Claude Code's own status settles a held card that no hook event would clear
  //     ("Yes" in the terminal on a long-running command, or feedback on a plan).
  const rec = fakeProcess();
  const SR = 'sess-r';
  const rbase = (event, extra = {}) => ({ session_id: SR, cwd: '/work/recon', hook_event_name: event, ...extra });
  const recFile = (fields) => sessionFile(rec.pid, { sessionId: SR, cwd: '/work/recon', ...fields });
  const rs = () => snap.sessions.find((x) => x.id === SR);
  recFile({ status: 'busy', statusUpdatedAt: Date.now() - 5000 });
  await hook('observe', rbase('UserPromptSubmit', { prompt: 'build it' }));
  const heldLong = hook('decide', rbase('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run long' }, permission_mode: 'default' }));
  await until(() => rs()?.pending?.detail === 'npm run long', 'held long command');
  recFile({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: Date.now() });
  await sleep(2500); // a housekeeping tick while Claude Code still shows the prompt
  assert.ok(rs().pending, 'the card must stay while Claude Code still shows the prompt');
  recFile({ status: 'busy', statusUpdatedAt: Date.now() });
  assert.equal((await heldLong).out, '');
  await until(() => rs()?.pending === null && rs().status === 'working' && rs().step === 'Answered in the terminal', 'settled from Claude Code status', 60);
  ok('a held card clears when Claude Code says its prompt is no longer open');

  // 9j. A card left "waiting in the terminal" clears when Claude Code says it's idle again.
  const heldRel = hook('decide', rbase('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run other' }, permission_mode: 'default' }));
  await until(() => rs()?.pending?.detail === 'npm run other', 'held other command');
  recFile({ status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: Date.now() });
  ws.send(JSON.stringify({ type: 'release', pendingId: rs().pending.id }));
  await heldRel;
  await until(() => rs()?.step === 'Waiting for you in the terminal', 'released to terminal');
  await sleep(1200);
  recFile({ status: 'idle', statusUpdatedAt: Date.now() });
  await until(() => rs()?.status === 'idle' && rs().step === 'Answered in the terminal', 'cleared from Claude Code status', 60);
  ok('a card waiting in the terminal clears when Claude Code says the session is idle');
  rec.kill();

  // 9k. Context-window meter from the transcript's token usage.
  const CTX = path.join(HOME, 'ctx.jsonl');
  const usageLine = (model, used, extra = {}) => JSON.stringify({
    type: 'assistant', ...extra,
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, cache_creation_input_tokens: 990, cache_read_input_tokens: used - 1000, output_tokens: 50 } },
  }) + '\n';
  fs.writeFileSync(CTX, usageLine('claude-opus-5-5', 100000) + usageLine('claude-opus-5-5', 401000) + usageLine('claude-opus-5-5', 900000, { isSidechain: true }));
  await hook('observe', { session_id: 'sess-ctx', cwd: '/work/ctx', transcript_path: CTX, hook_event_name: 'SessionStart', source: 'startup' });
  const cs = () => snap.sessions.find((x) => x.id === 'sess-ctx');
  await until(() => cs()?.context?.used === 401000, 'context from the newest main-thread message', 60);
  assert.equal(cs().context.window, 1000000);
  assert.equal(cs().context.percent, 40);
  assert.equal(cs().context.warn, false);
  ok('context meter: newest main-thread usage (subagents ignored), Opus 5.5 = 1M window');

  fs.appendFileSync(CTX, usageLine('claude-haiku-4-5', 170000));
  await until(() => cs()?.context?.used === 170000, 'context grows with the transcript', 60);
  assert.equal(cs().context.window, 200000);
  assert.equal(cs().context.percent, 85);
  assert.equal(cs().context.warn, true);
  ok('context meter: Haiku 4.5 = 200K window, warns from 80%');

  fs.appendFileSync(CTX, usageLine('claude-unknown-model', 210000));
  await until(() => cs()?.context?.used === 210000, 'unknown model', 60);
  assert.equal(cs().context.window, 1000000);
  ok('context meter: more than 200K in use means the window is bigger (1M)');

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
  for (const p of sleepers) p.kill();
  const pid = Number(fs.readFileSync(path.join(HOME, 'daemon.pid'), 'utf8'));
  process.kill(pid, 'SIGTERM');
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  for (const p of sleepers) p.kill();
  console.error('\nFAILED:', e.message);
  try { process.kill(Number(fs.readFileSync(path.join(HOME, 'daemon.pid'), 'utf8')), 'SIGTERM'); } catch {}
  console.error(fs.existsSync(path.join(HOME, 'daemon.log')) ? fs.readFileSync(path.join(HOME, 'daemon.log'), 'utf8').slice(-3000) : '');
  process.exit(1);
});
