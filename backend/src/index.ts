import dotenv from "dotenv";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// Package root — resolved from backend/dist/index.js (or backend/src/index.ts via tsx).
// Works both in local dev (monorepo root) and global npm install (package root).
const __pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Load .env: ~/.callboard/.env is the base config, then the project-root .env
// overrides it. This lets local dev runs use a local .env to override
// the global ~/.callboard config (e.g. different ports, passwords, log levels).
import { ENV_FILE, ensureDataDir, ensureEnvFile, ensureInstanceName, isValidIgnoredPrefix } from "./utils/paths.js";
ensureDataDir();
const __isFirstRun = ensureEnvFile();
migrateDrawlatchDirs();
migrateKeyDirectories();
if (existsSync(ENV_FILE)) {
  dotenv.config({ path: ENV_FILE, override: true });
}
{
  const rootEnv = path.join(__pkgRoot, ".env");
  if (existsSync(rootEnv)) {
    // override: true — project-root .env takes priority over ~/.callboard/.env
    const result = dotenv.config({ path: rootEnv, override: true });
    if (result.parsed && Object.keys(result.parsed).length > 0 && __isFirstRun) {
      console.warn(`[callboard] Loaded .env from project root (overrides ${ENV_FILE}).`);
    }
  }
}
// Ensure instance name exists in .env (generates one on first run)
ensureInstanceName();

import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { getClientKey } from "./utils/client-ip.js";
import { chatsRouter } from "./routes/chats.js";
import { streamRouter } from "./routes/stream.js";
import { imagesRouter } from "./routes/images.js";
import { queueRouter } from "./routes/queue.js";
import { foldersRouter } from "./routes/folders.js";
import { gitRouter } from "./routes/git.js";
import { appPluginsRouter } from "./routes/app-plugins.js";
import { agentsRouter } from "./routes/agents.js";
import { agentSettingsRouter } from "./routes/agent-settings.js";
import { proxyRouter } from "./routes/proxy.js";
import { sessionsRouter } from "./routes/sessions.js";
import { themesRouter } from "./routes/themes.js";
import { customSkillsRouter } from "./routes/custom-skills.js";
import { keywordsRouter } from "./routes/keywords.js";
import { filesRouter } from "./routes/files.js";
import { canvasRouter } from "./routes/canvas.js";
import { mcpToolsRouter } from "./routes/mcp-tools.js";
import { openRouterRouter } from "./routes/openrouter.js";
import { codexRouter } from "./routes/codex.js";
import { acpRouter } from "./routes/acp.js";
import { clineRouter } from "./routes/cline.js";
import { piRouter } from "./routes/pi.js";
import { enginesRouter } from "./routes/engines.js";
import { selfUpdateRouter } from "./routes/self-update.js";
import { jobsRouter } from "./routes/jobs.js";
import { cardsRouter } from "./routes/cards.js";
import { apiKeysRouter } from "./routes/api-keys.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { loginHandler, logoutHandler, checkAuthHandler, requireAllowedIp, requireAuth, changePasswordHandler } from "./auth.js";
import { createLogger } from "./utils/logger.js";
import { installProcessGuards } from "./utils/process-guards.js";
import { sweepTrash } from "./utils/worktree-trash.js";
import { initScheduler, shutdownScheduler } from "./services/cron-scheduler.js";
import { initJobRunner, shutdownJobRunner } from "./services/job-runner.js";
import { migrateCardsToMetadata, repairStrandedCardFields } from "./services/card-migration.js";
import { initEventWatchers, shutdownEventWatchers } from "./services/event-watcher.js";
import { shutdownDebounce } from "./services/trigger-debounce.js";
import { initCliWatcher, shutdownCliWatcher } from "./services/cli-watcher.js";
import { getAgentSettings, ensureRemoteProxyConfigDir, migrateDrawlatchDirs, migrateKeyDirectories } from "./services/agent-settings.js";
import { ensureCallerEnrolled } from "./services/proxy-singleton.js";
import { startLocalDaemon, stopLocalDaemon } from "./services/local-daemon.js";
import { startWebTunnel, stopWebTunnel } from "./services/web-tunnel.js";
import { initSdkInfoCache } from "./services/sdk-info.js";
import { getClaudeAuthStatus } from "./services/claude-auth-status.js";
import { initOpenRouterModelsCache, stopOpenRouterModelsRefresh } from "./services/openrouter-models.js";
import { initCodexModelsCache } from "./services/codex-models.js";
import { buildSystemInfo } from "./services/system-info.js";
import { BOOT_VERSION } from "./utils/package-manifest.js";

