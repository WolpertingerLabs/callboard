/**
 * Provider kind → tool-name categorizer registry.
 *
 * ## Why a registry and not a conditional
 *
 * `services/claude.ts` used to build its `ToolPermissionPolicy` with a ternary:
 *
 * ```ts
 * new ToolPermissionPolicy(providerKind === "acp" ? categorizeAcpToolName : categorizeClaudeTool, …)
 * ```
 *
 * That shape has two problems, and only the first is aesthetic. The second is
 * the bug it shipped: **the fallback is a real provider's map, not a neutral
 * default.** Every non-ACP kind silently inherited Claude Code's PascalCase
 * table, so the since-removed OpenRouter harness — whose tool names were all
 * snake_case — matched nothing and fell through `categorizeClaudeTool`'s
 * `return "fileWrite"`. The production log carries 641 `tool=bash,
 * category=fileWrite, decision=allow` lines: its shell tool, gated on the
 * `fileWrite` axis, auto-allowed for every user whose policy allowed writes but
 * asked about execution. The harness is gone; the shape that let it happen is
 * what this file exists to prevent recurring.
 *
 * A `Record<AgentProviderKind, …>` removes the failure mode by construction. A
 * new kind added to the union without an entry here is a **compile error**, not
 * a silent adoption of whichever provider happened to be the `else` branch.
 * There is no `default`, no partial record, and no lookup fallback — an
 * unregistered kind cannot exist.
 *
 * ## The two-pass rule
 *
 * Adapters that evaluate permission twice (an adapter-side resolve *and*
 * `buildCanUseTool`) must run the identical function over the identical input,
 * or the two passes can disagree and the second one can auto-allow what the
 * first escalated. This registry is what makes "the identical function" true:
 * both passes reach their categorizer through the same provider kind.
 *
 * Which providers actually have two passes, as of this file:
 *  - **acp** — yes. `resolveAcpPermission` is pass 1, `buildCanUseTool` pass 2.
 *    Kept in sync by `acpToolLabel` producing the one string both categorize.
 *  - **cline** — yes. `buildRequestToolApproval` is pass 1, `buildCanUseTool`
 *    pass 2. The easiest case of the three: Cline's `ToolApprovalRequest`
 *    always carries a real `toolName`, so there is no label ladder to keep the
 *    two passes agreeing — they receive the same string by construction.
 *  - **pi** — yes, and the same easy shape as Cline. `decidePiToolCall` (the
 *    `tool_call` extension handler) is pass 1, `buildCanUseTool` pass 2, and
 *    `ToolCallEvent.toolName` is always a real identifier from a closed set
 *    plus callboard's own tool names. Note pi does not ask *at all* without
 *    that handler — an unblocked `tool_call` executes — so the gate is not an
 *    escalation path but the whole permission surface.
 *  - **claude-code** — one pass. The SDK calls `canUseTool`; nothing else
 *    decides.
 *  - **codex** — no passes at all; see below.
 *  - **mock** — no passes; it is a scripted event emitter.
 *
 * @see plans/acp-adapter.md (Permissions — "The two-pass rule")
 * @see ../adapters/acp/permissionAdapter.ts (the reference implementation)
 */
import type { AgentProviderKind } from "../ports/AgentProvider.js";
import type { PermissionCategory } from "./ToolPermissionPolicy.js";
import { categorizeClaudeTool } from "../adapters/claude-code/permissionAdapter.js";
import { categorizeAcpToolName } from "../adapters/acp/permissionAdapter.js";
import { categorizeClineToolName } from "../adapters/cline/permissionAdapter.js";
import { categorizePiToolName } from "../adapters/pi/permissionAdapter.js";

/** Tool name → permission category. `null` means "ask", never "allowed". */
export type ToolCategorizer = (toolName: string) => PermissionCategory | null;

/**
 * Categorizer for a provider that gates nothing today.
 *
 * Used for kinds with no `canUseTool` path, where an entry is still required so
 * the record stays exhaustive. It gates everything at `codeExecution` — the
 * strictest axis — so that if such a provider ever *does* grow a per-call hook,
 * the failure mode is "over-prompts" rather than "silently ran the tool". The
 * one thing it must not be is another provider's map, which is the mistake this
 * registry exists to make unrepresentable.
 */
const gateEverything: ToolCategorizer = () => "codeExecution";

/**
 * The registry. Exhaustive by type: omitting a kind will not compile.
 *
 * `codex` is deliberately NOT given a real name map. Codex has no per-call
 * `canUseTool` hook — its permissions collapse onto `sandboxMode` +
 * `approvalPolicy` fixed at thread start (`adapters/codex/optionsAdapter.ts`),
 * a single pass with nothing to disagree with. `services/claude.ts` builds a
 * `ToolPermissionPolicy` unconditionally, so this entry exists and is
 * unreachable; writing a Codex tool table would imply a gate that does not
 * exist. Changing Codex's permission path is explicitly out of scope.
 *
 * `mock` gets Claude's map because the mock provider stands in for the
 * Claude-shaped SDK in tests. It never invokes `canUseTool` either.
 */
export const TOOL_CATEGORIZERS: Record<AgentProviderKind, ToolCategorizer> = {
  "claude-code": categorizeClaudeTool,
  acp: categorizeAcpToolName,
  cline: categorizeClineToolName,
  pi: categorizePiToolName,
  codex: gateEverything,
  mock: categorizeClaudeTool,
};

/**
 * Categorizer for a provider kind.
 *
 * Total over the union — every kind has an entry, so there is no fallback
 * parameter and no "unknown provider" branch to get wrong.
 */
export function getToolCategorizer(kind: AgentProviderKind): ToolCategorizer {
  return TOOL_CATEGORIZERS[kind];
}
