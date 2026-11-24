#!/bin/sh
# Start the X session as `desktop`, then exec tini, with the driver host under
# it, as `driver`. This script is PID 1 and runs as root only until that exec;
# afterwards no process in the container is root or holds a capability. The
# only capabilities it needs are SETUID and SETGID (for setpriv); run it with
# --cap-drop=ALL --cap-add=SETUID --cap-add=SETGID (see sandboxRunArgs).
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

if [ -n "${COMPUTER_USE_HOST_TOKEN:-}" ]; then
  echo "start-desktop: COMPUTER_USE_HOST_TOKEN is not supported; mount the token as a file (see docker/run.sh)" >&2
  exit 2
fi
token_file="${COMPUTER_USE_HOST_TOKEN_FILE:-/run/computer-use/token}"
# Root holds no DAC override here, so only existence is checked; the driver
# host reads and validates the file itself.
if [ ! -e "$token_file" ]; then
  echo "start-desktop: no token file at $token_file; mount one read-only (see docker/run.sh)" >&2
  exit 2
fi

display="${COMPUTER_USE_DISPLAY:-:99}"
screen="${COMPUTER_USE_SCREEN:-1280x800x24}"

# OpenGL. COMPUTER_USE_GL comes from the image's own environment: `none` in
# the base image, and in a sandbox profile whatever Callboard passed as the
# CALLBOARD_GL build argument (from the validated recipe's `gl`). No file a
# recipe wrote is read to decide it. `software` gives Xvfb its GLX extension
# and points Mesa at llvmpipe, with as many render threads as the container
# has CPUs (its cgroup quota), not the host's.
gl="${COMPUTER_USE_GL:-none}"
gl_env=""
case "$gl" in
  none) glx="-extension GLX" ;;
  software)
    glx="+extension GLX"
    threads=1
    if [ -r /sys/fs/cgroup/cpu.max ]; then
      read -r quota period < /sys/fs/cgroup/cpu.max || true
      case "$quota:$period" in
        max:* | *[!0-9:]* | :* | *:) ;;
        *) threads=$(((quota + period - 1) / period)) ;;
      esac
    fi
    [ "$threads" -ge 1 ] 2>/dev/null || threads=1
    gl_env="LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe LP_NUM_THREADS=$threads"
    ;;
  *)
    echo "start-desktop: COMPUTER_USE_GL must be none or software" >&2
    exit 2
    ;;
esac

# Replace the current (sub)shell with "$@" as `desktop`, in a clean
# environment: nothing inherited from docker run. A sandbox profile's PATH and
# variables (/etc/computer-use/profile.env) are added by profile-env, which
# runs as `desktop` too, so root never reads that file.
exec_desktop() {
  # shellcheck disable=SC2086 # $gl_env is a fixed list of NAME=value words.
  exec setpriv --reuid=desktop --regid=desktop --init-groups --inh-caps=-all \
    env -i HOME=/home/desktop USER=desktop LOGNAME=desktop SHELL=/bin/bash \
    PATH=/usr/local/bin:/usr/bin:/bin DISPLAY="$display" LANG=C.UTF-8 $gl_env \
    /bin/sh /usr/local/lib/computer-use/profile-env /etc/computer-use/profile.env "$@"
}
# Run "$@" as `desktop` and wait for it.
as_desktop() { (exec_desktop "$@"); }
# Start "$@" as `desktop` in the background. The subshell execs, so no root
# shell is left waiting on it.
spawn_desktop() { (exec_desktop "$@") >/dev/null 2>&1 & }

# The driver's own temporary directory (its cross-process input lock lives
# under TMPDIR), created as `driver` before any desktop process exists. /tmp is
# shared and world-writable: had the desktop user created the lock directory
# first, every session would have been refused. mkdir without -p fails if it
# already exists, so a squat cannot be inherited either.
driver_tmp=/tmp/.computer-use-driver
setpriv --reuid=driver --regid=driver --init-groups --inh-caps=-all mkdir -m 0700 "$driver_tmp"

# /tmp and /home/desktop may be fresh tmpfs mounts: recreate what the image had.
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
as_desktop /bin/sh -c 'mkdir -p "$HOME/outbox" "$HOME/.icewm" && printf "ShowTaskBar=0\n" > "$HOME/.icewm/preferences"'

cd /home/desktop
# shellcheck disable=SC2086 # $glx is one fixed flag pair.
spawn_desktop /usr/bin/Xvfb "$display" -screen 0 "$screen" -nolisten tcp -noreset $glx
i=0
until as_desktop /usr/bin/xdotool getdisplaygeometry >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "start-desktop: Xvfb did not come up on $display" >&2
    exit 1
  fi
  sleep 0.1
done
# Only the desktop user and the driver may connect to the X server.
as_desktop /usr/bin/xhost +si:localuser:driver >/dev/null
# icewm, not openbox: each non-ASCII character the driver types remaps a
# scratch keycode, so every client sees two keyboard MappingNotify events.
# Under a UTF-8 locale openbox spends ~80ms on each, falls minutes behind on a
# long string, and while behind it never releases its click-to-focus pointer
# grab, freezing the pointer. icewm keeps up (qualified live; see the README).
spawn_desktop /usr/bin/icewm
# The test target: one terminal in the desktop user's home, restarted if it exits.
spawn_desktop /bin/sh -c 'cd "$HOME" && while :; do /usr/bin/xterm -geometry 100x30+40+40 -fa "DejaVu Sans Mono" -fs 12 -title "test-terminal"; sleep 1; done'
# Serve only once the terminal is on screen, so a reachable host means a ready desktop.
i=0
until as_desktop /usr/bin/xdotool search --onlyvisible --class xterm >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    echo "start-desktop: the test terminal did not appear" >&2
    break
  fi
  sleep 0.1
done

# tini stays PID 1 (reaping the desktop processes started above) as `driver`.
exec setpriv --reuid=driver --regid=driver --init-groups --inh-caps=-all \
  env -i HOME=/nonexistent PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 TMPDIR="$driver_tmp" \
  COMPUTER_USE_HOST_TOKEN_FILE="$token_file" \
  COMPUTER_USE_DISPLAY="$display" \
  COMPUTER_USE_ACKNOWLEDGE_FULL_DESKTOP_ACCESS="${COMPUTER_USE_ACKNOWLEDGE_FULL_DESKTOP_ACCESS:-}" \
  COMPUTER_USE_HOST_LISTEN="${COMPUTER_USE_HOST_LISTEN:-0.0.0.0}" \
  COMPUTER_USE_HOST_PORT="${COMPUTER_USE_HOST_PORT:-7801}" \
  COMPUTER_USE_OUTBOX="${COMPUTER_USE_OUTBOX:-}" \
  /usr/bin/tini -- node /opt/computer-use/dist/driver-host-cli.js
