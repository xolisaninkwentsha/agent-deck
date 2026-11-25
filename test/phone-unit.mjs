// Unit tests for the phone summary: what a held prompt looks like on a phone, and what is masked.
import assert from 'node:assert/strict';
import { maskSecrets, phoneSummary, LIMITS } from '../src/phone-summary.mjs';

let passed = 0;
const check = (name) => { passed++; console.log(`  ✓ ${name}`); };
const M = '••••';

function main() {
  assert.equal(maskSecrets('curl -H "Authorization: Bearer fake_token_abc123def456ghi789" https://api.x.com'), `curl -H "Authorization: Bearer ${M}" https://api.x.com`);
  check('masks Authorization and Bearer values');

  assert.equal(maskSecrets('API_KEY=abcd1234 npm start'), `API_KEY=${M} npm start`);
  assert.equal(maskSecrets('deploy --token=abc123 --password hunter2'), `deploy --token=${M} --password ${M}`);
  check('masks secret flags and NAME=value variables');

  assert.equal(maskSecrets('psql postgres://admin:hunter2@db.example.com/app'), `psql postgres://${M}@db.example.com/app`);
  assert.equal(maskSecrets(`echo '{"api_key": "abc", "name": "x"}'`), `echo '{"api_key": "${M}", "name": "x"}'`);
  check('masks URL credentials and JSON secret fields');

  assert.equal(maskSecrets('use eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz now'), `use ${M} now`);
  assert.equal(maskSecrets('ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4'), M);
  check('masks JWTs and long mixed letter-digit tokens');

  for (const plain of ['npm test', 'git commit -m "Fix the 2nd test"', 'ls -la /home/me/Desktop/agent-deck/node_modules']) assert.equal(maskSecrets(plain), plain);
  check('leaves ordinary commands alone');

  const bash = phoneSummary({ toolName: 'Bash', toolInput: { command: 'TOKEN=abc123 ./x.sh' + ' y'.repeat(400) }, project: 'api' });
  assert.equal(bash.kind, 'approval');
  assert.equal(bash.title, 'Run command');
  assert.ok(bash.detail.startsWith(`TOKEN=${M}`));
  assert.ok(bash.detail.length <= LIMITS.detail);
  assert.ok(bash.detail.endsWith('…'));
  check('Bash summary is masked and cut to the detail limit');

  assert.equal(phoneSummary({ toolName: 'Write', toolInput: { file_path: '/a/b.txt', content: 'SECRET body' }, project: 'p' }).detail, '/a/b.txt');
  const mcp = phoneSummary({ toolName: 'mcp__gmail__send', toolInput: { to: 'x@y.com', body: 'private text' }, project: 'p' });
  assert.equal(mcp.detail, 'fields: to, body');
  assert.ok(!mcp.detail.includes('private'));
  check('file tools show the path and other tools show field names only');

  const plan = phoneSummary({ toolName: 'ExitPlanMode', toolInput: { plan: 'p'.repeat(2000) }, project: 'p' });
  assert.equal(plan.kind, 'plan');
  assert.ok(plan.detail.length <= LIMITS.plan);
  check('plan summary is cut to the plan limit');

  const q = phoneSummary({ toolName: 'AskUserQuestion', project: 'p', questions: [{ question: 'Pick?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: '' }] }] });
  assert.equal(q.kind, 'question');
  assert.deepEqual(q.questions[0].options, ['Red']);
  assert.deepEqual(bash.questions, []);
  check('question summary keeps option labels only');

  console.log(`\n${passed} checks passed`);
}

try { main(); } catch (e) {
  console.error('\nFAILED:', e.stack || e.message);
  process.exit(1);
}
