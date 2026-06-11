/**
 * OpenRouter Models Service — caches the list of tool-calling-capable models
 * from OpenRouter's public /models endpoint.
 *
 * The list rarely changes, so we fetch it once on startup (non-blocking) and
 * keep it for the process lifetime. The endpoint is public — no API key is
 * required — so the cache warms even before the user configures OpenRouter.
 *
 * Mirrors the cache shape of {@link ./sdk-info.ts}.
 */
import type { OpenRouterModelInfo, OpenRouterModelAliasInfo } from "shared/types/index.js";
import { getAgentSettings } from "./agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("openrouter-models");

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

interface OpenRouterModelsCache {
  models: OpenRouterModelInfo[];
  fetchedAt: number;
}

// Raw shape of the relevant fields from OpenRouter's /models response.
interface RawOpenRouterModel {
  id?: string;
  name?: string;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string };
}

let cache: OpenRouterModelsCache | null = null;
let fetchPromise: Promise<OpenRouterModelsCache> | null = null;

function resolveModelsUrl(): string {
  const configured = getAgentSettings().openRouterBaseUrl?.trim();
  const base = (configured || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}/models`;
}

async function fetchOpenRouterModels(): Promise<OpenRouterModelsCache> {
  const url = resolveModelsUrl();
  log.info(`Fetching OpenRouter models from ${url}...`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { data?: RawOpenRouterModel[] };
    const raw = Array.isArray(body.data) ? body.data : [];

    const models: OpenRouterModelInfo[] = raw
      // Keep only models that advertise tool calling.
      .filter((m) => Array.isArray(m.supported_parameters) && m.supported_parameters.includes("tools"))
      .filter((m): m is RawOpenRouterModel & { id: string } => typeof m.id === "string" && m.id.length > 0)
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        promptPrice: m.pricing?.prompt ?? "0",
        completionPrice: m.pricing?.completion ?? "0",
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    log.info(`OpenRouter models fetched: ${models.length} tool-calling models (of ${raw.length} total)`);
    return { models, fetchedAt: Date.now() };
  } catch (err: any) {
    log.error(`Failed to fetch OpenRouter models: ${err.message}`);
    return { models: [], fetchedAt: Date.now() };
  }
}

/**
 * Initialize the OpenRouter models cache. Call once at startup.
 * Non-blocking — runs in the background.
 */
export function initOpenRouterModelsCache(): void {
  if (fetchPromise) return;
  fetchPromise = fetchOpenRouterModels().then((result) => {
    cache = result;
    return result;
  });
}

/**
 * Get cached OpenRouter models, waiting for the initial fetch if needed.
 * If init was never called, kicks it off now.
 */
export async function getOpenRouterModelsAsync(): Promise<OpenRouterModelInfo[]> {
  if (cache) return cache.models;
  if (fetchPromise) return (await fetchPromise).models;
  initOpenRouterModelsCache();
  return (await fetchPromise!).models;
}

/**
 * Invalidate and re-fetch the models cache. Useful after the base URL changes.
 */
export function refreshOpenRouterModelsCache(): Promise<OpenRouterModelsCache> {
  cache = null;
  fetchPromise = fetchOpenRouterModels().then((result) => {
    cache = result;
    return result;
  });
  return fetchPromise;
}

/**
 * Format an OpenRouter per-token USD price into a clean per-1M-token display:
 *  - free -> "0"
 *  - whole dollars >= 1 -> no decimals ("$30")
 *  - otherwise -> two decimals ("$1.25", "$0.08")
 */
export function formatOpenRouterPrice(perToken: string): string {
  const perMillion = parseFloat(perToken) * 1_000_000;
  if (!isFinite(perMillion) || perMillion <= 0) return "0";
  const rounded = Math.round(perMillion * 100) / 100;
  if (rounded >= 1 && Number.isInteger(rounded)) return `$${rounded}`;
  return `$${rounded.toFixed(2)}`;
}

// Case-insensitive subsequence test: every char of `query` appears in `target`
// in order (not necessarily contiguous). "claop" matches "anthropic/claude-opus".
function isSubsequence(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++;
  }
  return i === q.length;
}

/**
 * Subsequence-search the cached tool-calling models by slug.
 * An empty query returns the full (sorted) list.
 */
export async function searchOpenRouterModels(query: string, limit = 50): Promise<OpenRouterModelInfo[]> {
  const models = await getOpenRouterModelsAsync();
  const q = query.trim();
  const matched = q === "" ? models : models.filter((m) => isSubsequence(q, m.id));
  return matched.slice(0, Math.max(1, limit));
}

/**
 * List user-defined model aliases, each joined with its target model's name
 * and pricing from the cached catalog. Targets that aren't in the cache
 * (stale cache, typo, non-tool-calling model) come back without the joined
 * fields rather than being dropped — the alias still resolves at run time.
 */
export async function getOpenRouterModelAliasesAsync(): Promise<OpenRouterModelAliasInfo[]> {
  const aliasMap = getAgentSettings().openRouterModelAliases;
  const entries = Object.entries(aliasMap ?? {});
  if (entries.length === 0) return [];
  const models = await getOpenRouterModelsAsync();
  const byId = new Map(models.map((m) => [m.id, m]));
  return entries
    .map(([alias, modelId]) => {
      const target = byId.get(modelId);
      return {
        alias,
        modelId,
        ...(target && { name: target.name, promptPrice: target.promptPrice, completionPrice: target.completionPrice }),
      };
    })
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

/**
 * Subsequence-search user-defined aliases by alias name or target slug.
 * An empty query returns all aliases.
 */
export async function searchOpenRouterModelAliases(query: string, limit = 50): Promise<OpenRouterModelAliasInfo[]> {
  const aliases = await getOpenRouterModelAliasesAsync();
  const q = query.trim();
  const matched = q === "" ? aliases : aliases.filter((a) => isSubsequence(q, a.alias) || isSubsequence(q, a.modelId));
  return matched.slice(0, Math.max(1, limit));
}
