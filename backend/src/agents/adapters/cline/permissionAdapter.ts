/**
 * Permission translation: Cline's `requestToolApproval` ⇄ callboard's four-axis
 * permission model.
 *
 * ## The trap this file exists to close
 *
 * `ToolPolicy` in `@cline/shared` is two optional booleans, and **both default
 * to `true`**:
 *
 * ```ts
 * interface ToolPolicy { enabled?: boolean; autoApprove?: boolean }
 * ```
 *
 * So a tool name absent from `toolPolicies` is enabled *and* auto-approved, and
 * `requestToolApproval` is never consulted for it. Left alone, callboard would
 * render its four-axis permission UI over a harness that never asks — the
 * decorative-gate failure `adapters/acp/vendors.ts` names as disqualifying for
 * onboarding a vendor. {@link buildClineToolPolicies} is what makes the gate
 * real, and it is not optional.
 *
 * ## Why policy is NOT encoded in `toolPolicies`
 *
 * The obvious implementation — `autoApprove: true` where the axis says `allow`,
 * `enabled: false` where it says `deny` — is wrong here, and the reason is a
 * lifecycle detail rather than a preference.
 *
 * `toolPolicies` and `capabilities` ride on `StartSessionInput`. `send()` takes
 * `SendSessionInput`, which has **neither**. A callboard chat calls `start()`
 * once and `send()` for every subsequent turn, so anything baked into the start
 * input is frozen for the life of the session — a user who tightens `fileWrite`
 * to `ask` in the middle of a long chat would not be asked until they began a
 * new one.
 *
 * So this adapter uses `toolPolicies` for exactly one thing: **forcing every
 * tool through the live gate** (`{ enabled: true, autoApprove: false }`). The
 * allow/deny/ask decision is then made per call in
 * {@link buildRequestToolApproval}, which reads the axes through a live accessor
 * at decision time. That is rule 1 of the two-pass ruling applied to the *when*
 * as well as the *what*, and it puts Cline alongside Claude Code and ACP rather
 * than alongside Codex, whose axes genuinely are flattened once at thread start.
 *
 * ## The two-pass rule
 *
 * callboard evaluates a tool's permission twice: here (pass 1), and again inside
 * `buildCanUseTool` via `ToolPermissionPolicy` before it prompts the user (pass
 * 2). If the passes can disagree, a tool escalated by pass 1 can be silently
 * auto-allowed by pass 2.
 *
 * Cline is the easiest case in the codebase for this. `ToolApprovalRequest`
 * carries a real `toolName: string` — always present, always an identifier, from
 * a closed set — and that same string is what pass 2 receives. Both passes run
 * {@link categorizeClineToolName} over the identical input, with no label ladder
 * of the kind `acpToolLabel` needs. The rule is satisfied by construction; the
 * only way to break it would be to categorize from `request.input` or
 * `request.policy`, which pass 2 cannot see. Do not.
 *
 * @see plans/cline-adapter.md
 * @see plans/cline-spike-findings.md (§2 — the trap, verified in the types)
 * @see ../acp/permissionAdapter.ts (the reference implementation of the rule)
 * @see ../openrouter/permissionAdapter.ts (the closed-tool-set precedent)
 */
import { ALL_DEFAULT_TOOL_NAMES, TEAM_TOOL_NAMES, type ToolApprovalRequest, type ToolApprovalResult, type ToolPolicy } from "@cline/sdk";
import type { DefaultPermissions } from "shared/types/index.js";
import { decidePermission, type PermissionCategory } from "../../permissions/ToolPermissionPolicy.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("cline-permissions");

/**
 * The category anything unrecognizable resolves to.
 *
 * `codeExecution` is the top of the restrictiveness order: a tool that can run
 * code can do everything the other three axes describe, so it is the only safe
 * answer when we do not know what a tool is.
 *
 * Note what this is NOT: `null`. `decidePermission(null, …)` returns "ask"
 * *unconditionally* — it does not consult the user's settings at all — so a
 * `null` default would prompt even under an all-"allow" policy. Callboard's
 * unattended runners (job steps, deployed agents, `start_chat_session`) all
 * hardcode every axis to `"allow"` precisely so they need no human, and an agent
 * job step has no timeout: a prompt nobody answers hangs the run until it is
 * aborted.
 */
