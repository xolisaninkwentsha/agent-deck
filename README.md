# Agent Deck

A small panel that stays on top of your screen and shows every Claude Code session on your machines:

- one card per session: project, what it asked for, the step it's on right now, task progress
- **Allow / Always / Deny** permission requests from the card
- **answer Claude's questions** from the card
- background work per session (dev servers, background shells, subagents) when you expand a card
- sessions from **several computers** (e.g. your Ubuntu box and your MacBook) in one panel
- jump back to the session's tmux pane or VS Code window

It works through Claude Code's own [hooks](https://code.claude.com/docs/en/hooks), so it sees sessions in any terminal, tmux, or the VS Code extension, with no wrapper around `claude`.

## How it fits together

```
 Claude Code session ──hook──▶ agent-deck daemon (one per machine, 127.0.0.1:47615)
 Claude Code session ──hook──▶        │
                                      │ WebSocket (token required from other machines)
                                      ▼
                         Agent Deck panel (Electron, always on top)
                         connects to this machine + any machines you add
```

- `src/hook.mjs`: Claude Code runs it on each event and it forwards the event to the daemon. It never fails a session: if anything goes wrong it just exits quietly. It also starts the daemon if it isn't running.
- `src/daemon.mjs`: keeps the live state of this machine's sessions, and holds permission requests and questions until you answer in the panel.
- `widget/`: the panel.

## Install (do this on each machine)

Needs Node 18+ and Claude Code.

```bash
cd agent-deck
npm install                 # also downloads Electron for the panel
npm link                    # puts the `agent-deck` command on your PATH (or use: node bin/agent-deck.mjs ...)
agent-deck install          # adds the hooks to ~/.claude/settings.json (backs it up first) and starts the daemon
agent-deck widget           # opens the panel
agent-deck autostart        # optional: open the panel when you log in
```

Sessions that were already open show up straight away as **watch only** (see below). Hooks are read when a session starts, so restart a session to answer its approvals and questions from the panel.

## See the Ubuntu machine from the Mac (or the other way round)

### With Tailscale: pair, nothing to copy

Both machines need Tailscale signed in to the same account, and Agent Deck.

1. On the machine you want to *watch* (e.g. Ubuntu): **Settings → Share this machine** on.
2. On the other one (e.g. the Mac): **Settings → Your devices on Tailscale** lists your devices where Agent Deck is shared. Click **Connect**. If the Mac is shared too, you can tick **both ways** first to offer the reverse.
3. On the watched machine, a card and a notification ask "*Mac* wants to see this machine". Click **Allow**. If the Mac offered both ways, the card also has **Also show its sessions here**. Nothing is granted in reverse unless both sides ticked it.

How it stays safe:
- **Who may ask:** Agent Deck asks Tailscale (`tailscale whois`) who is connecting. Only your own devices (the same Tailscale user) may ask. Tagged servers and other people's devices are refused, and so is anything Tailscale can't vouch for.
- **No token for paired devices:** a paired device connects without a token, because its Tailscale identity is checked on every connection.
- **Who can approve:** only a panel on the watched machine can allow a request or remove a device. Another machine's panel never even sees the requests.
- **What Allow grants:** trust goes to the **device**, not to one app. Anything running on a paired device can see your sessions and agents here and answer their approvals and questions. With a token, a program on that machine would first have to read Agent Deck's config. So pair only devices you'd trust at your keyboard.
- **Removing:** **Settings → Can see this machine** lists paired devices. **Remove** disconnects one at once.
- **Repeat requests:** after a Deny, the same device can't ask again for 10 minutes. Paired devices are kept in `~/.agent-deck/devices.json`.

### With a token (an office LAN, or without Tailscale)

On the machine you want to *watch*, turn on **Settings → Share this machine** (it uses the Tailscale address), or run this in a terminal:

```bash
agent-deck share            # listens on the network with a random token, prints a command to run on the other machine
```

Either way the daemon restarts, so a prompt the panel is holding at that moment goes back to the terminal. Turning it off (or `agent-deck unshare`) makes it local-only again and keeps the token, so panels that added this machine reconnect when you share again. A daemon restarted from the panel runs on Electron's built-in Node until the next `agent-deck restart`.

