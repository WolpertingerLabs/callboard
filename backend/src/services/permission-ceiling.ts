/**
 * The permission ceiling: a chat cannot use the Callboard platform tools to get
 * work done with more authority than it has itself.
 *
 * Two layers, both checked inside the tools against the calling session's live
 * effective policy (the getter its own `ToolPermissionPolicy` decides with). A
 * tool server built without that getter treats the caller as `null` — ask on
 * every axis — so a missing wire fails closed.
 *
 * 1. **The chat's own policy** ({@link guardSpecByPolicy}). Every Callboard
 *    tool has a gate in `agents/permissions/callboardToolPolicy.ts` — the axes
 *    a call needs, some raised by its arguments (`source_path`, `url`,
 *    branch arguments). A call on a denied axis is refused before its handler
 *    runs, on every engine. On Claude Code and pi the engine's per-call gate
 *    (`canUseTool` / pi `tool_call`) has already asked the user by the time
 *    the handler runs. Codex has no such gate, so there the guard asks
 *    itself, through the same prompt chain (`codexAsk` in claude.ts).
 * 2. **Authority it would hand on** (the rest of this file) — for tools that
 *    start, continue or approve work in another session.
 *
 * Order is deny < ask < allow, per axis. Both sides go through
 * `normalizePermissions`, so `null` (a chat created with no permissions) reads
 * as "ask" on every axis and "deny" for browser, computer and sandbox use — the same policy
 * `decidePermission` actually holds that chat to.
 *
 * What is covered:
 * - Every Callboard tool call, against the chat's own policy ({@link guardSpecByPolicy}).
 * - `start_chat_session` — the child gets the stricter of allow-all and the
 *   caller, per axis; browser, computer and sandbox use are always denied ({@link capPermissions}).
 * - `continue_chat` — refused when the target is looser than the caller on any
 *   axis ({@link axesAboveCeiling}).
 * - Codex targets of both — refused when an explicit `codexSandboxMode`
 *   setting is looser than the sandbox tier the capped permissions map to,
 *   because that setting overrides the permission-derived tier
 *   ({@link codexSandboxRefusal}).
 * - Tools that create, schedule or start unattended allow-all work (job
 *   create/update/spawn/retry/resume, and approving a job's approval gate; on agent sessions also talk_to_agent,
 *   deploy_agent, cron jobs, triggers, create/update_agent) — refused unless the
 *   caller is itself allow-all on every built-in axis ({@link guardUnattendedTools}).
 * - `write_custom_skill`, which changes what later runs (allow-all ones
 *   included) are told — gated at fileWrite + codeExecution by the policy table.
 *
 * What is NOT covered:
 * - The unattended defaults themselves. Agents, cron jobs, triggers, job steps
 *   and talk_to_agent targets still run `unattendedPermissions()`. An allow-all
 *   caller passes every check above, so their behaviour is unchanged.
 * - Indirect influence on later allow-all runs through content they later read.
 * - The global Codex sandbox setting for a chat's own session (separate finding).
 */
import type { SandboxMode } from "@openai/codex-sdk";
import type { DefaultPermissions, PermissionLevel } from "shared/types/index.js";
import { normalizePermissions } from "shared/types/index.js";
import { resolveSandboxMode } from "../agents/adapters/codex/permissionAdapter.js";
import { jsonResult } from "../agents/ports/tools.js";
import type { AnyToolDefinition, ToolCallResult, ToolServerSpec } from "../agents/ports/tools.js";
import { callboardToolGate, decideGate, type CallboardServerKey } from "../agents/permissions/callboardToolPolicy.js";
import type { PermissionCategory } from "../agents/permissions/ToolPermissionPolicy.js";
import { unattendedPermissions } from "./session-spawn.js";

const RANK: Record<PermissionLevel, number> = { deny: 0, ask: 1, allow: 2 };

/** Every permission category, in display order. */
export const AXES = [
  "fileRead",
  "fileWrite",
  "codeExecution",
  "webAccess",
  "browserControl",
  "computerControl",
  "sandboxControl",
] as const satisfies readonly (keyof DefaultPermissions)[];

/** Whether `value` is a permission category name. */
export function isPermissionAxis(value: unknown): value is (typeof AXES)[number] {
  return typeof value === "string" && (AXES as readonly string[]).includes(value);
}

/** Whether `value` is a permission level (allow / ask / deny). */
export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return typeof value === "string" && Object.hasOwn(RANK, value);
}

/** Per axis, the stricter of `requested` and `ceiling`. */
export function capPermissions(requested: DefaultPermissions, ceiling: DefaultPermissions | null | undefined): DefaultPermissions {
  const cap = normalizePermissions(ceiling);
  const result = normalizePermissions(requested);
  for (const axis of AXES) {
    if (RANK[cap[axis]] < RANK[result[axis]]) result[axis] = cap[axis];
  }
  return result;
}

