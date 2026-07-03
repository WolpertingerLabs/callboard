/**
 * Agent environment policy — the authoritative RECORD of callboard/drawlatch
 * production & server-specific environment variables that must NOT leak into
 * spawned agent subprocesses.
 *
 * ## Why this exists
 *
 * Callboard runs as a long-lived daemon and spawns agent subprocesses (the
 * Claude Code CLI via the Agent SDK, and the Codex CLI). Both inherit the
 * daemon's `process.env` — see `services/claude.ts` where the agent options
 * `env` is assembled as `{ ...process.env, ...getApiEnvOverrides() }`. Without
 * filtering, the daemon's entire environment flows into every agent, which:
 *
 *   1. Leaks secrets — the daemon computes `AUTH_PASSWORD_HASH`/`_SALT` at
 *      startup (see `auth.ts`) and stores them on `process.env`; any agent,
 *      the subprocesses it spawns, its tool output, and its logs can then read
 *      callboard's own auth credential material.
 *   2. Breaks agent tooling — `NODE_ENV=production` makes `npm install` inside
 *      an agent omit devDependencies (so `prepare`/build steps fail), and
 *      `PORT` makes any dev server / test harness an agent starts bind to the
 *      LIVE production port and collide with the running daemon.
 *   3. Leaks production identity/config — instance name, data dirs, drawlatch
 *      tunnel wiring, event-watcher endpoints, etc.
 *
 * ## Denylist, not allowlist
 *
 * We EXCLUDE known callboard/drawlatch vars rather than allowlisting a fixed
 * set, because agent MCP-server configs support generic `${VAR}` substitution
 * from `process.env` (see `resolveEnvReferences` in `services/claude.ts`), so a
 * user's MCP server may legitimately reference arbitrary host env vars. An
 * allowlist would silently break those; a denylist only strips what we know is
 * server-internal.
 *
 * ## NOT excluded here (intentionally)
 *
 *   - Vars the agent subprocess genuinely needs: `CODEX_HOME`, `XDG_DATA_HOME`,
 *     `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `CLAUDE_BINARY`, plus API-key
 *     overrides which are re-applied AFTER this filter by `getApiEnvOverrides`.
 *   - Third-party/user secrets inherited from the launching shell that are not
 *     callboard-specific (e.g. `GITHUB_TOKEN`, `STEAM_API_KEY`). These are
 *     out of scope for this callboard/drawlatch record — an agent doing git
 *     work may legitimately need `GITHUB_TOKEN`. If you want the daemon to stop
 *     inheriting those in the first place, sanitize at daemon launch instead.
 *
 * When you add a new callboard/drawlatch server/config env var anywhere in the
 * app, add it here too.
 */

/**
 * Exact variable names that are callboard/drawlatch production/server-specific.
 * Grouped by subsystem for auditability.
 */
export const CALLBOARD_AGENT_ENV_EXCLUSIONS: readonly string[] = [
  // ── Auth secrets (computed at startup, stored on process.env) ──
  "AUTH_PASSWORD_HASH",
  "AUTH_PASSWORD_SALT",

  // ── Server runtime config (breaks agent tooling / leaks identity) ──
  "NODE_ENV", // production → `npm install` omits devDependencies inside agents
  "PORT", // production port → agent-started servers collide with the daemon
  "LOG_LEVEL",
  "SESSION_COOKIE_NAME",
  "INSTANCE_NAME",
  "DEV_PORT_UI",
  "DEV_PORT_SERVER",

  // ── Server data / workspace paths ──
  "CALLBOARD_DATA_DIR",
  "CALLBOARD_WORKSPACES_DIR",
  "CCUI_AGENTS_DIR",

  // ── Event-watcher subsystem ──
  "EVENT_WATCHER_REMOTE_URL",
  "EVENT_WATCHER_REMOTE_KEYS_DIR",
  "EVENT_WATCHER_KEYS_DIR",
  "EVENT_WATCHER_POLL_INTERVAL",

  // ── MCP proxy ──
  "MCP_PROXY_MODE",

  // ── Test-only ──
  "SKIP_PROXY_TESTS",
] as const;

/**
 * Prefix families — every var starting with one of these is callboard/drawlatch
 * production wiring and is excluded, so new members of the family are covered
 * automatically. The known members at time of writing are listed for the record:
 *
 *   DRAWLATCH_*      DRAWLATCH_DIR, DRAWLATCH_HOST, DRAWLATCH_PORT,
 *                    DRAWLATCH_TUNNEL, DRAWLATCH_LOCAL_HOST, DRAWLATCH_LOCAL_PORT,
 *                    DRAWLATCH_LOCAL_CALLER_ALIAS, DRAWLATCH_LOCAL_CALLER_KEYS_DIR
 *   EVENT_WATCHER_*  (also enumerated above for the exact-name record)
 */
export const CALLBOARD_AGENT_ENV_EXCLUSION_PREFIXES: readonly string[] = ["DRAWLATCH_", "EVENT_WATCHER_"] as const;

const EXCLUSION_SET = new Set(CALLBOARD_AGENT_ENV_EXCLUSIONS);

/** True if `key` is a callboard/drawlatch var that must not reach an agent. */
export function isExcludedAgentEnvKey(key: string): boolean {
  if (EXCLUSION_SET.has(key)) return true;
  return CALLBOARD_AGENT_ENV_EXCLUSION_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Return a shallow copy of `env` with all callboard/drawlatch server-specific
 * variables removed. Use this to sanitize `process.env` BEFORE spreading it
 * into a spawned agent's environment; intentional overrides (API keys, MCP env)
 * should be applied AFTER this so they still take effect.
 */
export function sanitizeInheritedAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isExcludedAgentEnvKey(key)) sanitized[key] = value;
  }
  return sanitized;
}
