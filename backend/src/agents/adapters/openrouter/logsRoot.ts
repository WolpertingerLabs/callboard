/**
 * Single source of truth for resolving the OpenRouter logs root.
 *
 * The write side (`optionsAdapter` → `OpenRouterAgentRun.logsRoot`) and the
 * read side (`OpenRouterSessionProvider`) MUST agree on this path — if
 * they don't, callboard reads from one directory while OR writes to
 * another and chat history silently appears empty.
 *
 * Resolution order (first match wins):
 *   1. `getAgentSettings().openRouterLogsRoot` if set
 *   2. `$XDG_DATA_HOME/openrouter-agent-coder/logs` if env is set
 *   3. `<os.homedir()>/.openrouter-agent-coder/logs` (default)
 *
 * @see plans/openrouter-adapter.md §7 (SessionProvider — logsRoot)
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentSettings } from "../../../services/agent-settings.js";

export function resolveOpenRouterLogsRoot(): string {
  const fromSettings = getAgentSettings().openRouterLogsRoot?.trim();
  if (fromSettings) return fromSettings;
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim()) return join(xdg.trim(), "openrouter-agent-coder", "logs");
  return join(homedir(), ".openrouter-agent-coder", "logs");
}
