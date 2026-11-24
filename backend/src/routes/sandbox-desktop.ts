/**
 * Settings → Sandbox desktop.
 *
 *   GET  /api/sandbox-desktop        — settings, the mode in force, diagnostics, build state
 *   PUT  /api/sandbox-desktop        — change settings (partial; `null` clears a field)
 *   POST /api/sandbox-desktop/build  — build the image, in the background (explicit only)
 *
 * Reading is open to any authenticated caller, API keys included. Changing
 * settings and building need a signed-in session, as for every other host
 * setting: an API key may see where sandboxes run, not change it. Both
 * mutations also need a same-origin browser request (`requireControlOrigin`,
 * as for every `/api/computer-use` mutation): they start containers and end
 * live sessions.
 */
import { Router, type Request, type Response } from "express";
import { requireSessionAuth } from "../auth.js";
import { requireControlOrigin } from "./computer-use.js";
import { peekComputerUseHost } from "../services/computer-use.js";
import { currentSandboxMode, sandboxDesktopStatus, startSandboxBuild } from "../services/sandbox-desktop.js";
import { SandboxSettingsError, updateSandboxSettings } from "../services/sandbox-desktop-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("sandbox-desktop-routes");

export const sandboxDesktopRouter = Router();

const canEdit = (res: Response) => res.locals.authMethod === "session";

sandboxDesktopRouter.get("/", async (_req: Request, res: Response) => {
  try {
    res.json(await sandboxDesktopStatus(canEdit(res)));
  } catch (error) {
    log.warn(`Sandbox desktop status failed: ${error instanceof Error ? error.message : "unknown"}`);
    res.status(500).json({ error: "Could not read the sandbox desktop status" });
  }
});

sandboxDesktopRouter.put("/", requireSessionAuth, requireControlOrigin, async (req: Request, res: Response) => {
  const before = currentSandboxMode().mode;
  try {
    updateSandboxSettings(req.body);
  } catch (error) {
    if (error instanceof SandboxSettingsError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
  const after = currentSandboxMode().mode;
  // A session belongs to the mode it opened under: a container of the old
  // mode must not outlive the switch, and a consent asked under one mode
  // cannot open under another (its identity no longer matches).
  if (before !== after) {
    const host = peekComputerUseHost();
    const revoked = host ? await (await host).revokeTarget("sandbox") : 0;
    log.info(`Sandbox desktop mode changed from ${before} to ${after}${revoked ? `; ended ${revoked} live sandbox session(s)` : ""}`);
  }
  res.json(await sandboxDesktopStatus(true));
});

sandboxDesktopRouter.post("/build", requireSessionAuth, requireControlOrigin, (_req: Request, res: Response) => {
  res.status(202).json({ build: startSandboxBuild() });
});
