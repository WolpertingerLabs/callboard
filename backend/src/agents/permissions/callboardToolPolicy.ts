/**
 * Which permission axes each of Callboard's own tools needs.
 *
 * Callboard's in-process tool servers (`callboard-tools`, `callboard`,
 * `mcp-proxy`, `job-tools`, `objective-tools`) used to be pre-approved on
 * Claude Code with an `mcp__<key>__*` wildcard and run in-process on every
 * other engine, so a chat whose policy denied `fileRead` or `webAccess` could
 * still read any file through `save_storage_item(source_path)`, call any
 * service through `secure_request`, or read a vault secret through
 * `vault_get`. This table is what the chat's policy is now checked against, by
 * both the engine's per-call gate (Claude `canUseTool`, pi `tool_call`) and the
 * handler-side guard every engine runs (`guardSpecByPolicy`,
 * services/permission-ceiling.ts).
 *
 * Provider-neutral: tool names here are the bare names the specs register.
 * Claude Code sees them as `mcp__<server>__<name>` ({@link parseClaudeMcpName});
 * pi sees them bare ({@link callboardToolGateByBareName}).
 *
 * How a tool is classified:
 * - **ungated** — acts only on this chat's own state or UI, waits, lists a
 *   catalogue with no user content, or is already held to an internal ceiling
 *   at least as strict (`guardUnattendedTools`, the `start_chat_session` /
 *   `continue_chat` / parent-answer ceilings).
 * - **fileRead** — returns stored user content from outside this chat (other
 *   chats, storage, artifacts, canvases, skills, jobs, workspace and vault
 *   metadata, listener configuration), or a host file named by an argument.
 * - **fileWrite** — creates, changes or deletes persistent Callboard state or
 *   files on the host.
 * - **webAccess** — makes an outbound request or pulls in external data.
 * - **codeExecution** — reveals a secret, plants instructions in future runs,
 *   or runs git (checkout runs hooks and filters).
 *
 * A gate lists every axis a call needs; all must allow. `computer_use` is not
 * here: it keeps its own service gate.
 *
 * The coverage test (`callboardToolPolicy.test.ts`) builds every spec and fails
 * on any tool with no entry, so a new tool cannot ship unclassified. At runtime
 * a tool that is somehow missing resolves to `codeExecution` — fail closed.
 */
import type { DefaultPermissions } from "shared/types/index.js";
import { decidePermission, type PermissionCategory, type PermissionDecision } from "./ToolPermissionPolicy.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("callboard-tool-policy");

export const UNGATED = "ungated" as const;
/** `ungated`, or every axis the call needs (all must allow). */
export type ToolGate = typeof UNGATED | readonly PermissionCategory[];
type Entry = ToolGate | ((input: Record<string, unknown>) => ToolGate);

/** The server keys `inject()` (services/claude.ts) registers Callboard's own tools under. */
export const CALLBOARD_SERVER_KEYS = ["callboard-tools", "callboard", "mcp-proxy", "job-tools", "objective-tools"] as const;
export type CallboardServerKey = (typeof CALLBOARD_SERVER_KEYS)[number];

export function isCallboardServerKey(value: string): value is CallboardServerKey {
  return (CALLBOARD_SERVER_KEYS as readonly string[]).includes(value);
}

