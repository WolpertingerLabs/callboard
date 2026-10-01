/**
 * OpenRouter API — exposes the cached list of tool-calling-capable models.
 *
 * GET /api/openrouter/models — { models: OpenRouterModelInfo[], aliases: [] }
 *
 * `aliases` is always empty. It used to carry the deprecated
 * `openRouterModelAliases` map, pinned at the top of the model picker, but those
 * aliases only ever had an `openrouter` target, which resolves nowhere since the
 * OpenRouter engine was removed: picking one silently fell back to the default
 * model, or sent the alias name to OpenRouter as a slug. The key stays because
 * an older tab reads it. Cross-harness aliases live in Settings → Model Aliases.
 */
import { Router } from "express";
import { getOpenRouterModelsAsync } from "../services/openrouter-models.js";

export const openRouterRouter = Router();

openRouterRouter.get("/models", async (_req, res) => {
  try {
    const models = await getOpenRouterModelsAsync();
    res.json({ models, aliases: [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to get OpenRouter models" });
  }
});
