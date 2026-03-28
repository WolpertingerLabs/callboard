import dotenv from "dotenv";
import { execSync, spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// Package root — resolved from backend/dist/index.js (or backend/src/index.ts via tsx).
// Works both in local dev (monorepo root) and global npm install (package root).
const __pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Load .env: ~/.callboard/.env is the base config, then the project-root .env
// overrides it. This lets local dev runs use a local .env to override
// the global ~/.callboard config (e.g. different ports, passwords, log levels).
import { DATA_DIR, ENV_FILE, ensureDataDir, ensureEnvFile, ensureInstanceName } from "./utils/paths.js";
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
import { connectionsRouter } from "./routes/connections.js";
import { sessionsRouter } from "./routes/sessions.js";
import { themesRouter } from "./routes/themes.js";
import { filesRouter } from "./routes/files.js";
import { canvasRouter } from "./routes/canvas.js";
import { mcpToolsRouter } from "./routes/mcp-tools.js";
import { loginHandler, logoutHandler, checkAuthHandler, requireAuth, changePasswordHandler } from "./auth.js";
import { createLogger } from "./utils/logger.js";
import { initScheduler, shutdownScheduler } from "./services/cron-scheduler.js";
import { initEventWatchers, shutdownEventWatchers } from "./services/event-watcher.js";
import { initCliWatcher, shutdownCliWatcher } from "./services/cli-watcher.js";
import { LocalProxy } from "./services/local-proxy.js";
import {
  getAgentSettings,
  getActiveMcpConfigDir,
  ensureLocalProxyConfigDir,
  ensureRemoteProxyConfigDir,
  migrateDrawlatchDirs,
  migrateKeyDirectories,
} from "./services/agent-settings.js";
import { setLocalProxyInstance, getLocalProxyInstance } from "./services/proxy-singleton.js";
import { loadMcpEnvIntoProcess } from "./services/connection-manager.js";
import { startTunnelIfEnabled, stopTunnel } from "./services/tunnel-manager.js";
import { initSdkInfoCache, getSdkInfoAsync } from "./services/sdk-info.js";

const log = createLogger("server");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const PORT = (!isProduction && process.env.DEV_PORT_SERVER) || process.env.PORT || 8000;

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());

// Raw buffer for webhook endpoints (needed for signature verification).
// Must be registered BEFORE express.json() so webhook bodies stay as Buffers.
app.use("/webhooks", express.raw({ type: "application/json", limit: "1mb" }));

app.use(express.json({ limit: "50mb" }));

// ── Rate limiting ──────────────────────────────────────────────────
// Strict limiter for public/unauthenticated endpoints
const publicLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// General limiter for authenticated API endpoints
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: (req) => {
    // Skip rate limiting for SSE endpoints (long-lived connections)
    return req.path.endsWith("/stream") || req.path.endsWith("/events");
  },
});

// Webhook limiter — moderate (external services need reliable delivery)
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

// Apply webhook limiter before the raw body parser
app.use("/webhooks", webhookLimiter);

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

