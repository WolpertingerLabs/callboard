/**
 * Permission translation: pi's `tool_call` extension event ⇄ callboard's
 * four-axis permission model.
 *
 * ## The two traps this file exists to close
 *
 * **1. pi does not ask.** There is no approval callback in pi's session options
 * at all — a tool call executes unless an extension's `tool_call` handler returns
 * `{ block: true }`. Left alone, callboard would render its four-axis permission
 * UI over a harness that never prompts: the decorative-gate failure
 * `adapters/acp/vendors.ts` names as disqualifying. {@link buildPermissionExtension}
 * is what makes the gate real, and it is not optional.
 *
 * The spike confirmed every property this depends on against 0.83.0:
 * `tool_call` fires for all seven built-ins (`read`, `bash`, `edit`, `write`,
 * `grep`, `find`, `ls`) *and* for `customTools`; the handler is genuinely
 * awaited (a 300 ms sleep inside it delayed execution rather than racing it);
 * and `{ block: true, reason }` both prevented the write and delivered the
 * reason to the model verbatim.
 *
 * **2. Project trust is arbitrary code execution, and no tool gate can catch
 * it.** pi loads `.pi/extensions/*.ts` from the opened repository through jiti at
 * session start — before the first model call, so no `tool_call` handler exists
 * yet to block it. That mitigation lives in `optionsAdapter.buildPiServicesOptions`;
 * {@link assertPiTrustDenied} is the assertion that keeps it there.
 *
 * ## Fail-closed, twice over
 *
 * `categorizePiToolName` never returns `null`. The plan specified `null` for an
 * uncategorizable name, reasoning that the gate would read it as "block" — but
 * `decidePermission(null, …)` returns `"ask"` *unconditionally*, without
 * consulting the user's settings, and callboard's unattended runners (job steps,
 * `start_chat_session`, deployed agents) hardcode every axis to `"allow"`
 * precisely so they need no human. A `null` there would hang an agent job step on
 * a prompt nobody will answer. So an unknown name resolves to
 * {@link MOST_RESTRICTIVE_CATEGORY} instead, exactly as the Cline and ACP
 * adapters do, and "fail-closed" means *strictest axis*, not *ask*.
 *
 * ## The two-pass rule
 *
 * callboard evaluates a tool's permission twice: here (pass 1), and again inside
 * `buildCanUseTool` via `ToolPermissionPolicy` before it prompts (pass 2). If
 * they can disagree, a tool escalated by pass 1 can be silently auto-allowed by
 * pass 2. pi is the easy case, like Cline: `ToolCallEvent.toolName` is always a
 * real identifier from a closed set plus callboard's own tool names, and that
 * same string is what pass 2 receives. Both passes run
 * {@link categorizePiToolName} over the identical input. The only way to break it
 * would be to categorize from `event.input`, which pass 2 cannot see. Do not.
 *
 * @see plans/pi-adapter.md
 * @see plans/pi-spike-findings.md (§2 — project trust; §3 — the gate, measured)
 * @see ../cline/permissionAdapter.ts (the closest precedent)
 */
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
  CreateAgentSessionServicesOptions,
} from "@earendil-works/pi-coding-agent";
import type { DefaultPermissions } from "shared/types/index.js";
import { decidePermission, type PermissionCategory } from "../../permissions/ToolPermissionPolicy.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("pi-permissions");

/** The name callboard's inline gate extension registers under. */
export const PI_EXTENSION_NAME = "callboard-permissions";

/** An inline extension factory, as `resourceLoaderOptions.extensionFactories` takes it. */
export type PiPermissionExtension = ExtensionFactory;

/**
 * The category anything unrecognizable resolves to.
 *
 * `codeExecution` is the top of the restrictiveness order: a tool that can run
 * code can do everything the other three axes describe, so it is the only safe
 * answer when we do not know what a tool is. See the header for why this is not
 * `null`.
 */
