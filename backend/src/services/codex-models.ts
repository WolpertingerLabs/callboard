/**
 * Codex Models Service — caches the live Codex model catalog reported by the
 * installed Codex CLI.
 *
 * Codex does not expose model discovery through the TypeScript SDK, but the CLI
 * documents `codex debug models` as the raw model catalog Codex sees. We run it
 * on startup, non-blocking, and re-run it when a read finds the answer older
 * than {@link CODEX_MODELS_TTL_MS}. If the installed CLI is missing/old/offline,
 * we fall back to a small static suggestion list so free-text model entry still
 * works.
 *
 * ## Why the TTL
 *
 * This used to keep the first answer for the process lifetime: `fetchedAt` was
 * recorded and never read. On a daemon that is days, and it fails in the
 * direction that hurts — upgrading the Codex CLI, or logging in so the catalog
 * stops being the anonymous one, changed nothing until someone restarted
 * callboard. Worse, the fallback was cached on exactly the same terms, so a
 * daemon that started before Codex was installed served the static list
 * forever.
 *
 * Failures are therefore retried on a much shorter window than successes, and a
 * failed refresh keeps the last *live* catalog rather than collapsing back to
 * the static one. No timer, unlike the OpenRouter catalog: every consumer here
 * is async, so a read is always available to carry the refresh.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CodexModelInfo } from "shared/types/index.js";
import { getApiEnvOverrides, getCodexExecutablePath } from "./agent-settings.js";
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

/** How long a live catalog is served before a read re-runs the CLI. */
export const CODEX_MODELS_TTL_MS = 60 * 60 * 1000;

/**
 * How long a fallback result is served before a read tries again.
 *
 * Much shorter than the success TTL because the fallback is a guess, and the
 * conditions that produce it — Codex not installed yet, not logged in yet, a
 * half-finished upgrade — are exactly the ones a user fixes and then expects to
 * see reflected.
 */
export const CODEX_MODELS_RETRY_MS = 60 * 1000;

let cache: CodexModelsCache | null = null;
let fetchPromise: Promise<CodexModelsCache> | null = null;

/**
 * Bumped by {@link refreshCodexModelsCache}. A run that started before the bump
 * describes the previous binary or credentials, so it must not overwrite the
 * newer answer; it captures the generation it began in and drops out on
 * mismatch. This one is not hypothetical — the refresh is wired to settings
 * changes at `routes/agent-settings.ts`, so a slow `codex debug models` racing
 * a settings save is an ordinary Tuesday.
 */
let generation = 0;

/**
 * Which `codex` answers `debug models`.
 *
 * The configured override wins, for the reason the whole binary-override
 * feature exists: this catalog populates the model picker, and a picker filled
 * in by a *different* binary than the one running chats is a third opinion about
 * which Codex this machine has. A user who points Callboard at a newer CLI to
 * get a newer model would otherwise pick from the bundled copy's list and be
 * told their model does not exist — or, worse, not be offered it at all.
 *
 * `getCodexExecutablePath` is the same resolver `claude.ts` and
 * `engine-status.ts` use, so a rejected override falls back here exactly as it
 * does there. Absent ⇒ the bundled `codex.js` shim, as before.
 */
function resolveCodexBin(): { command: string; argsPrefix: string[] } {
  const override = getCodexExecutablePath();
  if (override) return { command: override, argsPrefix: [] };

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
  try {
    // Inside the try: this resolves a binary path off settings and can throw,
    // and this function is contracted never to reject — callers treat its
    // promise as the cache itself, so a rejection would strand `fetchPromise`
    // and stop the catalog refreshing for the life of the process.
    const { command, argsPrefix } = resolveCodexBin();
    const args = [...argsPrefix, "debug", "models"];
    log.info(`Fetching Codex models via ${[command, ...args].join(" ")}...`);

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
  } catch (err) {
    // Carry whatever we are holding forward, and note that the condition is
    // "do we have anything", NOT "was the last result live". Gating on
    // `source === "live"` looks equivalent and is not: the first failure
    // rewrites `source` to "fallback" while keeping the real models, so the
    // *second* consecutive failure would see a non-live source and throw the
    // user's real catalog away in favour of three hardcoded guesses. Two failed
    // runs a minute apart is an ordinary CLI upgrade.
    const message = err instanceof Error ? err.message : String(err);
    const previous = cache?.models.length ? cache.models : null;
    log.error(`Failed to fetch Codex models: ${message}${previous ? ` (keeping ${previous.length} cached)` : ""}`);
    // Copied, not aliased: `STATIC_MODELS` is module-level and this array is
    // handed to every caller of getCodexModelsAsync().
    return { models: previous ?? [...STATIC_MODELS], fetchedAt: Date.now(), source: "fallback" };
  }
}

/** True while `entry` may still be served without re-running the CLI. */
function isFresh(entry: CodexModelsCache): boolean {
  return Date.now() - entry.fetchedAt < (entry.source === "live" ? CODEX_MODELS_TTL_MS : CODEX_MODELS_RETRY_MS);
}

/**
 * The cache, re-running the CLI first if it has aged out. Concurrent callers
 * share one in-flight run. Never rejects.
 */
function ensureCodexModels(): Promise<CodexModelsCache> {
  if (cache && isFresh(cache)) return Promise.resolve(cache);
  if (!fetchPromise) {
    const gen = generation;
    fetchPromise = fetchCodexModels()
      .then((result) => {
        if (gen === generation) cache = result;
        return result;
      })
      .finally(() => {
        // In `finally`, not `then`: were this ever skipped, `fetchPromise`
        // would stay non-null and no read could refresh the cache again.
        if (gen === generation) fetchPromise = null;
      });
  }
  return fetchPromise;
}

/**
 * Initialize the Codex models cache. Call once at startup.
 * Non-blocking — runs in the background.
 */
export function initCodexModelsCache(): void {
  void ensureCodexModels();
}

/**
 * Get cached Codex models, waiting for a run if the cache is cold or has aged
 * past {@link CODEX_MODELS_TTL_MS}.
 */
export async function getCodexModelsAsync(): Promise<CodexModelInfo[]> {
  return (await ensureCodexModels()).models;
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
  generation++;
  cache = null;
  fetchPromise = null;
  return ensureCodexModels();
}

/** Test-only: drop the cached catalog and any in-flight run. */
export function resetCodexModelsCacheForTesting(): void {
  generation++;
  cache = null;
  fetchPromise = null;
}
