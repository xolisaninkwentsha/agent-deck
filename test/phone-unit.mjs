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

  assert.equal(maskSecrets('curl -H "Authorization-Token: abc123" https://x.io'), `curl -H "Authorization-Token: ${M}" https://x.io`);
  assert.equal(maskSecrets('curl -H "AuthorizationKey: abc" https://x.io'), `curl -H "AuthorizationKey: ${M}" https://x.io`);
  assert.equal(maskSecrets('curl -H "X-Authorization-Secret: s3cret" https://x.io'), `curl -H "X-Authorization-Secret: ${M}" https://x.io`);
  assert.equal(maskSecrets('curl -H "X_Authorization: abc" https://x.io'), `curl -H "X_Authorization: ${M}" https://x.io`);
  assert.equal(maskSecrets('curl -H "MyAuthorization: abc" https://x.io'), `curl -H "MyAuthorization: ${M}" https://x.io`);
  assert.equal(maskSecrets('curl -H "Authorization: Bearer x" https://x.io'), `curl -H "Authorization: Bearer ${M}" https://x.io`);
  assert.equal(maskSecrets('curl -H "X-Authorization: Bearer x" https://x.io'), `curl -H "X-Authorization: Bearer ${M}" https://x.io`);
  check('masks headers that only start or end with Authorization; the exact header is masked once');

  assert.equal(maskSecrets('curl -d "{\\"password\\": \\"hunter2\\"}" https://x.io'), `curl -d "{\\"password\\": \\"${M}\\"}" https://x.io`);
  assert.equal(maskSecrets('echo \'{"token": 12345, "name": "x"}\''), `echo '{"token": ${M}, "name": "x"}'`);
  check('masks shell-escaped JSON and non-string JSON secret values');

  assert.equal(maskSecrets('{"password": "hun\\"ter2"}'), `{"password": "${M}"}`);
  assert.equal(maskSecrets('{"token": "a\\\\b"}'), `{"token": "${M}"}`);
  assert.equal(maskSecrets('{"api_key": "ABC"}'), `{"api_key": "${M}"}`);
  assert.equal(maskSecrets('curl -d "{\\"password\\": \\"hun\\\\\\"ter2\\"}" https://x.io'), `curl -d "{\\"password\\": \\"${M}\\"}" https://x.io`);
  check('masks JSON values that contain escapes');

  assert.equal(maskSecrets('echo \\"password\\": \\"hunter2\\" next'), `echo \\"password\\": \\"${M}\\" next`);
  assert.equal(maskSecrets('echo \\"password\\": \\"hunter2 next'), `echo \\"password\\": \\"${M} next`);
  assert.equal(maskSecrets('echo {"password": "hunter2 next'), `echo {"password": "${M} next`);
  check('a matched JSON label always masks its value, even when no terminator or closing quote follows');

  assert.equal(maskSecrets('X-' + 'a'.repeat(100) + '-Api-Key: s3cret'), 'X-' + 'a'.repeat(100) + `-Api-Key: ${M}`);
  assert.equal(maskSecrets('A'.repeat(100) + '_TOKEN=abc'), 'A'.repeat(100) + `_TOKEN=${M}`);
  assert.equal(maskSecrets('{"' + 'k'.repeat(100) + '_token": "abc"}'), '{"' + 'k'.repeat(100) + `_token": "${M}"}`);
  check('masks values behind very long header, variable and JSON key names');

  for (const cmd of ['sudo mysql -phunter2 db', 'env X=1 mysql -phunter2 db', 'MYSQL_HOST=h mysql -phunter2 db', 'docker exec c mysql -uroot -phunter2', 'echo $(mysql -phunter2 -e "select 1")', 'cd /x\nmysql -phunter2 db', 'mariadb-admin -phunter2 ping', '/usr/bin/mysql.exe -phunter2 db']) {
    const out = maskSecrets(cmd);
    assert.ok(!out.includes('hunter2') && out.includes(`-p${M}`), `-p password left in: ${out}`);
  }
  assert.equal(maskSecrets('mysql -u root -p"x y" db'), `mysql -u root -p${M} db`);
  assert.equal(maskSecrets("mysql -u root -p'x y' db"), `mysql -u root -p${M} db`);
  check('masks -p passwords after wrappers, env prefixes, subshells, newlines and in quotes');

  for (const hostile of ['a'.repeat(50000) + '-key', 'x-'.repeat(25000), 'K'.repeat(50000), '"key' + ' '.repeat(50000), 'a'.repeat(50000) + '://',
    '\\"password\\": \\"'.repeat(3200) + 'x', '\\"password\\": \\"x\\" y '.repeat(2500), '\\"key\\":\\"'.repeat(4500) + 'x', '"key": "'.repeat(6000) + 'x']) {
    const t0 = performance.now();
    maskSecrets(hostile);
    assert.ok(performance.now() - t0 < 200, `maskSecrets too slow on ${hostile.slice(0, 8)}`);
  }
  const long = phoneSummary({ toolName: 'Bash', toolInput: { command: 'echo ' + 'x'.repeat(50000) + ' TOKEN=abc1' }, project: 'p' });
  assert.ok(long.detail.length <= LIMITS.detail);
  check('masking stays fast on hostile input');

  assert.equal(maskSecrets('curl -u admin:hunter2 https://x.io'), `curl -u ${M} https://x.io`);
  assert.equal(maskSecrets('curl --user admin:hunter2 https://x.io'), `curl --user ${M} https://x.io`);
  assert.equal(maskSecrets('mysql -uroot -phunter2 app'), `mysql -uroot -p${M} app`);
  assert.equal(maskSecrets('mysqldump -psecret app'), `mysqldump -p${M} app`);
  assert.equal(maskSecrets('mysql -uroot -phunter2 db'), `mysql -uroot -p${M} db`);
  assert.equal(maskSecrets('cd /x && mysql -phunter2 db | gzip -pv'), `cd /x && mysql -p${M} db | gzip -pv`);
  check('masks user:pass credentials and attached -p passwords (MySQL clients only)');

  assert.equal(maskSecrets('API_KEY="abc def" run'), `API_KEY=${M} run`);
  assert.equal(maskSecrets('DB_PASSWORD=\'a b\' run'), `DB_PASSWORD=${M} run`);
  check('masks quoted NAME=value values');

  for (const plain of ['serve -p 8080', 'docker run -p 3000:3000 img', 'find . -print', 'mysql -u root app', 'curl -H "Accept: text/html" https://x.io', 'ssh -p 22 host', 'cp -pr src dst', 'sudo cp -pr a b','mkdir -pv a/b', 'ls -pa', 'lsof -p1234', 'pytest -pno:cacheprovider', 'ssh -p22 host', 'docker run -p3000:3000 img'])assert.equal(maskSecrets(plain), plain);
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