export const MOST_RESTRICTIVE_CATEGORY: PermissionCategory = "codeExecution";

/**
 * pi's built-in tools, all seven.
 *
 * Confirmed by running `session.getAllTools()` against 0.83.0 with every tool
 * enabled — the default *active* set is only `read`/`bash`/`edit`/`write`, but
 * all seven are registerable and all seven fire `tool_call`.
 *
 * **There is no built-in web tool.** The `webAccess` axis therefore governs
 * nothing on a pi chat until one is added; Phase 4 should say so in the UI
 * rather than showing an inert control.
 */
export const PI_BUILTIN_TOOL_NAMES: readonly string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/**
 * Exact tool-name → category table for everything pi ships.
 *
 * All seven names are single common words, which is exactly the case where the
 * token fallback below would be least reliable — `find` and `ls` carry no token
 * from any family, and would otherwise land on `codeExecution` and over-prompt.
 * An exact table is both correct and cheaper to reason about.
 */
const EXACT_CATEGORIES: ReadonlyMap<string, PermissionCategory> = new Map<string, PermissionCategory>([
  // ── Read-only ──
  ["read", "fileRead"],
  ["grep", "fileRead"],
  ["find", "fileRead"],
  ["ls", "fileRead"],

  // ── File mutation ──
  ["edit", "fileWrite"],
  ["write", "fileWrite"],

  // ── Code execution ──
  ["bash", "codeExecution"],

  // Parity with the Claude, OpenRouter and Cline maps, which special-case this
  // same callboard tool. Under pi it arrives bare: `customTools` is an
  // in-process array with no server prefix. Neither `render` nor `file` is a
  // token in any family below, so without this entry it would fall through to
  // `codeExecution` and prompt on every file preview.
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
 * In the pi adapter this fallback serves callboard's own `customTools`, which
 * surface under their bare names (`spawn_job`, `set_chat_title`). pi has no MCP
 * client, so unlike the Cline adapter there is no third-party tool surface for it
 * to also cover — see the plan's Decision 5.
 *
 * Deliberately mirrors the Cline/ACP/OpenRouter tables rather than importing
 * one: each adapter owning its own categorizer is the property the registry in
 * `permissions/categorizers.ts` protects. Consolidating them is a reasonable
 * follow-up, but should be a deliberate refactor rather than a side effect of
 * adding a provider.
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
 * passes an identifier, so prose is never parsed for a gate: anything that is not
 * a single identifier-shaped token goes straight to
 * {@link MOST_RESTRICTIVE_CATEGORY} and its words are never read.
 */
export function isPiToolIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,63}$/.test(value);
}

/**
 * Category for a pi tool, from its name and nothing else.
 *
 * Resolution order:
 *  1. exact match in {@link EXACT_CATEGORIES}
 *  2. token match in {@link CATEGORY_TOKENS}, most restrictive family first
 *  3. {@link MOST_RESTRICTIVE_CATEGORY}
 *
 * Never returns `null` — see the header. The return type keeps `| null` only to
 * satisfy the shared `ToolCategorizer` signature that
 * `permissions/categorizers.ts` requires (Phase 3 registers it there).
 */
export function categorizePiToolName(toolName: string): PermissionCategory | null {
  const trimmed = toolName.trim();
  if (!isPiToolIdentifier(trimmed)) return MOST_RESTRICTIVE_CATEGORY;

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

/** A callboard `canUseTool` callback, as `services/claude.ts` builds it. */
export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: { signal: AbortSignal; suggestions?: readonly unknown[] },
) => Promise<{ behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string }>;

