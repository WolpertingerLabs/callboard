#!/bin/sh
# Start the X session as `desktop`, then exec the driver host as `driver`.
set -eu

if [ -z "${COMPUTER_USE_HOST_TOKEN:-}" ]; then
  echo "start-desktop: COMPUTER_USE_HOST_TOKEN is not set; refusing to start" >&2
  exit 2
fi

display="${COMPUTER_USE_DISPLAY:-:99}"
screen="${COMPUTER_USE_SCREEN:-1280x800x24}"

# A clean environment for the desktop: no token, nothing inherited from docker run.
as_desktop() {
  setpriv --reuid=desktop --regid=desktop --init-groups --inh-caps=-all \
    env -i HOME=/home/desktop USER=desktop LOGNAME=desktop SHELL=/bin/bash \
    PATH=/usr/local/bin:/usr/bin:/bin DISPLAY="$display" LANG=C.UTF-8 "$@"
}

cd /home/desktop
as_desktop Xvfb "$display" -screen 0 "$screen" -nolisten tcp -noreset &
i=0
until as_desktop xdpyinfo >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "start-desktop: Xvfb did not come up on $display" >&2
    exit 1
  fi
  sleep 0.1
done
# The driver user connects to the desktop user's X server.
as_desktop xhost +si:localuser:driver >/dev/null
# icewm, not openbox: each non-ASCII character the driver types remaps a
# scratch keycode, so every client sees two keyboard MappingNotify events.
# Under a UTF-8 locale openbox spends ~80ms on each, falls minutes behind on a
# long string, and while behind it never releases its click-to-focus pointer
# grab, freezing the pointer. icewm keeps up (qualified live; see the README).
as_desktop icewm >/dev/null 2>&1 &
# The test target: one terminal in the desktop user's home, restarted if it exits.
as_desktop sh -c 'cd /home/desktop && while :; do xterm -geometry 100x30+40+40 -fa "DejaVu Sans Mono" -fs 12 -title "test-terminal"; sleep 1; done' >/dev/null 2>&1 &
# Serve only once the terminal is on screen, so a reachable host means a ready desktop.
i=0
until as_desktop xdotool search --onlyvisible --class xterm >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "start-desktop: the test terminal did not appear" >&2
    break
  fi
  sleep 0.1
done

exec setpriv --reuid=driver --regid=driver --init-groups --inh-caps=-all \
  env -i HOME=/home/driver PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 \
  COMPUTER_USE_HOST_TOKEN="$COMPUTER_USE_HOST_TOKEN" \
  COMPUTER_USE_DISPLAY="$display" \
  COMPUTER_USE_ACKNOWLEDGE_FULL_DESKTOP_ACCESS="${COMPUTER_USE_ACKNOWLEDGE_FULL_DESKTOP_ACCESS:-}" \
  COMPUTER_USE_HOST_LISTEN="${COMPUTER_USE_HOST_LISTEN:-0.0.0.0}" \
  COMPUTER_USE_HOST_PORT="${COMPUTER_USE_HOST_PORT:-7801}" \
  COMPUTER_USE_OUTBOX="${COMPUTER_USE_OUTBOX:-}" \
  node /opt/computer-use/dist/driver-host-cli.js