const log = createLogger("server");

// Process-level guards: survive stray unhandled rejections (e.g. from
// provider SDKs), log-and-exit on uncaught exceptions. Must be installed
// before any async subsystem starts.
installProcessGuards();

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const PORT = (!isProduction && process.env.DEV_PORT_SERVER) || process.env.PORT || 8000;

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());

app.use(express.json({ limit: "50mb" }));

// ── Rate limiting ──────────────────────────────────────────────────
// Strict limiter for public/unauthenticated endpoints
const publicLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute per client
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  // Key on the real client. Behind the cloudflared tunnel every request arrives from
  // loopback, so without this all remote clients would share one bucket — letting a
  // single caller lock everyone out of login. We resolve forwarding headers only for
  // loopback traffic; see utils/client-ip.ts. Disable the XFF validation because we
  // handle (and deliberately distrust non-loopback) forwarding headers ourselves.
  keyGenerator: getClientKey,
  validate: { xForwardedForHeader: false },
});

// General limiter for authenticated API endpoints
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute per client
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  keyGenerator: getClientKey,
  validate: { xForwardedForHeader: false },
  skip: (req) => {
    // Skip rate limiting for SSE/stream endpoints and high-frequency polling
    return req.path.endsWith("/stream") || req.path.endsWith("/poll");
  },
});

// The remote-access IP allowlist gates EVERY /api route, and it has to be
// mounted here — above the auth routes — to make that true. It used to be the
// first block of `requireAuth`, which is registered below them, so an off-list
// public client reached `/api/auth/login` and `/api/auth/check` unimpeded while
// every other route returned 403. Login is precisely the endpoint an address
// gate exists to protect: it is the one an off-list client can attack without a
// credential. See `requireAllowedIp`.
app.use("/api", requireAllowedIp);

// Apply public rate limiter to unauthenticated auth endpoints
app.use("/api/auth/login", publicLimiter);
app.use("/api/auth/logout", publicLimiter);
app.use("/api/auth/check", publicLimiter);

