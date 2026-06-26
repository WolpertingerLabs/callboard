/**
 * Codex auth-readiness check, surfaced to the frontend via
 * `GET /api/system-info`'s `codexConfigured` flag (same pattern as
 * `openRouterConfigured`). The New Chat panel / ApiSettings use it to enable
 * or gray-out the Codex provider toggle without ever exposing credentials.
 *
 * "Configured" mirrors the three auth paths the Codex CLI accepts:
 *   - api-key mode  → a non-empty `codexApiKey` is set in agent settings.
 *   - subscription  → `$CODEX_HOME/auth.json` exists and parses as JSON
 *                     (written by `codex login`). We don't validate token
 *                     freshness here; the CLI refreshes on use.
 *   - config.toml   → `$CODEX_HOME/config.toml` declares a `model_provider`
 *                     or `[model_providers.*]` block (custom provider with
 *                     `env_key` / `experimental_bearer_token`). This is the
 *                     manual-setup path that bypasses `codex login`.
 *
 * Trust-only config.toml files (just `[projects.*]` blocks) don't count —
 * they're not an auth signal, and the CLI would still fail without `auth.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentSettings } from "../../../services/agent-settings.js";
import { resolveCodexHome } from "./sessionParser.js";

/** Which credential source backs the configured-state, or `null` when none. */
export type CodexAuthSource = "api-key" | "auth.json" | "config.toml" | null;

/** Heuristic: does this config.toml declare a provider (and therefore auth)? */
function tomlDeclaresProvider(content: string): boolean {
  // `model_provider = "..."` (top-level active-provider selector) OR
  // `[model_providers.<id>]` (custom provider definition). Either is enough
  // signal that the user has set up Codex auth manually via TOML.
  return /^\s*model_provider\s*=/m.test(content) || /^\s*\[model_providers\./m.test(content);
}

/**
 * Resolve which credential source (if any) backs Codex. Auth.json wins over
 * config.toml when both exist — it's the canonical `codex login` output and
 * matches the built-in `openai` provider's auth path.
 */
export function getCodexAuthSource(): CodexAuthSource {
  let settings;
  try {
    settings = getAgentSettings();
  } catch {
    return null;
  }

  if (settings.codexAuthMode === "api-key") {
    return settings.codexApiKey?.trim() ? "api-key" : null;
  }

  const home = resolveCodexHome();

  try {
    const authPath = join(home, "auth.json");
    if (existsSync(authPath)) {
      JSON.parse(readFileSync(authPath, "utf-8"));
      return "auth.json";
    }
  } catch {
    // auth.json present but malformed — fall through to config.toml.
  }

  try {
    const tomlPath = join(home, "config.toml");
    if (existsSync(tomlPath) && tomlDeclaresProvider(readFileSync(tomlPath, "utf-8"))) {
      return "config.toml";
    }
  } catch {
    // ignore — treat as unconfigured
  }

  return null;
}

/** True when Codex has usable credentials for the active auth mode. */
export function isCodexConfigured(): boolean {
  return getCodexAuthSource() !== null;
}

/**
 * Detect whether the ambient environment already routes the native Codex
 * harness through OpenRouter — either OPENAI_BASE_URL points at openrouter.ai,
 * or `$CODEX_HOME/config.toml` declares an openrouter base_url. Surfaced via
 * /api/system-info so Settings → API can default the "Route through OpenRouter"
 * toggle on before the user explicitly chooses.
 */
export function detectCodexOpenRouterEnv(): boolean {
  if (/openrouter\.ai/i.test(process.env.OPENAI_BASE_URL ?? "")) return true;
  try {
    const tomlPath = join(resolveCodexHome(), "config.toml");
    if (existsSync(tomlPath) && /openrouter\.ai/i.test(readFileSync(tomlPath, "utf-8"))) {
      return true;
    }
  } catch {
    // ignore — treat as not detected
  }
  return false;
}