It prints something like:

```
agent-deck add-hub ubuntu ws://100.101.102.103:47615 <token>
```

On the Mac, open the panel's **Settings → Other machines**, paste that whole line into any field of **Add a machine** (it fills in the name, address and token), and click **Add**. Or run the line in a terminal. The panel connects within a few seconds, and each card shows a small machine label. **Remove** in the same list disconnects it.

On the shared machine, **Share this machine** shows the address it's shared on, and **Copy line** copies that line (token included, so treat it like a password). To see both machines from both panels, share each one and add each to the other.

- Use **Tailscale** or your office LAN. Don't expose the port to the internet: the connection isn't encrypted by Agent Deck itself (Tailscale encrypts it).
- Web pages in your browser can't talk to the daemon: requests that come with a browser's `Origin` header (other than the panel's own) are refused, and hooks and agents can only report from this machine.
- To share on one interface only: `agent-deck share 100.101.102.103` (your Tailscale IP). The daemon still listens on 127.0.0.1 for this machine's own hooks and panel.
- Addresses can be given as `100.101.102.103`, `host:port` or `ws://host:port`; the port defaults to 47615.
- `agent-deck unshare` makes the machine local-only again.
- Answering approvals for the remote machine works the same as local.

## Approvals and questions: how the hand-off works

When Claude Code asks for permission, asks for a plan approval, or asks you a question, the card shows it with buttons.

- **Claude Code shows its normal prompt in the terminal at the same time**, so answer wherever you are. If you answer in the panel, the terminal prompt closes and Claude carries on.
- For questions this holds in the default, accept-edits, plan and auto permission modes (checked with Claude Code 2.1.332). In any other mode (for example bypass permissions) the panel gets the question *first*, and the terminal only shows it after you click **Terminal** or the hold runs out.
- If you answer in the terminal instead, the card clears by itself within a couple of seconds.
- If nobody answers in the panel within **5 minutes** (`holdSeconds` in `~/.agent-deck/config.json`), or you click **Terminal**, the card says "Waiting for you in the terminal" and only the terminal can answer. (A question in a mode where the panel gets it first is held for at most 90 seconds.)
- If no panel is open, nothing is held: Claude Code behaves exactly as before.
- The **shield** button in the panel header turns this off. With it off, the panel only watches and every prompt goes to the terminal.

"Always" applies the rule Claude Code suggests (for example "always allow `npm run test`"), the same as choosing "Yes, don't ask again" in the terminal.

## Service agents

Long-running agents that aren't Claude Code sessions (scheduled jobs, chat bots) get their own **Agents** section below the sessions. Each card shows:

- whether it's idle, working, **waiting on you**, in **error**, or **not responding**;
- the job and step it's on, or the next scheduled job;
- how many items are waiting on you;
- how its last job went.

Click a card to see the waiting items as links (they open in the browser: the Chat thread or email where you answer), the recent jobs, the last error and the schedule. **The panel doesn't approve anything for these agents**; approvals stay where the agent asks for them.

An agent reports with the tiny Python client in `clients/python/agent_deck.py`. It uses only the standard library: copy it into the agent's repo. It never raises and never blocks; if Agent Deck isn't running, events are dropped.

```python
from agent_deck import Deck
deck = Deck("finance-agent")
deck.start("Billing and collections", heartbeat=60)   # in the long-running process only
with deck.job("daily") as job:                        # job_start / job_end (error if it raises)
    deck.step("Matching payments")
    deck.waiting("bill-42", "Approve supplier bill 42", "https://chat.google.com/...")
    job.summary = "3 reminders sent"
deck.resolved("bill-42")
deck.error("Xero sign-in expired")
```

- **Liveness:** an agent that declared a heartbeat interval and has sent nothing for 3× that interval shows **Not responding** (red, with a notification). `start(..., timer=False)` plus `deck.heartbeat()` from the agent's own main loop catches a hung loop; the default timer thread only proves the process is alive. Beat in **every** wait of the loop, back-off sleeps after errors included, or a loop that backs off for minutes reads as hung.
- **Two kinds of process:** typically a long-running process (heartbeat, chat) and short scheduled jobs. Call `start()` only in the long-running command (e.g. `chat-watch`), never in setup that cron jobs share, or each cron run counts as a restart. Restarting the long-running one keeps jobs that cron started and the last error. A job that never reports its end is marked failed after `agentJobMaxHours` (12).
- **Sleep:** while this machine is suspended nothing can arrive, so after waking the heartbeat clocks move on by the time asleep instead of flagging every agent.
- **What's waiting:** `deck.waiting_set([...])` sends the complete list of open items and replaces the panel's, so a lost `resolved` can't leave a stale item.
- **Privacy:** keep titles and messages short, with no names, amounts or email text. They're stored in `~/.agent-deck/state.json`, shown in notifications and on any panel the machine is shared with. A failed job reports only the exception's type, never its message.
- **Tests:** `AGENT_DECK_DISABLE=1` turns the client off, so an agent's own test suite doesn't post to your panel.
- **Schedule:** the daemon reads your crontab and lists the lines that run in the agent's working folder (`python -m <package> <job>`), with their next run. An agent can also send its own (`deck.schedule([(job, next_run), ...])`).
- **Under the hood:** `POST http://127.0.0.1:47615/agent` with JSON `{agent, event, ...}`; only requests from this machine are accepted. Events: `start` (name, description, heartbeat, cwd), `heartbeat`, `job_start` (job, detail), `step` (text), `job_end` (job, result ok|error, summary), `waiting` (id, title, link), `resolved` (id), `schedule` (list of {job, next_run}), `error` (message).
- **To see it** without real agents: `node test/demo.mjs` adds two demo agents (one waiting on you, one that stops responding).

## OpenTelemetry agents

Any agent that exports OpenTelemetry over OTLP/HTTP shows up as a service-agent card, one per `service.name`, marked **OTLP**. The daemon listens on **`localhost:4318`**, the exporters' default endpoint, so the standard SDK setup works unchanged. It accepts `/v1/traces`, `/v1/metrics` and `/v1/logs`, in protobuf or JSON, optionally gzip.

- **Access:** only programs on this machine are accepted, even when the daemon is shared with another computer. Requests from web pages are refused.
- **Settings:** `otlpPort` changes the port (`0` turns it off). Claude Code's own telemetry (`service.name` `claude-code`) is ignored, since its sessions already have cards (`otlpIgnoreServices`).

Python setup, the standard SDK and exporter (`pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http`):

```python
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter

resource = Resource.create({"service.name": "finance-agent", "service.version": "1.4.0"})
tracer_provider = TracerProvider(resource=resource)
tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))      # http://localhost:4318
tracer = tracer_provider.get_tracer("finance-agent")

# In the long-running command only (e.g. chat-watch), not in setup that cron jobs share: the main loop's own pulse.
meter_provider = MeterProvider(resource=resource, metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter())])
heartbeat = meter_provider.get_meter("finance-agent").create_counter("agent.heartbeat")
# ...each time round the main loop, and in every wait (back-off sleeps after errors too): heartbeat.add(1)

# A job: mark it, and put job.name on its child spans too so it shows while it runs.
with tracer.start_as_current_span("invoke_agent daily", attributes={"job.name": "daily", "gen_ai.operation.name": "invoke_agent"}):
    with tracer.start_as_current_span("chat claude-sonnet-5-5", attributes={"job.name": "daily", "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "claude-sonnet-5-5"}) as s:
        response = client.messages.create(...)
        s.set_attribute("gen_ai.usage.input_tokens", response.usage.input_tokens)
        s.set_attribute("gen_ai.usage.output_tokens", response.usage.output_tokens)
    with tracer.start_as_current_span("execute_tool xero_lookup", attributes={"job.name": "daily", "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": "xero_lookup"}) as s:
        ...
        s.add_event("waiting", {"waiting.id": "bill-42", "waiting.title": "Approve supplier bill", "url.full": thread_url})
```

What the card reads:

| Card shows | Comes from |
| --- | --- |
| **Jobs** | spans marked with `job.name` (or `gen_ai.operation.name = invoke_agent`). The job ends when its root span arrives: ok, or failed with `error.type` / the exception's type. Its child spans show it as running, with the **last tool** that finished (`gen_ai.tool.name`). Standalone model calls aren't jobs. |
| **Waiting on you** | span events (or log events) named `waiting`, `approval.requested` or `human_input.requested`, with `waiting.id`/`approval.id`, `waiting.title`/`approval.title` and a link in `url.full`/`link`. Events named `resolved`, `approval.granted`, `approval.denied` or `human_input.received` with the same id remove them. Otherwise they disappear after 7 days. |
| **Tokens today** | `gen_ai.usage.input_tokens`/`output_tokens` (older `prompt_tokens`/`completion_tokens` work too), per model. `invoke_agent` totals aren't counted twice. |
| **Not responding** | a metric named `*heartbeat*` that hasn't **gone up** for 3 minutes (`otlpHeartbeatSeconds` × 3), with a notification. Because the SDK exports from its own thread, a hung main loop keeps exporting the same value; that counts as not responding. Use a counter: a gauge counts as alive whenever it's exported. Delta export (`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta`) works too: there, any increase since the last export is alive. |
| **Error** | failed jobs and ERROR log records (by type only). **3+ restarts in 10 minutes** (seen as a new heartbeat start time or `service.instance.id`) shows "restarting repeatedly", which catches a crash loop that systemd keeps restarting. With delta export the start time changes on every export, so only `service.instance.id` counts: the Python SDK sets one per process; with other SDKs, set one at start-up (a fresh UUID). |

- **Waiting events:** spans are exported only when they end, so put a waiting event on a short span (as above), not on the job's own span, or it only appears when the whole job finishes.
- **GenAI names:** the GenAI conventions are still in development. Newer names are tried first and older ones are accepted; a missing attribute just means less detail.
- **Metadata only:** the receiver never stores span or status messages, log bodies, or `gen_ai.*` message content. Still, don't send what you don't need: leave `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` off, and keep titles to the kind of item, with no names or amounts.

## Sessions that started before Agent Deck

Claude Code keeps a small file per running session in `~/.claude/sessions/`, with its folder, its title and whether it's busy, idle or waiting for you. The daemon reads these every 2 seconds:

- **Sessions without hooks** (started before `agent-deck install`, or with hooks pointing elsewhere) get a card marked **watch only**. It shows the session's title, status (including "Needs approval in the terminal"), the step it's on (from the end of its transcript) and task progress. Answer those prompts in the terminal; restart the session to answer from the panel. The card turns into a normal one as soon as the session's hooks report.
- **All cards** use Claude Code's own session title, which reads better than the first prompt.
- It also confirms when you've answered a prompt in the terminal, so the panel's card clears even when no hook event follows (for example "Yes" on a long-running command, or feedback on a plan).

The file isn't a documented Claude Code format (checked with 2.1.332). If it changes, those extras stop and the rest of Agent Deck works as before.

## Show, hide, tray

- **Ctrl+Alt+A** shows or hides the panel (`shortcut` in the config). The panel remembers whether it was hidden.
- **Tray icon** (top bar on Ubuntu): show/hide the panel, turn "Answer approvals here" on or off (the same as the shield), quit.
- **Esc** collapses the panel to its header; the ^ button opens it again.
- `agent-deck toggle | show | hide` does the same from a terminal or script.
- **GNOME on Wayland** doesn't let an app catch a key while another app has focus, so run `agent-deck shortcut` once. It adds a GNOME custom shortcut ("Agent Deck" in Settings > Keyboard > Custom Shortcuts) that runs `agent-deck toggle`, and the panel stops grabbing the key itself so one press never toggles twice. `agent-deck shortcut off` removes it. On other desktops and macOS the panel registers the key itself.

## Permission mode

A card shows a small badge when a session isn't in the default permission mode: **accept edits**, **plan**, **auto**, **don't ask**, or **bypass** (red: Claude Code won't ask before running tools, so no approvals will come). It follows Shift+Tab changes from the next thing the session does. Watch-only sessions don't show it, because only hooks report the mode.

## Settings

The **gear** in the panel header opens the settings; Esc or the gear goes back.

- Answer approvals and questions here (the same as the shield)
- How long the panel can answer a prompt: 1, 2, 5 or 9 minutes. This setting belongs to this machine's daemon, applies to new prompts straight away, and doesn't change other machines.
- Notifications on/off, and how long a session must work before "Done, your turn" notifies
- Context warning threshold
- Theme: System (follows the desktop), Dark or Light
- The show/hide shortcut (read-only; `agent-deck shortcut` sets it up on GNOME)

Each change is saved to `~/.agent-deck/config.json` immediately.

## Notifications

The panel sends a desktop notification when:

- a prompt is waiting in the panel (an approval, a plan or a question);
- a session needs you **in the terminal** (no panel hold: watch-only sessions, approvals turned off, or a prompt handed back);
- a session **finishes** after working for at least `notifyAfterSeconds` (30 s by default, so quick replies stay quiet);
- a session stops with an error.

At most one notification per session every 10 seconds. **Clicking** one shows the panel and jumps to the session (its tmux pane or VS Code window). Turn them off with **Notifications** in the tray menu (`notifications` in the config).

## Activity window: subagents

The **tree button** on a card, or **Open the activity window** in its expanded view, opens a window for that session. It shows the main session and every subagent it started as an outline, with connector lines showing who started whom. A subagent started by another subagent sits under it.

- **Each row:** Bolt, the type and description, and the status:
  - running, with a timer;
  - done, with how long it took;
  - stopped: it never recorded an end and has been quiet for 3 minutes.
- **Under each row:** its current step, tool count and tokens.
- **Click a row** for its steps, newest first, and its latest message or last reply. **Running only** hides finished work.
- **Where the data comes from:** Claude Code keeps each subagent's transcript and a small description file next to the session's transcript (`<session>/subagents/`). The window is built from those, so it works for watch-only sessions, and from another machine's panel through its share.
- **Cost:** only sessions with a window open are read, at most the 60 most recently active subagents, a little at a time.
- **Privacy:** it shows the same kind of text as the cards: descriptions, step summaries and a short last message, never full prompts or tool output.

## Bolt, and the line under each session

Each card has **Bolt**, a small robot whose state follows the session's:
- **Idle:** asleep, with a dark screen.
- **Working:** eyes scanning and his gear turning.
- **Needs you:** a "?" on his screen, a flashing antenna, and a wave.
- **Error:** ✕ eyes and smoke.

Each session gets its own head tint, so cards are easy to tell apart. The panel uses the **Blueprint** look: navy drafting paper in dark mode, and a light "whiteprint" under the Light theme.

The **tray icon** in the top bar is Bolt too, showing the most urgent state across all sessions and agents. "Needs you" comes first, then an error, then working; otherwise he's asleep. The icons are drawn from the same Bolt as the cards by `widget/icons/make-icons.cjs`.

Under each session, a line shows:
- **Model:** e.g. Opus 5.5. Taken from the transcript, so it follows a `/model` switch.
- **Context meter:** see below.
- **Tokens this session:** e.g. `186M in · 676k out`. "In" counts input, cache writes and cache reads, so it grows fast. Hover for the exact numbers.
- **Top three tools:** with how many times each was called.

Tokens and tools come from reading the session's transcript as it grows. Each API message and each tool call counts once. Subagents' own work isn't included, though the calls that started them are. Watch-only sessions get the same line, because it doesn't depend on hooks.

## Context meter

Each card shows how full the session's context window is (`ctx 59%`; hover for the token count and model). It turns amber from `contextWarnPercent` (80% by default) and red from 95%.

- The number is the input, cache-write and cache-read tokens of the session's latest message, which is what its next request sends. Subagents don't count.
- Transcripts don't say which window a session has, so it's worked out from the model: 1M for current models (Opus 5.x and 4.6–4.8, Sonnet 5.x and 4.6, Haiku 5.x, Fable, Mythos), 200K otherwise. Anything using more than 200K is counted against 1M. If a guess is wrong, set `contextWindows` in the config, e.g. `{"claude-opus-5-5": 1000000}`.
- After `/compact` the meter shows what the next message really sends. On a short conversation that can be *more* than before, because the summary and re-attached context are added.

## Ubuntu notes

- On Ubuntu 23.10+ run this once after `npm install` (Ubuntu blocks Electron's usual sandbox; `agent-deck widget` reminds you if needed):
  `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`
- The panel draws without the GPU sandbox on Linux, because the GPU process crashes on recent Ubuntu and leaves the window invisible. `AGENT_DECK_GPU=1` restores Electron's defaults. If the panel ever doesn't appear, `bash test/try-display.sh` tries the alternatives.

- Ubuntu's default Wayland session doesn't let apps keep themselves on top. The panel runs through XWayland to get around this: `agent-deck widget` and autostart start Electron with `--ozone-platform=x11`, and if you start `electron widget/main.cjs` yourself without it, the panel restarts itself once with it. (Setting it from inside the app has no effect in Electron 45.) If it still doesn't stay on top, log in with **"Ubuntu on Xorg"** (gear icon on the login screen), or set `AGENT_DECK_WAYLAND=1` to try native Wayland. Native Wayland can't stay on top, and its position can't be set or remembered.
- Drag the panel anywhere, on either screen; it opens there next time (top right of the main screen the first time).
- "Jump to session" switches tmux panes and focuses VS Code. For other terminals on Linux it can't raise the window yet.

## Commands

```
agent-deck install | uninstall
agent-deck widget | autostart [off]
agent-deck toggle | show | hide          # the running panel
agent-deck shortcut [off]                # GNOME: Ctrl+Alt+A everywhere
agent-deck status
agent-deck share [ip] | unshare
agent-deck add-hub <name> <ws://host:port> <token> | remove-hub <name>
agent-deck start | stop | restart        # the daemon
```

## Config: `~/.agent-deck/config.json`

| key | default | meaning |
| --- | --- | --- |
| `port` | 47615 | daemon port |
| `bind` | `127.0.0.1` | set by `share` |
| `token` | none | set by `share`; other machines need it |
| `holdSeconds` | 300 | how long the panel can answer a prompt (the terminal shows it meanwhile); max 570 |
| `name` | hostname | machine label on cards |
| `hubs` | `[]` | other machines this panel shows (managed by `add-hub`) |
| `approvalsInWidget` | true | the shield button |
| `shortcut` | `Control+Alt+A` | shows/hides the panel |
| `shortcutVia` | none | `gnome` after `agent-deck shortcut` (the panel then doesn't grab the key) |
| `theme` | `system` | `system`, `dark` or `light` |
| `notifications` | true | desktop notifications (also in the tray menu) |
| `notifyAfterSeconds` | 30 | "Done, your turn" only after this much work |
| `otlpPort` | 4318 | OpenTelemetry receiver on localhost (0 = off) |
| `otlpHeartbeatSeconds` | 60 | an OTLP agent's heartbeat must advance within 3× this |
| `otlpWaitingTtlHours` | 168 | waiting items an OTLP agent never resolves disappear after this |
| `otlpIgnoreServices` | `["claude-code"]` | `service.name` values not shown |
| `contextWarnPercent` | 80 | context meter turns amber from here |
| `contextWindows` | `{}` | context window per model-id prefix, if the built-in guess is wrong |

## Try it without real agents

```bash
agent-deck widget
node test/demo.mjs          # four fake sessions, one approval, one question. Ctrl+C ends them.
```

## Tests

```bash
npm test                    # end-to-end checks: hook script -> daemon -> fake panel
```

## Uninstall

```bash
agent-deck autostart off
agent-deck uninstall        # removes only Agent Deck's hooks (backs up settings.json first) and stops the daemon
rm -rf ~/.agent-deck
```

## If you change Node versions

The hooks point at the exact `node` binary used during `agent-deck install`. If you switch Node versions (nvm) or move the folder, run `agent-deck install` again.

## Files and logs

- `~/.agent-deck/daemon.log`: daemon log
- `~/.agent-deck/state.json`: sessions, so a daemon restart doesn't lose track of running ones
- `~/.claude/settings.json.agent-deck-backup-*`: backups made by install/uninstall