/** A present argument: not undefined/null/empty string. */
function has(input: Record<string, unknown>, key: string): boolean {
  const v = input[key];
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** `base`, plus `extra` axes for each present argument. Empty → ungated. */
function withArgs(base: readonly PermissionCategory[], extra: Record<string, readonly PermissionCategory[]>): (input: Record<string, unknown>) => ToolGate {
  return (input) => {
    const axes = [...base];
    for (const [arg, add] of Object.entries(extra)) {
      if (!has(input, arg)) continue;
      for (const axis of add) if (!axes.includes(axis)) axes.push(axis);
    }
    return axes.length === 0 ? UNGATED : axes;
  };
}

const R = ["fileRead"] as const satisfies readonly PermissionCategory[];
const W = ["fileWrite"] as const satisfies readonly PermissionCategory[];
const WEB = ["webAccess"] as const satisfies readonly PermissionCategory[];
const EXEC = ["codeExecution"] as const satisfies readonly PermissionCategory[];

/**
 * Job management tools — on `callboard-tools` for regular chats and on
 * `callboard` for agent sessions; the same gate on both.
 *
 * The five that start unattended allow-all work, and `respond_job_approval`,
 * are ungated here because `guardUnattendedTools` / `unattendedRefusal`
 * already refuse them unless the caller is allow-all on every axis — stricter
 * than any single-axis gate. Prompting first would only lead to that refusal.
 */
const JOB_TOOLS: Readonly<Record<string, Entry>> = {
  describe_job_schema: UNGATED,
  list_jobs: R,
  get_job: R,
  list_job_runs: R,
  get_job_run: R,
  delete_job: W,
  cancel_job_run: W,
  pause_job_run: W,
  create_job: UNGATED,
  update_job: UNGATED,
  spawn_job: UNGATED,
  retry_job_step: UNGATED,
  resume_job_run: UNGATED,
  respond_job_approval: UNGATED,
};

const CALLBOARD_TOOLS: Readonly<Record<string, Entry>> = {
  // ── This chat's own state and UI ──
  set_chat_status: UNGATED,
  set_chat_title: UNGATED,
  notify_user: UNGATED,
  summon_user: UNGATED,
  wait: UNGATED,
  wait_condition_met: UNGATED,
  // Model catalogues: no user content, cached by the daemon.
  list_anthropic_models: UNGATED,
  list_codex_models: UNGATED,
  list_openrouter_models: UNGATED,
  list_model_aliases: UNGATED,
  // ── Chat tree metadata, or already capped by an internal ceiling ──
  get_chat_tree: UNGATED,
  get_session_status: UNGATED,
  list_pending_requests: UNGATED,
  respond_to_request: UNGATED, // parentApprovalRefusal
  continue_chat: UNGATED, // axesAboveCeiling
  // The child is capped (capPermissions). Branch/worktree arguments make the
  // daemon run git checkout, which runs the repo's hooks and filters.
  start_chat_session: withArgs([], { newBranch: [...W, ...EXEC], baseBranch: [...W, ...EXEC], useWorktree: [...W, ...EXEC] }),
  // ── Canvases: inline content is like posting a message; a file_path reads the host ──
  create_canvas: withArgs([], { file_path: R }),
  update_canvas: withArgs([], { file_path: R }),
  read_canvas: R,
  render_file: withArgs([], { file_path: R, url: WEB }),
  // ── Other chats ──
  read_session_messages: R,
  search_chats: R,
  get_chat_view: R,
  // ── Custom skills: a write changes the instructions of every later chat, unattended allow-all runs included ──
  list_custom_skills: R,
  read_custom_skill: R,
  write_custom_skill: [...W, ...EXEC],
  // ── Model aliases ──
  set_model_alias: W,
  delete_model_alias: W,
  // ── Workspaces ──
  list_workspaces: R,
  list_unmanaged_worktrees: R,
  create_workspace: W,
  rename_workspace: W,
  archive_workspace: W,
  adopt_worktrees: W,
  // ── Storage and artifacts ──
  list_storage_keys: R,
  list_storage_items: R,
  read_storage_item: R,
  list_artifacts: R,
  read_artifact: R,
  render_artifact: R,
  create_storage_key: W,
  delete_storage_item: W,
  delete_storage_key: W,
  delete_artifact: W,
  save_storage_item: withArgs(W, { source_path: R }),
  save_artifact: withArgs(W, { source_path: R }),
  ...JOB_TOOLS,
};

const AGENT_TOOLS: Readonly<Record<string, Entry>> = {
  // AGENT_UNATTENDED_TOOLS (agent-tools.ts) — guardUnattendedTools, stricter.
  talk_to_agent: UNGATED,
  deploy_agent: UNGATED,
  create_cron_job: UNGATED,
  update_cron_job: UNGATED,
  create_trigger: UNGATED,
  update_trigger: UNGATED,
  create_agent: UNGATED,
  update_agent: UNGATED,
  // The agent's own scheduling, activity and theme catalogue.
  list_cron_jobs: UNGATED,
  list_triggers: UNGATED,
  list_agents: UNGATED,
  get_agent_info: UNGATED,
  get_activity: UNGATED,
  log_activity: UNGATED,
  list_themes: UNGATED,
  get_theme: UNGATED,
  delete_cron_job: W,
  delete_trigger: W,
  generate_theme: W,
  update_theme: W,
  delete_theme: W,
  ...JOB_TOOLS,
};

const PROXY_TOOLS: Readonly<Record<string, Entry>> = {
  // Stored configuration and vault metadata — never secret values.
  vault_list: R,
  vault_list_requests: R,
  list_routes: R,
  list_listener_configs: R,
  get_listener_params: R,
  list_listener_instances: R,
  ingestor_status: R,
  vault_create: W,
  vault_update: W,
  vault_delete: W,
  vault_request_access: W,
  vault_cancel_request: W,
  set_listener_params: W,
  delete_listener_instance: W,
  // Puts a secret value into the transcript: worth whatever it unlocks.
  vault_get: EXEC,
  // `files` uploads host files.
  secure_request: withArgs(WEB, { files: R }),
  poll_events: WEB,
  test_connection: WEB,
  test_ingestor: WEB,
  control_listener: WEB,
  resolve_listener_options: WEB,
};

export const CALLBOARD_TOOL_POLICY: Readonly<Record<CallboardServerKey, Readonly<Record<string, Entry>>>> = {
  "callboard-tools": CALLBOARD_TOOLS,
  callboard: AGENT_TOOLS,
  "mcp-proxy": PROXY_TOOLS,
  "job-tools": { complete_job_step: UNGATED, set_job_run_title: UNGATED },
  "objective-tools": { objective_complete: UNGATED },
};

/** The fail-closed gate for a Callboard tool missing from the table. */
const MISSING: ToolGate = EXEC;

function resolveEntry(entry: Entry, input: Record<string, unknown> | undefined): ToolGate {
  return typeof entry === "function" ? entry(input ?? {}) : entry;
}

/**
 * The gate for `name` on Callboard server `server`, or `undefined` when
 * `server` is not one of Callboard's. A name missing from a Callboard server's
 * table gets `codeExecution`.
 */
export function callboardToolGate(server: string, name: string, input?: Record<string, unknown>): ToolGate | undefined {
  if (!isCallboardServerKey(server)) return undefined;
  const entry = CALLBOARD_TOOL_POLICY[server][name];
  if (entry === undefined) {
    log.warn(`[PERM-DIAG] ${server}/${name} has no entry in CALLBOARD_TOOL_POLICY — gating at codeExecution`);
    return MISSING;
  }
  return resolveEntry(entry, input);
}

/**
 * Whether `name` is ungated for EVERY input — the only tools that may be
 * pre-approved by exact name on Claude Code (`allowedTools`). An input-aware
 * entry is never pre-approved: the SDK would approve it before the arguments
 * that raise its gate are seen.
 */
export function isAlwaysUngated(server: string, name: string): boolean {
  if (!isCallboardServerKey(server)) return false;
  return CALLBOARD_TOOL_POLICY[server][name] === UNGATED;
}

/** Bare name → entry, across every Callboard server (pi sees tools unprefixed). */
const BY_BARE_NAME: ReadonlyMap<string, Entry> = (() => {
  const map = new Map<string, Entry>();
  for (const key of CALLBOARD_SERVER_KEYS) {
    for (const [name, entry] of Object.entries(CALLBOARD_TOOL_POLICY[key])) if (!map.has(name)) map.set(name, entry);
  }
  return map;
})();

/** Every bare Callboard tool name in the table. */
export function callboardToolNames(): string[] {
  return [...BY_BARE_NAME.keys()];
}

/**
 * The gate for a bare tool name (pi), or `undefined` when it is not a
 * Callboard tool. Bare names are unique across servers or carry the same gate
 * wherever they repeat (the job tools) — the coverage test asserts it.
 */
export function callboardToolGateByBareName(name: string, input?: Record<string, unknown>): ToolGate | undefined {
  const entry = BY_BARE_NAME.get(name);
  return entry === undefined ? undefined : resolveEntry(entry, input);
}

const CLAUDE_MCP_NAME = new RegExp(`^mcp__(${CALLBOARD_SERVER_KEYS.map((k) => k.replace(/-/g, "\\-")).join("|")})__(.+)$`);

/** `mcp__<callboard server>__<tool>` → its parts, or `null` for any other name. */
export function parseClaudeMcpName(qualified: string): { server: CallboardServerKey; name: string } | null {
  const m = CLAUDE_MCP_NAME.exec(qualified);
  return m ? { server: m[1] as CallboardServerKey, name: m[2] } : null;
}

/** The Claude Code (and mock) resolver: a qualified name of a Callboard server → its gate. */
export function claudeCallboardGate(toolName: string, input?: Record<string, unknown>): ToolGate | undefined {
  const parsed = parseClaudeMcpName(toolName);
  return parsed ? callboardToolGate(parsed.server, parsed.name, input) : undefined;
}

export interface GateDecision {
  decision: PermissionDecision;
  /** The binding axis: the first denied one, else the first asking one, else the first; `null` when ungated. */
  category: PermissionCategory | null;
  /** Every axis that is not "allow" — what an approver must itself hold. */
  pending: PermissionCategory[];
}

/**
 * The chat's decision for a gate. `null` permissions mean "ask" on every axis
 * (the same reading `normalizePermissions(null)` gives).
 */
export function decideGate(gate: ToolGate, perms: DefaultPermissions | null): GateDecision {
  if (gate === UNGATED) return { decision: "allow", category: null, pending: [] };
  let firstAsk: PermissionCategory | null = null;
  const pending: PermissionCategory[] = [];
  for (const axis of gate) {
    const d = decidePermission(axis, perms);
    if (d === "deny") return { decision: "deny", category: axis, pending: [axis] };
    if (d === "ask") {
      pending.push(axis);
      firstAsk ??= axis;
    }
  }
  if (firstAsk) return { decision: "ask", category: firstAsk, pending };
  return { decision: "allow", category: gate[0] ?? null, pending: [] };
}
