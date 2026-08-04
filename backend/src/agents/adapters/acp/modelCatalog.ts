/**
 * The model catalog an ACP vendor advertises, harvested from real sessions.
 *
 * ## Why harvested rather than probed
 *
 * ACP 1.3.0 has no models API. The catalog exists in exactly one place — the
 * `configOptions` returned by `session/new` / `session/resume` — so a client can
 * only learn it by opening a session. The obvious implementation is the one
 * `codex-models.ts` uses for Codex: ask the vendor once at startup and cache the
 * answer.
 *
 * That is the wrong shape here, and the reason is specific rather than
 * theoretical: **a promptless ACP session persists.** Opening one against
 * OpenCode purely to read its catalog leaves a `New session - <timestamp>` entry
 * in the user's own session list, verified with `opencode session list`. One per
 * daemon start, forever, in a tool callboard does not own.
 *
 * So nothing is spawned for discovery. Every ACP chat already receives the full
 * catalog when its session is attached, and that is where the cache is filled
 * from. The cost is a cold start — a vendor the user has never run has no known
 * models — which is exactly the state Codex's own selector already handles by
 * accepting free text. A model callboard has never seen still works; it is
 * simply not suggested.
 *
 * ## Persistence
 *
 * `<DATA_DIR>/acp-models.json`, so the catalog survives a daemon restart and the
 * picker is useful on the first chat after one rather than the second. Writes
 * are best-effort: a catalog is a convenience, and losing it costs a suggestion
 * list, never a chat.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { createLogger } from "../../../utils/logger.js";
import { resolveAcpSessionsRoot } from "./transcript.js";

const log = createLogger("acp-models");

/** One selectable model, in the shape `AgentQuery.supportedModels()` returns. */
export interface AcpModelInfo {
  value: string;
  displayName: string;
  description: string;
}

/** A vendor's catalog plus when it was last seen, for the API to report. */
export interface AcpModelCatalog {
  providerId: string;
  models: AcpModelInfo[];
  /** ISO timestamp of the session that produced this list. */
  discoveredAt: string;
  /** The model that session was running on, when the agent reported one. */
  currentValue?: string;
}

/**
 * Flatten a session's `configOptions` into the model list.
 *
 * The single implementation of this projection — `AcpAgentQuery.supportedModels`
 * calls it too, so the list the UI suggests and the list the query reports
 * cannot drift.
 *
 * Two shapes have to be handled because the schema allows both:
 * `SessionConfigSelectOptions` is either a flat array of
 * `SessionConfigSelectOption` or an array of groups that each hold one. And each
 * value is `{value, name}` — `id` belongs to the enclosing option (the "model"
 * selector itself), which is the confusion that made this return [] for every
 * vendor before it was fixed.
 */
export function extractAcpModels(configOptions: readonly SessionConfigOption[] | null | undefined): { models: AcpModelInfo[]; currentValue?: string } {
  if (!Array.isArray(configOptions)) return { models: [] };
  const modelOption = configOptions.find((o) => o?.category === "model" && o.type === "select");
  if (!modelOption || modelOption.type !== "select") return { models: [] };
  const options = modelOption.options;
  if (!Array.isArray(options)) return { models: [] };

  const models: AcpModelInfo[] = [];
  for (const entry of options) {
    if (!entry || typeof entry !== "object") continue;
    const group = (entry as { options?: unknown }).options;
    const candidates = Array.isArray(group) ? group : [entry];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const value = (candidate as { value?: unknown }).value;
      if (typeof value !== "string" || !value) continue;
      const name = (candidate as { name?: unknown }).name;
      const description = (candidate as { description?: unknown }).description;
      models.push({
        value,
        displayName: typeof name === "string" && name ? name : value,
        description: typeof description === "string" && description ? description : value,
      });
    }
  }
  const current = (modelOption as { currentValue?: unknown }).currentValue;
  return { models, ...(typeof current === "string" && current ? { currentValue: current } : {}) };
}

/**
 * The `configId` this agent uses for its model selector, or null when it offers
 * none.
 *
 * Derived from the session rather than hardcoded to `"model"`. `category` is the
 * standardized field — ACP defines it as the semantic hint — while `id` is the
 * agent's own name for the option, and only `id` may be sent back on
 * `session/set_config_option`. OpenCode happens to use `"model"` for both; an
 * agent that names it `"llm"` would still work, and one that offers no model
 * option at all is reported honestly instead of being sent a request it will
 * reject with `unknown config option`.
 */
export function acpModelConfigId(configOptions: readonly SessionConfigOption[] | null | undefined): string | null {
  if (!Array.isArray(configOptions)) return null;
  const option = configOptions.find((o) => o?.category === "model" && o.type === "select");
  const id = (option as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id ? id : null;
}

/** `<DATA_DIR>/acp-models.json`. Resolved per call — see resolveAcpSessionsRoot. */
function catalogPath(): string {
  return join(dirname(resolveAcpSessionsRoot()), "acp-models.json");
}

let cache: Record<string, AcpModelCatalog> | null = null;

function load(): Record<string, AcpModelCatalog> {
  if (cache) return cache;
  cache = {};
  try {
    const path = catalogPath();
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
          const e = entry as Partial<AcpModelCatalog>;
          if (e && Array.isArray(e.models))
            cache[id] = { providerId: id, models: e.models, discoveredAt: e.discoveredAt ?? "", ...(e.currentValue ? { currentValue: e.currentValue } : {}) };
        }
      }
    }
  } catch (err) {
    // A corrupt catalog is a lost suggestion list, not a broken daemon.
    log.warn(`could not read the ACP model catalog: ${err instanceof Error ? err.message : String(err)}`);
    cache = {};
  }
  return cache;
}

/**
 * Record what a vendor advertised on a session it just opened.
 *
 * Called from the query's attach path. A session that reports no model option
 * (the agent has no catalog, or does not surface one) leaves any previously
 * known list alone rather than blanking it — an agent that goes quiet about its
 * models has not withdrawn them.
 */
export function recordAcpModels(providerId: string, configOptions: readonly SessionConfigOption[] | null | undefined, now: string): void {
  const { models, currentValue } = extractAcpModels(configOptions);
  if (models.length === 0) return;

  const store = load();
  store[providerId] = { providerId, models, discoveredAt: now, ...(currentValue ? { currentValue } : {}) };
  try {
    const path = catalogPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2), "utf8");
    log.debug(`recorded ${models.length} model(s) for ACP provider "${providerId}"`);
  } catch (err) {
    // Kept in memory regardless; only the restart-survival is lost.
    log.warn(`could not persist the ACP model catalog: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** What is known about a vendor's models, or null if it has never been run. */
export function getAcpModelCatalog(providerId: string): AcpModelCatalog | null {
  return load()[providerId] ?? null;
}

/** Test seam: drop the in-memory copy so the next read comes from disk. */
export function resetAcpModelCatalogCache(): void {
  cache = null;
}
