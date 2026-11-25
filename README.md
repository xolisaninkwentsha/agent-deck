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

Then **restart any Claude Code sessions that were already open**. Hooks are read when a session starts, so older sessions won't appear until they're restarted.

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
- If nobody answers in the panel within **90 seconds** (`holdSeconds` in `~/.agent-deck/config.json`), or you click **Terminal**, the card says "Waiting for you in the terminal" and only the terminal can answer.
- If no panel is open, nothing is held: Claude Code behaves exactly as before.
- The **shield** button in the panel header turns this off. With it off, the panel only watches and every prompt goes to the terminal.
- Known issue: if you answer in the terminal, the card can keep its buttons until the hold runs out. Clicking them then does nothing.

"Always" applies the rule Claude Code suggests (for example "always allow `npm run test`"), the same as choosing "Yes, don't ask again" in the terminal.

## Ubuntu notes

- On Ubuntu 23.10+ run this once after `npm install` (Ubuntu blocks Electron's usual sandbox; `agent-deck widget` reminds you if needed):
  `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`
- The panel draws without the GPU sandbox on Linux, because the GPU process crashes on recent Ubuntu and leaves the window invisible. `AGENT_DECK_GPU=1` restores Electron's defaults. If the panel ever doesn't appear, `bash test/try-display.sh` tries the alternatives.

- Ubuntu's default Wayland session doesn't let apps keep themselves on top. The panel runs through XWayland to get around this. If it still doesn't stay on top, log in with **"Ubuntu on Xorg"** (gear icon on the login screen), or set `AGENT_DECK_WAYLAND=1` to try native Wayland.
- "Jump to session" switches tmux panes and focuses VS Code. For other terminals on Linux it can't raise the window yet.

## Commands

```
agent-deck install | uninstall
agent-deck widget | autostart [off]
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
| `holdSeconds` | 90 | how long a prompt waits in the panel before going to the terminal |
| `name` | hostname | machine label on cards |
| `hubs` | `[]` | other machines this panel shows (managed by `add-hub`) |
| `approvalsInWidget` | true | the shield button |

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
