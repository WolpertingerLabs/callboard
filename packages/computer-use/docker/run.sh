#!/bin/sh
# Build (if needed) and run the sandbox desktop with the hardened flags, then
# print the two Callboard environment variables to use.
#
#   packages/computer-use/docker/run.sh [host-port]
#
# From a source checkout after `npm run build`, or an installed package (the
# Dockerfile takes the compiled dist/). Callboard users: `callboard sandbox build`
# builds the image, and Callboard starts and stops containers itself.
# COMPUTER_USE_DESKTOP_REBUILD=1 rebuilds an existing :local image, e.g. after
# pulling changes; `docker rmi callboard/computer-use-desktop:local` removes it.
#
# The flags mirror sandboxRunArgs() in src/remote/sandbox.ts, which is the
# authoritative list (test/sandbox.test.mjs keeps the two in step), and the
# network setup mirrors ensureSandboxNetwork().
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
image="${COMPUTER_USE_DESKTOP_IMAGE:-callboard/computer-use-desktop:local}"
name="${COMPUTER_USE_DESKTOP_NAME:-callboard-computer-use-desktop}"
network="${COMPUTER_USE_DESKTOP_NETWORK:-callboard-sandbox}"
port="${1:-7801}"

if [ "${COMPUTER_USE_DESKTOP_REBUILD:-}" = 1 ] || ! docker image inspect "$image" >/dev/null 2>&1; then
  # The image is built from the compiled package, not from src/.
  if [ ! -f "$here/dist/driver-host-cli.js" ]; then
    echo "run.sh: $here/dist is not built; run \`npm run build\` in $here first" >&2
    exit 1
  fi
  docker build -t "$image" -f "$here/docker/Dockerfile" "$here"
fi

# A bridge network with inter-container communication disabled, so nothing
# else on it can reach the driver host. Refuse one that exists without that.
if ! docker network inspect "$network" >/dev/null 2>&1; then
  docker network create --driver bridge --opt com.docker.network.bridge.enable_icc=false \
    --label dev.callboard.sandbox-network=1 "$network" >/dev/null
fi
if [ "$(docker network inspect -f '{{.Driver}} {{index .Options "com.docker.network.bridge.enable_icc"}}' "$network")" != "bridge false" ]; then
  echo "run.sh: network $network exists but is not a bridge with inter-container communication disabled; remove it or set COMPUTER_USE_DESKTOP_NETWORK" >&2
  exit 1
fi

# The token lives in a file in a private directory, and reaches the container
# as a read-only bind mount: never an environment variable, which `docker
# inspect` and every `docker exec` shell would show. The file itself is
# world-readable (0444) because the container's driver user is not your uid;
# the 0700 directory around it is what keeps it private on this host, and
# inside the container only the driver user can enter its mount directory.
dir="$(mktemp -d "${TMPDIR:-/tmp}/callboard-desktop-XXXXXX")"
# Remove the token if anything below fails; kept once the container is running.
trap 'rm -rf "$dir"' EXIT
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
  --network="$network" \
  --publish "127.0.0.1:$port:7801" \
  --mount "type=bind,source=$dir/token,target=/run/computer-use/token,readonly" \
  "$image" >/dev/null
trap - EXIT

echo "Started $name on 127.0.0.1:$port (network $network, token file: $dir/token). For Callboard:"
echo "  export CALLBOARD_SANDBOX_DESKTOP_URL=http://127.0.0.1:$port"
echo "  export CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE=$dir/token"
echo "Stop it with: docker rm -f $name && rm -r $dir"
echo "Remove the image with: docker rmi $image (and the network with: docker network rm $network)"
