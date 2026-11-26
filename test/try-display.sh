#!/usr/bin/env bash
# Tries a few ways of starting the panel on Linux, 10 seconds each.
# Watch the top-right of your main screen and note which number shows the panel.
cd "$(dirname "$0")/.." || exit 1
pkill -f widget/main.cjs 2>/dev/null
echo "Session: ${XDG_SESSION_TYPE:-unknown}, desktop: ${XDG_CURRENT_DESKTOP:-unknown}"
echo

try() {
  local n="$1"; shift
  local label="$1"; shift
  echo "=== $n) $label: look for the panel now (10s)"
  ( "$@" > "/tmp/modisa-try-$n.log" 2>&1 & echo $! > /tmp/modisa-try.pid )
  sleep 10
  pkill -f widget/main.cjs 2>/dev/null
  sleep 1
  grep -E "window shown|FATAL|exited unexpectedly|XGetWindowAttributes" "/tmp/modisa-try-$n.log" | head -3 | sed 's/^/     /'
  echo
}

E=node_modules/electron/dist/electron
try 1 "X11, GPU sandbox off"             "$E" widget/main.cjs --reset-position --disable-gpu-sandbox
try 2 "X11, GPU in main process"         "$E" widget/main.cjs --reset-position --disable-gpu-sandbox --in-process-gpu
try 3 "Native Wayland"                   env MODISA_WAYLAND=1 "$E" widget/main.cjs --reset-position --ozone-platform=wayland
try 4 "X11, all sandboxes off (diagnostic only)" "$E" widget/main.cjs --reset-position --no-sandbox

echo "Done. Tell me which number(s) showed the panel."
