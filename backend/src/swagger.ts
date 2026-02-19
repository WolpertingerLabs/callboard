import swaggerAutogen from "swagger-autogen";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const doc = {
  info: {
    title: "Claude Code UI API",
    description: "API for managing Claude Code chat sessions, message streaming, image uploads, draft messages, folder browsing, and git operations.",
    version: "1.0.0",
  },
  host: "localhost:8000",
  basePath: "/api",
  schemes: ["http"],
  tags: [
    {
      name: "Auth",
      description: "Authentication endpoints (public, no auth required)",
    },
    {
      name: "Chats",
      description: "Chat session management — list, create, get, delete chats and retrieve messages",
    },
    {
      name: "Stream",
      description: "Real-time messaging via SSE — send messages, connect to streams, handle pending requests",
    },
    {
      name: "Images",
      description: "Image upload, retrieval, and deletion for chat sessions",
    },
    {
      name: "Drafts",
      description: "Draft messages — save, retrieve, execute on demand, and delete draft messages",
    },
    {
      name: "Folders",
      description: "Directory browsing, path validation, suggestions, and recent folders",
    },
    {
      name: "Git",
      description: "Git branch listing, worktree management, and removal",
    },
  ],
  securityDefinitions: {
    cookieAuth: {
      type: "apiKey",
      in: "cookie",
      name: "ccui_session",
      description: "Session cookie obtained from POST /api/auth/login (configurable via SESSION_COOKIE_NAME env var)",
    },
  },
  security: [{ cookieAuth: [] }],
};

const outputFile = path.join(__dirname, "../swagger.json");
const routes = [path.join(__dirname, "index.ts")];

const options = {
  openapi: "3.0.0" as const,
};

swaggerAutogen(options)(outputFile, routes, doc).then((result) => {
  if (result && typeof result === "object" && "success" in result && result.success) {
    console.log("✅ Swagger spec generated:", outputFile);
  } else {
    console.error("❌ Swagger generation failed");
    process.exit(1);
  }
});
