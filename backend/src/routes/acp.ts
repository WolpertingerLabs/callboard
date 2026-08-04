/**
 * ACP API — the model catalog callboard has learned for each ACP vendor.
 *
 * `GET /api/acp/models?providerId=opencode` →
 *   `{ providerId, models, discoveredAt, currentValue }`
 *
 * Mirrors `GET /api/codex/models`, with one deliberate difference: this endpoint
 * never spawns anything. Codex can be asked for its catalog with a cheap
 * `codex debug models` exec, whereas ACP exposes models only through a session —
 * and a promptless ACP session persists in the vendor's own store (verified
 * against OpenCode). So the catalog is harvested from real chats instead; see
 * `adapters/acp/modelCatalog.ts`.
 *
 * The consequence the UI has to handle: a vendor the user has never run reports
 * an empty list. That is the honest answer, and the model field accepts free
 * text regardless, exactly as the Codex selector already does for slugs newer
 * than its catalog.
 */
import { Router } from "express";
import { getAcpModelCatalog } from "../agents/adapters/acp/modelCatalog.js";
import { resolveAcpVendorPreset } from "../agents/adapters/acp/vendors.js";

export const acpRouter = Router();

acpRouter.get("/models", (req, res) => {
  // #swagger.tags = ['ACP']
  // #swagger.summary = 'Get the known model catalog for an ACP vendor'
  // #swagger.description = 'Returns the models callboard has seen this ACP vendor advertise, harvested from previous sessions rather than probed (a promptless ACP session persists in the vendor own store). An empty list means the vendor has not been run yet, not that it has no models — the model field accepts free text either way.'
  /* #swagger.parameters['providerId'] = { in: 'query', required: true, type: 'string', description: 'Configured ACP provider id, e.g. opencode' } */
  /* #swagger.responses[200] = { description: 'Known models for the vendor' } */
  /* #swagger.responses[400] = { description: 'Missing or unknown providerId' } */
  const providerId = typeof req.query.providerId === "string" ? req.query.providerId.trim() : "";
  if (!providerId) return res.status(400).json({ error: "providerId is required" });
  if (!resolveAcpVendorPreset(providerId)) return res.status(400).json({ error: `Unknown ACP provider "${providerId}"` });

  const catalog = getAcpModelCatalog(providerId);
  // A vendor with no catalog yet is a 200 with an empty list, not a 404: the
  // provider exists, callboard just has not watched it open a session.
  return res.json(catalog ?? { providerId, models: [], discoveredAt: "" });
});
