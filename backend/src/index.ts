import dotenv from "dotenv";
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
import { ENV_FILE, ensureDataDir, ensureEnvFile } from "./utils/paths.js";
ensureDataDir();
const __isFirstRun = ensureEnvFile();
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
import cors from "cors";
import cookieParser from "cookie-parser";
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
import { loginHandler, logoutHandler, checkAuthHandler, requireAuth } from "./auth.js";
import { createLogger } from "./utils/logger.js";
import { initScheduler, shutdownScheduler } from "./services/cron-scheduler.js";
import { initEventWatchers, shutdownEventWatchers } from "./services/event-watcher.js";
import { initCliWatcher, shutdownCliWatcher } from "./services/cli-watcher.js";
import { LocalProxy } from "./services/local-proxy.js";
import { getAgentSettings, getActiveMcpConfigDir, ensureLocalProxyConfigDir, ensureRemoteProxyConfigDir } from "./services/agent-settings.js";
import { setLocalProxyInstance, getLocalProxyInstance } from "./services/proxy-singleton.js";
import { loadMcpEnvIntoProcess } from "./services/connection-manager.js";

const log = createLogger("server");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const PORT = (!isProduction && process.env.DEV_PORT_SERVER) || process.env.PORT || 8000;

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());

// Auth routes (public)
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

// Serve OpenAPI spec (public, no auth required for agent access)
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

// All /api routes below require auth
app.use("/api", requireAuth);

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

// Webhook route for local proxy mode (ingestor event ingestion)
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
  for (const ingestor of ingestors) {
    ingestor.handleWebhook(req.headers, req.body);
  }
  res.json({ received: true });
});

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
    if (!process.env.AUTH_PASSWORD) {
      log.warn(`Set AUTH_PASSWORD in ${ENV_FILE} to enable login.`);
    }
  }

  // Initialize automation systems (non-blocking, log errors but don't crash)
  try {
    initScheduler();
  } catch (err: any) {
    log.error(`Scheduler init failed: ${err.message}`);
  }
  try {
    initEventWatchers();
  } catch (err: any) {
    log.error(`Event watcher init failed: ${err.message}`);
  }
  try {
    initCliWatcher();
  } catch (err: any) {
    log.error(`CLI watcher init failed: ${err.message}`);
  }

  // Start proxy based on configured mode
  const settings = getAgentSettings();
  if (settings.proxyMode === "local") {
    // In local mode, getActiveMcpConfigDir() always returns a value (defaults to data/.drawlatch/)
    const activeMcpConfigDir = getActiveMcpConfigDir()!;

    // Ensure the config directory exists before starting
    ensureLocalProxyConfigDir();

    // Sync MCP_CONFIG_DIR and load secrets before creating LocalProxy
    process.env.MCP_CONFIG_DIR = activeMcpConfigDir;
    loadMcpEnvIntoProcess();

    try {
      const localProxy = new LocalProxy(activeMcpConfigDir, "default");
      localProxy
        .start()
        .then(() => {
          setLocalProxyInstance(localProxy);
          log.info("Local proxy started");
        })
        .catch((err: any) => {
          log.error(`Failed to start local proxy: ${err.message}`);
        });
    } catch (err: any) {
      log.error(`Failed to initialize local proxy: ${err.message}`);
    }
  } else if (settings.proxyMode === "remote") {
    // Ensure the remote config directory and key scaffold exist
    ensureRemoteProxyConfigDir();
  }
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  log.info(`${signal} received, shutting down gracefully`);
  shutdownScheduler();
  shutdownEventWatchers();
  shutdownCliWatcher();

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
