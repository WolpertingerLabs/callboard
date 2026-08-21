/**
 * Engine status API — `GET /api/engines`.
 *
 * Its own route rather than more fields on `/api/system-info`: system-info is
 * polled by several pages and already carries `acpProviders` /
 * `codexConfigured` / `codexAuthSource`, which older browser bundles read and
 * which this feature deliberately does not touch. Engine status runs at a
 * different cadence — it hits the npm registry and the filesystem — so it gets
 * its own route and its own cache.
 *
 * Auth is inherited: `app.use("/api", requireAuth)` runs before this router is
 * mounted, like every other route.
 *
 * @see plans/engine-availability-and-install.md — Phase 1, Decision 3
 */
import { Router } from "express";
import type { Request } from "express";
import type { EngineInstallCapability } from "shared/types/index.js";
import {
  getInstallCapability,
  getInstallRun,
  installRunEvents,
  isInstallRunDone,
  startEngineInstall,
  subscribeToInstallRun,
} from "../services/engine-install.js";
import { getEngineStatuses, refreshEngineStatuses } from "../services/engine-status.js";
import { getClientKey, isDirectLocalClient } from "../utils/client-ip.js";
import { createLogger } from "../utils/logger.js";
import { sendSSE, startSSEHeartbeat, writeSSEHeaders } from "../utils/sse.js";

const log = createLogger("engines-route");

export const enginesRouter = Router();

/**
 * This request's install capability, evaluated per request and never cached with
 * the statuses.
 *
 * It is the same function `POST /:id/install` gates on, which is what makes
 * Decision 8's promise hold in the other direction too: the button appears on a
 * card exactly when pressing it would be allowed, so there is no "offers a
 * button, declines to run it" state to fall out of.
 *
 * Never throws — a preflight that cannot answer is a refusal, and a refusal
 * still renders the copy-and-paste command.
 */
