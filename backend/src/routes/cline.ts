/**
 * Cline API — the providers and models the embedded `@cline/sdk` runtime can
 * route to.
 *
 * - `GET /api/cline/providers` → `{ providers: string[] }`
 * - `GET /api/cline/models?providerId=anthropic` → `{ providerId, models }`
 *
 * Both answer from the SDK rather than from a table in callboard, so an SDK bump
 * that adds a provider or a model needs no edit here.
 *
 * Contrast with `routes/acp.ts`, which serves a catalog *harvested* from past
 * chats because ACP exposes models only through a live session. Cline has no
 * such constraint — nothing is spawned and no session is created to answer these
 * — so a user who has never run a Cline chat still gets a populated picker.
 *
 * An unreachable provider yields an empty list and a 200, not a 500: the model
 * field accepts free text either way, exactly as the Codex and ACP selectors
 * already do for slugs newer than their catalog.
 */
import { Router } from "express";
import { getClineModels, listClineProviderIds } from "../agents/adapters/cline/modelCatalog.js";

export const clineRouter = Router();

clineRouter.get("/providers", (_req, res) => {
  // #swagger.tags = ['Cline']
  // #swagger.summary = 'List the model providers the Cline runtime supports'
  // #swagger.description = 'Provider ids the embedded @cline/sdk runtime ships support for, read from the SDK itself rather than a table in callboard. Use one of these as clineProviderId in Settings.'
  /* #swagger.responses[200] = { description: 'Supported Cline provider ids' } */
  return res.json({ providers: listClineProviderIds() });
});

clineRouter.get("/models", async (req, res) => {
  // #swagger.tags = ['Cline']
  // #swagger.summary = 'Get the models a Cline provider offers'
  // #swagger.description = 'Models the given Cline provider will route to. Answered from the SDK provider layer without starting a session. An empty list means the provider could not be reached, not that it has no models - the model field accepts free text either way.'
  /* #swagger.parameters['providerId'] = { in: 'query', required: true, type: 'string', description: 'Cline provider id, e.g. anthropic' } */
  /* #swagger.responses[200] = { description: 'Known models for the provider' } */
  /* #swagger.responses[400] = { description: 'Missing providerId' } */
  const providerId = typeof req.query.providerId === "string" ? req.query.providerId.trim() : "";
  if (!providerId) return res.status(400).json({ error: "providerId is required" });

  const models = await getClineModels(providerId);
  return res.json({ providerId, models });
});
