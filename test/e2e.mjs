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
const CRONTAB = path.join(HOME, 'crontab'); // instead of the real `crontab -l`
fs.writeFileSync(CRONTAB, '');
const env = { ...process.env, AGENT_DECK_HOME: HOME, AGENT_DECK_PORT: String(PORT), CLAUDE_CONFIG_DIR: CLAUDE, AGENT_DECK_CRONTAB: CRONTAB, AGENT_DECK_JOB_MAX_MS: '6000' };
delete env.AGENT_DECK_DISABLE;
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

  // 3b. Permission mode from the hook input, following Shift+Tab changes.
  await hook('observe', base('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/voice-api/a.py' }, permission_mode: 'plan' }));
  await until(() => sess()?.permissionMode === 'plan', 'plan mode');
  await hook('observe', base('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/work/voice-api/b.py' }, permission_mode: 'auto' }));
  await until(() => sess()?.permissionMode === 'auto', 'auto mode');
  ok('permission mode follows the hook input (plan, then auto)');

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

  // 9l. The panel's settings change holdSeconds in config.json; the daemon picks it up live.
  const cfgFile = path.join(HOME, 'config.json');
  const setHold = (n) => fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), holdSeconds: n }));
  setHold(7);
  await until(() => snap.holdSeconds === 7, 'daemon reloaded holdSeconds', 60);
  const heldNew = hook('decide', base('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'echo hold' }, permission_mode: 'default' }));
  await until(() => sess()?.pending?.detail === 'echo hold', 'hold with the new time');
  assert.equal(sess().pending.expiresAt - sess().pending.createdAt, 7000);
  ws.send(JSON.stringify({ type: 'release', pendingId: sess().pending.id }));
  await heldNew;
  setHold(5);
  ok('a hold time changed in the settings applies to the next prompt without restarting the daemon');

  // 9m. Service agents over POST /agent.
  const agentPost = (body, host = '127.0.0.1', port = PORT) => fetch(`http://${host}:${port}/agent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((res) => (res.status === 200 ? res.json() : { status: res.status }));
  const ag = (name) => snap.agents?.find((a) => a.name === name);
  fs.writeFileSync(CRONTAB, [
    'CRON_TZ=Africa/Johannesburg', 'APP=/work/fin', 'RUN=flock data/x.lock .venv/bin/python -m fin_agent',
    '47 7 * * 1-5  cd $APP && $RUN daily >> data/cron.log 2>&1', '52 7 * * 1  cd $APP && $RUN weekly',
    '15 * * * *  cd /work/elsewhere && .venv/bin/python -m other_agent hourly', '',
  ].join('\n'));
  assert.equal((await agentPost({ agent: 'fin-agent', event: 'start', name: 'Finance agent', description: 'Billing', heartbeat: 1, cwd: '/work/fin' })).ok, true);
  const beat = setInterval(() => agentPost({ agent: 'fin-agent', event: 'heartbeat' }).catch(() => {}), 300);
  await until(() => ag('fin-agent')?.schedule.length === 2, 'agent schedule from the crontab', 60);
  assert.deepEqual(ag('fin-agent').schedule.map((s) => s.job).sort(), ['daily', 'weekly']);
  assert.equal(ag('fin-agent').status, 'idle');
  assert.equal(ag('fin-agent').displayName, 'Finance agent');
  ok('agent: "start" registers it, and its cron jobs come from the crontab');

  await agentPost({ agent: 'fin-agent', event: 'job_start', job: 'daily', detail: 'morning run' });
  await agentPost({ agent: 'fin-agent', event: 'step', text: 'Matching payments' });
  await until(() => ag('fin-agent')?.status === 'working' && ag('fin-agent').step === 'Matching payments', 'agent working');
  assert.equal(ag('fin-agent').job.job, 'daily');
  await agentPost({ agent: 'fin-agent', event: 'waiting', id: 'bill-42', title: 'Approve supplier bill 42', link: 'https://chat.google.com/room/AAA/BBB' });
  await agentPost({ agent: 'fin-agent', event: 'waiting', id: 'evil', title: 'Not a web link', link: 'javascript:alert(1)' });
  await until(() => ag('fin-agent')?.waiting.length === 2, 'two items waiting');
  assert.equal(ag('fin-agent').status, 'waiting');
  assert.equal(ag('fin-agent').waiting.find((w) => w.id === 'bill-42').link, 'https://chat.google.com/room/AAA/BBB');
  assert.equal(ag('fin-agent').waiting.find((w) => w.id === 'evil').link, '');
  for (const id of ['bill-42', 'evil']) await agentPost({ agent: 'fin-agent', event: 'resolved', id });
  await agentPost({ agent: 'fin-agent', event: 'job_end', job: 'daily', result: 'ok', summary: '3 reminders sent' });
  await until(() => ag('fin-agent')?.status === 'idle' && ag('fin-agent').lastJob?.summary === '3 reminders sent', 'job finished');
  assert.equal(ag('fin-agent').lastJob.result, 'ok');
  ok('agent: job, step, waiting (only web links kept), resolved, job end');

  await agentPost({ agent: 'fin-agent', event: 'error', message: 'Xero sign-in expired' });
  await until(() => ag('fin-agent')?.status === 'error', 'agent error');
  await agentPost({ agent: 'fin-agent', event: 'job_start', job: 'weekly' });
  await until(() => ag('fin-agent')?.status === 'working', 'a new job clears the error');
  await agentPost({ agent: 'fin-agent', event: 'job_end', job: 'weekly', result: 'error', summary: 'RuntimeError: boom' });
  await until(() => ag('fin-agent')?.status === 'error' && ag('fin-agent').lastError?.message === 'RuntimeError: boom', 'failed job');
  assert.equal((await agentPost({ agent: 'bad name!', event: 'start' })).ok, false);
  assert.equal((await agentPost({ agent: 'fin-agent', event: 'explode' })).ok, false);
  ok('agent: errors show until the next job; bad names and unknown events are refused');

  clearInterval(beat);
  await until(() => ag('fin-agent')?.status === 'not_responding', 'not responding after 3x the heartbeat', 80);
  await agentPost({ agent: 'fin-agent', event: 'heartbeat' });
  await until(() => ag('fin-agent')?.status !== 'not_responding', 'back after a heartbeat');
  ok('agent: no heartbeat for 3x its interval shows "not responding"; a heartbeat brings it back');

  // 9m2. The cron matcher on fixed (local) times.
  const { nextRun } = await import('../src/agents.mjs');
  const wed0800 = new Date(2026, 10, 25, 8, 0).getTime(); // Wed 25 Nov 2026 08:00
  const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
  assert.equal(nextRun('47 7 * * 1-5', wed0800), at(2026, 11, 26, 7, 47));      // next weekday morning
  assert.equal(nextRun('*/30 7-19 * * 1-5', wed0800), at(2026, 11, 25, 8, 0));  // right now counts
  assert.equal(nextRun('57 7 1 * *', wed0800), at(2026, 12, 1, 7, 57));         // month end run
  assert.equal(nextRun('30 5 * * 1', wed0800), at(2026, 11, 30, 5, 30));         // Monday
  assert.equal(nextRun('0 9 * * 6,0', wed0800), at(2026, 11, 28, 9, 0));         // weekend list
  assert.equal(nextRun('not a cron', wed0800), null);
  ok('cron matcher: weekdays, steps, ranges, month days, lists');

  // 9n. The Python client against the daemon, and with no daemon at all.
  const CLIENT_DIR = path.join(ROOT, 'clients', 'python');
  const py = (code, port) => new Promise((resolve) => {
    const t = Date.now();
    const p = spawn('python3', ['-I', '-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(CLIENT_DIR)})\n${code}`], { env: { ...env, AGENT_DECK_PORT: String(port) } });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t }));
  });
  const pyAgent = [
    'from agent_deck import Deck',
    'd = Deck("py-agent")',
    'd.start("from python", heartbeat=0)',
    'with d.job("nightly", "test run") as j:',
    '    d.step("crunching")',
    '    d.waiting("w1", "Check the draft", "https://mail.google.com/mail/u/0/#inbox/abc")',
    '    j.summary = "done"',
    'try:',
    '    with d.job("broken"):',
    '        raise ValueError("nope")',
    'except ValueError:',
    '    print("re-raised")',
  ].join('\n');
  r = await py(pyAgent, PORT);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 're-raised');
  await until(() => ag('py-agent')?.recent.length === 2, 'python agent jobs', 60);
  assert.deepEqual(ag('py-agent').recent.map((j) => [j.job, j.result]), [['broken', 'error'], ['nightly', 'ok']]);
  assert.equal(ag('py-agent').recent[1].summary, 'done');
  assert.equal(ag('py-agent').recent[0].summary, 'ValueError', 'only the exception type, never its message');
  assert.equal(ag('py-agent').waiting[0].title, 'Check the draft');
  ok('Python client: job/step/waiting/summary arrive; the job\'s own exception is re-raised');
  r = await py(pyAgent, PORT + 500); // nothing listens there
  assert.equal(r.code, 0, r.err);
  assert.ok(r.ms < 2500, `took ${r.ms} ms`);
  ok('Python client: with no daemon it neither raises nor hangs');
  r = await py('import os; os.environ["AGENT_DECK_DISABLE"] = "1"\n' + pyAgent.replace('"py-agent"', '"py-off"'), PORT);
  assert.equal(r.code, 0, r.err);
  await sleep(500);
  assert.equal(ag('py-off'), undefined);
  ok('Python client: AGENT_DECK_DISABLE=1 sends nothing (for the agents\' own tests)');

  // 9n2. Two kinds of process per agent: a restart of the long-running one must not hide a
  //      cron job mid-run or an error; the full open list replaces drifted items; a job that
  //      never ends expires.
  await agentPost({ agent: 'two-proc', event: 'start', heartbeat: 0 });
  await agentPost({ agent: 'two-proc', event: 'job_start', job: 'nightly' });
  await agentPost({ agent: 'two-proc', event: 'error', message: 'sign-in expired' });
  await agentPost({ agent: 'two-proc', event: 'start', heartbeat: 0 }); // chat-watch restarted
  await until(() => ag('two-proc')?.restarts === 1, 'restart counted');
  assert.equal(ag('two-proc').job?.job, 'nightly');
  assert.equal(ag('two-proc').lastError?.message, 'sign-in expired');
  for (const id of ['a', 'b', 'c']) await agentPost({ agent: 'two-proc', event: 'waiting', id, title: `item ${id}` });
  await agentPost({ agent: 'two-proc', event: 'waiting_set', items: [{ id: 'b', title: 'item b' }, { id: 'd', title: 'item d', link: 'https://chat.google.com/x' }] });
  await until(() => ag('two-proc')?.waiting.map((w) => w.id).join() === 'b,d' || ag('two-proc')?.waiting.map((w) => w.id).sort().join() === 'b,d', 'waiting_set replaced the list');
  await until(() => ag('two-proc')?.jobsRunning === 0 && ag('two-proc').recent[0]?.summary === 'no end reported', 'stale job expired', 120);
  ok('agent: a restart keeps running jobs and the error; waiting_set replaces the list; a job with no end expires');

  // 9o. /agent and /hook only take requests from this machine.
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  if (!lan) {
    console.log('  - skipped the remote-request check: no LAN address on this machine');
  } else {
    const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-test-remote-'));
    const PORT2 = PORT + 1;
    fs.writeFileSync(path.join(HOME2, 'config.json'), JSON.stringify({ port: PORT2, bind: lan, token: 'x'.repeat(32), name: 'remote-test' }));
    const d2 = spawn(process.execPath, [path.join(ROOT, 'src', 'daemon.mjs')], { env: { ...env, AGENT_DECK_HOME: HOME2, AGENT_DECK_PORT: String(PORT2) } });
    try {
      for (let i = 0; i < 40; i++) { try { await fetch(`http://${lan}:${PORT2}/health`); break; } catch { await sleep(100); } }
      assert.equal((await agentPost({ agent: 'intruder', event: 'start' }, lan, PORT2)).status, 403);
      const hookRes = await fetch(`http://${lan}:${PORT2}/hook`, { method: 'POST', body: '{}' });
      assert.equal(hookRes.status, 403);
      assert.equal((await agentPost({ agent: 'local-ok', event: 'start' }, '127.0.0.1', PORT2)).ok, true);
    } finally { d2.kill(); }
    ok('a request from another machine to /agent or /hook is refused (403); loopback is accepted');
  }

  // 9p. A web page in a browser on this machine can reach 127.0.0.1 too: refuse it.
  const post = (url, headers, body = '{"agent":"web-page","event":"start"}') => fetch(`http://127.0.0.1:${PORT}${url}`, { method: 'POST', headers, body }).then((x) => x.status);
  assert.equal(await post('/agent', { 'content-type': 'application/json', origin: 'https://evil.example' }), 403);
  assert.equal(await post('/agent', { 'content-type': 'text/plain' }), 415);
  assert.equal(await post('/hook', { 'content-type': 'application/json', origin: 'https://evil.example' }), 403);
  assert.equal(await post('/hook', { 'content-type': 'text/plain' }), 415);
  assert.equal(ag('web-page'), undefined);
  const wsOpens = (origin) => new Promise((resolve) => {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, origin ? { origin } : {});
    w.on('open', () => { w.close(); resolve(true); });
    w.on('error', () => resolve(false));
    w.on('unexpected-response', () => resolve(false));
  });
  assert.equal(await wsOpens('https://evil.example'), false, 'a web page must not get a WebSocket');
  assert.equal(await wsOpens('null'), false, 'nor a sandboxed iframe (Origin: null)');
  assert.equal(await wsOpens('file://'), true, 'the panel (file://) must');
  assert.equal(await wsOpens(null), true, 'local tools without an Origin must');
  ok('web pages are refused: POSTs with an Origin or a non-JSON body, WebSockets from web origins');

  // 9q. At most 100 agents.
  const names = Array.from({ length: 100 }, (_, i) => `cap-${i}`);
  const already = snap.agents.length;
  const results = await Promise.all(names.map((n) => agentPost({ agent: n, event: 'heartbeat' })));
  assert.equal(results.filter((x) => x.ok).length, 100 - already);
  assert.equal((await agentPost({ agent: 'one-too-many', event: 'heartbeat' })).error, 'too many agents');
  ok('agents are capped at 100');

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