async function capabilityFor(req: Request): Promise<EngineInstallCapability> {
  try {
    return await getInstallCapability({ local: isDirectLocalClient(req) });
  } catch (err) {
    log.warn(`install preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      oneClick: false,
      code: "npm-unresolvable",
      refusal: "Callboard could not check whether it is able to run installs on this machine, so it will not try. Copy the command into a terminal instead.",
    };
  }
}

enginesRouter.get("/", async (req, res) => {
  // #swagger.tags = ['System']
  // #swagger.summary = 'Per-engine runtime, version and credential status'
  // #swagger.description = 'One status per engine Callboard can run a chat on. Reports three orthogonal facts - how the engine reaches this machine (bundled with Callboard, or an external binary on PATH), what version is running against what npm publishes, and whether credentials are configured and from which source. Four of the five engines ship inside the Callboard package, so "installed" alone would say nothing. Best-effort: an offline daemon omits latestVersion rather than failing.'
  /* #swagger.parameters['refresh'] = { in: 'query', required: false, type: 'string', description: 'Set to 1 to bypass the cached npm registry lookup and re-fetch latest versions.' } */
  /* #swagger.responses[200] = { description: 'Engine statuses' } */
  const refresh = req.query.refresh === "1" || req.query.refresh === "true";
  try {
    const engines = await getEngineStatuses({ refresh, capability: await capabilityFor(req) });
    return res.json({ engines });
  } catch (err) {
    // Every probe inside the service is individually guarded, so reaching here
    // means something genuinely unexpected broke. An empty list still renders a
    // page; a 500 on Settings → API does not.
    log.error(`failed to assemble engine statuses: ${err instanceof Error ? err.message : String(err)}`);
    return res.json({ engines: [] });
  }
});

/**
 * `POST /api/engines/refresh` — drop every memoized "is it installed" answer and
 * re-probe.
 *
 * A POST rather than another query flag on the GET because it has a side effect
 * beyond the response: five module-level caches are cleared, and the next chat
 * that starts sees the new resolution too. `?refresh=1` only bypasses the npm
 * registry cache, which is a different and much weaker claim — a user who has
 * just installed `opencode` and presses that gets the same "not installed" back.
 *
 * ## What it costs, stated accurately
 *
 * This introduces no new *kind* of execution: `which`, `<cli> --version` and the
 * Agent SDK's info query all already ran, and installing anything is Phase 3.
 * What it does do — and an earlier version of this comment denied it, claiming
 * the work was "the same … `GET /api/engines` already did" — is convert a
 * once-per-daemon probe into a per-request one, *because* it deletes the caches
 * that made the GET cheap. Measured on the unthrottled version: three GETs, one
 * spawn; three POSTs, four spawns.
 *
 * Two of those spawns are synchronous on a single-threaded server, so the bound
 * on how often this may run is not a nicety. It lives in
 * {@link refreshEngineStatuses} rather than here, so it applies to every caller
 * and is unit-testable without a router.
 */
enginesRouter.post("/refresh", async (req, res) => {
  // #swagger.tags = ['System']
  // #swagger.summary = 'Re-probe every engine, ignoring cached lookups'
  // #swagger.description = 'Clears the process-lifetime caches that memoize where each engine binary resolved (ACP PATH lookups and version probes, the Claude Code executable path handed to the Agent SDK, the separate claude binary lookup used by the login prompt, and the cached Agent SDK account info), then re-assembles every engine status with a fresh npm registry fetch. This is what makes an engine a user just installed - or a login they just completed - visible without restarting the daemon. Installs nothing. Rate-limited to one real probe every 10 seconds; inside that window the cached statuses are returned with probed:false.'
  /* #swagger.responses[200] = { description: 'Engine statuses, with probed:false when the call was coalesced or throttled' } */
  try {
    const { engines, probed, retryAfterMs } = await refreshEngineStatuses({ capability: await capabilityFor(req) });
    return res.json({ engines, probed, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  } catch (err) {
    // Every probe inside the service is individually guarded, so reaching here
    // means something genuinely unexpected broke. An empty list still renders a
    // page; a 500 on Settings -> API does not. `probed` is reported honestly:
    // whatever happened, the caller did not get a fresh answer.
    log.error(`failed to re-probe engine statuses: ${err instanceof Error ? err.message : String(err)}`);
    return res.json({ engines: [], probed: false });
  }
});

/**
 * `POST /api/engines/:id/install` — run this engine's `npm-global` recipe here.
 *
 * The only endpoint in Callboard that executes a command on a user's request,
 * and the reasoning for every one of its gates is in
 * `services/engine-install.ts`. What matters at this layer:
 *
 * - **`:id` is a selector, never an ingredient.** It picks a recipe out of a
 *   frozen registry; the argv that runs is that recipe's own literal array. No
 *   part of the request reaches a command line, and there is no shell.
 * - **The gate is shared with the card.** {@link capabilityFor} is the same
 *   function `GET /` used to decide whether to offer a button, so a client that
 *   can see the button can press it, and a client that cannot see one is never
 *   left wondering why it did not work.
 * - **Every refusal is a sentence.** The `refusal` field is written for the
 *   card, which renders it directly beneath the copy-and-paste command that was
 *   there all along.
 */
enginesRouter.post("/:id/install", async (req, res) => {
  // #swagger.tags = ['System']
  // #swagger.summary = 'Install an engine CLI from its recipe, and stream the output'
  // #swagger.description = 'Runs the npm-global install recipe registered for this engine id and returns an installId to stream. The engine id selects a recipe from a closed, static registry; nothing from the request reaches the command line and no shell is used. Refused - with a one-line reason for the UI to render next to the copy-and-paste command - for clients outside the LAN, when allowEngineInstalls is off, on Windows, when npm global prefix is missing or not writable, when another install is running, and for engines whose only install path is a vendor script. One install at a time, process-wide.'
  /* #swagger.responses[200] = { description: 'Install started' } */
  /* #swagger.responses[403] = { description: 'Refused: not a local client, or the capability is switched off' } */
  /* #swagger.responses[404] = { description: 'Refused: no runnable recipe for this engine' } */
  /* #swagger.responses[409] = { description: 'Refused: another install is already running' } */
  /* #swagger.responses[422] = { description: 'Refused: npm preflight failed (unresolvable or non-writable global prefix)' } */
  const engineId = String(req.params.id ?? "");
  const result = startEngineInstall({
    engineId,
    capability: await capabilityFor(req),
    clientKey: getClientKey(req),
  });

  if (!result.ok) {
    // `error` and `refusal` carry the same sentence on purpose: `error` is what
    // the frontend's generic `assertOk` surfaces, and `refusal` is what a client
    // that knows about this endpoint renders under the copy block. Neither
    // caller should have to reach for the other's field.
    return res.status(result.status).json({ error: result.refusal, refusal: result.refusal, code: result.code });
  }

  return res.json({ installId: result.installId, engineId: result.engineId, package: result.package, command: result.command });
});

/**
 * `GET /api/engines/installs/:installId/stream` — the install's output, live.
 *
 * Replays everything the run has emitted so far and then follows it, so a client
 * that connects a beat after the POST (or reconnects after a reload) sees the
 * whole transcript rather than the tail. Terminates itself on the run's last
 * event, which is `install_verified` after a zero exit and `install_exit`
 * otherwise.
 *
 * Gated on client scope like the POST: the output names paths on the daemon's
 * filesystem, and there is no reason a tunnelled client — who could not have
 * started this — should read it.
 */
enginesRouter.get("/installs/:installId/stream", (req, res) => {
  // #swagger.tags = ['System']
  // #swagger.summary = 'Stream one engine install: output lines, exit, and the re-probed status'
  // #swagger.description = 'Server-sent events for an install started by POST /api/engines/:id/install. Emits install_started, then install_output per line of stdout/stderr, then a terminal event. A non-zero exit ends at install_exit with a one-line refusal. A zero exit emits install_exit with no verdict, then install_verified once the server has re-probed - only that last event may say an engine is installed, because npm exiting 0 does not mean the daemon can see the binary. Replays the transcript from the start on connect. LAN clients only.'
  /* #swagger.responses[200] = { description: 'SSE stream' } */
  /* #swagger.responses[403] = { description: 'Not a local client' } */
  /* #swagger.responses[404] = { description: 'No such install, or it has aged out' } */
  if (!isDirectLocalClient(req)) {
    return res.status(403).json({
      error: "Install output is only available to clients on the local network.",
      refusal: "Install output is only available to clients on the local network.",
      code: "not-local",
    });
  }

  const run = getInstallRun(String(req.params.installId ?? ""));
  if (!run) {
    return res.status(404).json({
      error: "No such install — it finished a while ago, or a newer one replaced it.",
      refusal: "Callboard is no longer holding that install's output. Press Recheck to see where the engine stands now.",
      code: "no-recipe",
    });
  }

  writeSSEHeaders(res);
  const stopHeartbeat = startSSEHeartbeat(res);

  // Declared before `finish` because `finish` may run before anything has been
  // subscribed — a run that is already done replays and closes immediately, and
  // a `const` read from that path would be a temporal-dead-zone throw inside a
  // response that has already sent headers.
  let unsubscribe: (() => void) | null = null;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    unsubscribe?.();
    res.end();
  };

  // Replay, then subscribe — synchronously, with nothing awaited in between, so
  // an event emitted by the child process cannot slip through the gap.
  for (const event of installRunEvents(run)) sendSSE(res, { ...event });
  if (isInstallRunDone(run)) {
    finish();
    return;
  }

  unsubscribe = subscribeToInstallRun(run, (event) => {
    if (closed) return;
    sendSSE(res, { ...event });
    // `install_verified` always follows a zero exit, so a successful run's
    // terminal frame is that one; a failure's is the exit itself.
    if (event.type === "install_verified" || (event.type === "install_exit" && !event.ok)) finish();
  });

  req.on("close", finish);
});
