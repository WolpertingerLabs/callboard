/**
 * Settings → Sandbox desktop.
 *
 *   GET  /api/sandbox-desktop        — settings, the mode in force, diagnostics, build state
 *   PUT  /api/sandbox-desktop        — change settings (partial; `null` clears a field)
 *   POST /api/sandbox-desktop/build  — build the image, or with `{ profile }` one profile's image, in the background (explicit only)
 *   DELETE /api/sandbox-desktop/profiles/:name — remove a profile's image
 *
 * Reading is open to any authenticated caller, API keys included. Changing
 * settings, building and removing need a signed-in session, as for every other host
 * setting: an API key may see where sandboxes run, not change it. Both
 * mutations also need a same-origin browser request (`requireControlOrigin`,
 * as for every `/api/computer-use` mutation): they start containers and end
 * live sessions.
 */
import { Router, type Request, type Response } from "express";
import { requireSessionAuth } from "../auth.js";
import { requireControlOrigin } from "./computer-use.js";
import { peekComputerUseHost } from "../services/computer-use.js";
import { currentSandboxMode, removeSandboxProfile, sandboxDesktopStatus, startSandboxBuild } from "../services/sandbox-desktop.js";
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

sandboxDesktopRouter.post("/build", requireSessionAuth, requireControlOrigin, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { profile?: unknown };
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "profile") || (body.profile !== undefined && typeof body.profile !== "string")) {
    res.status(400).json({ error: "The body may only name a profile: { profile?: string }" });
    return;
  }
  try {
    res.status(202).json({ build: startSandboxBuild(body.profile as string | undefined) });
  } catch (error) {
    if ((error as { code?: string }).code === "not_found") {
      res.status(404).json({ error: error instanceof Error ? error.message : "No such profile" });
      return;
    }
    throw error;
  }
});

sandboxDesktopRouter.delete("/profiles/:name", requireSessionAuth, requireControlOrigin, async (req: Request, res: Response) => {
  try {
    const removed = await removeSandboxProfile(String(req.params.name));
    res.json({ removed, status: await sandboxDesktopStatus(true) });
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : "Could not remove the profile's image";
    if (code === "not_found") res.status(404).json({ error: message });
    else if (code === "conflict") res.status(409).json({ error: message });
    else {
      log.warn(`Removing sandbox profile ${String(req.params.name)} failed: ${message}`);
      res.status(409).json({ error: message });
    }
  }
});