// Auth routes (public, rate-limited)
app.post(
  "/api/auth/login",
  // #swagger.tags = ['Auth']
  // #swagger.summary = 'Login with password'
  // #swagger.description = 'Authenticate with the server password. Returns a session cookie on success. Rate limited to 3 attempts per minute per IP.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["password"],
          properties: {
            password: { type: "string", description: "Server password" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Login successful" } */
  /* #swagger.responses[401] = { description: "Invalid password" } */
  /* #swagger.responses[429] = { description: "Rate limited — too many attempts" } */
  loginHandler,
);
app.post(
  "/api/auth/logout",
  // #swagger.tags = ['Auth']
  // #swagger.summary = 'Logout'
  // #swagger.description = 'Destroy the current session and clear the session cookie.'
  /* #swagger.responses[200] = { description: "Logout successful" } */
  logoutHandler,
);
app.get(
  "/api/auth/check",
  // #swagger.tags = ['Auth']
  // #swagger.summary = 'Check authentication status'
  // #swagger.description = 'Returns whether the current session cookie is valid.'
  /* #swagger.responses[200] = { description: "Auth status" } */
  checkAuthHandler,
);

// All /api routes below require auth + rate limiting. (The IP allowlist is
// mounted further up, so that it also covers the auth routes above.)
app.use("/api", requireAuth);
app.use("/api", apiLimiter);

// Serve OpenAPI spec (requires auth)
app.get("/api/docs", (_req, res) => {
  // #swagger.ignore = true
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  const specPath = path.join(__dir, "../swagger.json");
  if (existsSync(specPath)) {
    const spec = JSON.parse(readFileSync(specPath, "utf-8"));
    res.json(spec);
  } else {
    res.status(404).json({ error: "API spec not found. Run: npm run swagger" });
  }
});

app.use("/api/chats", chatsRouter);
app.use("/api/chats", streamRouter);
app.use("/api/images", imagesRouter);
app.use("/api/chats", imagesRouter);
app.use("/api/queue", queueRouter);
app.use("/api/folders", foldersRouter);
app.use("/api/git", gitRouter);
app.use("/api/app-plugins", appPluginsRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/agent-settings", agentSettingsRouter);
app.use("/api/proxy", proxyRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/themes", themesRouter);
app.use("/api/custom-skills", customSkillsRouter);
app.use("/api/keywords", keywordsRouter);
app.use("/api/files", filesRouter);
app.use("/api/canvas", canvasRouter);
app.use("/api/mcp-tools", mcpToolsRouter);
app.use("/api/openrouter", openRouterRouter);
app.use("/api/codex", codexRouter);
app.use("/api/acp", acpRouter);
app.use("/api/cline", clineRouter);
app.use("/api/pi", piRouter);
// Per-engine runtime/version/credential status. Deliberately not part of
// /api/system-info — see routes/engines.ts.
app.use("/api/engines", enginesRouter);
// Callboard installing its own newer version, and restarting into it. A sibling
// of the engine installs above rather than one of them — see routes/self-update.ts.
app.use("/api/self-update", selfUpdateRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/cards", cardsRouter);
app.use("/api/api-keys", apiKeysRouter);
app.use("/api/workspaces", workspacesRouter);

// Instance name endpoints (requires auth)
import { getInstanceName, saveInstanceName, generateInstanceName } from "./utils/paths.js";

app.get("/api/instance-name", (_req, res) => {
  res.json({ name: getInstanceName() });
});

app.put("/api/instance-name", (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  saveInstanceName(name.trim());
  res.json({ name: name.trim() });
});

app.post("/api/instance-name/randomize", (_req, res) => {
  const name = generateInstanceName();
  saveInstanceName(name);
  res.json({ name });
});

// Ignored project directories endpoints (requires auth)
import { DEFAULT_IGNORED_PROJECT_DIR_PREFIXES, getIgnoredProjectDirPrefixes, saveIgnoredProjectDirPrefixes } from "./utils/paths.js";
import { clearListCaches } from "./services/list-caches.js";

app.get("/api/ignored-project-dirs", (_req, res) => {
  // #swagger.tags = ['Settings']
  // #swagger.summary = 'Get ignored project-dir prefixes'
  // #swagger.description = 'Returns the configured list of project-dir names whose subtrees are filtered out of chat listings and chat search, plus the built-in defaults.'
  res.json({
    prefixes: getIgnoredProjectDirPrefixes(),
    defaults: [...DEFAULT_IGNORED_PROJECT_DIR_PREFIXES],
  });
});

app.put("/api/ignored-project-dirs", (req, res) => {
  // #swagger.tags = ['Settings']
  // #swagger.summary = 'Update ignored project-dir prefixes'
  // #swagger.description = 'Replace the ignored prefix list. A project dir is hidden from chat listings and skipped by chat search — including a search that names it outright — when its slugified name equals one of these entries or continues past it at a separator (`-`, the slugified `/`). A name that merely shares leading characters, such as `-tmpish` against `-tmp`, is not matched. An entry written with a trailing `-` matches its whole subtree as spelled.'
  const { prefixes } = req.body ?? {};
  if (!Array.isArray(prefixes)) {
    return res.status(400).json({ error: "prefixes must be an array of strings" });
  }
  if (prefixes.some((p) => typeof p !== "string")) {
    return res.status(400).json({ error: "every prefix must be a string" });
  }
  // Project dirs are slugified paths, so a prefix that can ever match one holds
  // nothing but `[A-Za-z0-9-]`. Rejecting the rest is not a new restriction on
  // anything useful — such a prefix could never match a directory — and it is
  // the layer above the argv array that now carries these values into `find`.
  // Until that array existed, this endpoint was remote command execution: a
  // prefix of `evil$(id > /tmp/proof)` ran on the next `GET /api/chats`.
  const invalid = prefixes.filter((p: string) => !isValidIgnoredPrefix(p.trim()));
  if (invalid.length > 0) {
    return res.status(400).json({
      error: `A project-dir prefix may contain only letters, digits and hyphens — project dirs are slugified paths, so anything else can never match one. Rejected: ${invalid.map((p: string) => JSON.stringify(p)).join(", ")}`,
    });
  }
  const saved = saveIgnoredProjectDirPrefixes(prefixes);
  // Invalidate both listing caches so the next /api/chats and
  // /api/chats/folders calls reflect the change.
  clearListCaches();
  res.json({ prefixes: saved, defaults: [...DEFAULT_IGNORED_PROJECT_DIR_PREFIXES] });
});

// User contact info endpoints (requires auth)
import { getUserContact, saveUserContact } from "./services/user-contact.js";
import { getUserContactAvailability } from "./services/contact-channel-availability.js";

app.get("/api/user-contact", (_req, res) => {
  // #swagger.tags = ['Settings']
  // #swagger.summary = 'Get the user contact info'
  // #swagger.description = 'Returns the user contact channels (Discord, Telegram, phone, email), each with a handle and an on/off toggle.'
  res.json(getUserContact());
});

app.get("/api/user-contact/availability", async (req, res) => {
  // #swagger.tags = ['Settings']
  // #swagger.summary = "Which contact channels this instance's drawlatch credentials can deliver on"
  // #swagger.description = 'Reports, per notifiable channel (Discord, Telegram, email), whether the connection notify_user needs is present on a usable drawlatch caller — the default caller or any agent-bound one. `configured: false` means no usable caller exists; `channelsKnown: false` means the check itself failed and availability is unknown (fail open). Pass `refresh=1` to bypass the cached route listing — a throttled live daemon call, so reserve it for an explicit user gesture.'
  const refresh = req.query.refresh === "1" || req.query.refresh === "true";
  try {
    res.json(await getUserContactAvailability({ refresh }));
  } catch (err: any) {
    // Every dependency catches internally, so this is defensive — but an
    // unhandled rejection in an inline async handler hangs the request rather
    // than answering, and the settings page waits on this to render.
    log.warn(`Contact channel availability check failed: ${err?.message || err}`);
    res.status(502).json({ error: "Failed to check contact channel availability" });
  }
});

app.put("/api/user-contact", (req, res) => {
  // #swagger.tags = ['Settings']
  // #swagger.summary = 'Update the user contact info'
  // #swagger.description = 'Replace the user contact channels. Used by the notify_user tool to decide which channels the agent may use to reach the user.'
  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "request body must be a contact info object" });
  }
  res.json(saveUserContact(body));
});

// Claude Code auth status. The decision lives in
// `services/claude-auth-status.ts` — it is the login modal's whole input, and
// it needs a suite that can drive the "an API key is configured but the CLI is
// not logged in" case, which importing this module cannot.
app.get(
  "/api/auth/claude-status",
  // #swagger.tags = ['Auth']
  // #swagger.summary = 'Check whether Claude Code needs a login on this machine'
  // #swagger.description = 'Reports whether Claude Code chats can authenticate here — from a configured API key or auth token, OpenRouter routing, a third-party provider, or a `claude auth login`. `loggedIn` false means no credential of any kind was found. Positive answers are cached for 60 seconds.'
  /* #swagger.responses[200] = { description: "Claude Code auth status" } */
  async (_req, res) => {
    res.json(await getClaudeAuthStatus());
  },
);

// System info (requires auth — version, environment, SDK info)
app.get(
  "/api/system-info",
  // #swagger.tags = ['System']
  // #swagger.summary = 'Get system information'
  // #swagger.description = 'Returns Callboard version, Node.js version, platform, Claude Agent SDK version, account info, and supported models.'
  /* #swagger.responses[200] = { description: "System information" } */
  async (_req, res) => {
    // Assembly lives in `services/system-info.ts` — see that module for why the
    // probes run concurrently and why not one of them is allowed to reject.
    // `__pkgRoot` is passed in because it is derived from *this* file's depth;
    // `runningVersion` because it has to have been read before an `npm install
    // -g` could rewrite the manifest under this process, and this handler first
    // runs on a request.
    res.json(await buildSystemInfo({ pkgRoot: __pkgRoot, runningVersion: BOOT_VERSION }));
  },
);

// Change password (requires auth — registered after requireAuth middleware)
app.post(
  "/api/auth/change-password",
  // #swagger.tags = ['Auth']
  // #swagger.summary = 'Change password'
  // #swagger.description = 'Change the server password. Requires current password. Invalidates all other sessions.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          properties: {
            currentPassword: { type: "string", description: "Current password" },
            newPassword: { type: "string", description: "New password" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Password changed successfully" } */
  /* #swagger.responses[400] = { description: "Missing required fields" } */
  /* #swagger.responses[401] = { description: "Current password is incorrect" } */
  changePasswordHandler,
);

// Webhooks are received and verified by the drawlatch daemon (which owns the
// ingestors and its own cloudflared tunnel) — callboard no longer terminates
// webhook traffic. It polls the daemon for buffered events via the event watcher.

// Restart endpoint — delegates to `callboard restart` CLI which handles
// the full stop → start lifecycle including PID file management.
app.post(
  "/api/restart",
  // #swagger.tags = ['System']
  // #swagger.summary = 'Restart the Callboard server'
  // #swagger.description = 'Spawns `callboard restart` as a detached process which stops the current server and starts a fresh one.'
  /* #swagger.responses[200] = { description: "Restart initiated" } */
  (_req, res) => {
    log.info("Restart requested via API");
    res.json({ success: true, message: "Restarting..." });

    // Give the response time to flush before triggering restart
    setTimeout(() => {
      try {
        const bin = path.join(__pkgRoot, "bin/callboard.js");
        const child = spawn(process.execPath, [bin, "restart"], {
          detached: true,
          stdio: "ignore",
          env: process.env,
        });
        child.unref();
        log.info(`Spawned 'callboard restart' (PID ${child.pid})`);
      } catch (err: any) {
        log.error(`Failed to spawn callboard restart: ${err.message}`);
      }
    }, 500);
  },
);

// Serve frontend static files in production
const frontendDist = path.join(__pkgRoot, "frontend/dist");
app.use(express.static(frontendDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"));
});

// One-time cards-as-entity → cards-as-metadata migration. Must run before the
// server accepts requests and before initJobRunner resumes runs — both would
// otherwise read half-migrated shapes. Synchronous by design: it is a few
// hundred small file writes once, ever, and the daemon is not serving yet.
try {
  migrateCardsToMetadata();
} catch (err: any) {
  log.error(`Card migration failed: ${err.message} — the daemon continues on unmigrated data; the migration will retry on next boot`);
}

// Card fields stranded on a non-root chat by the first shipped migration are
// invisible to the board (card-rollup only projects from lineage roots), and
// the migration's marker means it will never revisit those installs. Runs on
// every boot, separately from the marker, and is idempotent — same placement
// rationale as the migration: before any request or run can read the half-
// repaired shape.
try {
  repairStrandedCardFields();
} catch (err: any) {
  log.error(`Stranded card repair failed: ${err.message} — affected cards keep showing stale fields; the repair retries on next boot`);
}

app.listen(PORT, () => {
  log.info(`Backend running on http://localhost:${PORT}`);
  log.info(`Log level: ${process.env.LOG_LEVEL || "info"}`);
  log.info(`Config: ${ENV_FILE}`);

  if (__isFirstRun) {
    log.warn(`First run detected — created ${ENV_FILE}`);
    if (!process.env.AUTH_PASSWORD_HASH) {
      log.warn(`No password configured. Set one with: callboard set-password`);
    }
  }

  // Cache SDK info (account, models) in the background — non-blocking
  initSdkInfoCache();

  // Warm the OpenRouter tool-calling model list (public endpoint) — non-blocking
  initOpenRouterModelsCache();

  // Warm the Codex model catalog reported by the installed CLI — non-blocking
  initCodexModelsCache();

  // Initialize automation systems (non-blocking, log errors but don't crash)
  try {
    initScheduler();
  } catch (err: any) {
    log.error(`Scheduler init failed: ${err.message}`);
  }
  try {
    // Resumes non-terminal job runs (re-arms timers/event waits, harvests
    // step sessions that finished during downtime).
    initJobRunner();
  } catch (err: any) {
    log.error(`Job runner init failed: ${err.message}`);
  }
  try {
    initCliWatcher();
  } catch (err: any) {
    log.error(`CLI watcher init failed: ${err.message}`);
  }

  // Age out quarantined worktrees (~/.callboard/trash) past the retention
  // window. Archiving sweeps too; this bounds the trash on a server that
  // archives rarely. Conservative by construction — see utils/worktree-trash.ts.
  try {
    const swept = sweepTrash();
    if (swept.removed.length > 0) log.info(`Trash sweep removed ${swept.removed.length} expired quarantined worktree(s)`);
    for (const error of swept.errors) log.warn(`Trash sweep: ${error}`);
  } catch (err: any) {
    log.error(`Trash sweep failed: ${err.message}`);
  }

  // Start the drawlatch daemon based on configured mode, then initialize event
  // watchers. Local: spawn + supervise a managed daemon and auto-enroll the
  // default caller before the watchers (which use getProxy()) come up. Remote:
  // connect to the external daemon; keys come from the Sync flow.
  const settings = getAgentSettings();
  if (settings.proxyMode === "remote") {
    // Ensure the remote config directory and key scaffold exist
    ensureRemoteProxyConfigDir();
    try {
      initEventWatchers();
    } catch (err: any) {
      log.error(`Event watcher init failed: ${err.message}`);
    }
  } else {
    void (async () => {
      try {
        const healthy = await startLocalDaemon();
        if (healthy) {
          await ensureCallerEnrolled("default");
        } else {
          log.warn("Local drawlatch daemon not healthy — proxy tools will be unavailable until it starts");
        }
      } catch (err: any) {
        log.error(`Failed to start local drawlatch daemon: ${err.message}`);
      }

      // Initialize event watchers once the daemon is up (or attempted).
      try {
        initEventWatchers();
      } catch (err: any) {
        log.error(`Event watcher init failed: ${err.message}`);
      }
    })();
  }

  // Bring up the remote-access (public) tunnel if the user left it enabled.
  // Independent of proxy mode — this exposes callboard's own web UI. Failures
  // are surfaced via /api/agent-settings/remote-access-status, never fatal.
  if (settings.remoteAccessEnabled) {
    void startWebTunnel({
      port: Number(PORT),
      host: "127.0.0.1",
      mode: settings.remoteAccessMode === "named" ? "named" : "quick",
      token: settings.cloudflaredToken,
      hostname: settings.remoteAccessHostname,
    }).catch((err: any) => log.error(`Remote-access tunnel start failed: ${err.message}`));
  }
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  log.info(`${signal} received, shutting down gracefully`);
  shutdownScheduler();
  shutdownJobRunner();
  shutdownDebounce();
  shutdownEventWatchers();
  shutdownCliWatcher();
  stopOpenRouterModelsRefresh();

  // Stop the callboard-managed drawlatch daemon (no-op in remote mode).
  try {
    await stopLocalDaemon();
  } catch (err: any) {
    log.error(`Failed to stop local drawlatch daemon: ${err.message}`);
  }

  // Tear down the remote-access tunnel (no-op when not running).
  try {
    await stopWebTunnel();
  } catch (err: any) {
    log.error(`Failed to stop remote-access tunnel: ${err.message}`);
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
