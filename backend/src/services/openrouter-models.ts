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
import type { OpenRouterModelInfo } from "shared/types/index.js";
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
