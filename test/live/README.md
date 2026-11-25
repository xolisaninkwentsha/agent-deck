# Live checks (dev only)

`npm test` checks the daemon with simulated hook input. These scripts check the real thing: an interactive Claude Code session, the real hooks in `~/.claude/settings.json`, the daemon, and a real panel. They stay isolated from your own daemon (port 47615) and panel:

- **Daemon**: a separate one on port 47690, with its own home in `test/live/.work/home`. It logs every raw hook payload to `events.jsonl`.
- **Panel**: a second one with its own Electron profile, driven over the DevTools protocol on port 9339.
- **Session**: `claude` in a pty, started in `test/live/.work/proj` with `AGENT_DECK_HOME`/`AGENT_DECK_PORT` set, so only its hooks go to the test daemon.

Your other sessions keep reporting to your own daemon. The test panel appears on your screen (right side of the main screen, below where your own panel usually sits); leave it alone while a check runs, because a click there answers for real.

Linux only (pty + XWayland). The terminal driver is Python (`pexpect`, which Ubuntu ships, and `pyte`); everything else is Node.

## Setup

```bash
test/live/live.sh setup      # installs pyte into test/live/.pylib (git-ignored)
```

## Run

Three long-running parts; give each its own terminal, or background them:

```bash
test/live/live.sh daemon                                     # 1
test/live/live.sh panel                                      # 2 (returns once the panel is up)
test/live/live.sh session --permission-mode default --model sonnet   # 3
```

The first session in `.work/proj` asks whether you trust the folder: `live.sh send key down`, then `live.sh send key enter`.

Then drive it:

```bash
test/live/live.sh send prompt "Use the Bash tool to run exactly this command and nothing else: touch a.txt"
test/live/live.sh screen                 # rendered terminal: the prompt shows here too
test/live/live.sh state                  # daemon's view: status | step | pending
test/live/live.sh eval 'document.querySelector(".pending .btn.allow").click(); "ok"'
test/live/live.sh result                 # what Claude received (tool_result from the transcript)
test/live/live.sh shot /tmp/panel.png    # screenshot of the test panel
```

Other keys: `send key esc|up|down|tab|shift-tab|enter [times]`, `send text "/exit"`. Shift+Tab cycles the permission mode (manual → accept edits → plan → auto).

`live.sh stop` stops the panel and daemon. End the session with `send text /exit` + `send key enter`.

## Scenarios worth re-running after a change

| Check | How | Expect |
| --- | --- | --- |
| Allow / Deny / Always | `touch` prompt, click `.btn.allow` / `.btn.deny` / the "Always" button | `result` shows the command ran / `Denied from Agent Deck.`; "Always" writes `.work/proj/.claude/settings.local.json` |
| Answer in terminal | hold a prompt, `send key enter` (Yes) or `send key down 3` + `enter` (No) | `state` clears straight away (Yes: on PostToolUse; No: "Interrupted in the terminal") |
| Terminal then No | click "Terminal", then No in the terminal | cleared from the transcript within ~2 s |
| Questions | ask for AskUserQuestion, click `.pending .opt` | terminal shows the question at the same time; `result` has the answer |
| Plan approval | Shift+Tab to plan mode, ask for a plan with ExitPlanMode | Allow returns to the pre-plan mode |
| Panel on X11 | `xwininfo -root -tree \| grep "Agent Deck"`, `xprop -id <id> _NET_WM_STATE` | listed, `_NET_WM_STATE_ABOVE` |
| Remembered position | `python3 -I test/live/xmove.py <id> 2600 300`, restart the panel | reopens there |

Raw payloads for any event are in `.work/home/events.jsonl`. Starting a `bypassPermissions` session this way may be refused by Claude Code's auto-mode classifier when an agent does it; run that one by hand.
