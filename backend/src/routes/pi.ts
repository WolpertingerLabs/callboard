/**
 * pi API — the providers and models the embedded `@earendil-works/pi-coding-agent`
 * runtime can route to.
 *
 * - `GET /api/pi/providers` → `{ providers: string[] }`
 * - `GET /api/pi/models?providerId=openrouter` → `{ providerId, models }`
 *
 * Both answer from the package's own bundled catalog rather than from a table in
 * callboard, so a version bump that adds a provider or a model needs no edit
 * here.
 *
 * Stronger than the Cline equivalent in one respect: these are answered with the
 * **network explicitly disabled** (`allowModelNetwork: false`), off a catalog
 * shipped inside the package — measured at 1,157 models across all providers,
 * 307 of them OpenRouter's. So a user who has never run a pi chat, and who has
 * not yet entered a key, still gets a fully populated picker, and no model
 * lookup can hang on a provider being down.
 *
 * Contrast with `routes/acp.ts`, which serves a catalog *harvested* from past
 * chats because ACP exposes models only through a live session.
 *
 * An unreadable catalog yields an empty list and a 200, not a 500: the model
 * field accepts free text either way, exactly as the Codex, ACP and Cline
 * selectors already do for slugs newer than their catalog.
 */
import { Router } from "express";
import { getPiModels, listPiProviderIds } from "../agents/adapters/pi/modelCatalog.js";

export const piRouter = Router();

piRouter.get("/providers", async (_req, res) => {
  // #swagger.tags = ['pi']
  // #swagger.summary = 'List the model providers the pi runtime supports'
  // #swagger.description = 'Provider ids the embedded pi runtime ships a model catalog for, read from the package itself rather than a table in callboard. Answered offline. Use one of these as piProviderId in Settings.'
  /* #swagger.responses[200] = { description: 'Supported pi provider ids' } */
  return res.json({ providers: await listPiProviderIds() });
});

piRouter.get("/models", async (req, res) => {
  // #swagger.tags = ['pi']
  // #swagger.summary = 'Get the models a pi provider offers'
  // #swagger.description = 'Models the given pi provider will route to, from the catalog bundled with the pi package. Answered offline and without a configured API key, so the picker is populated before the provider is set up. An empty list means the catalog could not be read, not that the provider has no models - the model field accepts free text either way.'
  /* #swagger.parameters['providerId'] = { in: 'query', required: true, type: 'string', description: 'pi provider id, e.g. openrouter' } */
  /* #swagger.responses[200] = { description: 'Known models for the provider' } */
  /* #swagger.responses[400] = { description: 'Missing providerId' } */
  const providerId = typeof req.query.providerId === "string" ? req.query.providerId.trim() : "";
  if (!providerId) return res.status(400).json({ error: "providerId is required" });

  const models = await getPiModels(providerId);
  return res.json({ providerId, models });
});
