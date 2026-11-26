# Phone approvals, phase 1: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modisa users link a phone number and answer Claude Code prompts from WhatsApp buttons while they're away. A hosted relay does the sending, and phase 1 charges trial credit only.

**Architecture:**
- **The relay** (`relay/`) is a Cloudflare Worker with one Durable Object.
  - Its logic lives in plain-JavaScript modules: a key-value store interface, an injected `fetch` and Web Crypto. So the logic is tested in Node and deployed unchanged.
  - Each Modisa daemon keeps one outgoing WebSocket to the relay (`src/phone.mjs`).
- **The daemon** decides when a held prompt goes to the phone, masks the text (`src/phone-summary.mjs`) and applies the answer that comes back through the same path as a panel decision.
- **The panel** gets a "Phone (WhatsApp)" section in Settings, and sends presence to other machines' daemons.

**Tech stack:**
- Node 22 ESM, and `ws` (already a dependency).
- Cloudflare Workers and Durable Objects (SQLite-backed, WebSocket hibernation), deployed with Wrangler (a devDependency of `relay/` only).
- WhatsApp Cloud API (Graph API).

**Spec:** `docs/superpowers/specs/2026-11-25-phone-approvals-design.md`. Read it first; this plan argues from it.

**Workspace:** a git worktree on branch `phone-approvals` (superpowers:using-git-worktrees). The live panel runs from `~/Desktop/modisa`, so don't switch branches there.

## Global constraints

- **Claude Code's wait:**
  - Claude Code's decide hooks time out at 600 s. `holdSeconds` defaults to 300 and is capped at 570.
  - PreToolUse question holds are capped at 90 s (`PRETOOLUSE_HOLD_MS`).
- **When a prompt is sent:**
  - Only with ≥ 60 s of its hold left.
  - Once the relay confirms it sent a **PermissionRequest** prompt, that hold is extended to `createdAt + 570 s`. PreToolUse holds are never extended.
- **Away:** any of these:
  - the screen is locked;
  - no keyboard or mouse input for 5 min;
  - a PermissionRequest prompt has sat unanswered for 2 min.

  A machine is not away while a remote panel reported `active` in the last 60 s. Panels send presence on change and every 30 s.
- **The relay link counts as an approver** only while the phone is linked, enabled and connected, and the mode is "everything" or the machine is away.
- **Linking code:** 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, single-use, valid 10 min. The bot never messages a number that hasn't sent a valid code, and invalid codes get no reply.
- **WhatsApp limits:**
  - body ≤ 1024 characters;
  - ≤ 3 reply buttons, titles ≤ 20 characters;
  - lists ≤ 10 rows, row titles ≤ 24 characters, descriptions ≤ 72;
  - footer ≤ 60 characters;
  - permission detail ≤ 300 characters; plan text ≤ 900 characters.
- **Charging:**
  - Every message the bot sends is charged. If the balance can't cover it, the message is skipped.
  - A template plus the full message after it is 2 charges.
  - The cap is 60 bot messages per account per rolling hour.
  - Meta "failed" statuses are refunded once.
- **Never from the phone:** "always" (`decision.always`). The phone can only allow, deny or answer a prompt the daemon sent and that is still open.
- **Machine key:** 32 random bytes (base64url), stored 0600 in `~/.modisa/phone.json` and written atomically. The relay stores only its SHA-256 hex.
- **Phase 1:** `BILLING=trial`, no top-ups, and no payment method on the Meta account.
- **Code rules:**
  - App: plain JavaScript, no build step, no new runtime dependencies.
  - Relay modules use only Web-standard APIs (`crypto.subtle`, `crypto.getRandomValues`, `fetch` passed in), so they run in Node 22 and in Workers.
- **The repo is public:** no secrets, and no operator values (markup, trial amount, rates) in tracked files. Those are Worker secrets.
- **Logs** carry neither prompt text nor full phone numbers.
- **Tests:** follow the house style (`node:assert/strict`, an `ok(name)` counter, a last line of `N checks passed`). `npm test` runs every test file; the last line of each is what gets quoted.

## Review focus

1. **Meta delivers the same webhook twice** (Meta retries deliveries). One tap must produce one decision and one charge. Test: Task 6, "duplicate inbound id is ignored".
2. **The relay link drops while a prompt is on the phone**, and the tap arrives while the machine is offline. The decision is queued and applied on reconnect if the prompt is still open. Tests: Task 6 "decide is queued for an offline machine", Task 9 "a decision delivered after a reconnect still answers".
3. **Two machines on one number have prompts open at once.** Each tap must reach its own machine. Test: Task 6, "two machines, one number".
4. **Typed text arrives with no open question, or from an unknown number.** It's ignored, with no charge and no reply. Test: Task 6, "stray text is ignored and free".
5. **A number is typed with spaces or dashes, or without a country code** ("082 123 4567"). Spaces and dashes are accepted; a missing country code is refused with `bad-number`. Test: Task 4, "normalizeNumber".

---

### Task 1: The phone summary and masking

**Files:**
- Create: `src/phone-summary.mjs`, `test/phone-unit.mjs`
- Modify: `package.json` (`"test"`)

**Interfaces:**
- Consumes: `describeApproval(tool, input)` from `src/state.mjs`, which returns `{ title, detail }`.
- Produces:
  - `export const LIMITS = { detail: 300, plan: 900, question: 1000 }`
  - `export function maskSecrets(text: string): string`
  - `export function phoneSummary({ toolName, toolInput, project, questions }): PhonePrompt`, where:
    - `PhonePrompt = { kind: 'approval'|'plan'|'question', project: string, title: string, detail: string, questions: Array<{ question: string, header: string, multiSelect: boolean, options: string[] }> }`;
    - `kind` is `'question'` when `toolName === 'AskUserQuestion'`, `'plan'` for `ExitPlanMode`, otherwise `'approval'`;
    - `questions` is `[]` unless `kind === 'question'`.

