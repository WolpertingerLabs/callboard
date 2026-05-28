/**
 * OpenRouter API — exposes the cached list of tool-calling-capable models.
 *
 * GET /api/openrouter/models — { models: OpenRouterModelInfo[] }
 */
import { Router } from "express";
import { getOpenRouterModelsAsync } from "../services/openrouter-models.js";

export const openRouterRouter = Router();

openRouterRouter.get("/models", async (_req, res) => {
  try {
    const models = await getOpenRouterModelsAsync();
    res.json({ models });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to get OpenRouter models" });
  }
});
