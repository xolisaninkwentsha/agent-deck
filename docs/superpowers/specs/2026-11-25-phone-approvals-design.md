# Phone approvals over WhatsApp: hosted relay with prepaid credit

Status: design, 2026-11-25. iMessage is a separate design, after this one ships.

## Why

Agent Deck users want to answer Claude Code from their phone when they're away from the computer: permission requests, questions and plan approvals, by tapping buttons in WhatsApp.

Setup must be "type your number, confirm once". Users never touch Meta's developer tools.

Agent Deck is open source, so the relay that talks to WhatsApp is open source too, and anyone can run their own. A hosted relay can also be offered as a paid convenience, priced to cover its costs. The operator's business details are kept out of this public repo.

## Goals

- **Connect.** Settings → phone number → Agent Deck shows a code → the user sends the code to the bot on WhatsApp → connected. One number can link several machines.
- **Reach the phone.** Prompts go to the phone only when the user is away (rules below). They come with buttons, and a tap answers the held prompt while Claude Code is still waiting.
- **Prepaid credit.**
  - New numbers get trial credit.
  - Users top up through a checkout link.
  - Each message deducts the operator's cost for the recipient's country, times a markup.
  - At zero nothing is sent, and prompts stay on the panel and in the terminal.
- **Self-host.** The same relay code runs on anyone's own accounts. Billing can be switched off for self-hosters, and Agent Deck has a relay-address setting.

## Non-goals (this design)

- iMessage (next design).
- Service agents' approvals. They stay in the agents' own chat apps.
- "Always allow" from the phone. It changes permission rules for good, so it stays on the computer.
- A web dashboard for accounts. Settings, WhatsApp and the payment provider's checkout cover it.

## Anti-goals (a failure even if it works)

- **No more power than a tap.** The relay must never be able to do more than a person tapping in WhatsApp. It can only answer prompts the daemon itself sent, while they're open, with allow, deny or an answer.
- **No unsolicited messages.** The bot never messages a number that hasn't first messaged it a code.
- **No surprise charges.** Balances can't go negative, and the operator never pays Meta for a message nobody paid for.
- **No more text than needed.** Messages carry a short summary. Prompt text isn't kept after the prompt closes; billing records are kept.

## Constraints

- **Claude Code's wait.**
  - Claude Code waits for a hook for at most 600 s (the timeout `agent-deck install` sets).
  - The daemon holds a prompt for `holdSeconds`: default 300, max 570 (`holdFrom` in `src/daemon.mjs`).
  - A question held on PreToolUse is held for at most 90 s (`PRETOOLUSE_HOLD_MS`).
  - A tap after the hold ends is too late; the prompt is back in the terminal.
- **What gets held.** The daemon only holds a prompt when an approver is connected (`approversConnected()`). So the relay link counts as an approver only while the phone would actually be used: the user is away, or "Send everything" is on *(call)*.
  - At the desk with the panel closed, nothing changes from today. In particular, questions held on PreToolUse (bypass and dontAsk modes), which hide from the terminal while held, aren't held just because a phone is linked.
