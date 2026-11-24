/**
 * Settings → Sandbox desktop.
 *
 *   GET  /api/sandbox-desktop        — settings, the mode in force, diagnostics, build state
 *   PUT  /api/sandbox-desktop        — change settings (partial; `null` clears a field)
 *   POST /api/sandbox-desktop/build  — queue a build of the image, or with `{ profile, scope? }` one profile's image (explicit only); returns its record
 *   GET  /api/sandbox-desktop/builds — recent builds, newest first
 *   GET  /api/sandbox-desktop/builds/:id — one build, with the tail of its log (`?tail=` characters, default 64 KB)
 *   GET  /api/sandbox-desktop/builds/:id/log — its whole (capped) log, as text
 *   POST /api/sandbox-desktop/builds/:id/cancel — cancel a queued or running build
 *   DELETE /api/sandbox-desktop/profiles/:name?scope= — remove a profile's image (scope default `global`)
 *   GET  /api/sandbox-desktop/agent-profiles — every stored agent-built profile, with its versions (no recipes)
 *   GET  /api/sandbox-desktop/agent-profiles/:name?scope= — one, with every version's recipe (the history)
 *   POST /api/sandbox-desktop/agent-profiles/:name/promote?scope= — make it global (and queue its global build)
 *   DELETE /api/sandbox-desktop/agent-profiles/:name?scope= — forget it: its versions and its image
 *
 * Agent-built profiles are proposed by agents (`sandbox_profile_propose`)
 * and approved build by build in the chat; everything a human does to one
 * afterwards — promote, remove, rebuild (`POST /build`) — is here, behind a
 * signed-in session and a same-origin request. No agent tool reaches these.
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
import { getSandboxProfileProposals } from "../services/computer-use.js";
import {
  agentProfileDetail,
  agentProfileSummaries,
  buildDto,
  cancelSandboxBuild,
  promoteAgentProfile,
  removeAgentProfile,
  currentSandboxMode,
  getSandboxBuilds,
  removeSandboxProfile,
  sandboxBuild,
  sandboxDesktopStatus,
  startSandboxBuild,
} from "../services/sandbox-desktop.js";
import { entryIdOf } from "../services/sandbox-profiles.js";
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
  const body = (req.body ?? {}) as { profile?: unknown; scope?: unknown };
  if (Object.keys(body).some((key) => key !== "profile" && key !== "scope") || (body.scope !== undefined && body.profile === undefined)) {
    res.status(400).json({ error: "The body may only name a profile: { profile?: string, scope?: string }" });
    return;
  }
  const id = body.profile === undefined ? undefined : entryIdOf(body.profile, body.scope ?? "global");
  if (body.profile !== undefined && !id) {
    res.status(400).json({ error: "Invalid profile name or scope" });
    return;
  }
  try {
    const build = startSandboxBuild(id);
    res.status(202).json({ build, id: build.id });
  } catch (error) {
    if ((error as { code?: string }).code === "not_found") {
      res.status(404).json({ error: error instanceof Error ? error.message : "No such profile" });
      return;
    }
    throw error;
  }
});

sandboxDesktopRouter.get("/builds", (_req: Request, res: Response) => {
  res.json({
    builds: getSandboxBuilds()
      .list()
      .map((record) => buildDto(record)),
  });
});

sandboxDesktopRouter.get("/builds/:id", (req: Request, res: Response) => {
  const tail = Number(req.query.tail ?? 64 * 1024);
  const build = sandboxBuild(String(req.params.id), Number.isInteger(tail) && tail > 0 ? tail : 64 * 1024);
  if (!build) res.status(404).json({ error: "No such build" });
  else res.json({ build });
});

sandboxDesktopRouter.get("/builds/:id/log", (req: Request, res: Response) => {
  const log = getSandboxBuilds().log(String(req.params.id));
  if (log === undefined) res.status(404).json({ error: "No such build" });
  else res.type("text/plain").send(log);
});

sandboxDesktopRouter.post("/builds/:id/cancel", requireSessionAuth, requireControlOrigin, (req: Request, res: Response) => {
  const build = cancelSandboxBuild(String(req.params.id));
  if (!build) res.status(404).json({ error: "No such build" });
  else res.json({ build });
});

sandboxDesktopRouter.delete("/profiles/:name", requireSessionAuth, requireControlOrigin, async (req: Request, res: Response) => {
  const id = entryIdOf(String(req.params.name), req.query.scope ?? "global");
  if (!id) {
    res.status(400).json({ error: "Invalid profile name or scope" });
    return;
  }
  try {
    const removed = await removeSandboxProfile(id);
    res.json({ removed, status: await sandboxDesktopStatus(true) });
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : "Could not remove the profile's image";
    if (code === "not_found") res.status(404).json({ error: message });
    else {
      if (code !== "conflict") log.warn(`Removing sandbox profile ${id} failed: ${message}`);
      res.status(409).json({ error: message });
    }
  }
});

/** A route's agent-profile id from `:name` and `?scope=` (default `global`), or a 400. */
function agentProfileId(req: Request, res: Response): string | undefined {
  const id = entryIdOf(String(req.params.name), req.query.scope ?? "global");
  if (!id) res.status(400).json({ error: "Invalid profile name or scope" });
  return id;
}
function sendProfileError(res: Response, error: unknown, what: string): void {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : `Could not ${what}`;
  if (code === "not_found") res.status(404).json({ error: message });
  else if (code === "conflict" || code === "invalid_request") res.status(code === "conflict" ? 409 : 400).json({ error: message });
  else {
    log.warn(`Could not ${what}: ${message}`);
    res.status(409).json({ error: message });
  }
}

sandboxDesktopRouter.get("/agent-profiles", (_req: Request, res: Response) => {
  res.json({ profiles: agentProfileSummaries() });
});

sandboxDesktopRouter.get("/agent-profiles/:name", (req: Request, res: Response) => {
  const id = agentProfileId(req, res);
  if (!id) return;
  try {
    res.json({ profile: agentProfileDetail(id) });
  } catch (error) {
    sendProfileError(res, error, "read that profile");
  }
});

sandboxDesktopRouter.post("/agent-profiles/:name/promote", requireSessionAuth, requireControlOrigin, async (req: Request, res: Response) => {
  const id = agentProfileId(req, res);
  if (!id) return;
  try {
    // Its open cards are visible to the promotion check only once the manager exists.
    getSandboxProfileProposals();
    const { profile, build } = await promoteAgentProfile(id);
    res.json({ profile, build, status: await sandboxDesktopStatus(true) });
  } catch (error) {
    sendProfileError(res, error, `promote ${id}`);
  }
});

sandboxDesktopRouter.delete("/agent-profiles/:name", requireSessionAuth, requireControlOrigin, async (req: Request, res: Response) => {
  const id = agentProfileId(req, res);
  if (!id) return;
  try {
    getSandboxProfileProposals();
    const result = await removeAgentProfile(id);
    res.json({ ...result, status: await sandboxDesktopStatus(true) });
  } catch (error) {
    sendProfileError(res, error, `remove ${id}`);
  }
});
