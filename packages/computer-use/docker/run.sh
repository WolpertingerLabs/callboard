#!/bin/sh
# Build (if needed) and run the remote desktop container on loopback only,
# then print the two Callboard environment variables to use.
#
#   packages/computer-use/docker/run.sh [host-port]
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
image="${COMPUTER_USE_DESKTOP_IMAGE:-callboard/computer-use-desktop:local}"
name="${COMPUTER_USE_DESKTOP_NAME:-callboard-computer-use-desktop}"
port="${1:-7801}"
token="${COMPUTER_USE_HOST_TOKEN:-$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')}"

docker image inspect "$image" >/dev/null 2>&1 || docker build -t "$image" -f "$here/docker/Dockerfile" "$here"
# 127.0.0.1 only: the token is the whole authentication, so the port must
# never be reachable from another machine except through an authenticating TLS proxy.
COMPUTER_USE_HOST_TOKEN="$token" docker run -d --rm --name "$name" \
  -p "127.0.0.1:$port:7801" -e COMPUTER_USE_HOST_TOKEN "$image" >/dev/null

echo "Started $name on 127.0.0.1:$port. For Callboard:"
echo "  export CALLBOARD_REMOTE_DESKTOP_URL=http://127.0.0.1:$port"
echo "  export CALLBOARD_REMOTE_DESKTOP_TOKEN=$token"
echo "Stop it with: docker rm -f $name"
