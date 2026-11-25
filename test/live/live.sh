#!/usr/bin/env bash
# Live checks against a real Claude Code session, isolated from your own daemon and panel.
# See test/live/README.md. Everything lives in $AGENT_DECK_LIVE_DIR (default test/live/.work).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=${AGENT_DECK_LIVE_DIR:-$HERE/.work}
PORT=${AGENT_DECK_LIVE_PORT:-47690}
CDP=${AGENT_DECK_LIVE_CDP:-9339}
export AGENT_DECK_HOME="$WORK/home"
mkdir -p "$WORK/home" "$WORK/drv/cmds" "$WORK/proj"
# The test panel opens below where your own panel sits by default (top right of the main screen).
# OTLP on 4319 so the test daemon never takes your real daemon's 4318.
[ -f "$WORK/home/config.json" ] || printf '{"port":%s,"holdSeconds":25,"name":"livetest","window":{"x":1544,"y":600},"otlpPort":4319}\n' "$PORT" > "$WORK/home/config.json"
n() { date +%s%N; }

case "${1:-help}" in
  setup)    # one-off: pyte for the terminal driver
    python3 -c 'import pexpect' 2>/dev/null || { echo "needs python3-pexpect"; exit 1; }
    python3 -m pip install -q --target "$HERE/.pylib" pyte 2>/dev/null || pip3 install -q --target "$HERE/.pylib" pyte ;;
  daemon)   # foreground; Ctrl+C stops it. Every hook payload goes to $WORK/home/events.jsonl
    AGENT_DECK_EVENT_LOG="$WORK/home/events.jsonl" exec node "$ROOT/src/daemon.mjs" ;;
  panel)    # a second panel with its own profile, drivable over DevTools on $CDP
    exec node "$ROOT/bin/agent-deck.mjs" widget --user-data-dir="$WORK/electron" --remote-debugging-port="$CDP" ;;
  session)  # foreground; extra args go to claude, e.g.: live.sh session --permission-mode default --model sonnet
    shift; rm -f "$WORK/drv/exit"
    AGENT_DECK_PORT=$PORT exec python3 -I "$HERE/drive.py" "$WORK/drv" "$WORK/proj" "$@" ;;
  send)     # live.sh send key <name> [times] | text <s> | prompt <s>   (then waits ${WAIT:-1}s)
    case "$2" in
      key)    node -e 'console.log(JSON.stringify({key:process.argv[1],times:Number(process.argv[2]||1)}))' "$3" "${4:-1}" > "$WORK/drv/cmds/$(n).json" ;;
      text)   node -e 'console.log(JSON.stringify({text:process.argv[1]}))' "$3" > "$WORK/drv/cmds/$(n).json" ;;
      prompt) node -e 'console.log(JSON.stringify({text:process.argv[1]}))' "$3" > "$WORK/drv/cmds/$(n).json"; sleep 0.4
              echo '{"key":"enter"}' > "$WORK/drv/cmds/$(n).json" ;;
    esac
    sleep "${WAIT:-1}" ;;
  screen)   grep -v '^\s*$' "$WORK/drv/screen.txt" ;;          # rendered terminal of the session
  eval)     node "$HERE/cdp.mjs" "$CDP" eval "$2" ;;            # run JS in the test panel
  shot)     node "$HERE/cdp.mjs" "$CDP" shot "$2" ;;            # screenshot of the test panel
  state)    node "$HERE/snap.mjs" "$PORT" ;;                     # the daemon's view of each session
  result)   # last tool_result in the newest session transcript: what Claude actually received
    tp=$(grep -o '"transcript_path":"[^"]*"' "$WORK/home/events.jsonl" | tail -1 | cut -d'"' -f4)
    python3 -I "$HERE/lastresult.py" "$tp" ;;
  stop)     # stop the test panel and daemon
    pkill -f "user-data-dir=$WORK/electron"
    [ -f "$WORK/home/daemon.pid" ] && kill "$(cat "$WORK/home/daemon.pid")" 2>/dev/null
    echo "stopped panel and daemon (end the session with: live.sh send text /exit; live.sh send key enter)" ;;
  *) sed -n '2,3p' "$0"; grep -E '^  [a-z]+\)' "$0" | sed -E 's/^  ([a-z]+)\)[^#]*#\s*(.*)$/  \1: \2/' ;;
esac
