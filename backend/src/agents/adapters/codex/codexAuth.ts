/**
 * Codex auth-readiness check, surfaced to the frontend via
 * `GET /api/system-info`'s `codexConfigured` flag (same pattern as
 * `openRouterConfigured`). The New Chat panel / ApiSettings use it to enable
 * or gray-out the Codex provider toggle without ever exposing credentials.
 *
 * "Configured" mirrors the two auth paths the optionsAdapter supports:
 *   - api-key mode  → a non-empty `codexApiKey` is set in agent settings.
 *   - subscription  → `$CODEX_HOME/auth.json` exists and parses as JSON
 *                     (written by `codex login`). We don't validate token
 *                     freshness here; the CLI refreshes on use.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentSettings } from "../../../services/agent-settings.js";
import { resolveCodexHome } from "./sessionParser.js";

/** True when Codex has usable credentials for the active auth mode. */
export function isCodexConfigured(): boolean {
  let settings;
  try {
    settings = getAgentSettings();
  } catch {
    return false;
  }

  if (settings.codexAuthMode === "api-key") {
    return Boolean(settings.codexApiKey?.trim());
  }

  // Subscription mode (default): a parseable auth.json under $CODEX_HOME.
  try {
    const authPath = join(resolveCodexHome(), "auth.json");
    if (!existsSync(authPath)) return false;
    JSON.parse(readFileSync(authPath, "utf-8"));
    return true;
  } catch {
    return false;
  }
}
