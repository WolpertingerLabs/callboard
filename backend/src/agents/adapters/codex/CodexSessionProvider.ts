/**
 * Codex session provider — scaffold stub.
 *
 * Wiring placeholder for discovery/reading of Codex CLI session rollouts
 * stored under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`
 * (see plans/codex-spike-findings.md §5). Registered in the factory's session
 * provider array so the merge layer is aware of the kind; every method throws
 * "WIP" until the session-provider slice implements the dated-tree scan and
 * the rollout parser.
 *
 * @see plans/codex-adapter-job.md (Step 9 session-provider)
 * @see plans/codex-spike-findings.md
 */
import type { ParsedMessage } from "shared/types/index.js";
import type {
  SessionProvider,
  DiscoverResult,
  ResolvedSession,
  SubagentFile,
  SessionSearchFilters,
  SessionSearchResponse,
} from "../../ports/SessionProvider.js";

const WIP = "CodexSessionProvider is not yet implemented (WIP) — see plans/codex-adapter-job.md";

export class CodexSessionProvider implements SessionProvider {
  readonly kind = "codex" as const;

  discoverSessions(_opts: { limit: number; offset: number }): DiscoverResult {
    throw new Error(WIP);
  }

  resolveSession(_sessionId: string): ResolvedSession | null {
    throw new Error(WIP);
  }

  findSubagentFiles(_sessionId: string): SubagentFile[] {
    throw new Error(WIP);
  }

  parseSessionMessages(_sessionIds: string[]): ParsedMessage[] {
    throw new Error(WIP);
  }

  getSessionPreview(_logPath: string, _maxLength?: number): string | null {
    throw new Error(WIP);
  }

  searchSessions(_filters: SessionSearchFilters): SessionSearchResponse {
    throw new Error(WIP);
  }

  deleteSessionFiles(_sessionId: string): void {
    throw new Error(WIP);
  }
}
