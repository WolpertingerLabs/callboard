/**
 * Permission translation: ACP `session/request_permission` ⇄ callboard's
 * four-axis permission model.
 *
 * ## The shape of the problem
 *
 * Codex has no per-call hook, so `adapters/codex/permissionAdapter.ts` collapses
 * callboard's four axes onto two coarse knobs set once at thread start. ACP is
 * the opposite and much closer to Claude Code: the agent asks *per tool call*,
 * over the wire, and blocks until the client answers. So this adapter is a
 * request/response mapper, not a policy flattener.
 *
 * Two translations happen here:
 *
 *  1. **ACP tool → permission category.** ACP gives us a `ToolKind` enum
 *     (`read` | `edit` | `execute` | `fetch` | …) alongside a free-text title.
 *     The enum is a *far* better categorization signal than tool-name matching
 *     (which is what `categorizeClaudeTool` must do, because the Claude SDK has
 *     no equivalent) — it is vendor-neutral by construction, so an ACP agent we
 *     have never seen still categorizes correctly. Name matching is only a
 *     fallback for agents that omit `kind`.
 *
 *  2. **Decision → `PermissionOption`.** ACP does not accept a boolean; it sends
 *     a menu of `PermissionOption`s and wants one `optionId` back. The agent
 *     chooses that menu, so we must select from what we were offered rather than
 *     assert an answer. `*_once` is always preferred over `*_always`: callboard
 *     re-evaluates policy on every call, and accepting an `allow_always` would
 *     hand the agent a standing grant that callboard's own settings could no
 *     longer revoke.
 *
 * Nothing here throws. A malformed request, an empty option list, or an option
 * list with no usable kind all resolve to a definite protocol answer — a hung
 * permission request would stall the agent's turn forever.
 *
 * @see plans/acp-adapter.md (Permissions)
 * @see ../codex/permissionAdapter.ts (the other foreign-vocabulary bridge)
 */
import type { PermissionOption, PermissionOptionKind, RequestPermissionRequest, RequestPermissionResponse, ToolKind } from "@agentclientprotocol/sdk";
import type { DefaultPermissions } from "shared/types/index.js";
import { decidePermission, type PermissionCategory, type PermissionDecision } from "../../permissions/ToolPermissionPolicy.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("acp-permissions");

/**
 * Map ACP's `ToolKind` onto a callboard permission category.
 *
 * `think` and `switch_mode` touch nothing the four axes govern, so they return
 * null ⇒ {@link decidePermission} treats them as "ask" only if there is no other
 * signal; callers pair this with the `null` → no-category path the policy
 * already handles.
 *
 * `other` is deliberately NOT mapped to a category here — see
 * {@link categorizeAcpTool}, which falls back to name matching for it.
 */
export function categorizeAcpToolKind(kind: ToolKind | null | undefined): PermissionCategory | null {
  switch (kind) {
    case "read":
    case "search":
      return "fileRead";
    case "edit":
    case "delete":
    case "move":
      return "fileWrite";
    case "execute":
      return "codeExecution";
    case "fetch":
      return "webAccess";
    case "think":
    case "switch_mode":
      return null;
    case "other":
    case undefined:
    case null:
    default:
      return null;
  }
}

/**
 * Best-effort category from a tool's free-text name/title, used only when the
 * agent omitted `kind` or sent `other`. Intentionally conservative: an
 * unrecognized name falls back to `fileWrite`, matching
 * {@link categorizeClaudeTool}'s "unknown tools are treated as the dangerous
 * case" rule, so a vendor that under-reports metadata cannot quietly obtain a
 * weaker gate than it deserves.
 */
export function categorizeAcpToolName(name: string): PermissionCategory | null {
  // Tokenize rather than using `\b` word boundaries. Tool names in this
  // ecosystem are overwhelmingly snake_case (`read_file`, `run_command`), and
  // `_` is a word character — so `/\bread\b/` does NOT match `read_file`, which
  // would send every read tool to the conservative fileWrite default. Splitting
  // on non-alphanumerics also handles camelCase and kebab-case for free.
  const tokens = new Set(
    name
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const hasAny = (words: readonly string[]): boolean => words.some((w) => tokens.has(w));

  // Order matters: a name matching more than one family resolves to the first
  // listed, and the list runs least-privileged first so an ambiguous name never
  // silently widens its own gate.
  if (hasAny(["read", "glob", "grep", "search", "find", "list", "cat", "view", "stat"])) return "fileRead";
  if (hasAny(["write", "edit", "create", "delete", "remove", "move", "rename", "patch", "apply", "mkdir"])) return "fileWrite";
  if (hasAny(["bash", "sh", "shell", "exec", "execute", "run", "terminal", "command", "spawn"])) return "codeExecution";
  if (hasAny(["fetch", "http", "https", "web", "browse", "url", "download", "curl", "request"])) return "webAccess";
  return "fileWrite";
}

/**
 * Category for an ACP tool call. Prefers the structured `kind`; falls back to
 * the name/title only when `kind` is absent or `other`.
 */
export function categorizeAcpTool(kind: ToolKind | null | undefined, name: string | null | undefined): PermissionCategory | null {
  const fromKind = categorizeAcpToolKind(kind);
  if (fromKind) return fromKind;
  // `think` / `switch_mode` are explicitly "no axis applies" — don't let name
  // matching drag them back into fileWrite.
  if (kind === "think" || kind === "switch_mode") return null;
  const label = (name ?? "").trim();
  if (!label) return "fileWrite";
  return categorizeAcpToolName(label);
}

/** Display name for a permission request: the experimental `name`, else the title. */
export function acpToolLabel(toolCall: RequestPermissionRequest["toolCall"]): string {
  const name = typeof toolCall?.name === "string" ? toolCall.name.trim() : "";
  if (name) return name;
  const title = typeof toolCall?.title === "string" ? toolCall.title.trim() : "";
  return title || "unknown_tool";
}

/**
 * Pick the option matching a decision, preferring the one-shot variant.
 *
 * Returns null when the agent offered nothing usable — e.g. a "deny" decision
 * against a menu containing only `allow_once`. The caller turns that into a
 * `cancelled` outcome rather than picking an option that means the opposite of
 * what callboard decided.
 */
export function selectPermissionOption(options: readonly PermissionOption[], decision: Exclude<PermissionDecision, "ask">): PermissionOption | null {
  const preferred: PermissionOptionKind[] = decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of preferred) {
    const match = options.find((o) => o?.kind === kind);
    if (match && typeof match.optionId === "string") return match;
  }
  return null;
}