export interface PiPermissionContext {
  /**
   * Live accessor for the user's four-axis defaults; absent (or returning null)
   * ⇒ every category resolves to "ask".
   *
   * A **getter**, not a value. `ToolPermissionPolicy` — pass 2 — already holds a
   * live accessor and re-reads storage on every call. If pass 1 were handed a
   * snapshot taken at session start, a user who tightened a policy mid-chat would
   * have pass 1 auto-allow on the stale value and never escalate, so pass 2's
   * fresh read would never happen. Same function, same input, same moment.
   */
  getPermissions?: () => DefaultPermissions | null;
  /** callboard's per-call prompt path. Absent ⇒ "ask" degrades to deny. */
  canUseTool?: CanUseToolFn;
  /** Aborted when the run is cancelled, so a pending prompt resolves. */
  signal: AbortSignal;
}

/**
 * Decide one tool call. Exported so the gate can be tested without constructing
 * a pi extension runtime.
 *
 * Order of operations mirrors the Claude, ACP and Cline paths: consult the
 * four-axis policy first (a definite allow/deny answers without bothering the
 * user), and escalate to `canUseTool` — which owns the SSE prompt and the user's
 * reply — only when the policy says "ask".
 *
 * Every failure mode lands on a definite answer, and every one of them lands on
 * **blocking**. A permission handler that throws or hangs would stall the turn
 * forever with no error, and a tool call is not something to fail open on:
 *  - unidentifiable tool name  → block
 *  - "ask" with no `canUseTool` → block (there is nobody to ask)
 *  - `canUseTool` throws        → block
 *  - run aborted mid-prompt     → block
 *
 * The `reason` travels back to the model as an error tool result, which the
 * spike verified reaches it verbatim — the model reported the exact denial
 * string and adjusted rather than halting.
 */
export async function decidePiToolCall(ctx: PiPermissionContext, event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
  const toolName = typeof event?.toolName === "string" ? event.toolName.trim() : "";
  // A tool call with no name is not a tool we can identify. `categorizePiToolName`
  // would give the empty string the strictest gate anyway, but say so explicitly
  // rather than relying on that — it is the one input that would make both passes
  // categorize something meaningless.
  if (!toolName) {
    log.warn("tool_call arrived with no toolName — blocking");
    return { block: true, reason: "callboard could not identify this tool" };
  }

  // One categorizer, one input — and the same `toolName` goes to `canUseTool`
  // below, so pass 2 cannot reach a different answer.
  const category = categorizePiToolName(toolName);
  // Read at decision time, never at session start — see `getPermissions`.
  const decision = decidePermission(category, ctx.getPermissions?.() ?? null);
  log.info(`[PERM-DIAG] pi tool=${toolName}, category=${category ?? "(none)"}, decision=${decision}`);

  // `undefined`, not `{ block: false }`: pi treats any handler result without
  // `block: true` as permission, and returning nothing is the documented
  // "no opinion" shape.
  if (decision === "allow") return undefined;
  if (decision === "deny") {
    return { block: true, reason: `Auto-denied by default ${category} policy` };
  }

  if (!ctx.canUseTool) {
    // Nothing can surface a prompt (e.g. a quick-completion run). Refusing is the
    // only safe reading of "ask".
    log.warn(`"ask" decision for ${toolName} with no canUseTool available — blocking`);
    return { block: true, reason: "No approval channel available for this run" };
  }

  const input = event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {};

  try {
    const result = await ctx.canUseTool(toolName, input, { signal: ctx.signal });
    if (ctx.signal.aborted) return { block: true, reason: "Aborted" };
    return result?.behavior === "allow" ? undefined : { block: true, reason: result?.message ?? "Denied by the user" };
  } catch (err) {
    log.warn(`canUseTool threw for ${toolName} — blocking: ${err instanceof Error ? err.message : String(err)}`);
    return { block: true, reason: "Approval failed" };
  }
}

