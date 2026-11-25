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

  assert.equal(maskSecrets('curl -H "X-Api-Key: abc123secret" https://x.io'), `curl -H "X-Api-Key: ${M}" https://x.io`);
  assert.equal(maskSecrets('curl -H "Cookie: sid=abc; theme=dark" -H "Accept: text/html" https://x.io'), `curl -H "Cookie: ${M}" -H "Accept: text/html" https://x.io`);
  assert.equal(maskSecrets('curl -H "Authorization: Basic dXNlcjpwYXNz" https://x.io'), `curl -H "Authorization: Basic ${M}" https://x.io`);
  assert.equal(maskSecrets('curl -H "Authorization: Token abc123" https://x.io'), `curl -H "Authorization: Token ${M}" https://x.io`);
  check('masks header values (api keys, cookies, Basic and Token schemes)');

  assert.equal(maskSecrets('curl -d "{\\"password\\": \\"hunter2\\"}" https://x.io'), `curl -d "{\\"password\\": \\"${M}\\"}" https://x.io`);
  assert.equal(maskSecrets('echo \'{"token": 12345, "name": "x"}\''), `echo '{"token": ${M}, "name": "x"}'`);
  check('masks shell-escaped JSON and non-string JSON secret values');

  assert.equal(maskSecrets('curl -u admin:hunter2 https://x.io'), `curl -u ${M} https://x.io`);
  assert.equal(maskSecrets('curl --user admin:hunter2 https://x.io'), `curl --user ${M} https://x.io`);
  assert.equal(maskSecrets('mysql -uroot -phunter2 app'), `mysql -uroot -p${M} app`);
  check('masks user:pass credentials and attached -p passwords');

  assert.equal(maskSecrets('API_KEY="abc def" run'), `API_KEY=${M} run`);
  assert.equal(maskSecrets('DB_PASSWORD=\'a b\' run'), `DB_PASSWORD=${M} run`);
  check('masks quoted NAME=value values');

  for (const plain of ['serve -p 8080', 'docker run -p 3000:3000 img', 'find . -print', 'mysql -u root app', 'curl -H "Accept: text/html" https://x.io', 'ssh -p 22 host']) assert.equal(maskSecrets(plain), plain);
  check('leaves port flags and ordinary headers alone');

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
