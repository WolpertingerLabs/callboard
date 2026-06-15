/**
 * Codex Models Service — caches the live Codex model catalog reported by the
 * installed Codex CLI.
 *
 * Codex does not expose model discovery through the TypeScript SDK, but the CLI
 * documents `codex debug models` as the raw model catalog Codex sees. We run it
 * once on startup, non-blocking, and keep the result for the process lifetime.
 * If the installed CLI is missing/old/offline, we fall back to a small static
 * suggestion list so free-text model entry still works.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CodexModelInfo } from "shared/types/index.js";
import { getApiEnvOverrides } from "./agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("codex-models");
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const REFRESH_TIMEOUT_MS = 15_000;

const STATIC_MODELS: CodexModelInfo[] = [
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    description: "Latest GPT-5 agentic coding model",
    visibility: "list",
    supportedInApi: true,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    description: "GPT-5.4 agentic coding model",
    visibility: "list",
    supportedInApi: true,
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    description: "Faster, lower-cost GPT-5.4 coding model",
    visibility: "list",
    supportedInApi: true,
  },
];

interface CodexModelsCache {
  models: CodexModelInfo[];
  fetchedAt: number;
  source: "live" | "fallback";
}

interface RawCodexModel {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  service_tiers?: unknown;
}

let cache: CodexModelsCache | null = null;
let fetchPromise: Promise<CodexModelsCache> | null = null;

function resolveCodexBin(): { command: string; argsPrefix: string[] } {
  try {
    const packageJsonPath = require.resolve("@openai/codex/package.json");
    return {
      command: process.execPath,
      argsPrefix: [join(dirname(packageJsonPath), "bin", "codex.js")],
    };
  } catch {
    return { command: "codex", argsPrefix: [] };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseReasoningLevels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { effort?: unknown }).effort === "string") {
        return (item as { effort: string }).effort;
      }
      return "";
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseServiceTiers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
        return (item as { id: string }).id;
      }
      return "";
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseCodexModelsCatalog(rawBody: unknown): CodexModelInfo[] {
  const body = rawBody as { models?: unknown };
  const raw = Array.isArray(body?.models) ? (body.models as RawCodexModel[]) : [];
  return raw
    .map((m, index) => {
      if (!m || typeof m !== "object") return null;
      const id = asString(m.slug);
      if (!id) return null;
      const name = asString(m.display_name) ?? id;
      const visibility = asString(m.visibility);
      return {
        index,
        model: {
          id,
          name,
          ...(asString(m.description) && { description: asString(m.description) }),
          ...(visibility && { visibility }),
          ...(typeof m.supported_in_api === "boolean" && { supportedInApi: m.supported_in_api }),
          ...(asString(m.default_reasoning_level) && { defaultReasoningLevel: asString(m.default_reasoning_level) }),
          ...(parseReasoningLevels(m.supported_reasoning_levels).length > 0 && {
            supportedReasoningLevels: parseReasoningLevels(m.supported_reasoning_levels),
          }),
          ...(parseServiceTiers(m.service_tiers).length > 0 && { serviceTiers: parseServiceTiers(m.service_tiers) }),
        } satisfies CodexModelInfo,
      };
    })
    .filter((m): m is { index: number; model: CodexModelInfo } => m !== null)
    .sort((a, b) => {
      const aVisible = a.model.visibility === "list" ? 0 : 1;
      const bVisible = b.model.visibility === "list" ? 0 : 1;
      return aVisible - bVisible || a.index - b.index;
    })
    .map((entry) => entry.model);
}

async function fetchCodexModels(): Promise<CodexModelsCache> {
  const { command, argsPrefix } = resolveCodexBin();
  const args = [...argsPrefix, "debug", "models"];
  log.info(`Fetching Codex models via ${[command, ...args].join(" ")}...`);

  try {
    const env = { ...process.env, ...getApiEnvOverrides() };
    const { stdout } = await execFileAsync(command, args, {
      env,
      timeout: REFRESH_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
    });
    const models = parseCodexModelsCatalog(JSON.parse(stdout));
    if (models.length === 0) {
      throw new Error("Codex catalog contained no models");
    }
    log.info(`Codex models fetched: ${models.filter((m) => m.visibility === "list").length} visible models (${models.length} total)`);
    return { models, fetchedAt: Date.now(), source: "live" };
  } catch (err: any) {
    log.error(`Failed to fetch Codex models: ${err.message}`);
    return { models: STATIC_MODELS, fetchedAt: Date.now(), source: "fallback" };
  }
}

/**
 * Initialize the Codex models cache. Call once at startup.
 * Non-blocking — runs in the background.
 */
export function initCodexModelsCache(): void {
  if (fetchPromise) return;
  fetchPromise = fetchCodexModels().then((result) => {
    cache = result;
    return result;
  });
}

/**
 * Get cached Codex models, waiting for the initial fetch if needed.
 * If init was never called, kicks it off now.
 */
export async function getCodexModelsAsync(): Promise<CodexModelInfo[]> {
  if (cache) return cache.models;
  if (fetchPromise) return (await fetchPromise).models;
  initCodexModelsCache();
  return (await fetchPromise!).models;
}

export async function getVisibleCodexModelsAsync(): Promise<CodexModelInfo[]> {
  const models = await getCodexModelsAsync();
  return models.filter((m) => m.visibility !== "hide");
}

// Case-insensitive subsequence test: every char of `query` appears in `target`
// in order (not necessarily contiguous). "g55" matches "gpt-5.5".
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
 * Subsequence-search the cached visible Codex models by slug or display name.
 * An empty query returns the full visible list.
 */
export async function searchCodexModels(query: string, limit = 50): Promise<CodexModelInfo[]> {
  const models = await getVisibleCodexModelsAsync();
  const q = query.trim();
  const matched = q === "" ? models : models.filter((m) => isSubsequence(q, m.id) || isSubsequence(q, m.name));
  return matched.slice(0, Math.max(1, limit));
}

/**
 * Invalidate and re-fetch the models cache. Useful after Codex auth/settings
 * change, or for manual refresh endpoints.
 */
export function refreshCodexModelsCache(): Promise<CodexModelsCache> {
  cache = null;
  fetchPromise = fetchCodexModels().then((result) => {
    cache = result;
    return result;
  });
  return fetchPromise;
}
