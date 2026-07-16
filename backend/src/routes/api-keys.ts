import { Router } from "express";
import { requireSessionAuth } from "../auth.js";
import { listApiKeys, createApiKey, deleteApiKey } from "../services/api-keys.js";

export const apiKeysRouter = Router();

// API keys are credentials — only a logged-in browser session may manage
// them. A bearer key cannot list, mint, or revoke keys.
apiKeysRouter.use(requireSessionAuth);

apiKeysRouter.get("/", (_req, res) => {
  // #swagger.tags = ['API Keys']
  // #swagger.summary = 'List API keys'
  // #swagger.description = 'Returns all API keys (metadata only — tokens are never returned after creation). Requires a session cookie; not accessible with a bearer key.'
  /* #swagger.responses[200] = { description: "List of API keys" } */
  res.json({ keys: listApiKeys() });
});

apiKeysRouter.post("/", (req, res) => {
  // #swagger.tags = ['API Keys']
  // #swagger.summary = 'Create an API key'
  // #swagger.description = 'Creates a new bearer API key. The plaintext token is returned once in this response and never again. Requires a session cookie.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", description: "Display name for the key" },
            description: { type: "string", description: "What the key is used for" },
            expiresAt: { type: "number", nullable: true, description: "Expiry as epoch ms; omit or null for no expiry" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[201] = { description: "Created key with one-time plaintext token" } */
  /* #swagger.responses[400] = { description: "Invalid name or expiry" } */
  const { name, description, expiresAt } = req.body ?? {};

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "A name is required." });
  }
  if (description !== undefined && typeof description !== "string") {
    return res.status(400).json({ error: "description must be a string." });
  }

  let expiry: number | null = null;
  if (expiresAt !== undefined && expiresAt !== null) {
    expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number(expiresAt);
    if (!Number.isFinite(expiry)) {
      return res.status(400).json({ error: "expiresAt must be a timestamp (epoch ms or ISO date string)." });
    }
    if (expiry <= Date.now()) {
      return res.status(400).json({ error: "expiresAt must be in the future." });
    }
  }

  const { key, token } = createApiKey(name.trim(), (description ?? "").trim(), expiry);
  res.status(201).json({ key, token });
});

apiKeysRouter.delete("/:id", (req, res) => {
  // #swagger.tags = ['API Keys']
  // #swagger.summary = 'Revoke an API key'
  // #swagger.description = 'Deletes an API key. Requests using its token are rejected immediately. Requires a session cookie.'
  /* #swagger.responses[200] = { description: "Key revoked" } */
  /* #swagger.responses[404] = { description: "Key not found" } */
  const deleted = deleteApiKey(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: "API key not found." });
  }
  res.json({ ok: true });
});