- **WhatsApp Cloud API** (Meta's official API; the only route where buttons work):
  - **The 24-hour window.** Free-form and interactive messages can only be sent within 24 hours of the user's last message to the bot. A button tap counts as a message, so it reopens the window. Outside the window, only a pre-approved template can be sent.
  - **Interactive messages:**
    - reply buttons: at most 3, titles at most 20 characters;
    - lists: at most 10 rows, row titles at most 24 characters;
    - body: at most 1,024 characters.
  - **Templates:** Meta reviews them. They have fixed text with variables and can carry quick-reply buttons.
  - **Pricing** ([Meta, effective 1 Oct 2026](https://developers.facebook.com/docs/whatsapp/pricing)):
    - charged per delivered message, at a rate set by the recipient's country and the message category;
    - each business number gets 1,000 free service messages a month;
    - messages from users to the business are free;
    - with no payment method on the account, Meta sends only within the free tier.
  - **Webhooks:** Meta calls a public HTTPS URL. GET verifies the URL with `hub.verify_token` and `hub.challenge`. POST bodies are signed in `X-Hub-Signature-256` (an HMAC-SHA256 of the raw body with the app secret), and that signature must be checked.
- **Hosting:** Cloudflare Workers on the free plan, with SQLite-backed Durable Objects.
  - The free plan allows 100,000 requests a day, and incoming WebSocket messages count 20:1.
  - Hibernating sockets cost nothing while idle.
  - Workers Paid ($5 a month) is the step up if needed.
- **Payments:**
  - The plan is a merchant of record (MoR), which handles VAT in buyers' countries. Which one is a phase 2 decision.
- **Agent Deck:** plain JavaScript, no build step, no new runtime dependencies in the app (the daemon already has `ws`). The relay is a separate package in this repo (`relay/`), deployed with Wrangler, and isn't part of the desktop app.
- **The repo is public.** No operator secrets or business details go in it.
- **Platforms:** Ubuntu (GNOME on Wayland; the panel runs through XWayland) and macOS.

## Approaches considered

**Delivery:**
1. **A shared hosted relay, open source and replaceable. Chosen.** It's the only way to get "type your number, done". Its costs and trust sit with the operator.
2. **Every user runs their own WhatsApp bot.** Private and free per user, but it means 20–30 minutes in Meta's setup plus a public address for each user. Rejected for the default path. Running your own relay (Goals) keeps this option open for people who want it.
3. **Link your own WhatsApp by QR code (unofficial WhatsApp Web libraries).** Buttons don't render (polls are the workaround), it breaks WhatsApp's terms so numbers can be banned, and it breaks when WhatsApp changes. Rejected.

**Pricing:**
- **Prepaid credit. Chosen.** It covers cost exactly in every country, and there are no renewals to manage.
- **Monthly plan with an allowance.** Rejected: Meta's rates differ a lot by country, so it needs prices per country, plus renewal handling.
- **Unlimited for a flat fee.** Rejected: one heavy user in an expensive country makes a loss.

## The design

Who decided what:
- **Decided by the user:** the shared relay, prepaid credit, messages only when away, the message contents, no "Always" from the phone, and a hosted relay run by an operator.
- **Marked *(call)*:** choices made while writing this, open to change.

### Pieces

- **Relay** (`relay/`, new): a Cloudflare Worker with Durable Objects.
  - `GET|POST /whatsapp/webhook`: Meta's callbacks.
  - `GET /link` (WebSocket): each Agent Deck daemon keeps one outgoing connection here.
  - `POST /billing/webhook`: the MoR's callbacks.
  - `GET /top-up`: starts a checkout for an account.
  - **Storage:**
    - accounts: number, balance, trial used, window open until, linked machines;
    - prompts in flight: short-lived;
    - the billing ledger.
- **Daemon:** `src/phone.mjs` (new), wired into `src/daemon.mjs`.
  - Keeps the relay link while phone approvals are on.
  - Decides when a held prompt goes to the phone.
  - Turns a decision from the relay into the same `finish(...)` a panel's `decide` produces.
- **Panel:** a "Phone (WhatsApp)" section in Settings.
  - **Connecting:** the number field, then the code plus an "Open WhatsApp" link (`https://wa.me/<bot>?text=<code>`). Then connected-as, the balance with a Top up button, and Disconnect.
  - **Switches:** "Only when I'm away" or "Send everything", and phone approvals on or off for this machine.
  - **Advanced:** the relay address. The default is the hosted relay.

### Linking a number

1. The daemon has a random 32-byte machine key, created on first use and stored 0600 in `~/.agent-deck/`. The relay keeps only a hash of it. The daemon presents it on every connection to the relay.
2. In Settings the user types their number. The daemon sends `link-start {number}`, and the relay returns a code that is single-use and valid for 10 minutes *(call: 8 characters, no lookalikes)*.
3. The user sends that code to the bot from that number; the wa.me link fills it in.
   - The relay matches the code and the sender's WhatsApp id, links the machine to the number, and replies "Connected: <machine name>".
   - That reply is paid from the new account's trial credit, like every bot message (see Credit). It also opens the 24-hour window.
4. A number that never sent a code is never messaged.
   - Link attempts are rate-limited per machine and per number.
   - "stop" sent to the bot unlinks every machine for that number.
   - Disconnect in Settings unlinks that machine.

### When a prompt goes to the phone

The user agreed to these defaults; both can be changed in Settings.
- **Phone approvals on:** the machine is linked and the switch is on.
- **The user is away**, meaning any of these:
  - the screen is locked;
  - there has been no keyboard or mouse input for 5 minutes;
  - the prompt has sat on the panel unanswered for 2 minutes.
- **Away from every machine** *(call)*. A machine isn't "away" while a panel that shows its sessions is open on a machine that's in use. For example, with the Ubuntu box shown in the Mac's panel and the user at the Mac, the Ubuntu daemon doesn't message the phone.
  - Each panel tells every daemon it's connected to whether its own machine is in use (a new `presence` message, sent on change and every 30 s).
  - The daemon treats a panel's presence as stale after 60 s.
- **"Send everything"** sends every held prompt at once.
- **Timing** *(call)*:
  - A prompt with less than 60 s of its hold left isn't sent.
  - When a PermissionRequest prompt is sent to the phone, its hold is extended to the maximum (570 s, inside Claude Code's 600 s). The terminal shows that prompt anyway, so a longer hold blocks nobody.
  - Questions held on PreToolUse keep their 90 s cap. They're only sent when the user is already away, so the 2-minute rule doesn't apply to them.

How it works:
- **Away detection** runs in the daemon, so it works with the panel closed.
  - On GNOME, `gdbus` calls to Mutter's IdleMonitor `GetIdletime` and `org.gnome.ScreenSaver.GetActive`.
  - On macOS, `ioreg` HIDIdleTime and the lock state.
  - If detection fails, only the 2-minute rule applies.
  - Electron's own idle API is not used: the panel runs through XWayland and may not see Wayland input.
- **One message per prompt.** If the panel or terminal answers first, nothing more is sent. A later tap gets "Already answered on the computer."

### What a message says

Text starts from what the panel already shows (`describeApproval` in `src/state.mjs`, and `view.questions`). Before anything leaves the machine, a phone summary with its own rules and tests (`phoneSummary`, new) masks it. The user chose masking over sending text as-is or sending titles only. Truncation lengths are *(call)*.
- **Masking:**
  - **Shell commands:** shown with secret-looking parts replaced by `••••`. That covers values after `Authorization:`/`Bearer`/`token`/`key`/`secret`/`password` (in flags, headers, `KEY=value` env assignments and JSON), logins inside URLs (`user:pass@`), and long random-looking strings (hex, base64 or JWT shapes over about 20 characters).
  - **File edits and writes:** the file path only, never the content.
  - **MCP and other tools:** the tool name and the names of the fields it's filling in, never their values (`describeApproval` currently uses the raw JSON for these).
  - **Questions and plans:** sent as written, since Claude wrote them for the user. Plans are cut to their start.
  - The panel itself is unchanged and keeps showing the full text.
- **Permission:** "<project> · Claude wants to <title>", then the masked detail (at most 300 characters; a shell command at most 900, ending "… (+N more characters: check the computer)" when cut). Buttons: **Allow** / **Deny**.
- **Plan** (ExitPlanMode): the start of the plan (at most about 900 characters). Buttons: **Approve** / **Keep planning**.
- **Question:**
  - single choice, 3 options or fewer: reply buttons;
  - single choice, 4 to 10 options: a list;
  - multi-select or more than 10 options: a numbered list. The user replies to that message with numbers (e.g. "1 3").
  - **Your own answer:** on every question the user can reply with text instead of tapping, which is the panel's "Other" box. WhatsApp's reply context ties a typed reply to its question; otherwise it goes to the newest open question for that number *(call)*.
  - **Several questions in one prompt** *(call)*: sent one at a time, the next once the previous is answered. The relay keeps the answers so far. The daemon gets one `decide` with all the answers, exactly as the panel's Send does. Each message is charged.
- **Outside the 24-hour window:** a utility template, "<project> needs you: <short title>", with one quick-reply button, **Show**. Tapping it reopens the window, and the full interactive message follows. The builder drafts the template wording; the operator submits it to Meta.
- **Never sent:** file contents, tool output, environment details, unmasked secrets, "Always".

### Answers coming back

- **Button payload:** `<promptRef>:<choice>`. `promptRef` is an opaque relay id mapped to (machine, the daemon's pending id).
- **The relay checks** that the sender's number owns that machine, that the prompt is open and unexpired, and that this is the first answer (first answer wins). Then it sends `decide` down that machine's link.
- **The daemon checks** that the pending id exists and that the choice is valid for that prompt. Then it answers through the same code path as a panel decision, and never with "always".
- **The bot doesn't confirm** a normal tap, because WhatsApp already shows the user what they tapped *(call: it saves a paid message)*. It only replies when the tap didn't land: "Too late: it's waiting in the terminal" or "Already answered on the computer".

### Credit

- **Accounts:** balance in micro-USD, trial credit on first link (amount set by the operator), and a ledger of charges, top-ups and refunds.
- **The price of a message** is the operator's cost for the recipient's country and that message type (from a rate table the operator keeps up to date from Meta's rate card) times the markup. Both are relay settings, not code.
  - Users pay per message, even when the message fell in Meta's monthly free tier *(call: the free tier pays for the trial credit)*.
- **Every message the bot sends is charged** to the account at that price *(call)*. That includes prompts, follow-up questions, "Connected", "Too late", "Already answered" and credit notices. Outside the 24-hour window, the template and the full message after it are two charges.
- **Before each send** the relay checks the balance covers the price. If it doesn't, the message is skipped, never sent at the operator's cost. At zero, Agent Deck shows "Out of phone credit: top up" in Settings and on the card.
- **Phase 1 (trial credit only)** runs with no payment method on the Meta account. Meta's 1,000 free messages a month are then a hard cap, and the operator pays nothing. If Meta refuses a send because the free tier is used up, the prompt simply stays on the panel and in the terminal.
- **Warnings:** a low-balance warning at 20% of the last top-up *(call)*. It goes in the next message, or in a confirmation reply while the window is open.
- **Top-up:** Settings → Top up → the relay creates a checkout for that account, for a fixed pack *(call: 5, 10 or 20 USD)*.
  - The MoR's webhook, with its signature checked, credits the balance, keyed by order id so a repeat can't double-credit.
  - Refunds debit the balance.
- **A runaway session can't drain the balance:** there's a cap of 60 bot messages per account per hour *(call)*, counting every kind of message.
- **A self-hosted relay** with billing off sends without charging.

### Security

- **Connections:** the daemon only ever connects out to the configured relay, which can't reach machines any other way.
- **Limits on the relay:**
  - It can't create prompts; the daemon ignores decisions for ids it didn't send.
  - Only allow, deny and answers exist.
  - Each machine has to turn phone approvals on.
- **Webhook signatures:** both Meta's and the MoR's are checked, compared in constant time, with replay protection by message id.
- **Stored data:**
  - machine keys hashed;
  - numbers kept (needed);
  - prompt text deleted when the prompt closes or expires;
  - logs carry neither prompt text nor full numbers.
- **Operator secrets** (Meta token, app secret, MoR keys) live in Worker secrets and never in the repo.

### Running your own relay

`relay/README.md` covers:
- deploying with Wrangler to your own Cloudflare account;
- creating your own Meta app and number, and the webhook URL;
- leaving billing off (the default for a self-hosted relay);
- pointing Agent Deck at it from Settings → Relay address.

## Phases

1. **Relay, WhatsApp, linking and phone approvals.** Credit works as a trial balance only; top-up is off. Tested with Meta's test number first.
2. **Billing:** the rate table, top-ups through the MoR, the ledger, low-balance and out-of-credit handling.
3. **iMessage:** its own design.

## Testing

- **e2e (daemon side), with a fake relay** (a WebSocket server inside the test) and stubbed away-detection:
  - the sending rules: away, the 2-minute rule, "send everything";
  - the decision path;
  - late taps;
  - unknown ids;
  - "always" rejected;
  - the relay link counting as an approver only while away, or with "Send everything" on;
  - presence from a remote panel keeping a machine "not away";
  - the hold extension, and no send with under 60 s left;
  - a prompt with two questions answered one at a time;
  - `phoneSummary` masking: tokens in headers, flags, env assignments and URLs; file content never included; MCP values never included.
- **Relay tests:** signed fake Meta webhooks, MoR webhooks, linking codes (expiry, wrong number, reuse), balance checks, the hourly cap.
- **Live:** Meta's test number with the operator's phone, before the real bot number.

## Left to the builder

- the exact away-detection calls per OS;
- the relay's storage schema;
- the template wording and button labels;
- which MoR;
- the code format;
- the rate-table format;
- how Agent Deck shows a stale or failed relay link.

Operator-specific details (seller, markup, accounts) are in the git-ignored `HANDOFF.private.md`.