export const MOST_RESTRICTIVE_CATEGORY: PermissionCategory = "codeExecution";

/**
 * The subagent-spawning tool, built by `createSpawnAgentTool` when
 * `enableSpawnAgent` is on.
 *
 * A string literal because — unlike the two families below — the SDK exports the
 * factory but not the name. `permissionAdapter.test.ts` asserts the full gated
 * set, so a rename upstream fails a test rather than silently ungating
 * delegation.
 */
export const SPAWN_AGENT_TOOL = "spawn_agent";

/**
 * Every tool name callboard must gate, taken from the SDK's **own constants**
 * rather than transcribed.
 *
 * Transcribing was the first implementation and it was already wrong in a way
 * worth recording: the published docs list nine tools and omit `spawn_agent`
 * entirely. Deriving from `ALL_DEFAULT_TOOL_NAMES` (the nine built-ins) and
 * `TEAM_TOOL_NAMES` (the eighteen `team_*` coordination tools) means an SDK bump
 * that adds a tool extends the gate automatically instead of shipping one
 * auto-approved hole — the failure mode `ToolPolicy`'s defaults make so easy.
 *
 * `TEAM_TOOL_NAMES` is included even though this adapter starts sessions with
 * `enableAgentTeams: false`. Listing a tool that is never registered costs
 * nothing; *not* listing one that later gets registered costs the gate.
 */
export const CLINE_GATED_TOOL_NAMES: readonly string[] = [...ALL_DEFAULT_TOOL_NAMES, SPAWN_AGENT_TOOL, ...TEAM_TOOL_NAMES];

/**
 * Exact tool-name → category table for everything Cline ships.
 *
 * Two entries are worth their justification:
 *
 * - **`skills` → `codeExecution`, not `fileRead`.** The OpenRouter adapter maps
 *   its similarly-named `skill` tool to `fileRead` because it only resolves a
 *   name and returns the SKILL.md body. Cline's is a different tool wearing the
 *   same word: its own description advertises `` `skill: "commit", args: "-m
 *   \"Fix bug\""` `` — it *invokes* the skill with arguments. A tool that runs a
 *   commit is not a disk read.
 * - **`spawn_agent` → `codeExecution`.** A subagent inherits the full toolset,
 *   `run_commands` included, so delegating is at least as privileged as running
 *   a command. Same reasoning as OR's `spawn_subagent`.
 */
const EXACT_CATEGORIES: ReadonlyMap<string, PermissionCategory> = new Map<string, PermissionCategory>([
  // ── Read-only ──
  ["read_files", "fileRead"],
  ["search_codebase", "fileRead"],

  // ── File mutation ──
  ["editor", "fileWrite"],
  ["apply_patch", "fileWrite"],

  // ── Code execution ──
  ["run_commands", "codeExecution"],
  ["skills", "codeExecution"],
  ["spawn_agent", "codeExecution"],

  // ── Network ──
  ["fetch_web_content", "webAccess"],

  // ── Tools with no axis of their own ──
  //
  // The honest category for these is "none of the above", and the type can spell
  // that — `null`. We do not use it, for the reason in
  // MOST_RESTRICTIVE_CATEGORY: `null` means "ask", not "allowed", so an
  // unattended run would stop and wait for a human the first time the model
  // asked a question or finished its task.
  //
  // `ask_question` is Cline's analogue of Claude's `AskUserQuestion`, but
  // `buildCanUseTool`'s special case matches that PascalCase name only. Sending
  // this one to the generic permission prompt would put a permission dialog in
  // front of every question the agent asks, so it must resolve to "allow" under
  // a normal policy. `fileRead` is the weakest of the four gates and a true
  // upper bound on what either tool can do — the smallest lie available.
  ["ask_question", "fileRead"],
  ["submit_and_exit", "fileRead"],

  // Parity with the Claude and OpenRouter maps, which special-case this same
  // callboard tool. Under Cline it arrives bare: `extraTools` is an in-process
  // array with no server prefix. Neither `render` nor `file` is a token in any
  // family below, so without this entry it would fall through to
  // `codeExecution`.
  ["render_file", "fileRead"],
]);

