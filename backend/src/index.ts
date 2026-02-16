import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// Load .env from project root
const __rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(__rootDir, ".env"), override: true });
import cors from "cors";
import cookieParser from "cookie-parser";
import { chatsRouter } from "./routes/chats.js";
import { streamRouter } from "./routes/stream.js";
import { imagesRouter } from "./routes/images.js";
import { queueRouter } from "./routes/queue.js";
import { foldersRouter } from "./routes/folders.js";
import { gitRouter } from "./routes/git.js";
import { appPluginsRouter } from "./routes/app-plugins.js";
import { loginHandler, logoutHandler, checkAuthHandler, requireAuth } from "./auth.js";
import { existsSync, readFileSync } from "fs";
import { createLogger } from "./utils/logger.js";

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

// Serve frontend static files in production
const frontendDist = path.join(process.cwd(), "frontend/dist");
app.use(express.static(frontendDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(frontendDist, "index.html"));
});

app.listen(PORT, () => {
  log.info(`Backend running on http://localhost:${PORT}`);
  log.info(`Log level: ${process.env.LOG_LEVEL || "info"}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  log.info("SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  log.info("SIGINT received, shutting down gracefully");
  process.exit(0);
});
