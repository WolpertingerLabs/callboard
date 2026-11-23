# Sandbox desktop for computer use: Xvfb + icewm + xterm, driven by
# computer-use-driver-host. Build from packages/computer-use, after `npm run
# build` (the image takes the compiled dist/, so the same context works from a
# source checkout and from an npm-installed Callboard, which ships dist/ and
# docker/ but not src/):
#
#   docker build -t callboard/computer-use-desktop:local -f docker/Dockerfile .
#
# or `callboard sandbox build`, which does exactly that. Only package.json,
# dist/ and docker/ are sent to the daemon (.dockerignore).
#
# Run it with the hardened flags in docker/run.sh (or sandboxRunArgs() from the
# package): read-only root, tmpfs home and /tmp, no capabilities but SETUID and
# SETGID, no-new-privileges, pid/memory/CPU limits, the token as a read-only
# file mount, and the port on 127.0.0.1 only.

# Pinned by digest: node:22-bookworm-slim as of 2026-11-23. Bump deliberately.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM ${NODE_IMAGE} AS build
WORKDIR /pkg
# docker/package-lock.json is this package's own lockfile (the repository's root
# lockfile covers the whole workspace), pinned to the versions Callboard runs.
# Only the runtime dependencies are installed (no TypeScript, no Playwright):
# the code is already compiled.
COPY package.json ./
COPY docker/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
COPY dist ./dist
# Fails the build, rather than the first sandbox, if dist/ was never built.
RUN test -f dist/driver-host-cli.js

FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb xdotool imagemagick icewm xterm x11-xserver-utils fonts-dejavu-core fonts-wqy-microhei tini \
 # The dependency closure drags in things this headless, GL-less desktop never
 # loads; purged deliberately (about 250 MB), and verified by the Docker test.
 # --force-depends leaves apt's dependency state broken ON PURPOSE: nothing
 # installs packages at runtime (npm and apt lists are gone too), and a later
 # `apt-get install` in a derived image must start by `apt-get -f install`.
 #  - mesa's DRI drivers + LLVM + z3: Xvfb's optional GLX loader. Without them
 #    Xvfb runs without GLX, which xdotool, import, icewm and xterm don't use.
 #  - cpp: needed only by xrdb in x11-xserver-utils; we use xhost alone.
 #  - Ghostscript, its fonts and poppler-data: imlib2's PostScript loader (via icewm).
 && purged="libgl1-mesa-dri libllvm15 libz3-4 cpp cpp-12 libspectre1 libgs10 libgs10-common fonts-urw-base35 poppler-data" \
 && dpkg --purge --force-depends $purged \
 && for p in $purged; do if dpkg -s "$p" >/dev/null 2>&1; then echo "still installed: $p" >&2; exit 1; fi; done \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man \
 # The runtime never installs packages: drop npm, npx and corepack.
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && test -x /usr/bin/xdotool && test -x /usr/bin/import \
 # No setuid/setgid programs (su, mount, passwd, …). no-new-privileges already
 # makes them inert; without the bits there is nothing to make inert.
 && find / -xdev -type f -perm /6000 -exec chmod ug-s {} + \
 && test -z "$(find / -xdev -type f -perm /6000 -print -quit)" \
 # Xvfb runs unprivileged; its socket directory must be root-owned (it is
 # recreated on the /tmp tmpfs at start, too).
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Two unprivileged users. `desktop` owns the X session and every app on it.
# `driver` runs the driver host and alone can reach the token, whose mount
# point sits in a directory only `driver` may enter.
RUN useradd --create-home --uid 10001 --shell /bin/bash desktop \
 && useradd --no-create-home --home-dir /nonexistent --uid 10002 --shell /usr/sbin/nologin driver \
 && chmod 0755 /home/desktop \
 && mkdir -p /run/computer-use \
 && chown root:driver /run/computer-use \
 && chmod 0750 /run/computer-use

COPY --from=build /pkg/package.json /opt/computer-use/package.json
COPY --from=build /pkg/dist /opt/computer-use/dist
# The driver host loads only zod (driver-host-cli → native driver, remote host;
# never the MCP server or the browser driver), so only zod ships. The Docker
# test fails at startup if that ever stops being true.
COPY --from=build /pkg/node_modules/zod /opt/computer-use/node_modules/zod
COPY docker/start-desktop.sh /usr/local/bin/start-desktop.sh
RUN chmod 0755 /usr/local/bin/start-desktop.sh

ENV COMPUTER_USE_DISPLAY=:99 \
    COMPUTER_USE_SCREEN=1280x800x24 \
    COMPUTER_USE_HOST_LISTEN=0.0.0.0 \
    COMPUTER_USE_HOST_PORT=7801 \
    COMPUTER_USE_HOST_TOKEN_FILE=/run/computer-use/token \
    COMPUTER_USE_OUTBOX=/home/desktop/outbox \
    # The native driver insists on explicit full-desktop acknowledgement and
    # all four scopes on allow, because X11 cannot confine the apps it drives.
    # Inside this container that is correct: the container is the boundary
    # (its filesystem, processes and network), and authorization lives in the
    # Callboard ComputerUseService that connects to the driver host.
    COMPUTER_USE_ACKNOWLEDGE_FULL_DESKTOP_ACCESS=1

# For a host to check before `docker run` (SANDBOX_IMAGE_LABELS in the package).
# A unit test keeps these in step with package.json and PROTOCOL.
LABEL org.opencontainers.image.title="callboard-computer-use-desktop" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.source="https://github.com/WolpertingerLabs/callboard" \
      org.opencontainers.image.licenses="MIT" \
      dev.callboard.computer-use.protocol="2.0"

EXPOSE 7801
# Starts as root only to split the desktop and the driver host into their two
# users, then execs into tini as `driver`; see start-desktop.sh.
ENTRYPOINT ["/usr/local/bin/start-desktop.sh"]