/** The axes on which `target` is looser than `ceiling` — empty when it fits. */
export function axesAboveCeiling(target: DefaultPermissions | null | undefined, ceiling: DefaultPermissions | null | undefined): (keyof DefaultPermissions)[] {
  const cap = normalizePermissions(ceiling);
  const have = normalizePermissions(target);
  return AXES.filter((axis) => RANK[have[axis]] > RANK[cap[axis]]);
}

const SANDBOX_RANK: Record<SandboxMode, number> = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };

/**
 * Why a Codex session under `permissions` must not be started, or `null`.
 *
 * Codex has no per-call hook: permissions collapse onto a sandbox tier at
 * thread start, and an explicit `codexSandboxMode` setting replaces the
 * permission-derived tier outright (optionsAdapter `resolveSandboxAndApproval`).
 * So when that setting is looser than the tier `permissions` map to — e.g.
 * `danger-full-access` while the capped `codeExecution` is "ask" — the capped
 * child would still get a full shell.
 */
export function codexSandboxRefusal(permissions: DefaultPermissions, explicitSandbox: SandboxMode | undefined): string | null {
  if (!explicitSandbox) return null;
  const implied = resolveSandboxMode(normalizePermissions(permissions));
  if (SANDBOX_RANK[explicitSandbox] <= SANDBOX_RANK[implied]) return null;
  return (
    `The Codex sandbox setting codexSandboxMode="${explicitSandbox}" (Settings → Codex) overrides per-chat permissions, and is looser than the ` +
    `"${implied}" sandbox this session's permissions allow (fileWrite=${permissions.fileWrite}, codeExecution=${permissions.codeExecution}). ` +
    "Refused so it cannot run with more access than this chat has. Use another provider, or ask the user."
  );
}

/**
 * Refuse each named tool unless the caller is already allow-all on every
 * built-in axis — i.e. unless {@link unattendedPermissions} fits under it.
 * Browser, computer and sandbox use are aside: unattended work always denies them.
 *
 * For tools that create, schedule or start sessions that run allow-all with
 * nobody watching (job steps, agent runs, cron, triggers). A caller that is
 * already allow-all gains nothing from them; anyone else would gain a shell.
 * Throws when a name is not in `tools`, so a renamed tool cannot silently lose
 * its guard.
 */
export function guardUnattendedTools(
  tools: AnyToolDefinition[],
  names: readonly string[],
  getPermissions: (() => DefaultPermissions | null) | undefined,
): AnyToolDefinition[] {
  for (const name of names) {
    if (!tools.some((t) => t.name === name)) throw new Error(`guardUnattendedTools: no tool named "${name}"`);
  }
  const guarded = new Set(names);
  return tools.map((tool) => {
    if (!guarded.has(tool.name)) return tool;
    return {
      ...tool,
      description: `${tool.description} ${UNATTENDED_REQUIREMENT_NOTE}`,
      handler: async (args, context) => unattendedRefusal(tool.name, getPermissions) ?? tool.handler(args, context),
    };
  });
}

/** Appended to the description of every tool {@link unattendedRefusal} can refuse. */
export const UNATTENDED_REQUIREMENT_NOTE =
  "Requires THIS chat to allow fileRead, fileWrite, codeExecution and webAccess — it starts unattended allow-all work.";

/**
 * The refusal {@link guardUnattendedTools} returns, or `null` when the caller
 * is allow-all. Exported for a tool where only some calls start unattended
 * work — `respond_job_approval` guards `approve` and leaves `reject` open.
 */
export function unattendedRefusal(toolName: string, getPermissions: (() => DefaultPermissions | null) | undefined): ToolCallResult | null {
  const looser = axesAboveCeiling(unattendedPermissions(), getPermissions?.() ?? null);
  if (looser.length === 0) return null;
  return jsonResult({
    ok: false,
    error: "permission_ceiling",
    tool: toolName,
    looserCategories: looser,
    message:
      `${toolName} creates or starts work that runs unattended with every category allowed, and this chat does not allow ${looser.join(", ")}. ` +
      "Refused so it cannot reach more than it has. Ask the user to do this, or to allow those categories for this chat.",
  });
}

