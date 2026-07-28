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
 *  1. **ACP tool → permission category.** Done by {@link categorizeAcpToolName}
 *     over the tool's *name*, and by nothing else — see "The two-pass rule"
 *     below. ACP's structured `ToolKind` looks like a better signal and is not
 *     usable as one: the second pass cannot see it.
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
 * ## The two-pass rule
 *
 * callboard evaluates a tool's permission **twice**: here, and again inside
 * `buildCanUseTool` before it prompts the user. Pass 2 is reached only for tools
 * this pass resolved to "ask" — i.e. exactly the tools we want a human to see —
 * and it re-decides from scratch. So if the two passes can disagree, and pass 2
 * lands on a category the user set to `allow`, the tool runs and nobody is asked.
 *
 * That bypass shipped. Pass 1 categorized from ACP's `ToolKind`; pass 2 gets a
 * bare `toolName: string` (the `ToolPermissionPolicy` port is shared by every
 * adapter and takes nothing else), so `kind` was information only one pass had.
 * Under `{fileRead: "allow", fileWrite: "ask", codeExecution: "ask"}`, Cursor's
 * real `search_replace` tokenized to `search` → `fileRead` in pass 2 and edited
 * files with no prompt.
 *
 * The three rules that follow — architect ruling, 2026-07-28 — are why this file
 * looks the way it does:
 *
 *  1. **Both passes run the identical function over the identical input.**
 *     {@link resolveAcpPermission} categorizes {@link acpToolLabel}'s output with
 *     {@link categorizeAcpToolName}, and hands that *same string* to
 *     `canUseTool`, which categorizes it with the same function again. `kind` is
 *     used for logging only. Better information that only one pass has is worse
 *     than no information: it manufactures disagreement.
 *
 *     The policy settings are input too, and "identical" includes *when* they
 *     are read. Both passes therefore hold a live accessor —
 *     {@link AcpPermissionContext.getPermissions} here, `ToolPermissionPolicy`'s
 *     own `getDefaultPermissions` there — so a policy tightened mid-turn binds
 *     on the very next tool call rather than after the turn ends.
 *  2. **Ambiguity resolves to the most restrictive matching category** — see
 *     {@link CATEGORY_TOKENS}.
 *  3. **Never categorize from prose** — see {@link isToolIdentifier}.
 *
 * @see plans/acp-adapter.md (Permissions — "The two-pass rule")
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
 * **This does not gate anything.** It exists so the diagnostic log can report
 * what the structured `kind` would have said next to what the name says, which
 * is how a vendor whose two signals disagree gets noticed during Phase 2
 * onboarding. Wiring it back into the decision would re-open the bypass
 * described at the top of this file — pass 2 has no `kind` to agree with.
 *
 * `think` and `switch_mode` touch nothing the four axes govern, and `other`
 * carries no information at all, so all three return null.
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
 * The category anything unrecognizable resolves to.
 *
 * `codeExecution` is the top of the restrictiveness order below: a tool that can
 * run code can do everything the other three axes describe, so it is the only
 * safe answer when we do not know what a tool is.
 */
export const MOST_RESTRICTIVE_CATEGORY: PermissionCategory = "codeExecution";

/**
 * Token families, **most restrictive first**.
 *
 * A name matching more than one family resolves to the first listed. The order
 * is the polarity that matters (rule 2): the original ran least-privileged first
 * on the reasoning that an ambiguous name should "never silently widen its own
 * gate", which is exactly backwards. Resolving `search_and_run` to `fileRead`
 * treats a run-capable tool as read-only — *that* is the widening, and `fileRead`
 * is the axis users most often set to `allow`.
 *
 * The order is by what a tool in that family can do, not by alphabet:
 * `codeExecution` subsumes the rest, `fileWrite` mutates local state,
 * `webAccess` moves data in and out of the machine, `fileRead` only observes.
 */
const CATEGORY_TOKENS: ReadonlyArray<readonly [PermissionCategory, readonly string[]]> = [
  ["codeExecution", ["bash", "sh", "shell", "exec", "execute", "run", "terminal", "command", "spawn", "eval", "script", "process", "kill"]],
  [
    "fileWrite",
    // `replace` earns its place the hard way: Cursor's `search_replace` is a
    // real editing tool, and without this token it fell through to `fileRead`.
    ["write", "edit", "create", "delete", "remove", "move", "rename", "patch", "apply", "mkdir", "replace", "insert", "append", "update", "modify", "save", "touch"],
  ],
  ["webAccess", ["fetch", "http", "https", "web", "browse", "url", "download", "upload", "curl", "request"]],
  ["fileRead", ["read", "glob", "grep", "search", "find", "list", "cat", "view", "stat"]],
];