/** A callboard `canUseTool` callback, as `services/claude.ts` builds it. */
export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: { signal: AbortSignal; suggestions?: readonly unknown[] },
) => Promise<{ behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }>;

export interface AcpPermissionContext {
  /** The user's four-axis defaults; absent ⇒ every category resolves to "ask". */
  permissions?: DefaultPermissions | null;
  /** callboard's per-call prompt path. Absent ⇒ "ask" degrades to deny. */
  canUseTool?: CanUseToolFn;
  /** Aborted when the run is cancelled, so a pending prompt resolves. */
  signal: AbortSignal;
}

/** A definite ACP answer meaning "no option selected". */
function cancelled(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

/**
 * Resolve one `session/request_permission` into an ACP response.
 *
 * Order of operations mirrors the Claude path: consult the four-axis policy
 * first (a definite allow/deny answers without bothering the user), and only
 * escalate to `canUseTool` — which owns the SSE prompt and the user's reply —
 * when the policy says "ask".
 *
 * Every failure mode lands on a valid response:
 *  - no options offered            → cancelled
 *  - decision has no matching kind → cancelled
 *  - "ask" with no canUseTool      → reject (there is no one to ask)
 *  - canUseTool throws             → reject
 */
export async function resolveAcpPermission(request: RequestPermissionRequest, ctx: AcpPermissionContext): Promise<RequestPermissionResponse> {
  const options = Array.isArray(request?.options) ? request.options.filter((o): o is PermissionOption => !!o && typeof o.optionId === "string") : [];
  if (options.length === 0) {
    log.warn("session/request_permission arrived with no usable options — answering cancelled");
    return cancelled();
  }

  const toolCall = request.toolCall ?? ({} as RequestPermissionRequest["toolCall"]);
  const label = acpToolLabel(toolCall);
  const category = categorizeAcpTool(toolCall.kind, toolCall.name ?? toolCall.title);
  const decision = decidePermission(category, ctx.permissions ?? null);
  log.info(`[PERM-DIAG] acp tool=${label}, kind=${toolCall.kind ?? "(none)"}, category=${category ?? "(none)"}, decision=${decision}`);

  if (decision !== "ask") {
    const option = selectPermissionOption(options, decision);
    if (!option) {
      log.warn(`no "${decision}" option offered for ${label} (kinds: ${options.map((o) => o.kind).join(", ")}) — answering cancelled`);
      return cancelled();
    }
    return selected(option.optionId);
  }

  if (!ctx.canUseTool) {
    // Nothing can surface a prompt (e.g. a quick-completion run). Refusing is
    // the only safe reading of "ask".
    const rejection = selectPermissionOption(options, "deny");
    log.warn(`"ask" decision for ${label} with no canUseTool available — rejecting`);
    return rejection ? selected(rejection.optionId) : cancelled();
  }

  const input = (toolCall.rawInput && typeof toolCall.rawInput === "object" ? (toolCall.rawInput as Record<string, unknown>) : {}) satisfies Record<string, unknown>;

  let allowed: boolean;
  try {
    const result = await ctx.canUseTool(label, input, { signal: ctx.signal });
    allowed = result?.behavior === "allow";
  } catch (err) {
    log.warn(`canUseTool threw for ${label} — rejecting: ${err instanceof Error ? err.message : String(err)}`);
    allowed = false;
  }

  if (ctx.signal.aborted) return cancelled();

  const option = selectPermissionOption(options, allowed ? "allow" : "deny");
  if (!option) {
    log.warn(`no "${allowed ? "allow" : "deny"}" option offered for ${label} — answering cancelled`);
    return cancelled();
  }
  return selected(option.optionId);
}