/**
 * Token families for names not in {@link EXACT_CATEGORIES}, **most restrictive
 * first**. A name matching more than one family resolves to the first listed.
 *
 * The order is by what a tool in that family can do, not by alphabet:
 * `codeExecution` subsumes the rest, `fileWrite` mutates local state,
 * `webAccess` moves data in and out of the machine, `fileRead` only observes.
 * Resolving `search_and_run` to `fileRead` would treat a run-capable tool as
 * read-only — the widening this ordering exists to prevent.
 *
 * In the Cline adapter this fallback serves callboard's own `extraTools`, which
 * surface under their bare names (`spawn_job`, `set_chat_title`), and any MCP
 * tools a future session enables. None are knowable in advance.
 *
 * Deliberately mirrors the ACP and OpenRouter tables rather than importing one:
 * each adapter owning its own categorizer is the property the registry in
 * `permissions/categorizers.ts` is built to protect. Consolidating all three
 * into one shared tokenizer is a reasonable follow-up, but it should be a
 * deliberate refactor rather than a side effect of adding a provider.
 */
const CATEGORY_TOKENS: ReadonlyArray<readonly [PermissionCategory, readonly string[]]> = [
  ["codeExecution", ["bash", "sh", "shell", "exec", "execute", "run", "terminal", "command", "spawn", "eval", "script", "process", "kill"]],
  ["fileWrite", ["write", "edit", "create", "delete", "remove", "move", "rename", "patch", "apply", "mkdir", "replace", "insert", "append", "update", "modify", "save", "touch"]],
  ["webAccess", ["fetch", "http", "https", "web", "browse", "url", "download", "upload", "curl", "request"]],
  ["fileRead", ["read", "glob", "grep", "search", "find", "list", "cat", "view", "stat"]],
];

/**
 * Does this string look like a *tool name* rather than a sentence?
 *
 * Rule 3 of the two-pass ruling. `ToolPermissionPolicy` is a
 * `(toolName: string, …)` bridge and nothing structurally guarantees the caller
 * passes an identifier, so prose is never parsed for a gate: anything that is
 * not a single identifier-shaped token goes straight to
 * {@link MOST_RESTRICTIVE_CATEGORY} and its words are never read.
 */
export function isClineToolIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,63}$/.test(value);
}

/**
 * Category for a Cline tool, from its name and nothing else.
 *
 * Resolution order:
 *  1. exact match in {@link EXACT_CATEGORIES}
 *  2. token match in {@link CATEGORY_TOKENS}, most restrictive family first
 *  3. {@link MOST_RESTRICTIVE_CATEGORY}
 *
 * Never returns `null` — see {@link MOST_RESTRICTIVE_CATEGORY} for why "ask" is
 * not a safe default on a path unattended runs depend on. The return type keeps
 * `| null` only to satisfy the shared `ToolCategorizer` signature.
 */
