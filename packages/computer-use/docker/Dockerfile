# Remote desktop target for computer use: Xvfb + icewm + xterm, driven by
# computer-use-driver-host. Build from packages/computer-use:
#
#   docker build -t callboard/computer-use-desktop:local -f docker/Dockerfile .
#
# Run with the port published on loopback ONLY (see docker/run.sh). The token
# authorizes full control of this desktop; never publish it on 0.0.0.0.

FROM node:22-bookworm-slim AS build
WORKDIR /pkg
COPY package.json tsconfig.json ./
COPY src ./src
# No lockfile ships with the package. Playwright is installed only so the
# browser driver type-checks (--ignore-scripts: no browser is downloaded),
# then pruned: the image never runs a browser driver.
RUN npm install --ignore-scripts --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev --omit=optional --no-audit --no-fund

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb xdotool imagemagick icewm xterm x11-utils x11-xserver-utils xfonts-base fonts-dejavu-core tini \
 && rm -rf /var/lib/apt/lists/* \
 && test -x /usr/bin/xdotool && test -x /usr/bin/import \
 # Xvfb runs unprivileged; its socket directory must exist and be root-owned.
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Two unprivileged users. `desktop` owns the X session and every app on it.
# `driver` runs the driver host and alone holds the bearer token, so nothing
# launched on the desktop can read it from the host process's environment.
RUN useradd --create-home --uid 10001 --shell /bin/bash desktop \
 && useradd --create-home --uid 10002 --shell /usr/sbin/nologin driver \
 && mkdir -p /home/desktop/outbox /home/desktop/.icewm \
 # No taskbar: one terminal is the whole test target, and no clock keeps frames stable.
 && printf 'ShowTaskBar=0\n' > /home/desktop/.icewm/preferences \
 && chown -R desktop:desktop /home/desktop/outbox /home/desktop/.icewm \
 && chmod 0755 /home/desktop /home/desktop/outbox

COPY --from=build /pkg/package.json /opt/computer-use/package.json
COPY --from=build /pkg/dist /opt/computer-use/dist
COPY --from=build /pkg/node_modules /opt/computer-use/node_modules
COPY docker/start-desktop.sh /usr/local/bin/start-desktop.sh
RUN chmod 0755 /usr/local/bin/start-desktop.sh

ENV COMPUTER_USE_DISPLAY=:99 \
    COMPUTER_USE_SCREEN=1280x800x24 \
    COMPUTER_USE_HOST_LISTEN=0.0.0.0 \
    COMPUTER_USE_HOST_PORT=7801 \
    COMPUTER_USE_OUTBOX=/home/desktop/outbox \
    # The native driver insists on explicit full-desktop acknowledgement and
    # all four scopes on allow, because X11 cannot confine the apps it drives.
    # Inside this container that is correct: the container is the boundary
    # (its filesystem, processes and network), and authorization lives in the
    # Callboard ComputerUseService that connects to the driver host.
    COMPUTER_USE_ACKNOWLEDGE_FULL_DESKTOP_ACCESS=1

EXPOSE 7801
# The entrypoint starts as root only to start each process as its own
# unprivileged user; nothing keeps running as root except tini.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-desktop.sh"]
