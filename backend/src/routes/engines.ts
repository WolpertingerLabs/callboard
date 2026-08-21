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
import { getEngineStatuses } from "../services/engine-status.js";
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
