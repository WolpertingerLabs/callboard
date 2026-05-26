/**
 * OpenRouter session provider — concrete {@link SessionProvider} backed by
 * `openrouter-agent-coder`'s on-disk session logs.
 *
 * Layout:
 *
 *     <logsRoot>/<sessionId>/
 *       session.json                 { sessionId, startedAt, cwd?, parentSessionId? }
 *       state.json                   { id, messages, previousResponseId, ... }
 *       req_<requestId>/
 *         request.json               { sessionId, requestId, prompt, timestamp }
 *         gen_<generationId>/
 *           response.json            raw OR Responses API response
 *
 * `logsRoot` resolution (first match wins):
 *   1. `getAgentSettings().openRouterLogsRoot` if set
 *   2. `$XDG_DATA_HOME/openrouter-agent-coder/logs` if env is set
 *   3. `<os.homedir()>/.openrouter-agent-coder/logs`
 *
 * Subagents are NOT discovered as separate session files in v1 — OR
 * subagents reuse the `<parentSessionId>:sub:<uuid>` naming scheme, so
 * findSubagentFiles() scans the same logsRoot for sibling directories
 * whose names start with `<sessionId>:sub:`. The Claude provider's notion
 * of an "agent file" maps onto OR's full child sessionId; v1 returns them
 * as `SubagentFile { agentId: childSessionId, filePath: <state.json> }`.
 *
 * @see plans/openrouter-adapter.md §7
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ParsedMessage } from "shared/types/index.js";
import type {
  DiscoverResult,
  ResolvedSession,
  SessionProvider,
  SessionSearchFilters,
  SessionSearchResponse,
  SubagentFile,
} from "../../ports/SessionProvider.js";
import { getAgentSettings } from "../../../services/agent-settings.js";
import { createLogger } from "../../../utils/logger.js";
import {
  parseOpenRouterState,
  readFirstUserPrompt,
  readRequestTimestamps,
  readStateJson,
} from "./sessionParser.js";

const log = createLogger("openrouter-session-provider");

interface SessionJson {
  sessionId?: string;
  startedAt?: string;
  cwd?: string;
  parentSessionId?: string;
}

export class OpenRouterSessionProvider implements SessionProvider {
  readonly kind = "openrouter" as const;

  /**
   * Resolve the OR logs root for the current process. Falls back through
   * settings → XDG → `~/.openrouter-agent-coder/logs`. The result may be
   * a path that doesn't exist yet — discovery returns an empty list rather
   * than throwing for that case.
   */
  private resolveLogsRoot(): string {
    const fromSettings = getAgentSettings().openRouterLogsRoot?.trim();
    if (fromSettings) return fromSettings;
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg && xdg.trim()) return join(xdg.trim(), "openrouter-agent-coder", "logs");
    return join(homedir(), ".openrouter-agent-coder", "logs");
  }

  /**
   * Resolve `<logsRoot>/<sessionId>` while rejecting any sessionId that
   * would escape the logs root via `..`, absolute paths, or path separators.
   * Returns `null` for unsafe inputs — callers treat that the same as "session
   * does not exist." Closes the path-traversal vector where a corrupted chat
   * metadata `provider: "openrouter"` could pair with a sessionId like `""`
   * or `".."` and turn `deleteSessionFiles()` into an arbitrary-rmSync.
   */
  private safeSessionDir(sessionId: string): { logsRoot: string; sessionDir: string } | null {
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    if (sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("\0")) return null;
    if (sessionId === "." || sessionId === ".." || sessionId.startsWith("../") || sessionId.startsWith("..\\")) {
      return null;
    }
    const logsRoot = this.resolveLogsRoot();
    const sessionDir = resolve(logsRoot, sessionId);
    const root = resolve(logsRoot);
    // Belt-and-suspenders: require the resolved path to be strictly inside
    // logsRoot. The string checks above already cover this for the
    // typical attacker inputs, but resolve() also collapses any embedded
    // `..` segments the validators above missed.
    if (sessionDir === root) return null;
    if (!sessionDir.startsWith(root + sep)) return null;
    return { logsRoot, sessionDir };
  }

  /** Read a session.json safely; returns null on missing / malformed. */
  private readSessionJson(sessionDir: string): SessionJson | null {
    const path = join(sessionDir, "session.json");
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as SessionJson;
    } catch {
      return null;
    }
  }

  // ── Discovery ───────────────────────────────────────────────────────

  discoverSessions(opts: { limit: number; offset: number }): DiscoverResult {
    const logsRoot = this.resolveLogsRoot();
    if (!existsSync(logsRoot)) return { sessions: [], total: 0 };

    let entries: { sessionId: string; sessionDir: string; mtime: Date; birthtime: Date }[];
    try {
      const dirEntries = readdirSync(logsRoot, { withFileTypes: true });
      entries = dirEntries
        .filter((d) => d.isDirectory())
        // Skip subagent slot dirs (`<parent>:sub:<uuid>`) — they surface
        // through findSubagentFiles, not as top-level chats.
        .filter((d) => !d.name.includes(":sub:"))
        .map((d) => {
          const sessionDir = join(logsRoot, d.name);
          // Require a recognizable session marker. Without this, any stale
          // dir under logsRoot (`.tmp/`, partial writes, anything else the
          // user dropped here) shows up as a ghost chat with no preview
          // and an empty conversation. The Claude provider gets this for
          // free because its discovery only matches `*.jsonl` files.
          if (!existsSync(join(sessionDir, "session.json")) && !existsSync(join(sessionDir, "state.json"))) {
            return null;
          }
          try {
            const st = statSync(sessionDir);
            return {
              sessionId: d.name,
              sessionDir,
              mtime: st.mtime,
              birthtime: st.birthtime,
            };
          } catch {
            return null;
          }
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);
    } catch (err) {
      log.warn(`Failed to read OR logsRoot ${logsRoot}: ${(err as Error).message}`);
      return { sessions: [], total: 0 };
    }

    entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const total = entries.length;
    const page = entries.slice(opts.offset, opts.offset + opts.limit);

    const sessions = page
      .map((entry) => {
        const sessionJson = this.readSessionJson(entry.sessionDir);
        // session.json's `cwd` (Phase 1.6 in the OR repo) is the canonical
        // working folder. Sessions written before that field existed get an
        // empty string — callers know to display "(unknown folder)".
        const folder = sessionJson?.cwd ?? "";
        return {
          sessionId: entry.sessionId,
          folder,
          displayFolder: folder,
          filePath: join(entry.sessionDir, "session.json"),
          createdAt: entry.birthtime,
          updatedAt: entry.mtime,
        };
      });

    return { sessions, total };
  }

  // ── Session resolution ──────────────────────────────────────────────

  resolveSession(sessionId: string): ResolvedSession | null {
    const safe = this.safeSessionDir(sessionId);
    if (!safe) return null;
    if (!existsSync(safe.sessionDir)) return null;
    const sessionJson = this.readSessionJson(safe.sessionDir);
    const folder = sessionJson?.cwd ?? "";
    return {
      logPath: join(safe.sessionDir, "session.json"),
      folder,
      displayFolder: folder,
    };
  }

  // ── Subagent files ──────────────────────────────────────────────────

  findSubagentFiles(sessionId: string): SubagentFile[] {
    // Validate sessionId so a hostile `""` doesn't degenerate the prefix to
    // `:sub:` and match every dir in logsRoot.
    if (this.safeSessionDir(sessionId) === null) return [];
    const logsRoot = this.resolveLogsRoot();
    if (!existsSync(logsRoot)) return [];
    const prefix = `${sessionId}:sub:`;
    try {
      return readdirSync(logsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
        .map((d) => ({
          agentId: d.name.slice(sessionId.length + 1), // drop `<parent>:`
          filePath: join(logsRoot, d.name, "state.json"),
        }))
        .filter((sub) => existsSync(sub.filePath));
    } catch {
      return [];
    }
  }

  // ── Message parsing ─────────────────────────────────────────────────

  parseSessionMessages(sessionIds: string[]): ParsedMessage[] {
    const all: ParsedMessage[] = [];

    for (const sid of sessionIds) {
      const safe = this.safeSessionDir(sid);
      if (!safe) continue;
      const state = readStateJson(safe.sessionDir);
      if (!state) continue;
      const timestamps = readRequestTimestamps(safe.sessionDir);
      all.push(...parseOpenRouterState(state, timestamps));

      // Inline subagent transcripts after their parent. Sequencing within a
      // single session is preserved by state.json's array order; we don't
      // currently splice subagent messages at their spawn point (that would
      // require correlating spawn_subagent tool_call IDs to child session
      // ids — a v2 refinement matching what the Claude provider does).
      for (const sub of this.findSubagentFiles(sid)) {
        const subDir = join(safe.logsRoot, `${sid}:${sub.agentId}`);
        const subState = readStateJson(subDir);
        if (!subState) continue;
        const subTimestamps = readRequestTimestamps(subDir);
        all.push(...parseOpenRouterState(subState, subTimestamps));
      }
    }

    return all;
  }

  // ── Preview ─────────────────────────────────────────────────────────

  getSessionPreview(logPath: string, maxLength = 100): string | null {
    // logPath is `<sessionDir>/session.json` — pull the first user prompt
    // from `<sessionDir>/req_*/request.json` so the chat list shows what
    // the user typed, not the random sessionId.
    const sessionDir = join(logPath, "..");
    const prompt = readFirstUserPrompt(sessionDir);
    if (!prompt) return null;
    return prompt.length > maxLength ? `${prompt.slice(0, maxLength)}…` : prompt;
  }

  // ── Search ──────────────────────────────────────────────────────────

  searchSessions(filters: SessionSearchFilters): SessionSearchResponse {
    // OR sessions have no concept of agentAlias / triggered / gitBranch
    // — those live on callboard's own chat metadata, which the merge layer
    // in routes/chats.ts joins onto session search results. Within the OR
    // provider's scope, the supported filters are `folder` (cwd-prefix
    // match via session.json) and `grep` (substring match across the
    // first user prompt). Date filters operate on the session.json
    // file's mtime.
    const { folder, grep, updatedAfter, updatedBefore, limit = 50 } = filters;
    const logsRoot = this.resolveLogsRoot();
    if (!existsSync(logsRoot)) return { chats: [], total: 0 };

    const matches: SessionSearchResponse["chats"] = [];
    let entries: string[];
    try {
      entries = readdirSync(logsRoot).filter((name) => !name.includes(":sub:"));
    } catch {
      return { chats: [], total: 0 };
    }

    for (const name of entries) {
      const sessionDir = join(logsRoot, name);
      let st;
      try {
        st = statSync(sessionDir);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }

      const sessionJson = this.readSessionJson(sessionDir);
      const cwd = sessionJson?.cwd ?? "";

      // Folder filter — OR's session.json carries cwd verbatim; Claude's
      // folder filter is exact-match, so we mirror that.
      if (folder && cwd !== folder) continue;

      // Date filters use the session.json mtime as a proxy for "session
      // last updated". A more accurate signal would scan the deepest
      // req_*/gen_*/response.json, but that's expensive and the difference
      // is small for non-pathological workloads.
      const updatedAt = st.mtime;
      if (updatedAfter && updatedAt < new Date(updatedAfter)) continue;
      if (updatedBefore && updatedAt > new Date(updatedBefore)) continue;

      // Grep filter — match against the first user prompt.
      if (grep) {
        const prompt = readFirstUserPrompt(sessionDir) ?? "";
        if (!prompt.toLowerCase().includes(grep.toLowerCase())) continue;
      }

      matches.push({
        chatId: name,
        sessionId: name,
        folder: cwd,
        repoFolder: cwd,
        isWorktree: false,
        gitBranch: null,
        agentAlias: null,
        triggered: false,
        createdAt: st.birthtime.toISOString(),
        updatedAt: updatedAt.toISOString(),
      });
    }

    matches.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const total = matches.length;
    return { chats: matches.slice(0, limit), total };
  }

  // ── Deletion ────────────────────────────────────────────────────────

  deleteSessionFiles(sessionId: string): void {
    // Reject malformed sessionIds outright — the most destructive operation
    // in the provider, so validation is non-negotiable.
    const safe = this.safeSessionDir(sessionId);
    if (!safe) {
      log.warn(`Refused deleteSessionFiles for unsafe sessionId="${sessionId}"`);
      return;
    }
    if (existsSync(safe.sessionDir)) {
      try {
        rmSync(safe.sessionDir, { recursive: true, force: true });
      } catch (err) {
        log.warn(`Failed to remove OR session dir ${safe.sessionDir}: ${(err as Error).message}`);
      }
    }
    // Subagent dirs share the same logsRoot — remove them too.
    try {
      const subPrefix = `${sessionId}:sub:`;
      for (const entry of readdirSync(safe.logsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(subPrefix)) continue;
        const subDir = join(safe.logsRoot, entry.name);
        try {
          rmSync(subDir, { recursive: true, force: true });
        } catch (err) {
          log.warn(`Failed to remove OR subagent dir ${subDir}: ${(err as Error).message}`);
        }
      }
    } catch {
      // logsRoot disappeared between calls — no-op.
    }
  }
}
