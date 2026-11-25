# Agent Deck: handoff notes

Written at the end of the chat session that built v0.1.0, for the Claude Code session that continues it, and kept up to date since.

Notes specific to the author's own machines and service agents (addresses, paths, deployment details) are in `HANDOFF.private.md`. That file is git-ignored and isn't in this repository; if it's in your checkout, read it too.

## What this is and why

The user runs several Claude Code sessions at once on an **Ubuntu desktop** (GNOME on **Wayland**, two 1920×1080 monitors side by side) and a **MacBook**. They wanted a small always-on-top desktop panel (not a web page) showing what each session is doing, modelled on a video of a tool called "Agent Huddle". Each agent gets a card with its current step and progress. You can allow or deny permissions and answer Claude's questions from the panel, and jump back to the session. We looked at existing open-source tools (AgentPulse was a web dashboard, which they rejected; Tablo is the closest, see the bottom of this file) and chose to build our own in plain JavaScript (no build step on purpose).

## Architecture (read README.md for usage)

- `src/hook.mjs`: Claude Code runs it for every hook event (`node hook.mjs observe|decide`). It POSTs `{mode, event, input, meta:{ts, pid: ppid, tmuxPane, termProgram}}` to `127.0.0.1:<port>/hook`, starts the daemon if the connection is refused, and always exits 0. In `decide` mode it prints the daemon's JSON answer.
- `src/daemon.mjs`: one per machine, port 47615. Keeps session state (`src/state.mjs` turns events into status/step/steps/tasks/background/subagents), streams snapshots to panels over WebSocket `/ws`, and holds `decide` requests until a panel answers, or `holdSeconds` (300) passes, or the panel clicks "Terminal". Then it returns no output, so Claude Code shows its normal prompt. It finds the real Claude PID by walking `ps` up from the hook's parent and marks sessions ended when that PID dies. It persists to `~/.agent-deck/state.json`. Remote panels need `token` (set by `agent-deck share`), and `/hook` accepts loopback only.
- `src/agents.mjs` + `clients/python/agent_deck.py`: service agents (long-running non-Claude-Code agents) report over `POST /agent`; the panel shows them in an "Agents" section. See "Service agents" below.
- `src/otlp.mjs`: a dependency-free OTLP (protobuf + JSON) decoder for the OpenTelemetry receiver on 127.0.0.1:4318. See "OpenTelemetry receiver" below.
- `src/subagents.mjs`: reads a session's `subagents/` folder (each subagent's transcript and meta file) for the activity window. See "Panel redesign and activity window" below.
- `src/tailscale.mjs`: Tailscale identity (`status`, `whois`) for pairing machines without tokens. See P2 item 13.
- `src/claude-sessions.mjs`: reads Claude Code's own `~/.claude/sessions/<pid>.json` (session id, folder, title, busy/idle/waiting) and transcript tails. The daemon uses it to show sessions without hooks (watch-only) and to confirm prompts answered in the terminal. See P1 item 6.
- `src/install.mjs`: merges hooks into `~/.claude/settings.json` (backup first, idempotent, only touches entries containing `# agent-deck`). Observe hooks are `async: true`. Decide hooks (timeout 600) are `PermissionRequest` (all tools) and `PreToolUse` matcher `AskUserQuestion`. The daemon answers a question on the PermissionRequest for AskUserQuestion when the hook input's `permission_mode` is default/acceptEdits/plan/auto (verified live; the terminal shows the question at the same time). In any other mode it answers on PreToolUse, which keeps the question out of the terminal while held (`questionHookFor` in `daemon.mjs`).
- `widget/`: the Electron panel (`main.cjs`, `preload.cjs`, `renderer.js`, `style.css`, plus `shared.js` with Bolt and the DOM helper), the activity window (`activity.html`/`.js`/`.css`, `activity-preload.cjs`) and the icons (`icons/`, drawn by `icons/make-icons.cjs`). It's frameless, always on top, 360px wide, and its height follows the content. It connects to the local daemon plus `hubs` from config. All session text goes in via `textContent` (no HTML injection).
- `bin/agent-deck.mjs`: the CLI (`install`, `widget`, `autostart`, `status`, `share`/`unshare`, `add-hub`, `start`/`stop`/`restart`, `uninstall`).
- Tests: `npm test` (end-to-end checks: hook script → daemon → fake WebSocket panel, covering approvals, "Always", deny, question answers on both hooks, release to terminal, hold timeout, background tasks, subagents, approvals off). `node test/demo.mjs` feeds fake sessions. `bash test/try-display.sh` tries different Linux display modes.

Hook formats were taken from https://code.claude.com/docs/en/hooks (Claude Code 2.1.33x):
- `PermissionRequest` → `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny", "updatedInput"?, "updatedPermissions"?, "message"?}}}`. "Always" sends the request's `permission_suggestions` back as `updatedPermissions`. `ExitPlanMode` needs `updatedInput` echoed.
- Questions: `PreToolUse` on `AskUserQuestion` → `permissionDecision:"allow"` + `updatedInput` = original `questions` plus `answers: {questionText: label}` (multi-select labels joined with ", ").
- `Stop` input carries `background_tasks` (id, type shell/subagent/monitor/..., status, description, command) and `last_assistant_message`.
- Hooks load when a session starts, so sessions that were already open don't report until restarted.

## Ubuntu fixes already applied on this machine

