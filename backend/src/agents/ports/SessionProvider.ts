/**
 * SessionProvider — the seam between callboard and a provider's native
 * session storage for discovery and reading of historical sessions.
 *
 * Companion to {@link AgentProvider} (which handles execution). Each
 * provider registers one of each. Callers go through the factory.
 *
 * Session discovery is about *reading existing data* — listing, parsing,
 * searching old sessions. It is deliberately separate from AgentProvider
 * because the lifecycles differ: you may want to list sessions from a
 * provider whose runtime engine is not installed or configured.
 *
 * @see plans/agent-abstraction-layer.md
 */
import type { ParsedMessage } from "shared/types/index.js";
import type { AgentProviderKind } from "./AgentProvider.js";

// ── Discovery types ─────────────────────────────────────────────────

/** A discovered session entry from the provider's native storage. */
export interface DiscoveredSession {
  sessionId: string;
  /** The working directory this session was run in. */
  folder: string;
  /** Display-friendly folder (resolved worktrees, etc.). */
  displayFolder: string;
  /** Absolute path to the session log file. */
  filePath: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DiscoverResult {
  sessions: DiscoveredSession[];
  total: number;
}

/** Result of resolving a session ID to its native storage location. */
export interface ResolvedSession {
  /** Absolute path to the session log file. */
  logPath: string;
  /** The working directory this session was run in (may be a worktree). */
  folder: string;
  /** Display-friendly folder (resolved to main repo for grouping). */
  displayFolder: string;
}

export interface SubagentFile {
  agentId: string;
  filePath: string;
}

// ── Search types ────────────────────────────────────────────────────

/** Filters for session search. Provider-neutral superset. */
export interface SessionSearchFilters {
  folder: string;
  grep?: string;
  gitBranch?: string;
  agentAlias?: string;
  triggered?: boolean;
  updatedAfter?: string;
  updatedBefore?: string;
  sort?: "updated" | "created";
  limit?: number;
}

export interface SessionSearchResult {
  chatId: string;
  sessionId: string;
  folder: string;
  repoFolder: string;
  isWorktree: boolean;
  gitBranch: string | null;
  agentAlias: string | null;
  triggered: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSearchResponse {
  chats: SessionSearchResult[];
  total: number;
}

// ── Interface ───────────────────────────────────────────────────────

/**
 * Adapter seam for session discovery. Implementations live under
 * `agents/adapters/<name>/`. Construct via {@link getSessionProviders}
 * from `../factory.js`.
 */
export interface SessionProvider {
  readonly kind: AgentProviderKind;

  /**
   * List sessions from native storage, sorted by mtime DESC.
   *
   * The limit/offset are a performance hint for single-provider mode.
   * When multiple providers are registered, the merge layer may request
   * all sessions and handle pagination itself.
   */
  discoverSessions(opts: { limit: number; offset: number }): DiscoverResult;

  /**
   * Resolve a session ID to its log file path and folder info.
   * Returns null if the session is not found in this provider's storage.
   *
   * Returns richer data than just a path so callers don't need to know
   * provider-specific path encoding/decoding conventions.
   */
  resolveSession(sessionId: string): ResolvedSession | null;

  /**
   * Find child/subagent session files for a given parent session.
   * Returns an empty array if not found or if the provider doesn't
   * support subagents.
   */
  findSubagentFiles(sessionId: string): SubagentFile[];

  /**
   * Parse all messages for the given session IDs into the neutral
   * {@link ParsedMessage} format. Handles subagent discovery, reading,
   * and merging internally.
   *
   * The sessionIds array supports multi-session chats (where one chat
   * spans multiple session IDs due to resumed sessions).
   */
  parseSessionMessages(sessionIds: string[]): ParsedMessage[];

  /**
   * Extract a short preview string from a session log (e.g. first user
   * message). Used for chat list display.
   * Returns null if no preview is available.
   */
  getSessionPreview(logPath: string, maxLength?: number): string | null;

  /**
   * Search sessions matching the given filters.
   * Handles provider-specific path encoding, worktree resolution, etc.
   */
  searchSessions(filters: SessionSearchFilters): SessionSearchResponse;

  /**
   * Delete a session's native storage (log file + subagent files).
   * Called by DELETE /chats/:id after callboard's own metadata is
   * cleaned up. No-op if the session is not found.
   */
  deleteSessionFiles(sessionId: string): void;

  /**
   * Fork a session at a point in time: copy the native session log(s) up
   * to and including the last entry at or before `cutoffTimestamp` into a
   * new session keyed by `newSessionId`, so the new session can be resumed
   * independently of the original.
   *
   * Optional — providers whose storage can't be truncated this way (e.g.
   * OpenRouter's response-chained state) simply don't implement it, and
   * the fork route rejects the request.
   *
   * Returns the new session log path, or null if the source session is
   * missing or no entries fall at/before the cutoff.
   */
  forkSession?(sessionIds: string[], cutoffTimestamp: string, newSessionId: string): { logPath: string } | null;
}
