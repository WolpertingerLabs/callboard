/**
 * Codex API — exposes the cached live model catalog reported by
 * `codex debug models`.
 *
 * GET /api/codex/models — { models: CodexModelInfo[] }
 */
import { Router } from "express";
import { getVisibleCodexModelsAsync } from "../services/codex-models.js";

import { resolveReasoningCapability } from "../services/reasoning-capabilities.js";

export const codexRouter = Router();

codexRouter.get("/models", async (_req, res) => {
  try {
    const models = await getVisibleCodexModelsAsync();
    res.json({ models });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to get Codex models" });
  }
});

codexRouter.get("/reasoning", async (req, res) => {
  try {
    res.json(
      await resolveReasoningCapability({
        provider: typeof req.query.provider === "string" ? req.query.provider : undefined,
        model: typeof req.query.model === "string" ? req.query.model : undefined,
      }),
    );
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to resolve reasoning capabilities" });
  }
});