/**
 * Does this string look like a *tool name*, as opposed to a sentence?
 *
 * Rule 3. `name` is optional on ACP's `ToolCallUpdate`, and {@link acpToolLabel}
 * falls back to `title` — which is a human-readable description, not an
 * identifier. `` Run `rm -rf` to clear the search index `` tokenizes to `search`
 * and would categorize as `fileRead`. Prose must never be parsed for a gate, so
 * anything that is not a single identifier-shaped token is categorized to
 * {@link MOST_RESTRICTIVE_CATEGORY} and the words in it are never consulted.
 *
 * Deliberately strict — no spaces, no quotes, no punctuation beyond what real
 * tool names use (`read_file`, `mcp__server__tool`, `fs.read`, `web-search`).
 */
export function isToolIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,63}$/.test(value);
}

/**
 * Category for an ACP tool, from its name and nothing else.
 *
 * This is the **only** categorizer in the ACP path, and both permission passes
 * call it on the same string — see "The two-pass rule" at the top of this file.
 * Its input is whatever {@link acpToolLabel} produced, which is also what
 * `canUseTool` receives.
 *
 * Three outcomes:
 *  - a name matching a token family → that family, most restrictive first
 *  - a name matching nothing        → {@link MOST_RESTRICTIVE_CATEGORY}
 *  - anything that is not a name    → {@link MOST_RESTRICTIVE_CATEGORY}
 *
 * The last two collapsing into one answer is intentional. The predecessor
 * defaulted unknown names to `fileWrite` on the grounds that unknown tools are
 * "the dangerous case", but `fileWrite` is not the dangerous case —
 * `codeExecution` is, and it is the axis that can produce the other three. One
 * rule ("anything we cannot confidently identify gets the strictest gate") is
 * also easier to keep true than two.
 */
export function categorizeAcpToolName(name: string): PermissionCategory | null {
  const label = name.trim();
  if (!isToolIdentifier(label)) return MOST_RESTRICTIVE_CATEGORY;

  // Tokenize rather than using `\b` word boundaries. Tool names in this
  // ecosystem are overwhelmingly snake_case (`read_file`, `run_command`), and
  // `_` is a word character — so `/\bread\b/` does NOT match `read_file`, which
  // would send every read tool to the conservative default. Splitting on
  // non-alphanumerics also handles camelCase and kebab-case for free.
  const tokens = new Set(
    label
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

  for (const [category, words] of CATEGORY_TOKENS) {
    if (words.some((w) => tokens.has(w))) return category;
  }
  return MOST_RESTRICTIVE_CATEGORY;
}

/**
 * The one string that identifies a tool call for both the gate and the prompt.
 *
 * `name` is ACP's actual tool identifier and is preferred; `title` is a human
 * sentence and is only a display fallback — {@link categorizeAcpToolName} refuses
 * to read words out of it. Whatever this returns is what `canUseTool` is called
 * with, so the prompt the user sees and the string both passes categorize are
 * guaranteed to be the same thing.
 */
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
  /**
   * Live accessor for the user's four-axis defaults; absent (or returning null)
   * ⇒ every category resolves to "ask".
   *
   * A **getter**, not a value, and that is rule 1 applied to the other half of
   * the input. `ToolPermissionPolicy` — pass 2 — already holds a live accessor
   * and re-reads storage on every call. If pass 1 were handed a snapshot taken
   * at send time, a user who tightened a policy mid-turn would have pass 1
   * auto-allow on the stale value and never escalate, so pass 2's fresh read
   * would never happen. Same function, same input, at the same moment.
   */
  getPermissions?: () => DefaultPermissions | null;
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
  // One label, one categorizer, one input — and the same label goes to
  // `canUseTool` below, so the second pass cannot reach a different answer.
  const label = acpToolLabel(toolCall);
  const category = categorizeAcpToolName(label);
  // Read at decision time, never at send time — see `getPermissions` above.
  const decision = decidePermission(category, ctx.getPermissions?.() ?? null);
  // `kind` is reported, never consulted. A vendor whose structured kind
  // disagrees with its own tool name is worth knowing about before Phase 2
  // onboards it, and this line is where that shows up.
  const fromKind = categorizeAcpToolKind(toolCall.kind);
  log.info(
    `[PERM-DIAG] acp tool=${label}, category=${category ?? "(none)"}, decision=${decision}` +
      `, kind=${toolCall.kind ?? "(none)"}${fromKind && fromKind !== category ? ` (kind would say ${fromKind} — NOT used)` : ""}`,
  );

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