export function categorizeClineToolName(toolName: string): PermissionCategory | null {
  const trimmed = toolName.trim();
  if (!isClineToolIdentifier(trimmed)) return MOST_RESTRICTIVE_CATEGORY;

  const exact = EXACT_CATEGORIES.get(trimmed);
  if (exact) return exact;

  // Tokenize rather than using `\b` word boundaries: these names are
  // overwhelmingly snake_case and `_` is a word character, so `/\bread\b/` does
  // NOT match `read_files`. Splitting on non-alphanumerics handles snake_case,
  // camelCase and kebab-case for free.
  const tokens = new Set(
    trimmed
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
 * The `toolPolicies` map to hand `start()`.
 *
 * Every name maps to `{ enabled: true, autoApprove: false }` — not a policy, a
 * *routing instruction*: it forces the call through
 * {@link buildRequestToolApproval}, where the real decision is made against the
 * live axes. See "Why policy is NOT encoded in `toolPolicies`" above.
 *
 * `extraToolNames` must include every tool callboard registers via
 * `config.extraTools`. A name omitted here keeps `ToolPolicy`'s defaults and is
 * therefore **auto-approved and never gated** — which is the entire failure mode
 * this function exists to prevent, so the caller passing an incomplete list is
 * the one bug worth guarding in review.
 */
export function buildClineToolPolicies(extraToolNames: readonly string[] = []): Record<string, ToolPolicy> {
  const policies: Record<string, ToolPolicy> = {};
  for (const name of [...CLINE_GATED_TOOL_NAMES, ...extraToolNames]) {
    policies[name] = { enabled: true, autoApprove: false };
  }
  return policies;
}

/** A callboard `canUseTool` callback, as `services/claude.ts` builds it. */
export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: { signal: AbortSignal; suggestions?: readonly unknown[] },
) => Promise<{ behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }>;

export interface ClinePermissionContext {
  /**
   * Live accessor for the user's four-axis defaults; absent (or returning null)
   * ⇒ every category resolves to "ask".
   *
   * A **getter**, not a value. `ToolPermissionPolicy` — pass 2 — already holds a
   * live accessor and re-reads storage on every call. If pass 1 were handed a
   * snapshot taken at session start, a user who tightened a policy mid-chat
   * would have pass 1 auto-allow on the stale value and never escalate, so pass
   * 2's fresh read would never happen. Same function, same input, at the same
   * moment.
   */
  getPermissions?: () => DefaultPermissions | null;
  /** callboard's per-call prompt path. Absent ⇒ "ask" degrades to deny. */
  canUseTool?: CanUseToolFn;
  /** Aborted when the run is cancelled, so a pending prompt resolves. */
  signal: AbortSignal;
}

/**
 * Build the `capabilities.requestToolApproval` handler for one chat.
 *
 * Order of operations mirrors the Claude and ACP paths: consult the four-axis
 * policy first (a definite allow/deny answers without bothering the user), and
 * escalate to `canUseTool` — which owns the SSE prompt and the user's reply —
 * only when the policy says "ask".
 *
 * Every failure mode lands on a definite answer, and every one of them lands on
 * **denial**. A permission handler that throws or hangs would stall the turn
 * forever with no error, and a tool call is not something to fail open on:
 *  - "ask" with no `canUseTool` → deny (there is nobody to ask)
 *  - `canUseTool` throws        → deny
 *  - run aborted mid-prompt     → deny
 *
 * The `reason` travels back to the model, which per Cline's docs "receives a
 * rejection message and can adjust its approach" rather than halting — the same
 * contract as callboard's `behavior: "deny"` message on the Claude path.
 */
export function buildRequestToolApproval(ctx: ClinePermissionContext): (request: ToolApprovalRequest) => Promise<ToolApprovalResult> {
  return async (request: ToolApprovalRequest): Promise<ToolApprovalResult> => {
    const toolName = typeof request?.toolName === "string" ? request.toolName.trim() : "";
    // An approval request with no tool name is not a tool we can identify, and
    // `categorizeClineToolName` gives the empty string the strictest gate — but
    // say so explicitly rather than relying on that, since it is the one input
    // that would make both passes categorize something meaningless.
    if (!toolName) {
      log.warn("requestToolApproval arrived with no toolName — denying");
      return { approved: false, reason: "callboard could not identify this tool" };
    }

    // One categorizer, one input — and the same `toolName` goes to `canUseTool`
    // below, so pass 2 cannot reach a different answer.
    const category = categorizeClineToolName(toolName);
    // Read at decision time, never at session start — see `getPermissions`.
    const decision = decidePermission(category, ctx.getPermissions?.() ?? null);
    log.info(`[PERM-DIAG] cline tool=${toolName}, category=${category ?? "(none)"}, decision=${decision}, agent=${request.agentId ?? "(root)"}`);

    if (decision === "allow") return { approved: true };
    if (decision === "deny") {
      return { approved: false, reason: `Auto-denied by default ${category} policy` };
    }

    if (!ctx.canUseTool) {
      // Nothing can surface a prompt (e.g. a quick-completion run). Refusing is
      // the only safe reading of "ask".
      log.warn(`"ask" decision for ${toolName} with no canUseTool available — denying`);
      return { approved: false, reason: "No approval channel available for this run" };
    }

    const input = request.input && typeof request.input === "object" ? (request.input as Record<string, unknown>) : {};

    try {
      const result = await ctx.canUseTool(toolName, input, { signal: ctx.signal });
      if (ctx.signal.aborted) return { approved: false, reason: "Aborted" };
      return result?.behavior === "allow" ? { approved: true } : { approved: false, reason: result?.message ?? "Denied by the user" };
    } catch (err) {
      log.warn(`canUseTool threw for ${toolName} — denying: ${err instanceof Error ? err.message : String(err)}`);
      return { approved: false, reason: "Approval failed" };
    }
  };
}