- [ ] **Step 1: Write the failing tests** in `test/phone-unit.mjs` (house style). Assertions:

```js
import { maskSecrets, phoneSummary, LIMITS } from '../src/phone-summary.mjs';
const M = '••••';
eq(maskSecrets('curl -H "Authorization: Bearer fake_token_abc123def456ghi789" https://api.x.com'), `curl -H "Authorization: Bearer ${M}" https://api.x.com`);
eq(maskSecrets('API_KEY=abcd1234 npm start'), `API_KEY=${M} npm start`);
eq(maskSecrets('deploy --token=abc123 --password hunter2'), `deploy --token=${M} --password ${M}`);
eq(maskSecrets('psql postgres://admin:hunter2@db.example.com/app'), `psql postgres://${M}@db.example.com/app`);
eq(maskSecrets(`echo '{"api_key": "abc", "name": "x"}'`), `echo '{"api_key": "${M}", "name": "x"}'`);
eq(maskSecrets('use eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz now'), `use ${M} now`);
eq(maskSecrets('ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4'), M);
for (const plain of ['npm test', 'git commit -m "Fix the 2nd test"', 'ls -la /home/me/Desktop/modisa/node_modules']) eq(maskSecrets(plain), plain);
// summaries
const bash = phoneSummary({ toolName: 'Bash', toolInput: { command: 'TOKEN=abc123 ./x.sh' + ' y'.repeat(400) }, project: 'api' });
eq(bash.kind, 'approval'); eq(bash.title, 'Run command'); ok(bash.detail.startsWith(`TOKEN=${M}`)); ok(bash.detail.length <= LIMITS.detail);
eq(phoneSummary({ toolName: 'Write', toolInput: { file_path: '/a/b.txt', content: 'SECRET body' }, project: 'p' }).detail, '/a/b.txt');
const mcp = phoneSummary({ toolName: 'mcp__gmail__send', toolInput: { to: 'x@y.com', body: 'private text' }, project: 'p' });
eq(mcp.detail, 'fields: to, body'); ok(!mcp.detail.includes('private'));
const plan = phoneSummary({ toolName: 'ExitPlanMode', toolInput: { plan: 'p'.repeat(2000) }, project: 'p' });
eq(plan.kind, 'plan'); ok(plan.detail.length <= LIMITS.plan);
const q = phoneSummary({ toolName: 'AskUserQuestion', project: 'p', questions: [{ question: 'Pick?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: '' }] }] });
eq(q.kind, 'question'); eq(q.questions[0].options, ['Red']);
```

- [ ] **Step 2: Run it.** `node test/phone-unit.mjs` should fail with "Cannot find module".
- [ ] **Step 3: Implement** `maskSecrets` and `phoneSummary` in `src/phone-summary.mjs`.
  - **Masking:** regex passes, in this order:
    1. `Authorization:`/`Bearer` values;
    2. `--(token|key|secret|password|pass|pwd|auth|api-key)[= ]value`;
    3. `NAME=value`, where NAME contains TOKEN|KEY|SECRET|PASS|PWD|AUTH (case-insensitive);
    4. JSON `"…(key|token|secret|password)…": "value"`;
    5. URL `scheme://user:pass@` → `scheme://••••@`;
    6. JWT `eyJ…\.…\.…`;
    7. any run of ≥ 24 characters from `[A-Za-z0-9_-]` that has both letters and digits.
  - **Detail per tool:**
    - Bash/PowerShell: `maskSecrets(command)`;
    - Edit/MultiEdit/Write: `file_path`;
    - WebFetch: `maskSecrets(url)`;
    - ExitPlanMode: the plan, unmasked;
    - anything else: `fields: <comma-joined keys>`.

    Cut to `LIMITS`, ending in `…` when cut.
- [ ] **Step 4: Change `package.json`** `"test"` to `node test/e2e.mjs && node test/phone-unit.mjs`. Run `npm test`: the last line is `N checks passed` with N ≥ 15.
- [ ] **Step 5: Commit.** `git add src/phone-summary.mjs test/phone-unit.mjs package.json && git commit -m "Phone summary: mask secrets in what goes to the phone"`

### Task 2: Away detection

**Files:**
- Create: `src/away.mjs`
- Modify: `test/phone-unit.mjs`

**Interfaces:**
- Produces:
  - `export function parseGnomeIdle(stdout: string): number|null`. `"(uint64 123456,)"` → `123456` (ms).
  - `export function parseGnomeLocked(stdout: string): boolean|null`. `"(true,)"` → `true`.
  - `export function parseMacIdle(stdout: string): number|null`. ioreg's `"HIDIdleTime" = 5000000000` (ns) → `5000` (ms).
  - `export async function localAway({ idleAfterMs = 300000 } = {}): Promise<{ away: boolean, known: boolean, idleMs: number|null, locked: boolean|null }>`
    - `away = locked === true || (idleMs ?? 0) >= idleAfterMs`.
    - `known` is false when neither could be read.
    - If env `MODISA_AWAY_FILE` is set, it reads `{ idleMs, locked }` JSON from that file on every call instead (for tests).

- [ ] **Step 1: Write the failing tests.**
  - The three parsers, on the sample strings above.
  - Garbage gives `null`.
  - `localAway` with `MODISA_AWAY_FILE` pointing at `{"idleMs":400000,"locked":false}` → `away: true, known: true`.
  - With `{"idleMs":1000,"locked":false}` → `away: false`.
  - A missing file → `known: false, away: false`.
- [ ] **Step 2: Run.** `node test/phone-unit.mjs` should fail.
- [ ] **Step 3: Implement.**
  - **Linux:** `execFile('gdbus', ['call','--session','--dest','org.gnome.Mutter.IdleMonitor','--object-path','/org/gnome/Mutter/IdleMonitor/Core','--method','org.gnome.Mutter.IdleMonitor.GetIdletime'])`, and the same for `org.gnome.ScreenSaver` / `/org/gnome/ScreenSaver` / `org.gnome.ScreenSaver.GetActive`.
  - **macOS:** `ioreg -c IOHIDSystem -d 4`, and `locked: null`.
  - Each call has a timeout of 2000 ms, and any error gives `null`.
- [ ] **Step 4: Run both checks.**
  - `node test/phone-unit.mjs` passes.
  - Live on this Ubuntu machine: `node -e "import('./src/away.mjs').then(async m => console.log(await m.localAway()))"` prints `known: true` with a plausible `idleMs`. If it prints `known: false`, record why (DBus address, Wayland) in the commit message. Don't work around it: the 2-minute rule still applies.
- [ ] **Step 5: Commit.** `git commit -am "Away detection: idle time and screen lock on GNOME and macOS"` (add `src/away.mjs`).

### Task 3: Relay WhatsApp module

**Files:**
- Create: `relay/package.json` (`{"name":"modisa-relay","private":true,"type":"module","devDependencies":{"wrangler":"<current 4.x>"}}`), `relay/src/whatsapp.js`, `test/relay.mjs`
- Modify: `package.json` (append `&& node test/relay.mjs` to `"test"`)

**Interfaces:**
- Consumes: `PhonePrompt` (Task 1 shape, passed in as data).
- Produces:
  - `export async function verifySignature(rawBody: string, header: string|null, appSecret: string): Promise<boolean>`. `header` is `"sha256=<hex>"`. Constant-time compare.
  - `export function parseWebhook(body: object): { inbound: Inbound[], statuses: Status[] }`, where:
    - `Inbound = { id, from, ts, text?: string, buttonId?: string, contextId?: string }`;
    - `buttonId` comes from `interactive.button_reply.id`, `interactive.list_reply.id` or `button.payload`;
    - `Status = { id, status, recipient }`.
  - `export function promptMessage(to: string, ref: string, prompt: PhonePrompt, qIndex: number): object`
    - **approval:** buttons `${ref}:allow` "Allow", `${ref}:deny` "Deny".
    - **plan:** `${ref}:approve` "Approve", `${ref}:plan` "Keep planning".
    - **question,** single-select: ≤ 3 options → buttons; 4–10 → a list. Ids are `${ref}:q${qIndex}:o${i}`.
    - **question,** multi-select or > 10 options: a text message with a numbered list, ending "Reply to this message with the numbers, e.g. 1 3".
    - Interactive messages carry the footer "Or reply with your own answer".
    - Body: `"<project> · Claude wants to <title lowercased>\n\n<detail>"`, `"<project> · Plan to approve\n\n<detail>"` or `"<project> · <header>: <question>"`, cut to 1024.
  - `export function textMessage(to: string, body: string, replyTo?: string): object`
  - `export function templateMessage(to: string, ref: string, prompt: PhonePrompt, tpl: { name: string, lang: string }): object`. Body parameters are `[project, title]`, plus one quick-reply button with payload `${ref}:show`.
  - `export function createSender({ fetch, token, phoneNumberId, graphVersion }): { send(payload: object): Promise<{ ok: true, id: string } | { ok: false, error: string }> }`
    - It POSTs `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages` with `Authorization: Bearer`.
    - `id` is `messages[0].id`.
    - It never throws.

- [ ] **Step 1: Write the failing tests** in `test/relay.mjs`:
  - **Signatures:** computed with `crypto.subtle` HMAC-SHA256 over a sample body. Valid → true; tampered body → false; missing header → false.
  - **parseWebhook** on three fixtures written inline in the test, shaped like Meta's documented payloads: a button reply, a list reply, a text with `context.id`, and a `statuses` entry.
  - **promptMessage:**
    - an approval gives 2 buttons with ids `r1:allow` and `r1:deny`;
    - a 3-option question gives buttons, a 5-option one gives a list (row title ≤ 24), and multi-select gives text containing `1.` and `2.`;
    - a 30-character option title is cut to ≤ 20 characters ending in `…`;
    - the body is ≤ 1024 when the detail is 5,000 characters.
  - **templateMessage** carries the payload `r1:show`.
  - **createSender** with a fake `fetch`:
    - a 200 response → `{ ok: true, id }`;
    - a 400 → `{ ok: false }`;
    - a rejecting fetch → `{ ok: false }`.
- [ ] **Step 2: Run.** `node test/relay.mjs` should fail.
- [ ] **Step 3: Implement** `relay/src/whatsapp.js`, using the Graph API shapes (`messaging_product: 'whatsapp'`, `type: 'interactive'|'text'|'template'`).
- [ ] **Step 4: Run.** `node test/relay.mjs` passes.
- [ ] **Step 5: Commit.** `git commit -m "Relay: WhatsApp messages, webhook parsing and signature check"`

### Task 4: Relay core: store, ids, numbers, credit

**Files:**
- Create: `relay/src/memory-store.js`, `relay/src/ids.js`, `relay/src/credit.js`
- Modify: `test/relay.mjs`

**Interfaces:**
- Produces:
  - **Store interface** (what the Durable Object adapter in Task 7 implements): `{ get(key): Promise<any>, put(key, value): Promise<void>, delete(key): Promise<void>, list(prefix): Promise<Map<string, any>> }`. `export class MemoryStore` implements it, and stores clones.
  - **`ids.js`:**
    - `export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'`
    - `export function newCode(): string` (8 characters)
    - `export function findCode(text: string): string|null` (finds a code anywhere in the text; case-insensitive; a dash or space after the 4th character is allowed)
    - `export function newRef(): string` (12 lowercase characters from the same alphabet)
    - `export async function sha256Hex(s: string): Promise<string>`
    - `export function normalizeNumber(input: string): string|null` (strips spaces, dashes and brackets; accepts a leading `+` or `00`; refuses a single leading `0`; result is 8–15 digits)
    - `export function maskNumber(digits: string): string` (`'+27•••••4567'`: `+`, the first 2 digits, `•` for the middle, the last 4)
  - **`credit.js`:**
    - `export function priceFor(number: string, config): number`: micro-USD. The rate comes from the longest prefix of `number` found in `config.rates` (else `config.rates.default`), then `Math.ceil(rate * (100 + config.markupPercent) / 100)`. It's `0` when `config.billing === 'off'`.
    - `export function reserve(account, price: number, nowMs: number, cap: number): { ok: true } | { ok: false, reason: 'no-credit'|'rate-limited' }`: mutates `account.balance` and `account.sent` (a timestamp array pruned to the last hour).
    - `export function release(account, price: number): void`: refunds a reservation that wasn't used.

- [ ] **Step 1: Write the failing tests.**
  - **normalizeNumber:**
    - `'+27 82 123-4567'` → `'27821234567'`;
    - `'0027821234567'` → `'27821234567'`;
    - `'082 123 4567'` → `null`;
    - `'+1 (415) 555-0100'` → `'14155550100'`;
    - `'12'` → `null`.
  - **maskNumber:** `'27821234567'` → `'+27•••••4567'`.
  - **Codes:**
    - `findCode('code: abcd-2345')` → `'ABCD2345'`;
    - `findCode('hello')` → `null`;
    - `newCode()` matches `^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$`.
  - **priceFor** with `{ rates: { default: 10000, '27': 9500 }, markupPercent: 20, billing: 'trial' }`:
    - `'27…'` → `11400`;
    - `'44…'` → `12000`;
    - billing off → `0`.
  - **reserve:**
    - balance 20000 with price 11400 → ok, then not ok `no-credit`;
    - with a balance of 1e9, the 61st reserve within an hour → `rate-limited`;
    - `release` restores the balance.
- [ ] **Step 2: Run.** `node test/relay.mjs` should fail.
- [ ] **Step 3: Implement** the three files. `newCode` and `newRef` use `crypto.getRandomValues`, with rejection sampling so there's no modulo bias.
- [ ] **Step 4: Run.** `node test/relay.mjs` passes.
- [ ] **Step 5: Commit.** `git commit -m "Relay: store, codes, numbers and credit"`

### Task 5: Relay core: linking and status

**Files:**
- Create: `relay/src/core.js`
- Modify: `test/relay.mjs`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces: `export function createRelay({ store, sender, config, now = Date.now }): Relay`. `config` is `{ botNumber, billing, trialMicroUsd, rates, markupPercent, hourlyCap: 60, codeTtlMs: 600000, windowMs: 86400000, template: { name, lang } }`. `Relay` has:
  - `hello(keyHash: string, info: { machine: string, version: string }): Promise<object[]>`. It creates `machine:<keyHash>` if missing and returns `[statusMsg]` plus any queued messages (`outbox:<keyHash>`, cleared).
  - `machineMessage(keyHash: string, msg: object): Promise<object[]>`, which returns the replies to that machine.
  - `webhook(parsed: { inbound, statuses }): Promise<Array<{ keyHash: string, msg: object }>>`, which returns the messages for machines.
  - `queue(keyHash: string, msg: object): Promise<void>`. The caller uses it when a machine has no open socket. Queued `decide` messages are dropped when their prompt has expired by the time they're delivered.
  - **Messages:**
    - `statusMsg = { type: 'status', linked: boolean, number: string|null (masked), balanceMicroUsd: number|null, billing, botNumber }`
    - linking: `{type:'link-start', number}` → `[{type:'link-code', code, expiresAt, botNumber}]` or `[{type:'error', op:'link-start', reason:'bad-number'|'rate-limited'}]` (at most 5 per machine per hour). `{type:'unlink'}` → `[statusMsg]`.
  - **Store keys:**
    - `machine:<keyHash>` = `{ keyHash, machine, number, linkedAt }`
    - `account:<number>` = `{ number, balance, sent: [], windowUntil, machines: [] }`
    - `code:<CODE>` = `{ keyHash, number, expiresAt }`
    - `seen:<inboundId>` = `ts`

- [ ] **Step 1: Write the failing tests**, using `MemoryStore`, a fake `sender` that records payloads and returns `{ ok: true, id: 'w' + n }`, and a controllable `now`.
  - **Linking:**
    1. `link-start '+27 82 123 4567'` → a `link-code`, and nothing sent.
    2. Inbound text containing the code from `27821234567` → a `status linked:true` routed to that keyHash, plus one "Connected: <machine>" text sent.
    3. The balance is `trialMicroUsd - price`, and `windowUntil = ts + 24h`.
  - **Code checks:**
    - the code from another number → nothing sent, not linked;
    - an expired code (now + 11 min) → nothing sent;
    - a code used twice → the second does nothing.
  - **Stray text is ignored and free:** text from an unknown number → no sends, no routes.
  - **Unlinking:**
    - `"stop"` from a linked number → every machine on it gets `status linked:false`, and one "Disconnected." is sent;
    - `unlink` → `status linked:false`.
  - **The 6th `link-start`** within an hour → `rate-limited`.
- [ ] **Step 2: Run.** `node test/relay.mjs` should fail.
- [ ] **Step 3: Implement** `createRelay` with `hello`, `machineMessage` (`link-start`, `unlink`), `webhook` (inbound codes, "stop", window tracking, dedupe on `seen:`) and `queue`.
  - Every outgoing message goes through a single internal `sendCharged(account, payload, meta) → { ok, id } | { ok: false, reason }`, which reserves, sends and releases on failure.
  - It records `msg:<id> = { ref, qIndex, number, price, refunded: false }`.
- [ ] **Step 4: Run.** `node test/relay.mjs` passes.
- [ ] **Step 5: Commit.** `git commit -m "Relay: link a number with a code; status and stop"`

### Task 6: Relay core: prompts and answers

**Files:**
- Modify: `relay/src/core.js`, `test/relay.mjs`

**Interfaces:**
- **Daemon to relay:**
  - `{type:'prompt', pendingId, expiresAt, prompt: PhonePrompt}` → `[{type:'prompt-sent', pendingId}]` or `[{type:'prompt-failed', pendingId, reason:'not-linked'|'no-credit'|'rate-limited'|'send-failed'}]`
  - `{type:'prompt-closed', pendingId, why:'answered'|'timeout'|'gone'}` → `[]`
  - `{type:'decide-ack', pendingId, ok: boolean, reason?: string}` → `[]`. When not ok, the relay sends "Too late: it's waiting in the terminal."
- **Relay to daemon:** `{type:'decide', pendingId, decision}`, where `decision` is one of:
  - `{behavior:'allow'}`
  - `{behavior:'deny'}`
  - `{behavior:'deny', message:'Not yet: keep planning.'}` (plan → "Keep planning")
  - `{answers:{[questionText]: string}}` (multi-select labels joined with `", "`)
- **Store keys:**
  - `prompt:<ref>` = `{ ref, keyHash, pendingId, number, prompt, qIndex, answers, expiresAt, state: 'open'|'deciding'|'closed', closedWhy, createdAt }`
  - `pending:<keyHash>:<pendingId>` = `ref`
  - `expiresAt` is clamped to ≤ now + 600 s.

- [ ] **Step 1: Write the failing tests** (house style, each named as quoted):
  - **"prompt in window":** sends interactive buttons → `prompt-sent`. A tap `${ref}:allow` → routed `{type:'decide', pendingId, decision:{behavior:'allow'}}`.
  - **"prompt outside window":** sends a template. Tapping `${ref}:show` sends the full prompt, for 2 charges in total.
  - **"plan":** `${ref}:plan` → deny with the "keep planning" message.
  - **"two questions":** the first answered by button → the second is sent. The second answered by typed text (with `contextId` = the second message's id) → one decide with both answers.
  - **"multi-select":** a reply of `"1 3"` → labels joined `"A, C"`. A reply of `"blue please"` → the answer is `"blue please"`.
  - **"typed text without context":** goes to the newest open question prompt for that number.
  - **"two machines, one number":** each `allow` is routed to its own keyHash.
  - **"duplicate inbound id is ignored":** the same webhook twice → one decide, one charge.
  - **"late taps":**
    - after `prompt-closed why:'answered'` → "Already answered on the computer." sent, no decide;
    - after `expiresAt` → "Too late…";
    - `decide-ack ok:false` → "Too late…".
  - **"a tap from a different number"** on someone's ref → ignored, no charge.
  - **"no credit":** `prompt-failed no-credit` and nothing sent. **"not linked":** `prompt-failed not-linked`.
  - **"failed status refunds once":** the balance is restored, and a second `failed` status doesn't refund again.
  - **"decide is queued for an offline machine":** `queue()` and then `hello()` returns the decide. If the prompt expired before `hello`, it's dropped.
- [ ] **Step 2: Run.** `node test/relay.mjs` should fail.
- [ ] **Step 3: Implement** the `prompt`, `prompt-closed` and `decide-ack` handlers, and in `webhook`: button and typed answers, multi-question progress, late-tap replies and failed-status refunds.
  - Window rule: `now < account.windowUntil - 300000` → interactive; otherwise template.
- [ ] **Step 4: Run.** `node test/relay.mjs` passes.
- [ ] **Step 5: Commit.** `git commit -m "Relay: send prompts, route taps and typed answers, late taps, refunds"`

### Task 7: Relay Worker, Durable Object and self-hosting docs

**Files:**
- Create: `relay/src/worker.js`, `relay/src/relay-do.js`, `relay/src/env.js`, `relay/wrangler.toml`, `relay/README.md`
- Modify: `test/relay.mjs`

**Interfaces:**
- Produces:
  - `export function parseEnv(env): config` (the shape from Task 5), from these variables:
    - secrets: `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`;
    - `BOT_NUMBER`;
    - `BILLING` (`'off'` by default);
    - `TRIAL_MICRO_USD` (0 by default);
    - `RATES_JSON` (`'{"default":0}'` by default);
    - `MARKUP_PERCENT` (0 by default);
    - `HOURLY_CAP` (60 by default);
    - `GRAPH_VERSION` (required, no default);
    - `TEMPLATE_NAME` (`'modisa_needs_you'` by default);
    - `TEMPLATE_LANG` (`'en'` by default).

    It throws with the variable's name if a required one is missing.
  - **Worker routes:**
    - `GET /whatsapp/webhook`: verify token, echo `hub.challenge`.
    - `POST /whatsapp/webhook`: signature checked on the raw text (401 if bad). The parsed body goes to the Durable Object, and the Worker answers 200.
    - `GET /link`: WebSocket only, `Authorization: Bearer <43-char base64url>`. `sha256Hex(key)` goes to the Durable Object in header `x-key-hash`; 401 otherwise.
    - `GET /health`.
  - **Durable Object `RelayDO`**, a single instance `idFromName('main')`:
    - `this.ctx.acceptWebSocket(server, [keyHash])` and `serializeAttachment({ keyHash })`;
    - `setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))`;
    - `webSocketMessage` → `relay.machineMessage`. The daemon's first message is `{type:'hello', machine, version}`, which `machineMessage` hands to `relay.hello`;
    - routed messages go to `this.ctx.getWebSockets(keyHash)`, or `relay.queue` if there are none;
    - the store adapter maps `get/put/delete/list` to `this.ctx.storage`;
    - an alarm every 10 min sweeps:
      - expired `code:` entries;
      - `prompt:` entries closed more than 1 h ago;
      - `seen:` entries older than 1 day;
      - `msg:` entries older than 7 days.
  - **`wrangler.toml`:** `name = "modisa-relay"`, `main = "src/worker.js"`, a DO binding `RELAY` → `RelayDO`, and a migration `new_sqlite_classes = ["RelayDO"]`. No `[vars]` for operator values.

- [ ] **Step 1: Write the failing tests:**
  - `parseEnv` defaults;
  - a missing `GRAPH_VERSION` throws naming it;
  - `RATES_JSON` parsing.
- [ ] **Step 2: Run.** `node test/relay.mjs` should fail.
- [ ] **Step 3: Implement** `env.js`, `worker.js` and `relay-do.js`, plus `relay/README.md`:
  - deploying your own relay: `npm i`, `npx wrangler deploy`, then `npx wrangler secret put` for each secret and operator value;
  - the Meta app and test number, the webhook URL and the `messages` subscription;
  - the template `modisa_needs_you` (utility; body `Modisa: {{1}} needs you: {{2}}. Tap Show to see it.` (Meta rejects a body that starts or ends with a variable); quick reply "Show");
  - billing off by default;
  - Modisa → Settings → Relay address.
- [ ] **Step 4: Check it runs.**
  - `node test/relay.mjs` passes.
  - `cd relay && npm i && npx wrangler dev`, then `curl localhost:8787/health` prints `ok`, and `curl -i localhost:8787/link` returns `401`.
- [ ] **Step 5: Commit.** `git commit -m "Relay: Worker, Durable Object, self-hosting guide"` (`relay/package-lock.json` included, `node_modules` ignored).

### Task 8: Daemon phone client

**Files:**
- Create: `src/phone.mjs`, `test/phone.mjs`
- Modify: `package.json` (append `&& node test/phone.mjs`)

**Interfaces:**
- Consumes: `phoneSummary` (Task 1), and the relay protocol (Tasks 5 and 6).
- Produces:
  - `export const DEFAULT_RELAY_URL = ''` (set in Task 11)
  - `export function createPhone({ home, machineName, log, onChange, decide, extendHold, relayUrl = process.env.MODISA_RELAY, WebSocketImpl, now = Date.now }): Phone`
    - `decide(pendingId, decision) → { ok: boolean, reason?: string }`
    - `extendHold(pendingId) → void`
  - `Phone` has:
    - `start()` / `stop()`
    - `view(): { relay, connected, linked, number, enabled, mode: 'away'|'everything', code: {code, expiresAt, botNumber}|null, balanceMicroUsd, billing, botNumber, error, sent: { [pendingId]: 'sent'|'failed:<reason>' } }`
    - `isApprover(away: boolean): boolean`
    - `consider(list: PendingInfo[], away: boolean): void`, where `PendingInfo = { id, hookEvent, toolName, toolInput, project, questions, createdAt, expiresAt }`
    - `closed(pendingId: string, why: 'answered'|'timeout'|'gone'): void`
    - `panelMessage(msg): void`, which handles `{type:'phone-link', number}`, `{type:'phone-unlink'}`, `{type:'phone-cancel-link'}` and `{type:'phone-settings', enabled?, mode?, relay?}`
- **State file** `phone.json`: `{ key, relay, enabled, mode, lastStatus }`, written 0600 by temp file plus rename (as `saveDevices` does).
  - `enabled` defaults to `false` and becomes `true` when this machine's link completes; the spec says each machine has to turn it on.
  - `mode` defaults to `'away'`.
- **Connection:**
  - `new WebSocketImpl(relayUrl, { headers: { Authorization: 'Bearer ' + key } })`;
  - send `"ping"` every 30 s; if nothing arrives for 75 s, terminate;
  - reconnect with backoff from 1 s up to 60 s;
  - on open, send `{type:'hello', machine, version}`.
- **The rules in `consider`:**
  - Skip prompts already in `sent`, and prompts with `expiresAt - now < 60000`.
  - Send if `mode === 'everything' || away || (hookEvent === 'PermissionRequest' && now - createdAt >= 120000)`.
  - For a PermissionRequest, send `expiresAt = createdAt + 570000`.
  - On `prompt-sent` → `extendHold(id)` for PermissionRequest prompts.
- **Answers:** `decide` messages call `decide()` and reply with `decide-ack`.

- [ ] **Step 1: Write the failing tests** in `test/phone.mjs`, against a fake relay (a `ws` `WebSocketServer` on a spare port that checks the `authorization` header). Each check is named as quoted:
  - **"key":** `phone.json` is created with mode `0600` and a 43-character key, and the fake relay sees `Bearer <same key>`.
  - **"link":** `panelMessage(phone-link)` → the relay receives it. The relay answers `link-code` → `view().code`. Then `status linked` → `view().linked`.
  - **"rules":**
    - away → sent at once;
    - not away → not sent before 2 min, sent after (fake `now`);
    - PreToolUse with 50 s left → never sent;
    - `everything` → sent at once.
  - **"extend":** `prompt-sent` for a PermissionRequest → `extendHold` called once; for PreToolUse, not called.
  - **"decide":** relay `decide` → `decide()` called, and `decide-ack ok` sent back.
  - **"isApprover":** false when unlinked, disabled or disconnected, or when mode is away and not away.
  - **"reconnect":** the server closes the socket → the client reconnects and sends `hello` again.
- [ ] **Step 2: Run.** `node test/phone.mjs` should fail.
- [ ] **Step 3: Implement** `src/phone.mjs`.
- [ ] **Step 4: Run.** `node test/phone.mjs` passes.
- [ ] **Step 5: Commit.** `git commit -m "Daemon: phone link to the relay, sending rules, decisions"`

### Task 9: Wire the phone into the daemon

**Files:**
- Modify: `src/daemon.mjs` (`hold`, `handleHook`, `handleWidgetMessage`, `handleUpgrade`'s close handler, `snapshot`, the tick at the `setInterval(..., TICK_MS)` block), `test/phone.mjs`

**Interfaces:**
- Consumes: `createPhone` (Task 8), `localAway` (Task 2).
- Changes:
  - **`pendings` entries** gain `expiresAt` and `view`.
  - **New `extendHold(id)`:** resets that entry's timer to `createdAt + 570000`, sets `view.expiresAt`, then `broadcast()`.
  - **New `phoneDecide(id, decision)`:**
    - an unknown id → `{ ok: false, reason: 'gone' }`;
    - drop `decision.always`;
    - for an approval, `decision.behavior` must be `'allow'|'deny'`; for a question, `decision.answers` must be an object of strings;
    - then `p.finish(buildOutput(p, decision), 'answered on phone')`.
  - **`finish`** calls `phone.closed(id, mapped)`. The mapping:
    - a `why` starting with `'answered'` (panel, phone or terminal) → `'answered'`;
    - `'hook closed'` → `'gone'`;
    - anything else (`timeout`, `release`, `no widgets`, `no approvers`) → `'timeout'`.
  - **Away state** (`machineAway`): every tick, `localAway()` is cached. A machine is away when `local.away` is true and no remote `ws.presence` is `{active:true}` from the last 60 s.
  - **`handleHook`:** `skip = !approversConnected() && !phone.isApprover(machineAway)`.
  - **The socket close handler** releases pendings only if `!approversConnected() && !phone.isApprover(machineAway)`.
  - **Each tick:**
    - `phone.consider(...)` over `pendings`;
    - if `!approversConnected() && !phone.isApprover(machineAway)`, release the PreToolUse holds;
    - PermissionRequest holds already sent to the phone stay open.
  - **Local snapshots** add `phone: phone.view()` and `localActive: !local.away`. `view.phone` is set from `phone.view().sent[id]`.
  - **Messages:**
    - `case 'presence'` (any panel): `ws.presence = { active: Boolean(msg.active), at: Date.now() }`.
    - `phone-*` messages are accepted from local panels only.
  - **Environment for tests:** `MODISA_RELAY` and `MODISA_AWAY_FILE`.

- [ ] **Step 1: Write the failing tests**, appended to `test/phone.mjs`.
  - **Setup:** a real daemon in a temp `MODISA_HOME`, the fake relay (answering `hello` with `status linked:true`), and `hook()` copied from `test/e2e.mjs`. Each check is named as quoted:
  - **"no panel, away"** (away file idle 400000): a PermissionRequest hook is held, the relay gets `prompt` with masked detail, and the relay's `decide allow` → hook output `behavior: 'allow'`.
  - **"no panel, at desk"** (idle 1000): the hook returns at once with no output, and the relay gets nothing.
  - **"always is ignored":** a relay decide `{behavior:'allow', always:true}` → output has no `updatedPermissions`.
  - **"hold extended":** after `prompt-sent`, the local snapshot's pending `expiresAt ≈ createdAt + 570000`.
  - **"presence":** a second panel connection with approvals off sends `presence active:true` → with the away file idle, the hook isn't held. Presence is accepted from any panel; only the renderer limits sending it to other machines.
  - **"a decision delivered after a reconnect still answers":** the fake relay drops the socket after `prompt-sent`, the daemon reconnects, then the relay sends `decide` → the hook is answered.
  - **"local only":** `phone-link` from a remote panel is ignored. The daemon is bound to the machine's LAN IPv4 with a token, as `test/e2e.mjs` section 9o does. Skip with a printed note when there's no LAN address.
- [ ] **Step 2: Run.** `node test/phone.mjs` should fail.
- [ ] **Step 3: Implement** the daemon changes.
- [ ] **Step 4: Run.** `npm test`: all four files pass, and `test/e2e.mjs` still prints `56 checks passed`.
- [ ] **Step 5: Commit.** `git commit -m "Daemon: phone counts as an approver while away; answers from the phone"`

### Task 10: The panel: Settings, approval box, presence

**Files:**
- Create: `test/live/fake-relay.mjs` (a standalone fake relay for the harness: it answers `hello` with `status linked:true`, `link-start` with a `link-code`, and `prompt` with `prompt-sent`)
- Modify: `widget/renderer.js` (`settingsView` gains `...phoneView(row)` before `...machinesView(row)`; the snapshot handler; `approvalBox`), `widget/style.css`, `README.md` (a "Phone approvals (WhatsApp)" section)

**Interfaces:**
- Consumes: local snapshot `phone` (the `view()` shape) and `localActive`; pending `phone: 'sent'|'failed:<reason>'`.
- Produces:
  - **`function phoneView(row): Element[]`:**
    - **Linking:**
      - section head "Phone (WhatsApp)";
      - no relay → hint "Needs a relay address (below)";
      - relay unreachable → "Can't reach the relay";
      - not linked → a number input (`state.phoneDraft`) and **Connect** (sends `phone-link` to the local hub);
      - while a code is shown → the code in large text, "Send this code to the Modisa bot on WhatsApp within 10 minutes", **Open WhatsApp** (`window.deck.openLink('https://wa.me/' + botNumber + '?text=' + code)`) and **Cancel**.
    - **Once linked:**
      - "Connected" with the masked number;
      - a switch "Phone approvals on this machine";
      - a select of `[['away', "Only when I'm away"], ['everything', 'Send everything']]`;
      - "Credit": `$x.xx left (trial)`, or "Not charged" when billing is `off`;
      - **Disconnect**.
    - **Advanced:** "Relay address", an input plus **Save** (sends `phone-settings {relay}`).
    - Errors show as a hint line: `bad-number` → "Include the country code, e.g. +27 82 123 4567"; `rate-limited` → "Too many tries; wait an hour".
  - **Approval box:** "Sent to your phone", or "Couldn't send to your phone: <reason>" with `no-credit` → "out of phone credit", `rate-limited` → "hourly limit reached", `not-linked` → "phone not connected", `send-failed` → "WhatsApp refused it".
  - **Presence:** when the local hub's `localActive` changes, and every 30 s, `send(hub, {type:'presence', active})` to every non-local connected hub.
  - **Settings rebuilds:** like `devicesSig`, a change in the phone view's signature sets `state.settingsDirty`.

- [ ] **Step 1: Check on the harness panel.**
  - `node test/live/fake-relay.mjs <port>` running, then `test/live/live.sh panel` with `MODISA_RELAY=ws://127.0.0.1:<port>/link` set for the harness daemon.
  - `CDP_URL=… node test/live/cdp.mjs` screenshots of: Settings not linked, Settings with a code, Settings linked, and an approval card showing "Sent to your phone".
  - Look at each screenshot in both themes.
- [ ] **Step 2: Implement**, then re-take the screenshots until all four states read correctly.
- [ ] **Step 3: Run.** `npm test` passes; quote the last line.
- [ ] **Step 4: Commit.** `git commit -m "Panel: phone settings, sent-to-phone on cards, presence to other machines"`

### Task 11: Deploy the hosted relay and test live on Meta's test number

The user's accounts are involved, so **ask the user before each external step.**
- [ ] **Step 1: Cloudflare login.** Ask the user to run `! npx wrangler login` (in `relay/`) on the operator's Cloudflare account.
- [ ] **Step 2: Meta setup, by the user, with my guidance.**
  - A Meta app with the WhatsApp product under the operator's business portfolio.
  - The test number, with the user's phone added as a recipient.
  - A permanent system-user token, and the app secret.
  - The template `modisa_needs_you`, submitted for review.
  - A payment method stays **off** the account.
- [ ] **Step 3: Deploy, with the user's OK.**
  - `npx wrangler deploy`.
  - `npx wrangler secret put` for: `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `BOT_NUMBER`, `BILLING=trial`, `TRIAL_MICRO_USD`, `RATES_JSON`, `MARKUP_PERCENT` (values from `HANDOFF.private.md`), `GRAPH_VERSION` (the current Graph API version).
  - Set the webhook URL to `https://<worker>/whatsapp/webhook` and subscribe to `messages`.
- [ ] **Step 4: Point Modisa at the deployed relay.** Set `DEFAULT_RELAY_URL` in `src/phone.mjs` to `wss://<worker host>/link`. Commit.
- [ ] **Step 5: Live run on the harness.**
  1. Link the user's number.
  2. Start a real Claude Code session pointed at the harness daemon.
  3. Use "Send everything".
  4. Trigger a Bash permission and approve it from the phone.
  5. Trigger a 2-question AskUserQuestion and answer both from the phone.
  6. Check: the hook output in the transcript, the trial balance going down, and "Too late" after a timeout.
  7. Screenshot the WhatsApp chat (the user sends it) and the panel.
- [ ] **Step 6: Open the PR.** `npm test` last line quoted; the PR description has no operator values. Ask before merging, and before restarting the live daemon or panel.

---

## Self-review notes

- **Spec coverage:**

  | Spec section | Task |
  |---|---|
  | Linking | 5 |
  | When a prompt goes / timing | 8, 9 |
  | Away from every machine | 9, 10 |
  | What a message says / masking | 1, 3 |
  | Answers coming back | 6, 9 |
  | Credit (trial part) | 4, 5, 6 |
  | Security | 1, 7, 9 |
  | Running your own relay | 7 |
  | Phase 1 live test | 11 |

- **Phase 2 is out of scope:** top-ups, the MoR webhook and low-balance warnings.
- **Names used across tasks:**
  - `PhonePrompt`, `createRelay`, `createPhone`, `phoneDecide`, `extendHold`, `localAway`;
  - the messages `prompt`, `prompt-sent`, `prompt-failed`, `prompt-closed`, `decide`, `decide-ack`, `status`, `link-start`, `link-code`, `unlink`, `presence` and `phone-*`.
