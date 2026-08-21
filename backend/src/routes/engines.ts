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
import { getEngineStatuses, refreshEngineStatuses } from "../services/engine-status.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("engines-route");

export const enginesRouter = Router();

enginesRouter.get("/", async (req, res) => {
  // #swagger.tags = ['System']
  // #swagger.summary = 'Per-engine runtime, version and credential status'
  // #swagger.description = 'One status per engine Callboard can run a chat on. Reports three orthogonal facts - how the engine reaches this machine (bundled with Callboard, or an external binary on PATH), what version is running against what npm publishes, and whether credentials are configured and from which source. Four of the five engines ship inside the Callboard package, so "installed" alone would say nothing. Best-effort: an offline daemon omits latestVersion rather than failing.'
  /* #swagger.parameters['refresh'] = { in: 'query', required: false, type: 'string', description: 'Set to 1 to bypass the cached npm registry lookup and re-fetch latest versions.' } */
  /* #swagger.responses[200] = { description: 'Engine statuses' } */
  const refresh = req.query.refresh === "1" || req.query.refresh === "true";
  try {
    const engines = await getEngineStatuses({ refresh });
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
enginesRouter.post("/refresh", async (_req, res) => {
  // #swagger.tags = ['System']
  // #swagger.summary = 'Re-probe every engine, ignoring cached lookups'
  // #swagger.description = 'Clears the process-lifetime caches that memoize where each engine binary resolved (ACP PATH lookups and version probes, the Claude Code executable path handed to the Agent SDK, the separate claude binary lookup used by the login prompt, and the cached Agent SDK account info), then re-assembles every engine status with a fresh npm registry fetch. This is what makes an engine a user just installed - or a login they just completed - visible without restarting the daemon. Installs nothing. Rate-limited to one real probe every 10 seconds; inside that window the cached statuses are returned with probed:false.'
  /* #swagger.responses[200] = { description: 'Engine statuses, with probed:false when the call was coalesced or throttled' } */
  try {
    const { engines, probed, retryAfterMs } = await refreshEngineStatuses();
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