1. Ubuntu 24.04 blocks unprivileged user namespaces, so Electron aborts unless `node_modules/electron/dist/chrome-sandbox` is `root:root` with mode `4755`. This was done with sudo. **It must be redone after any reinstall of node_modules.** `agent-deck widget` detects and explains this.
2. The GPU process crashed (`MESA-LOADER: failed to open dri_gbm.so: Permission denied`, exit 139), so the window was never drawn and stayed invisible. `widget/main.cjs` now, on Linux: asks for `ozone-platform=x11` (XWayland, so always-on-top can work), disables hardware acceleration, and adds `disable-gpu-sandbox` + `in-process-gpu`. Of the four modes `test/try-display.sh` tried, this was the clean one. The panel now shows. Overrides: `AGENT_DECK_GPU=1` and `AGENT_DECK_WAYLAND=1`. **Correction (2026-11-25):** `appendSwitch('ozone-platform')` from inside `main.cjs` has no effect in Electron 45, and the panel was really running as a native Wayland client (connected to `wayland-0`, absent from `xwininfo`). See P0 item 3.
3. Files edited by the chat session lost their executable bit. `bin/agent-deck.mjs` must be `chmod +x` (it's npm-linked as `agent-deck`).

The daemon is running and **already tracking real sessions**. Be careful when restarting it: a restart drops pending approvals back to the terminal, which is harmless but worth knowing. Don't remove or rewrite the user's own hooks in `~/.claude/settings.json`. If AgentPulse was installed earlier, its hooks may also be in that file; leave them unless the user says otherwise.

## Still to do (in priority order)

**Next up (2026-11-25):**
1. Check the service agents' cards once they run a real job.
2. The Mac: reset to the rewritten history (see "GitHub" below), restart, then the Mac checks under item 13.

The rest: the P2 list (installers, security) and item 9's notification click, which the user never confirmed.

### P0: verify with real sessions (only simulated so far)
1. ~~**Approval round-trip with a live session**~~ **Verified 2026-11-25** with Claude Code 2.1.332, an interactive session in `--permission-mode default` (hook input `permission_mode: "default"`), an isolated daemon (`AGENT_DECK_HOME`/`AGENT_DECK_PORT` set on the session, so hooks went to it) and a second panel driven over the DevTools protocol (`--remote-debugging-port`, its own `--user-data-dir`). Results:
   - **Allow**: the card appears about 1 s after the tool call. The click reaches Claude Code within 1 ms of the daemon's decision, and the terminal shows "Allowed by PermissionRequest hook".
   - **Deny**: Claude receives `Denied from Agent Deck.` and carries on with the turn; Stop fires.
   - **Always**: for `node -e ...` the suggestion was `addRules` with `destination: "localSettings"`. Claude Code wrote the exact command to `<project>/.claude/settings.local.json`, and the next identical call produced no PermissionRequest. The terminal's own option offers a broader prefix (`node *`), so the panel's "Always" is narrower than the terminal's. For `touch` the suggestions were `addDirectories` + `setMode acceptEdits`, both `destination: "session"`, so "Always" changes only that session's mode. `~/.claude/settings.json` was never touched.
   - **Terminal** and **timeout**: both hand back with no output, the terminal prompt is still there, and answering it works.
   - **Important finding: Claude Code shows its normal permission dialog in the terminal *while* the PermissionRequest hook is held.** Panel and terminal race, so the hold does not block someone at the terminal for approvals. But: answering **Yes** in the terminal does *not* cancel the hook (the card kept live Allow/Deny buttons for an already-answered request until the hold expired, and a click on it did nothing). Answering **No/Esc** kills the hook and is followed by no other event (only `[Request interrupted by user for tool use]` in the transcript), so the card stayed "Needs approval" until the next prompt. Both are fixed under item 4.
   - Dev aid added: `AGENT_DECK_EVENT_LOG=/path.jsonl` on the daemon appends every raw hook payload.
2. ~~**Question round-trip**~~ **Verified 2026-11-25** (same setup as item 1). What Claude received, from the transcript:
   - Single-select: `"Pick a colour"="Green"`.
   - Multi-select + "Other" in one call: `"Which toppings?"="Cheese, Mushrooms", "Which size?"="Medium please"`.
   - Answering on PreToolUse suppresses the terminal dialog; no PermissionRequest follows.
   - **Terminal** / timeout: Claude Code then sends a *PermissionRequest* for AskUserQuestion (not held twice), shows the question in the terminal, and about 6 s later a `Notification` `permission_prompt` "Claude needs your permission". That Notification is what mislabelled a real session's card as "approval" while it was really a question (fixed under item 4).
   - **Plan approval** (`ExitPlanMode`, input `{plan, planFilePath}`, no suggestions): Allow → "User has approved your plan", and Claude returns to the mode it was in *before* plan mode (default → default, acceptEdits → acceptEdits). The terminal offers "Yes, and use auto mode" / "Yes, manually approve edits", so the panel can't pick a mode yet. Deny → Claude gets `Denied from Agent Deck.` as an error, stays in plan mode and re-presents. Also confirmed in a real session: the user approved a plan from the panel at 13:28 SAST.
   - **Questions block the terminal on PreToolUse**: while the PreToolUse hook is held the terminal shows only "running PreToolUse hooks…" and no question, so someone at the terminal waits for the whole hold. **Changed:** the daemon now answers on the **PermissionRequest** for AskUserQuestion, and the question appears in the terminal *and* the panel at once. Verified live: single- and multi-select in default, acceptEdits, plan and auto mode. Other modes keep the PreToolUse route. `bypassPermissions` is not verified (the auto-mode classifier refused to start a bypass session for testing); a person running one could check it.
   - Bug found and fixed: after typing an "Other" answer and pressing Enter, the panel stopped updating (render skipped rebuilding while an answer box had focus, and the box kept focus). The renderer now always rebuilds and restores focus/caret to the same answer box if its question is still open; only an IME composition defers the rebuild.
3. **Always-on-top on GNOME Wayland via XWayland** (2026-11-25):
   - **Found:** the panel was a native Wayland client, because `app.commandLine.appendSwitch('ozone-platform','x11')` is too late in Electron 45. GNOME ignores always-on-top for Wayland clients.
   - **Fixed:**
     - `agent-deck widget` and autostart pass `--ozone-platform=x11` on the command line.
     - `main.cjs` restarts itself once with the flag if launched without it. `app.relaunch()` does nothing before "ready", so it spawns the new process directly, guarded by `AGENT_DECK_RELAUNCHED`.
     - **Dragged positions were never saved on Linux:** the code listened for `moved`, which Electron only emits on macOS/Windows (`@platform darwin,win32`). It now saves on `move` (debounced, ignoring the first second after showing).
     - The height change uses `setSize`, not `setBounds({...getBounds()})`, so it never writes a position back.
     - Commit 102e9a7 also moved the panel to its saved spot after showing, because it seemed to open in the wrong place. That was the user dragging the test panel while I measured: geometry sampled every 100 ms showed the window at exactly the requested spot at 212 ms, then a smooth drag. So mutter does honour the requested position, and the workaround was removed.
   - **Verified with the flag:**
     - XWayland client (`X11-unix` socket, listed by `xwininfo`) with `_NET_WM_STATE_ABOVE`.
     - Draws correctly with the in-process GPU flags.
     - Opens at the remembered position on monitor 2 (three launches in a row, no drift) and at the top right of monitor 1 (1544,48) with no saved position.
     - Height follows content (125 → 122 → 200 → 279 → 125 px, with the viewport always equal to the content).
     - An external `XMoveWindow` to 2600,300 was saved as 2616,310 (content position). Of three relaunches, two opened exactly there. One opened at 1274,347 within its first second, cause unclear (a drag, or mutter placing it), and the saved spot was not overwritten. If that recurs, moving the window to `pos` after showing is the workaround.
   - **User check (about 14:12 SAST):** with the panel running through XWayland, it **stays above other windows on both monitors**, including while dragging between them. No need for "Ubuntu on Xorg" or GNOME's "Always on Top" menu.
4. ~~**Stale statuses**~~ **Fixed 2026-11-25.**
   - **Mislabel:** a real session's card said "approval / Claude needs your permission" from 13:07 to 13:27 SAST. That wasn't stale: it was a *question* waiting in the terminal, relabelled by the `permission_prompt` Notification Claude Code also sends for questions.
   - **Reproduced live:**
     - "Yes" in the terminal doesn't cancel the held hook, so the card kept live buttons.
     - "No"/Esc kills the hook and then sends no event.
     - After Terminal/timeout (or with no panel), a terminal "No" also sends no event; only `[Request interrupted by user for tool use]` lands in the transcript.
   - **Changes:**
     - `settleHeld` drops a held card on the matching `PostToolUse`/`PostToolUseFailure`. The match is on `tool_input`; for AskUserQuestion on `questions`, since `answers` is added; for ExitPlanMode on the tool name, since the plan isn't repeated. It also drops the card on `Stop`/`UserPromptSubmit`/`SessionEnd` from the same agent, without touching status timestamps.
     - A hook killed by Claude Code → idle "Interrupted in the terminal".
     - The housekeeping tick (now 2 s) reads the transcript tail of sessions shown waiting in the terminal and spots the interrupt.
     - The Notification no longer relabels a question.
     - Default `holdSeconds` 90 → 300 (max 570, PreToolUse question holds max 90). The released-question fingerprint only applies to PreToolUse holds: it had stopped a re-asked identical question from being held on PermissionRequest for 2 minutes.
   - **Verified live:**
     - Yes during a hold → card cleared on PostToolUse.
     - No during a hold → "Your turn / Interrupted in the terminal".
     - Terminal, then No → cleared from the transcript within about 3 s.
     - A released question stays "question" after the Notification.
     - Plan approved in the terminal → cleared on PostToolUse. Plan rejected in the terminal → no PostToolUse, cleared on Stop.
   - **Limitations:**
     - ~~"Yes" on a long-running command kept the card until the tool finished~~ and ~~plan → "Tell Claude what to change" kept live buttons until `Stop`~~. Both are **fixed under item 6** using Claude Code's session status, and verified live. When the session file is missing (another Claude Code version), the old behaviour applies.
     - **Unverified assumption:** `settleHeld` matches on `agent_id`, assuming a subagent's PermissionRequest carries it. Every payload seen so far was from the main thread (`agent_id` absent). If subagent requests lack it, a main-thread `Stop` would drop a background subagent's card while its prompt is still open in the terminal (the prompt itself is unaffected). Check with the event log and a subagent that needs a permission.
   - The countdown on cards used to say "Goes back to the terminal in Ns". It now says "Answer here or in the terminal · N left here".
5. ~~Check that ended sessions disappear~~ **Verified 2026-11-25** on the live test session:
   - `kill -9` of the Claude process → card "Ended" within one housekeeping tick, gone about 20 s later, and `state.json` empty.
   - `/exit` → `SessionEnd` (`reason: prompt_input_exit`) → "Ended" at once.
   - The real sessions on this machine all had a resolved PID.
   - Hardening: a session whose PID couldn't be resolved (`pid: null` counts as alive, so it lingered up to 12 h) now retries on later events, at most once a minute.
   - Note for testing: fake sessions injected by running `hook.mjs` from a shell inside a Claude Code session resolve to *that* session's PID, so they live as long as it does. End them with a `SessionEnd` event.

**P0 live on this machine (14:27 SAST, 2026-11-25):** with the user's OK, the daemon was restarted on the new code (hold 300 s, 3 sessions restored) and the panel relaunched through XWayland. Smoke test: a throwaway session reported to the real daemon, the user clicked Allow on its card in the real panel, and Claude Code ran the command ("Allowed by PermissionRequest hook").

**How the live checks were run.** This is now committed as `test/live/` (`live.sh` + README, dev-only; the terminal driver is Python). Nothing is installed system-wide:
- An isolated daemon: `AGENT_DECK_HOME=<scratch> AGENT_DECK_EVENT_LOG=<scratch>/events.jsonl node src/daemon.mjs`, with `port`/`holdSeconds` in `<scratch>/config.json`.
- A second panel: `AGENT_DECK_HOME=<scratch> agent-deck widget --user-data-dir=<scratch>/electron --remote-debugging-port=9339`. Its own profile avoids the single-instance lock, and it was driven over the DevTools protocol (`Runtime.evaluate` to click, `Page.captureScreenshot`).
- An interactive `claude --permission-mode default` in a pty, with `AGENT_DECK_HOME`/`AGENT_DECK_PORT` set so its hooks go to the isolated daemon and `CLAUDE*` variables removed. It was run by a small Python pexpect + pyte driver that renders the screen to a file and takes keystrokes from command files.
- Ground truth was the session transcript (`tool_result`) and the rendered terminal, not panel state.
- Starting a `bypassPermissions` session that way is refused by the auto-mode classifier, so a person has to check that mode.

### P1: features (several are things Tablo has; see below)
6. ~~**Show sessions without a restart**~~ **Done 2026-11-25.**
   - **Source:** better than scanning processes. Claude Code 2.1.332 keeps `~/.claude/sessions/<pid>.json` per running interactive session (`src/claude-sessions.mjs` reads it every 2 s; it never reads the `.key` files). Fields used:
     - `sessionId`, `cwd`, `name` (auto title), `startedAt`;
     - `procStart`, which equals `/proc/<pid>/stat` field 22 on Linux and guards against PID reuse;
     - `status` + `waitingFor` + `statusUpdatedAt`.
   - **Status values observed:**
     - `idle`
     - `busy` (a tool running)
     - `waiting` + `"permission prompt"`
     - `waiting` + `"input needed"` (a question)
     - `shell` (background shells)

     They are verified to follow a held PermissionRequest: `waiting` while held, `busy` within about 1 s of "Yes" in the terminal or of plan feedback.
   - **Discovery:** sessions with no hooks get `source: 'discovered'` and show "watch only". Status comes from the file; step, last message and todos from the transcript tail (read again only when its size changes). The first hook event switches the session to `source: 'hooks'`. Every card's title is now Claude Code's `name` when there is one.
   - **Reconciliation:** for hooked sessions, the file ends stale cards. A held *PermissionRequest* (not a PreToolUse question, which the terminal isn't showing) is settled when the file says not-`waiting` with `statusUpdatedAt` more than 1 s after the hold began. A card shown waiting with no hold clears when the file says idle/busy/shell.
   - **Verified live:**
     - The isolated harness daemon showed the user's three real sessions as watch-only with live status, titles and steps (screenshot taken).
     - "Yes" in the terminal on a 20 s command → card cleared in about 1.1 s.
     - Plan feedback → cleared in about 2.3 s.
     - 5 new e2e checks.
   - **Not verified:** macOS (the file is probably written there too, and nothing in the code needs `/proc`).
7. ~~**Context-window meter**~~ **Done 2026-11-25.**
   - **Used** = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` of the latest main-thread (`!isSidechain`) assistant entry, read from the last 256 KB of the transcript when it grows (`contextUsage` in `src/claude-sessions.mjs`).
   - **Window:** nothing in the transcript or the request says which window a session has (plain model id, no 1M beta), so it's inferred.
     - 1M for current models, per the Claude API model table (Nov 2026): Fable/Mythos, Opus 5.x and 4.6–4.8, Sonnet 5.x and 4.6, Haiku 5.x.
     - 200K otherwise.
     - A `[1m]` suffix means 1M; usage above the guess means 1M.
     - `contextWindows` in the config overrides per model prefix.
   - **Warning:** amber from `contextWarnPercent` (80), red from 95%.
   - **Verified live:** the user's sessions showed 34% / 52% / 58–59% of 1M (Opus 5.5), matching the raw transcripts. After `/compact` on a tiny test conversation, usage went *up* (49k → 71k: the summary plus re-attached context); the meter follows what the transcript reports.
   - 3 new e2e checks.
8. ~~**Tray icon**, **global shortcut**, Esc~~ **Done 2026-11-25.**
   - **Tray:** Electron `Tray`, shown via Ubuntu's AppIndicator extension. Menu: show/hide, "Answer approvals here" (kept in sync with the shield), quit.
   - **Control socket:** `~/.agent-deck/panel.sock` (0600) for `agent-deck toggle|show|hide`. A hidden panel stays hidden across relaunches, but only when a tray or shortcut can bring it back.
   - **Esc** collapses the panel.
   - **Shortcut:** Ctrl+Alt+A, the user's choice. GNOME 46 has no GlobalShortcuts portal, and an XWayland grab only fires while an X11 window has focus. So `agent-deck shortcut` adds a GNOME custom keybinding running `agent-deck toggle`, and the panel's own `globalShortcut` is off while `shortcutVia: gnome` (otherwise one press would toggle twice). On this machine it was added with the user's OK.
   - **Verified on the harness panel:**
     - tray item registered (StatusNotifierWatcher 4 → 5);
     - toggle → IsUnMapped / IsViewable;
     - Esc → collapsed to the header;
     - hidden state survives a relaunch; socket removed on quit.
   - **Gotcha:** `gsettings set` parses values as GVariant, so strings that contain quotes must be passed as double-quoted literals.
   - **User check (2026-11-25):** on the real panel, Ctrl+Alt+A hides/shows it with VS Code focused *and* with other windows focused, and the tray icon and its menu work.
9. ~~**Better notifications**~~ **Done 2026-11-25.**
   - **Detection:** the renderer (`notifyChanges`) compares each snapshot with the last status per session. The first snapshot from a hub only primes, so reconnects are quiet. It notifies on:
     - working → idle/background after `notifyAfterSeconds` (30);
     - → approval/question with no panel hold (not right after a hand-back from the panel);
     - → error.

     Held prompts keep the existing notification. At most one notification per session per 10 s.
   - **Click:** shows the panel and jumps via the daemon's existing `jump` (tmux / VS Code).
   - **Switch:** tray "Notifications" checkbox (`notifications`).
   - **Verified on the harness:**
     - an 8 s turn → "Done, your turn: …";
     - a prompt not held → "Needs your approval in the terminal: run command";
     - with notifications off → none.
   - **Harness note:** to keep a test panel from re-notifying about your real sessions, run the harness daemon with an empty `CLAUDE_CONFIG_DIR`. Also, `live.sh panel` starts a harness daemon if none is running; `live.sh stop` stops it.
10. ~~**In-panel settings**~~ **Done 2026-11-25.**
    - **Settings view** behind the header gear (renderer `settingsView`): approvals, hold time (1/2/5/9 min), notifications plus the "done" delay, context warning %, theme (System/Dark/Light), shortcut (read-only).
    - **Saving:** main accepts only whitelisted keys and values (`SETTINGS` in `main.cjs`). The daemon re-reads `holdSeconds`/`contextWarnPercent`/`contextWindows` when `config.json` changes, so new prompts use the new hold without a restart.
    - **Theme:** all colours are tokens now. Light palette via `data-theme` or `prefers-color-scheme`; Electron's `nativeTheme.themeSource` follows the setting.
    - **Rebuilds:** the settings view rebuilds only when a setting changes, because snapshot renders would close an open dropdown.
    - **Verified on the harness panel:** screenshots of the settings view and of light-theme cards; changing the hold to 2 min → daemon log "panel can now answer for 120s" and the snapshot reports 120; the notification switch saved. 1 new e2e check (live hold reload).
11. **Jump on Linux** beyond tmux/VS Code: **researched 2026-11-25 and deferred** (the user's choice).
    - **Works today:**
      - tmux sessions (`select-window`/`select-pane`/`switch-client`);
      - VS Code terminals (`code <cwd>` brings that folder's window forward). Several of the user's sessions ran there when this was checked.
    - **gnome-terminal** (this session runs in it) is a native Wayland client on GNOME 46.
      - Wayland lets no background process raise another app's window, and `wmctrl`/`xdotool` only reach X11 windows.
      - gnome-terminal exposes `/org/gnome/Terminal/window/N` with `org.gtk.Actions` and `org.gtk.Application`, but presenting a window needs an xdg-activation token the daemon can't get. The likely result is a "Terminal is ready" notice. There's also no API that maps a tab to a process.
    - **A reliable option, if wanted:** the user installs the "Window Calls" GNOME Shell extension. It offers a D-Bus `List` (with titles and PIDs) and `Activate`. Jump could then focus the window whose title holds the session name, since Claude Code puts it in the tab title.
    - **macOS** (tab-precise AppleScript for Terminal/iTerm2/Ghostty): do it with item 13, where it can be tested on the Mac.
12. ~~**Permission-mode** badge~~ **Done 2026-11-25.**
    - `s.permissionMode` is taken from every hook input. The card shows a chip when it isn't `default`: accept edits, plan, auto, don't ask, or bypass (red).
    - Watch-only sessions have no mode (the session file doesn't record it).
    - Verified on the harness: plan → "plan" chip, then Shift+Tab to auto → "auto" on the next event. 1 new e2e check.

### Service agents (added 2026-11-25)
Long-running agents that aren't Claude Code sessions: for example an agent that runs scheduled jobs (cron) plus one long-running watcher, and asks a person to approve things in a chat app. They report to the daemon over `POST /agent` (below) or over OpenTelemetry (next section). Their approvals stay in their own chat; the panel only links there.

**Ask the user before changing or restarting any of their agents, and before merging anything.**

**S1–S4 and S6 done 2026-11-25:**
- **`src/agents.mjs`**:
  - agent state and status (not responding > error > waiting > working > idle);
  - an error clears on the next `job_start` or ok `job_end`;
  - waiting links: http(s) only, up to 50; recent jobs: 10;
  - `nextRun` (5-field cron) and `cronJobs` (crontab lines that run in the agent's `cwd`, job = the word after `-m <package>`).
- **`src/daemon.mjs`**:
  - `POST /agent`, loopback only, at most 64 KB, answers at once;
  - agents persisted in `state.json` and sent in snapshots;
  - liveness checked each housekeeping tick;
  - `refreshSchedules` reads `crontab -l` (or `AGENT_DECK_CRONTAB`) every minute and on `start`;
  - `dismiss-agent`.
- **Panel:**
  - an "Agents" section below the sessions (square avatars, status, current job/step or next run, waiting count, last job);
  - expanded: waiting links opened through main's `open-link` (http/https only; `AGENT_DECK_NO_OPEN` logs instead), recent jobs, last error, schedule, heartbeat;
  - notifications for not responding, errors and new waiting items (a click opens the link);
  - collapsed dots and the header light include agents.
- **`clients/python/agent_deck.py`** (stdlib, 85 lines including its usage docstring):
  - a bounded queue with a sender thread and an `atexit` flush (≤ 1 s);
  - the job context manager re-raises the agent's own exception (`sys.exit(0)` counts as ok).
- **Tests** (40 checks):
  - the `/agent` event sequence, link filtering, bad names, unknown events;
  - liveness → not responding → back;
  - the cron matcher on fixed dates;
  - the Python client end to end, and with no daemon (exits in < 2.5 s);
  - 403 for `/agent` and `/hook` from the machine's LAN address against a second daemon bound there.
- **Demo and live check:** `test/demo.mjs` adds two demo agents. Verified on the harness panel: screenshots of collapsed and expanded cards; "isn't responding" and "needs you" notifications (also for an agent that appears later); a link click logged by main.

S1. **Daemon API** `POST /agent`, loopback only like `/hook`. Body `{agent, event, ...}`; state kept per agent and persisted like sessions. Events:
   - `start` (name, description)
   - `heartbeat`
   - `job_start` (job, detail)
   - `step` (text)
   - `job_end` (job, result: ok|error, summary)
   - `waiting` (id, title, link to the chat thread or email)
   - `resolved` (id)
   - `schedule` (list of {job, next_run})
   - `error` (message)

S2. **Liveness.** An agent with no heartbeat for 3× its stated interval shows as **"Not responding"** (red, with a notification), not silently stale.

S3. **Panel "Agents" section**, separate from the Claude Code sessions.
   - Each card shows: status (idle / working / waiting on you / error / not responding), the current job and step, the next scheduled job, how many items are waiting on you, and when the last job finished and how it went.
   - Expanded, it shows the waiting items as links that open the chat thread or email in the browser, the recent jobs, and the last error.
   - **Approvals stay in the agent's chat.** The panel only links there and never approves anything for these agents.

S4. **Tiny clients**, one per language the agents use (about 40 lines, no dependencies):
   - API: `deck.start()`, `deck.heartbeat()` on a background timer, `deck.job(name)` as a context manager, `deck.step()`, `deck.waiting(id, title, link)`, `deck.resolved(id)`, `deck.error()`.
   - It must never raise or block the agent. If the daemon is down, it drops events silently.

**Hardening done 2026-11-25:**
- `start` keeps running jobs and `lastError`, and counts restarts.
- New `waiting_set` replaces the list.
- Jobs with no end expire after `agentJobMaxHours`.
- Client: the `AGENT_DECK_DISABLE` off switch, failure summaries are the exception type only, `timer=False` for loop-driven heartbeats, `waiting_set`.

**S5 (wiring real agents): done 2026-11-25** for the user's own two agents, over OpenTelemetry, by another Claude Code session working in their repos. Details are in `HANDOFF.private.md`. **Still to check:** a real running job, a posted approval list, and the token counts on the cards.

**When wiring any agent** (these apply equally to `agent_deck.py` and OpenTelemetry):
- **Metadata only.** Waiting titles are short and name the kind of item only (e.g. "Approve supplier bill", "Send draft"): **no amounts, names or email text**, plus the link.
- **Don't edit a deployed working tree.** If the agent runs from a checkout (cron, systemd), a branch switch, edit or pull there is a deploy. Work in a separate clone with its own environment, run only its tests (with `AGENT_DECK_DISABLE=1`), and leave merging, deploying and restarting to the user.
- **Heartbeat from the loop.** In the long-running loop use `start(heartbeat=60, timer=False)` + `heartbeat()` from the loop, so a hung loop shows "not responding". Report `waiting_set` from the agent's durable list of open asks, if it has one.
- **Back-off trap.** If the loop backs off after errors (say up to 30 × 20 s), a heartbeat only in the loop body stalls for 10 minutes and shows "Not responding". Beat inside the back-off sleep too (sleep in short steps and beat each step).
- **Shared entry point trap.** If the watcher and the cron jobs all start as `python -m <pkg> <cmd>`, register the heartbeat (the OTel counter, or `start()`) only in the watcher's command, never in shared setup. Otherwise each cron run counts as a restart, and two overlapping runs read as a crash loop.
- If an agent is built on the Claude Agent SDK, consider forwarding its tool steps through SDK hooks so the step line is live.

### OpenTelemetry receiver (added and done 2026-11-25)
The user asked for any agent that exports OTLP to show in the panel. Design rules: **metadata only**, because service agents can handle financial and personal data; and silent crash loops are the main blind spot to catch.
- **Receiver:**
  - `src/otlp.mjs`: a dependency-free decoder for OTLP protobuf (field numbers from the official `opentelemetry-proto` 1.45.2 descriptors) and OTLP/JSON. Log bodies and status messages are never decoded.
  - The daemon serves `/v1/traces|metrics|logs` on **127.0.0.1 and ::1 only**, port `otlpPort` (4318), even when shared.
  - It refuses requests with an `Origin` header (403), other content types (415), and bad bodies (400, never throws). Bodies up to 8 MB; gzip inflated to at most 16 MB.
  - The OTLP server has its own error handler: a busy port is logged, never fatal.
- **Mapping** (`src/agents.mjs`, `applyOtlp*`/`otlpTick`): one agent per `service.name`, in the existing Agents section with an "OTLP" chip.
  - **Jobs:** marked spans (`job.name` / `invoke_agent`); running from children, finished by the root; finished trace ids remembered; silent 15 min → "no end reported".
  - **Waiting:** from span/log events, with a 7-day TTL.
  - **Tokens today:** by receive day, from tolerant GenAI names, skipping aggregate operations.
  - **Liveness:** the heartbeat must *advance*.
  - **Crash loop:** a new start time or `service.instance.id` = restart; 3 in 10 min → error.
  - **Errors:** by type only.
  - **Bounds:** every map is bounded.
- **Verified live with the real Python SDK** (endpoint `localhost`, harness on 4319, heartbeat 10 s):
  - a job was seen mid-run ("daily · last tool: xero_lookup") and finished (25 s);
  - a **hung main loop** with the exporter still running → "not responding" plus a notification;
  - **4 starts in a row** → "Restarting repeatedly" plus a notification.
  - Found live: an event on a job's own (still open) span only arrives when the job ends, so the README says to put waiting events on a short span.
- **Tests:** `test/fixtures/otlp/*.bin` (Python, protobuf) and `*.json` (JS, JSON) are real exporter bodies, used for decoding. Card state is tested with fresh JSON. 4 e2e groups: protobuf + "no secret text in `state.json`"; JSON+gzip running/finished/late child/standalone chat; liveness and crash loop; refusals and `claude-code` ignored. Loopback-only is also checked against a LAN-bound daemon.
- **Demo:** `test/demo.mjs` adds `invoices-agent-demo` (OTLP).
- **Follow-ups after review** (2026-11-25, before going live):
  - **Delta temporality.** Before the fix, a delta heartbeat changed its start time on every export, so a healthy agent read as "Restarting repeatedly". Reproduced with the real Python SDK (`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta`): 9 "restarts" in a 30 s run.
    - The decoder now reads `aggregation_temporality`.
    - For delta, alive = increase > 0, and only a new `service.instance.id` is a restart (the Python SDK sets one per process; a delta counter with no increments exports no point at all).
    - Re-checked live on the harness: working with 0 restarts; a hung loop → not responding; 4 starts → "Restarting repeatedly".
  - **Wake from suspend.** A gap of more than 30 s (`AGENT_DECK_WAKE_GAP_MS`) since the daemon last ran moves every agent's heartbeat clock on by the gap (never past now), so waking doesn't flag every agent. `wakeClock` in `agents.mjs` is checked on every tick, snapshot and agent event, because timers pause during a real suspend and a snapshot can go out before the next tick.
    - e2e covers the tick path with `SIGSTOP`/`SIGCONT`, plus the clock directly.
    - `SIGSTOP` can't reproduce the snapshot-first ordering: the monotonic clock keeps running, so the overdue tick runs first. That path is covered by the direct clock test and by reading the code, not end to end.
  - **Logs.** A bad body is logged by error class only, because a JSON parse error quotes the start of the body. The same applies to the panel's parse errors.
  - **Test ports.** e2e never picks ports that land on 47615 (your daemon) or 47690 (the harness).
  - **Fixtures.** `make_fixtures.py delta` → `metrics-delta.bin`. `make_json_fixtures.mjs` records `traces/metrics/logs.json` from the official JS SDK (3.1.1, exporters 0.301.2) with its OTLP/JSON exporter, so the JSON path is checked against real exporter output too. Both decoded with no changes needed.
- **Other names (added 2026-11-25).** Agents that wrap their work differently are read as they are: `job <name>` spans are jobs, and model or tool calls inside an unfinished job span keep that job running even without `job.name`; an `agent.watcher.heartbeat` counter is a heartbeat; `approval.posted` events (`approval.kind`, `chat.thread`) are waiting items, trimmed by an `agent.approvals.waiting` gauge.
- **For new agents:** standard OpenTelemetry (see README) works instead of, or as well as, `agent_deck.py`. The "When wiring any agent" notes above still apply.

### Panel redesign, activity window and GitHub (added and done 2026-11-25)
- **GitHub:** public repo `xolisaninkwentsha/agent-deck`.
  - Each change goes on its own branch with a PR, and CI runs `npm test` on it (`.github/workflows/test.yml`). **The user approves every merge**, then the panel (and the daemon when its code changed) restarts.
  - **History was rewritten on 2026-11-25** before the repo stayed public: earlier versions of this file (which held private notes) were removed from every commit, and commit emails now use the GitHub noreply address. The first PRs (#1–#13) live in a private archive, so "Merge pull request #N" in old commit messages refers to those, not to this repo's PRs.
  - Commit with the noreply address (set in the checkout's local git config) so the work email doesn't come back.
  - **Any other clone** (the Mac's) must reset to the new history: `git fetch origin && git checkout main && git reset --hard origin/main`. A plain `git pull` would try to merge two unrelated histories.
- **Readability:**
  - **Scrolling:** the list scrolls once the window reaches 85% of the screen. `naturalHeight()` adds up the list's contents, so the panel shrinks back when a card collapses; `scrollHeight` never shrinks.
  - **Plans and questions:** plans show as formatted text (`planDoc()`), with Show all. Question options show their descriptions.
  - **Expanded cards:** tinted sections (last message, background, subagents, waiting, errors). Steps form a timeline: a green tick when done, a pulsing dot for the one in progress (only while the session is still at it).
- **Look:**
  - **Bolt:** an original robot mascot (Pac-Man and Bob the Builder were the user's ideas but are trademarked) on every card and in the tray.
    - States: asleep / working / "?" when it needs you / ✕ and smoke on errors; a head tint per session.
    - The tray shows the most urgent state across everything. `icons/make-icons.cjs` draws the PNGs from the cards' own Bolt.
  - **Studio style:** soft neutral greys, rounded cards, an indigo accent; dark and light.
    - It replaced Blueprint, which replaced the original look that was too close to the video.
    - Picked from mockups (two rounds: mascots, then panel styles in dark and light).
  - **Info line:** under each session: model, context, tokens in/out, the top three tools. `scanUsage()` reads the transcript a piece at a time; each message and each tool call is counted once; subagents are left out.
- **Activity window** (the card's tree button):
  - **Layout:** a session's subagents as an outline (Tree · Outline, picked from mockups of three tree and three graph layouts).
  - **Source:** `src/subagents.mjs` reads `<session>/subagents/agent-<id>.jsonl` + `.meta.json`.
    - Parents come from the `Agent` call ids, depth 2 included.
    - "Running" = unfinished and written to in the last 3 minutes, because `finished` isn't always set.
    - At most the 60 most recent agents, 16 MB per tick.
  - **Daemon:** reads only sessions a window watches (`{type:'watch-activity', key}`) and pushes changes. Those sockets get no snapshots.
  - **Works remotely:** the window talks to the session's daemon itself.
- **Still to do here:**
  1. **Plans in the activity window:** the session's plan with its steps ticked off (the user asked for "plan and subagent activity"). Built 2026-11-25: the task list with ticks, and the latest plan from plan mode (approved, rejected or proposed).
  2. **Check the agents' cards on real work:** a running job, waiting items, tokens.
  3. **The Mac** needs the reset above, then `agent-deck restart`.
  4. **One unexplained e2e failure** in seven runs (an unlabelled assertion). Labelled since; CI should catch it if it comes back.

### P2: second machine, packaging, polish
13. **MacBook**: `git clone https://github.com/xolisaninkwentsha/agent-deck`, then `npm install && npm link && agent-deck install && agent-deck widget`. Test remote approvals. On macOS the panel uses `floating` level and `setVisibleOnAllWorkspaces`, which is untested on a real Mac.
    - **Done 2026-11-25:**
      - Tailscale is up on the Ubuntu machine.
      - The live daemon is shared on its Tailscale address only, plus 127.0.0.1. Over Tailscale it needs the token (no token or a wrong one is refused); the LAN address isn't bound; `/hook` and `/agent` are 403 from outside.
    - **Other machines in the panel (no terminal):**
      - **Settings → Other machines:** paste the share line into any field and it fills in the name, address and token. Add and Remove are validated by `config.addHub`, the same as the CLI (e2e check).
      - **Settings → Share this machine** (switch):
        - It runs `agent-deck share <Tailscale IP>` / `unshare` through Electron's built-in Node (`ELECTRON_RUN_AS_NODE`), so the restarted daemon runs on that until the next `agent-deck restart`.
        - If the machine has no Tailscale address, it shows an error and points to the CLI for a LAN.
        - Copy line is done in main, so the page never sees the token.
        - The CLI's `restart`/`share` now wait for the old daemon to exit instead of a fixed 400 ms.
        - Verified on the harness: on → listening on the Tailscale address plus 127.0.0.1, reachable over Tailscale with the token; off → local-only, token kept.
        - Not tested: the no-Tailscale error path, and the Mac.
    - **Tailscale pairing** (no tokens to copy; the user asked for "a ping to the other device and approve there"):
      - **Asking:** Settings lists your own Tailscale devices (`tailscale status`) and probes `GET /pair` on each; **Connect** POSTs `/pair`.
      - **Checking:** the watched daemon runs `tailscale whois` on the caller (`src/tailscale.mjs`). It needs the same user ID as Self and no tags, and fails closed on any error.
      - **Approving:** the request is held until a **local** panel answers with the Allow/Deny card in `#requests`.
      - **After Allow:** `devices.json` (owned by the daemon) keeps the StableID, and WebSocket upgrades from that device need no token.
      - **Local only:** pairing data in snapshots, and the decide, allow-device and remove-device messages.
      - **Other guards:** Remove closes the device's live sockets; a 10-minute cooldown after Deny; at most 3 requests waiting.
      - **Both ways:** explicit on both sides, after a security-review finding about consent.
        - The asker ticks "both ways" next to Connect; only then does it send `shared: true`.
        - The watched machine's card then offers "Also show its sessions here". The box is hidden when that address is already a hub, because adding it again would replace a working token entry.
        - On Allow with the box ticked, the response carries back: true, and only then does the asker's panel send allow-device (checked with whois).
      - **What Allow grants:** trust goes to the device, so anything running on it can connect. A secret issued at Allow and stored in the hub entry would narrow that to Agent Deck; not done.
      - **Tests:**
        - e2e: a fake `tailscale` (`AGENT_DECK_TAILSCALE`) covers whois failure, garbage output, another user and tagged devices, nobody to approve, the remote panel's decide being ignored, no leak to remote panels, token-free entry, Remove, and Deny plus the cooldown. Two deliberate breakages were caught by those tests.
        - Harness with **real** Tailscale (this machine pairing with itself over its Tailscale address): card, Allow, token-free connect, Remove → 401.
        - **Mac ↔ Ubuntu:** the user has since connected the two, and Ubuntu's panel shows the Mac's sessions. **Still to check step by step:** the asking side (Connect, the panel's `pair` handler, a successful probe) hasn't run end to end, and neither has finding the Tailscale CLI on macOS (if Settings there says "Tailscale isn't running", the lookup in `src/tailscale.mjs` missed it).
      - Assumes both machines use the same port (47615).
      - Verified on the harness panel: it connected to the live daemon over Tailscale, cards carried the "ubuntu" label, Remove worked, and the copied line was checked from outside the page.
14. **Packaging**: build a `.deb` (whose post-install script sets chrome-sandbox permissions, so there's no manual sudo step) and a `.dmg` with electron-builder. Add autostart. Add a systemd user unit or LaunchAgent for the daemon if starting it lazily isn't enough.
15. Optional: Codex CLI support, a TypeScript migration. ~~CI for `npm test`~~ added 2026-11-25 (`.github/workflows/test.yml`, on every PR and on pushes to `main`).
16. Security review: the token travels in the WS query string and WS isn't encrypted, so Tailscale is the intended network. Consider `wss` or an auth handshake message.
    - **Partly done 2026-11-25** (after an automated review of the agents commit): a web page in a browser on this machine could reach `127.0.0.1:47615`.
      - **POSTs:** it could POST "simple" requests to `/hook` and `/agent`, planting fake sessions, agents or links.
      - **WebSocket (worse, since v0.1.0):** it could open `/ws`, which needs no token from loopback, then read every session and send `decide` to **approve a held permission request**.
    - **Now refused:**
      - POSTs with any `Origin` header (403) or a non-JSON content type (415);
      - WebSocket upgrades whose `Origin` is anything but the panel's own `file://` or `null` (403).
    - Our own clients send no web Origin: `hook.mjs`, the Python client, Node `fetch`/`WebSocket`, and the `ws` package. The Electron panel was checked to still connect.
    - **Agents** are capped at 100; one not heard from in 30 days is dropped. Covered by e2e checks.

## What Tablo has that Agent Deck doesn't (as of Nov 2026; github.com/aristocrat71/tablo, MIT, Tauri + Svelte)
- Session discovery by **tailing transcripts** (no restart needed), with activity windows and clear/restore timers
- **Context-window meters** (auto-detects standard or 1M window, LED bar, warning threshold, animates when context is compacted)
- **Codex and OpenCode** support
- **Toasts** with a jump button; a larger **dashboard window** with a live terminal-style activity preview
- **Settings pane**, **keyboard shortcut**, **light theme**, **menu-bar icon**, AeroSpace workspace following
- Permission-mode badge; AI-generated session titles
- Tab-precise **jump** for Terminal.app, iTerm2 and Ghostty on macOS
- One-line installers with checksum verification, and **auto-update**

## What Agent Deck has that Tablo doesn't
- **Answering questions** (AskUserQuestion) and plan approval from the panel
- **Several machines in one panel** (`share` / `add-hub`, token-protected)
- **Background tasks and subagents** per session, and task progress (x/y)
- "Always allow" (applies Claude Code's suggested rule)
- Uses `PermissionRequest`, so it only intervenes when Claude Code would actually ask, which respects accept-edits, plan and bypass modes
- Works on Ubuntu 24.04 Wayland (fixes above)