// All /api routes below require auth + rate limiting
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
app.use("/api/connections", connectionsRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/themes", themesRouter);
app.use("/api/files", filesRouter);
app.use("/api/canvas", canvasRouter);
app.use("/api/mcp-tools", mcpToolsRouter);

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

// Claude Code auth status (requires auth — exposes server-side CLI state)
let claudeStatusCache: { data: any; ts: number } | null = null;
const CLAUDE_STATUS_TTL = 60_000; // 60 seconds

app.get(
  "/api/auth/claude-status",
  // #swagger.tags = ['Auth']
  // #swagger.summary = 'Check Claude Code CLI login status'
  // #swagger.description = 'Returns whether the server host is logged into Claude Code via the CLI. Cached for 60 seconds.'
  /* #swagger.responses[200] = { description: "Claude Code auth status" } */
  (_req, res) => {
    const now = Date.now();
    if (claudeStatusCache && now - claudeStatusCache.ts < CLAUDE_STATUS_TTL) {
      return res.json(claudeStatusCache.data);
    }

    try {
      const raw = execSync("claude auth status", { timeout: 1_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      const parsed = JSON.parse(raw.trim());
      if (parsed.loggedIn) claudeStatusCache = { data: parsed, ts: now };
      res.json(parsed);
    } catch (err: any) {
      const fallback = { loggedIn: false, error: err.code === "ENOENT" ? "Claude CLI not installed" : `CLI error: ${err.message}` };
      res.json(fallback);
    }
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
    let version = "unknown";
    let pkgName = "@wolpertingerlabs/callboard";
    try {
      const pkgPath = path.join(__pkgRoot, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      version = pkg.version;
      pkgName = pkg.name || pkgName;
    } catch {
      // ignore
    }

    let sdkVersion = "unknown";
    try {
      const sdkPkgPath = path.join(__pkgRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
      const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, "utf-8"));
      sdkVersion = sdkPkg.version;
    } catch {
      // ignore
    }

    let claudeCliVersion = "unknown";
    try {
      claudeCliVersion = execSync("claude --version", { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    } catch {
      // ignore
    }

    // Fetch latest version from npm (cached, best effort)
    let latestVersion: string | undefined;
    try {
      const cacheFile = path.join(DATA_DIR, "version-check.json");
      const cacheTtl = 4 * 60 * 60 * 1000; // 4 hours
      let cached: { latestVersion: string; ts: number } | null = null;
      try {
        if (existsSync(cacheFile)) {
          cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
        }
      } catch {
        // ignore corrupt cache
      }
      if (cached && Date.now() - cached.ts < cacheTtl) {
        latestVersion = cached.latestVersion;
      } else {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const npmRes = await fetch(`https://registry.npmjs.org/${pkgName}/latest`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        clearTimeout(timeout);
        if (npmRes.ok) {
          const npmData = (await npmRes.json()) as { version?: string };
          if (npmData.version) {
            latestVersion = npmData.version;
            try {
              writeFileSync(cacheFile, JSON.stringify({ latestVersion, ts: Date.now() }) + "\n");
            } catch {
              // best effort
            }
          }
        }
      }
    } catch {
      // best effort — don't fail the endpoint
    }

    // Include cached SDK info (account + models) if available
    const sdkInfo = await getSdkInfoAsync();

    res.json({
      version,
      latestVersion,
      nodeVersion: process.version,
      platform: `${process.platform} (${process.arch})`,
      sdkVersion,
      claudeCliVersion,
      proxyMode: process.env.MCP_PROXY_MODE || undefined,
      environment: process.env.NODE_ENV || "development",
      account: sdkInfo.account || undefined,
      models: sdkInfo.models.length > 0 ? sdkInfo.models : undefined,
    });
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

// Webhook routes for local proxy mode (ingestor event ingestion).
// HEAD handler: some webhook providers (e.g., Trello) send a HEAD request to
// verify the callback URL during registration. Return 200 so verification passes.
app.head("/webhooks/:path", (_req, res) => {
  res.sendStatus(200);
});

app.post("/webhooks/:path", (req, res) => {
  const localProxy = getLocalProxyInstance();
  if (!localProxy) {
    res.status(404).json({ error: "Local proxy not active" });
    return;
  }

  const ingestors = localProxy.ingestorManager.getWebhookIngestors(req.params.path);
  if (ingestors.length === 0) {
    res.status(404).json({ error: "No webhook ingestor for this path" });
    return;
  }

  // Ensure we have a raw Buffer for signature verification.
  // The /webhooks express.raw() middleware should provide a Buffer, but
  // fall back safely if something else parsed the body first.
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body));

  // Fan out to all matching ingestors (multiple callers may share a webhook path)
  let anyAccepted = false;
  for (const ingestor of ingestors) {
    const result = ingestor.handleWebhook(req.headers, rawBody);
    if (result.accepted) anyAccepted = true;
  }

  // Return 200 if any ingestor accepted (providers like GitHub retry on non-2xx)
  if (anyAccepted) {
    res.status(200).json({ received: true });
  } else {
    res.status(403).json({ error: "Webhook rejected by all ingestors" });
  }
});

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

  // Initialize automation systems (non-blocking, log errors but don't crash)
  try {
    initScheduler();
  } catch (err: any) {
    log.error(`Scheduler init failed: ${err.message}`);
  }
  try {
    initCliWatcher();
  } catch (err: any) {
    log.error(`CLI watcher init failed: ${err.message}`);
  }

  // Start proxy based on configured mode, then initialize event watchers.
  // In local mode, event watchers must start AFTER LocalProxy is ready
  // (they use getProxy() which requires the LocalProxy singleton to be set).
  const settings = getAgentSettings();
  if (settings.proxyMode === "local") {
    // Async IIFE: tunnel must start before LocalProxy constructor so that
    // callback URL env vars are available during drawlatch's resolveSecrets().
    void (async () => {
      // In local mode, getActiveMcpConfigDir() always returns a value (defaults to data/.drawlatch.local/)
      const activeMcpConfigDir = getActiveMcpConfigDir()!;

      // Ensure the config directory exists before starting
      ensureLocalProxyConfigDir();

      // Sync MCP_CONFIG_DIR and load secrets before creating LocalProxy
      process.env.MCP_CONFIG_DIR = activeMcpConfigDir;
      loadMcpEnvIntoProcess();

      // Start cloudflared tunnel if enabled — sets callback URL env vars
      // (e.g., TRELLO_CALLBACK_URL) that resolveSecrets() needs
      try {
        await startTunnelIfEnabled(PORT);
      } catch (err: any) {
        log.error(`Tunnel startup failed: ${err.message}`);
      }

      try {
        const localProxy = new LocalProxy(activeMcpConfigDir, "default");
        await localProxy.start();
        setLocalProxyInstance(localProxy);
        log.info("Local proxy started");

        // Initialize event watchers now that LocalProxy is ready
        try {
          initEventWatchers();
        } catch (err: any) {
          log.error(`Event watcher init failed: ${err.message}`);
        }
      } catch (err: any) {
        log.error(`Failed to start local proxy: ${err.message}`);
      }
    })();
  } else {
    if (settings.proxyMode === "remote") {
      // Ensure the remote config directory and key scaffold exist
      ensureRemoteProxyConfigDir();
    }

    // In remote mode, event watchers can start immediately (ProxyClient
    // resolves keys synchronously and doesn't depend on LocalProxy)
    try {
      initEventWatchers();
    } catch (err: any) {
      log.error(`Event watcher init failed: ${err.message}`);
    }
  }
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  log.info(`${signal} received, shutting down gracefully`);
  shutdownScheduler();
  shutdownEventWatchers();
  shutdownCliWatcher();

  // Stop tunnel first (fast — just kills cloudflared child process)
  try {
    await stopTunnel();
  } catch (err: any) {
    log.error(`Failed to stop tunnel: ${err.message}`);
  }

  const localProxy = getLocalProxyInstance();
  if (localProxy) {
    try {
      await localProxy.stop();
      log.info("Local proxy stopped");
    } catch (err: any) {
      log.error(`Failed to stop local proxy: ${err.message}`);
    }
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
