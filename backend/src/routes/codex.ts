/**
 * Codex API — exposes the cached live model catalog reported by
 * `codex debug models`.
 *
 * GET /api/codex/models — { models: CodexModelInfo[] }
 */
import { Router } from "express";
import { getVisibleCodexModelsAsync } from "../services/codex-models.js";

export const codexRouter = Router();

codexRouter.get("/models", async (_req, res) => {
  try {
    const models = await getVisibleCodexModelsAsync();
    res.json({ models });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to get Codex models" });
  }
});
