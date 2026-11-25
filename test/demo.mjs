// Feeds the local daemon a few fake sessions so you can see the panel without real agents.
// Usage: node test/demo.mjs        (Ctrl+C to stop; the fake sessions end on exit)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = (mode, input) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'hook.mjs'), mode], { env: process.env });
  let out = ''; p.stdout.on('data', (c) => { out += c; });
  p.on('close', () => resolve(out));
  p.stdin.end(JSON.stringify(input));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (id, cwd, event, extra = {}) => hook('observe', { session_id: id, cwd, hook_event_name: event, ...extra });

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

  approval.then((out) => console.log('approval answer:', out || '(handed to terminal)'));
  question.then((out) => console.log('question answer:', out || '(handed to terminal)'));
  console.log('Demo sessions are live. Ctrl+C to end them.');

  const end = async () => {
    for (const [id, cwd] of [A, B, C, D]) await ev(id, cwd, 'SessionEnd', { reason: 'exit' });
    process.exit(0);
  };
  process.on('SIGINT', end);
  process.on('SIGTERM', end);
  if (process.env.DEMO_SECONDS) setTimeout(end, Number(process.env.DEMO_SECONDS) * 1000);
  await new Promise(() => {});
}
main();