/**
 * Build the inline extension that installs the gate.
 *
 * An `ExtensionFactory` — `(pi: ExtensionAPI) => void` — handed to
 * `resourceLoaderOptions.extensionFactories`. **Not** `loadExtensionFromFactory`,
 * which the plan named: that function exists in pi's `dist/` but is not
 * re-exported from the package root, and pi's `exports` map refuses deep imports
 * (`ERR_PACKAGE_PATH_NOT_EXPORTED`, verified).
 *
 * Registers `tool_call` only. It does *not* register `project_trust`: that event
 * is emitted by `resolveProjectTrusted()`, which the SDK path never calls, so a
 * handler here would be dead code that reads like a working mitigation. The real
 * denial is `resolveProjectTrust` in `optionsAdapter.buildPiServicesOptions`.
 */
export function buildPermissionExtension(ctx: PiPermissionContext): PiPermissionExtension {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", (event) => decidePiToolCall(ctx, event));
  };
}

/**
 * Assert that a services-options object actually denies project trust.
 *
 * This is a **guard, not documentation**. The whole of §2's mitigation is three
 * settings that are easy to drop in a refactor and produce no symptom when they
 * are missing — a chat on an untrusted repo simply works, having executed the
 * repo's TypeScript. `permissionAdapter.test.ts` runs this over the real
 * `buildPiServicesOptions()` output so that swapping in `createAgentSession()`,
 * or losing `noExtensions`, fails a test rather than shipping.
 *
 * Returns the list of problems; empty means the options are safe.
 */
export function assertPiTrustDenied(options: CreateAgentSessionServicesOptions): string[] {
  const problems: string[] = [];

  if (!options.settingsManager) {
    problems.push("no settingsManager — pi defaults projectTrusted to true");
  } else if (options.settingsManager.isProjectTrusted()) {
    problems.push("settingsManager reports the project as trusted");
  }

  if (!options.resourceLoaderReloadOptions?.resolveProjectTrust) {
    problems.push("no resolveProjectTrust — project-local extensions load unasked");
  }

  if (options.resourceLoaderOptions?.noExtensions !== true) {
    problems.push("noExtensions is not true — project-local extensions are discoverable");
  }

  const factories = options.resourceLoaderOptions?.extensionFactories ?? [];
  if (factories.length === 0) {
    problems.push("no extensionFactories — the permission gate is not installed");
  }

  return problems;
}

/**
 * Tool allowlist/denylist derived from the four permission axes.
 *
 * Belt and braces beside the live gate: an axis set to `deny` makes the tool
 * *invisible to the model* rather than merely blocked at call time, so the model
 * does not waste a turn attempting something it will never be allowed to do.
 * Exactly what the Cline adapter does with `toolPolicies` + `requestToolApproval`.
 *
 * **`tools` is an allowlist over `customTools` too.** This is the sharp edge the
 * spike found by wasting a run on it: passing `tools: ["read","bash",…]` without
 * naming callboard's own tools silently removed them from the model's tool list.
 * So `customToolNames` is appended to any allowlist this builds — narrowing the
 * built-ins for a permission axis must never delete callboard's tool surface.
 *
 * Only `deny` produces an allowlist. `ask` and `allow` both leave the tool
 * visible, because "ask" means *prompt at call time*, which requires the model to
 * be able to call it.
 */
export function buildToolFilters(
  permissions: DefaultPermissions | null,
  customToolNames: readonly string[] = [],
): { tools?: string[]; excludeTools?: string[] } {
  if (!permissions) return {};

  const denied = PI_BUILTIN_TOOL_NAMES.filter((name) => {
    const category = categorizePiToolName(name);
    return decidePermission(category, permissions) === "deny";
  });

  if (denied.length === 0) return {};

  const allowed = PI_BUILTIN_TOOL_NAMES.filter((name) => !denied.includes(name));
  return {
    // Both, deliberately. `tools` alone would be enough, but pi applies
    // `excludeTools` *after* `tools`, so listing the denied names too means a
    // future pi that changes allowlist semantics still cannot re-admit them.
    tools: [...allowed, ...customToolNames],
    excludeTools: denied,
  };
}
