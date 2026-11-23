#!/bin/sh
# Build (if needed) and run the sandbox desktop with the hardened flags, then
# print the two Callboard environment variables to use.
#
#   packages/computer-use/docker/run.sh [host-port]
#
# The flags mirror sandboxRunArgs() in src/remote/sandbox.ts, which is the
# authoritative list (test/sandbox.test.mjs keeps the two in step).
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
image="${COMPUTER_USE_DESKTOP_IMAGE:-callboard/computer-use-desktop:local}"
name="${COMPUTER_USE_DESKTOP_NAME:-callboard-computer-use-desktop}"
port="${1:-7801}"

docker image inspect "$image" >/dev/null 2>&1 || docker build -t "$image" -f "$here/docker/Dockerfile" "$here"

# The token lives in a file in a private directory, and reaches the container
# as a read-only bind mount: never an environment variable, which `docker
# inspect` and every `docker exec` shell would show. The file itself is
# world-readable (0444) because the container's driver user is not your uid;
# the 0700 directory around it is what keeps it private on this host, and
# inside the container only the driver user can enter its mount directory.
dir="$(mktemp -d "${TMPDIR:-/tmp}/callboard-desktop-XXXXXX")"
chmod 0700 "$dir"
token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
(umask 0333 && printf '%s\n' "$token" > "$dir/token")

# 127.0.0.1 only: the token is the whole authentication, so the port must
# never be reachable from another machine except through an authenticating TLS proxy.
docker run --detach --rm --name "$name" \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
  --tmpfs /home/desktop:rw,nosuid,nodev,size=512m,uid=10001,gid=10001,mode=0755 \
  --cap-drop=ALL --cap-add=SETUID --cap-add=SETGID \
  --security-opt=no-new-privileges \
  --pids-limit=256 --memory=1g --memory-swap=1g --cpus=1 \
  --publish "127.0.0.1:$port:7801" \
  --mount "type=bind,source=$dir/token,target=/run/computer-use/token,readonly" \
  "$image" >/dev/null

echo "Started $name on 127.0.0.1:$port (token file: $dir/token). For Callboard:"
echo "  export CALLBOARD_REMOTE_DESKTOP_URL=http://127.0.0.1:$port"
echo "  export CALLBOARD_REMOTE_DESKTOP_TOKEN_FILE=$dir/token"
echo "Stop it with: docker rm -f $name && rm -r $dir"
