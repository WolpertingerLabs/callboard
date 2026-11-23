#!/usr/bin/env node
/**
 * computer-use-driver-host: serve this machine's X11 desktop to ONE remote
 * `ComputerUseService` over authenticated HTTP. Built for the container image
 * in `docker/`; see the README's "Remote desktop container" section.
 *
 * Environment (all read once, at startup):
 *   COMPUTER_USE_HOST_TOKEN                        required, >= 32 chars
 *   COMPUTER_USE_DISPLAY                           X11 display, e.g. ":99"
 *   COMPUTER_USE_ACKNOWLEDGE_FULL_DESKTOP_ACCESS   must be "1"
 *   COMPUTER_USE_HOST_LISTEN                       bind address (default 127.0.0.1)
 *   COMPUTER_USE_HOST_PORT                         port (default 7801)
 *   COMPUTER_USE_OUTBOX                            outbox directory (optional)
 */
import { createNativeDesktopDriver } from "./drivers/native.js";
import { createDriverHost } from "./remote/host.js";

async function main() {
  const token = process.env.COMPUTER_USE_HOST_TOKEN ?? "";
  // Keep the token out of every child process (xdotool, import) and out of anything they spawn.
  delete process.env.COMPUTER_USE_HOST_TOKEN;
  if (!token) {
    process.stderr.write("computer-use-driver-host: COMPUTER_USE_HOST_TOKEN is not set; refusing to start without authentication\n");
    process.exit(2);
  }
  const acknowledged = process.env.COMPUTER_USE_ACKNOWLEDGE_FULL_DESKTOP_ACCESS === "1";
  if (!acknowledged) {
    process.stderr.write(
      "computer-use-driver-host: set COMPUTER_USE_ACKNOWLEDGE_FULL_DESKTOP_ACCESS=1 to serve the whole X11 desktop; run it only where that desktop is the boundary (a container)\n",
    );
    process.exit(2);
  }
  // X11 cannot confine applications, so the native driver only runs with every
  // scope on allow and full-desktop access acknowledged. That is the honest
  // setting here because this host is meant to run inside a container, and the
  // container — its filesystem, processes and network — is the boundary, not
  // these flags. Who may drive it, and when, is decided by the remote
  // ComputerUseService, not here.
  const driver = createNativeDesktopDriver({
    enabled: true,
    display: process.env.COMPUTER_USE_DISPLAY,
    acknowledgeFullDesktopAccess: true,
    permissions: { webAccess: "allow", fileRead: "allow", fileWrite: "allow", codeExecution: "allow" },
  });
  const host = createDriverHost({ driver, token, outboxDir: process.env.COMPUTER_USE_OUTBOX || undefined });
  const listen = process.env.COMPUTER_USE_HOST_LISTEN || "127.0.0.1";
  const port = await host.listen(Number(process.env.COMPUTER_USE_HOST_PORT || 7801), listen);
  process.stderr.write(`computer-use-driver-host: listening on ${listen}:${port} (instance ${host.identity.instanceId})\n`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => process.exit(1), 5000);
    timer.unref();
    await host.close().catch(() => {});
    clearTimeout(timer);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}
main().catch((error) => {
  process.stderr.write(`computer-use-driver-host: startup failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