/**
 * Why a parent chat may NOT approve its child's permission prompt, or `null`.
 *
 * The same ceiling as everything else in this file, applied to answering
 * instead of spawning: approving a child's call is doing that call through the
 * child, so the answerer must itself hold `allow` on the call's axis. A parent
 * whose own axis is "ask" would have had to ask the human for the very same
 * thing; one on "deny" could not do it at all. Either way it may still DENY —
 * refusing never grants authority — which is why only `allow` is checked.
 *
 * A call with no category (an unknown tool) has no axis to compare, and so no
 * proof the parent holds the authority: refused. Browser/computer control never
 * reaches a prompt (`decidePermission` maps its "ask" to the service's own
 * gate), but would be refused here regardless unless the parent allows it.
 */
export function parentApprovalRefusal(
  category: string | null | undefined,
  parentPermissions: DefaultPermissions | null | undefined,
  /** Further axes the call needs (a multi-axis Callboard tool gate): each must be `allow` too. */
  alsoRequired?: readonly string[],
): string | null {
  if (!category || !(AXES as readonly string[]).includes(category)) {
    return "This call has no permission category (an unknown tool), so there is no axis on which this chat could hold the authority to approve it. You may deny it; otherwise leave it for the user.";
  }
  for (const extra of alsoRequired ?? []) {
    if (extra === category) continue;
    const refusal = parentApprovalRefusal(extra, parentPermissions);
    if (refusal) return refusal;
  }
  const axis = category as (typeof AXES)[number];
  const own = normalizePermissions(parentPermissions)[axis];
  if (own === "allow") return null;
  return (
    `This chat's own ${axis} permission is "${own}", not "allow", so it cannot approve a ${axis} call for a child — that would do through the child what ` +
    `this chat ${own === "ask" ? "would have to ask the user for" : "is denied"}. You may deny it; otherwise leave it for the user.`
  );
}

/** What a guard's own "ask" resolved to. */
export interface PolicyAskResult {
  behavior: "allow" | "deny";
  message?: string;
}

/**
 * How {@link guardSpecByPolicy} treats a call the policy says to ask about.
 *
 * - `"harness"` — the engine's per-call gate (Claude `canUseTool`, pi
 *   `tool_call`) already asked and the user approved, or the call would not
 *   have reached the handler. Run it; enforce only deny.
 * - a function — there is no per-call gate (Codex). Ask through it; run the
 *   handler only on allow.
 */
export type PolicyAskMode =
  | "harness"
  | ((
      qualifiedName: string,
      input: Record<string, unknown>,
      ctx: { category: PermissionCategory; pending: PermissionCategory[]; signal?: AbortSignal },
    ) => Promise<PolicyAskResult>);

/**
 * Wrap every handler of a Callboard tool server so a call is checked against
 * the chat's live policy and the tool's gate (`callboardToolPolicy.ts`) before
 * it runs. A denied call returns {@link policyRefusal} and never reaches the
 * handler.
 *
 * Applied in `inject()` (services/claude.ts) to every Callboard server on
 * every engine, so this is the backstop that holds whatever an engine's own
 * gate did. A missing getter reads as `null` — ask on every axis.
 */
export function guardSpecByPolicy(
  spec: ToolServerSpec,
  serverKey: CallboardServerKey,
  opts: { getPermissions: (() => DefaultPermissions | null) | undefined; onAsk: PolicyAskMode },
): ToolServerSpec {
  return {
    ...spec,
    tools: spec.tools.map((tool) => ({
      ...tool,
      handler: async (args, context) => {
        const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
        const gate = callboardToolGate(serverKey, tool.name, input) ?? ["codeExecution"];
        const decided = decideGate(gate, opts.getPermissions?.() ?? null);
        if (decided.decision === "allow") return tool.handler(args, context);
        const category = decided.category ?? "codeExecution";
        if (decided.decision === "deny") return policyRefusal(tool.name, category, "deny");
        if (opts.onAsk === "harness") return tool.handler(args, context);
        const answer = await opts.onAsk(`mcp__${serverKey}__${tool.name}`, input, { category, pending: decided.pending, signal: context?.signal });
        if (answer.behavior === "allow") return tool.handler(args, context);
        return policyRefusal(tool.name, category, "not_approved", answer.message);
      },
    })),
  };
}

/**
 * The refusal {@link guardSpecByPolicy} returns: the same shape as
 * {@link unattendedRefusal}, so a model reads it, relays it and carries on.
 */
export function policyRefusal(toolName: string, category: PermissionCategory, reason: "deny" | "not_approved", detail?: string): ToolCallResult {
  return jsonResult({
    ok: false,
    error: "permission_policy",
    tool: toolName,
    category,
    message:
      reason === "deny"
        ? `${toolName} needs the ${category} permission, which is set to deny for this chat, so it was not run. Ask the user to allow ${category} for this chat, or to do this themselves.`
        : `${toolName} needs the ${category} permission and was not approved, so it was not run${detail ? ` (${detail})` : ""}.`,
  });
}
