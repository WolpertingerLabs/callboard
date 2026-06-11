/**
 * OpenRouter API — exposes the cached list of tool-calling-capable models
 * plus the user-defined model aliases (joined with target pricing).
 *
 * GET /api/openrouter/models — { models: OpenRouterModelInfo[], aliases: OpenRouterModelAliasInfo[] }
 */
import { Router } from "express";
import { getOpenRouterModelsAsync, getOpenRouterModelAliasesAsync } from "../services/openrouter-models.js";

export const openRouterRouter = Router();

openRouterRouter.get("/models", async (_req, res) => {
  try {
    const [models, aliases] = await Promise.all([getOpenRouterModelsAsync(), getOpenRouterModelAliasesAsync()]);
    res.json({ models, aliases });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to get OpenRouter models" });
  }
});
