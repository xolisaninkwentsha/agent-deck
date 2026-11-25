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

On the machine you want to *watch* (e.g. Ubuntu):

```bash
agent-deck share            # listens on the network with a random token, prints a command to run on the other machine
```

It prints something like:

```
agent-deck add-hub ubuntu ws://100.101.102.103:47615 <token>
```

Run that on the Mac. The panel picks it up within a few seconds, and each card shows a small machine label.

- Use **Tailscale** or your office LAN. Don't expose the port to the internet: the connection isn't encrypted by Agent Deck itself (Tailscale encrypts it).
- To share on one interface only: `agent-deck share 100.101.102.103` (your Tailscale IP).
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
