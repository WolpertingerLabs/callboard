/**
 * The permission ceiling: a chat cannot use the Callboard platform tools to get
 * work done with more authority than it has itself.
 *
 * Why the tools need it: the in-process tool servers (`callboard-tools`, and
 * `callboard` for agent sessions) are pre-approved on Claude Code
 * (`allowedTools.push("mcp__<key>__*")` in claude.ts) and run in-process on
 * every other engine, so calling one never reaches `canUseTool` or a sandbox.
 * The ceiling is checked inside the tools instead, against the calling
 * session's live effective policy (the getter its own `ToolPermissionPolicy`
 * decides with). A tool server built without that getter treats the caller as
 * `null` — ask on every axis — so a missing wire fails closed.
 *
 * Order is deny < ask < allow, per axis. Both sides go through
 * `normalizePermissions`, so `null` (a chat created with no permissions) reads
 * as "ask" on every axis and "deny" for computer control — the same policy
 * `decidePermission` actually holds that chat to.
 *
 * What is covered:
 * - `start_chat_session` — the child gets the stricter of allow-all and the
 *   caller, per axis; computer control is always denied ({@link capPermissions}).
 * - `continue_chat` — refused when the target is looser than the caller on any
 *   axis ({@link axesAboveCeiling}).
 * - Codex targets of both — refused when an explicit `codexSandboxMode`
 *   setting is looser than the sandbox tier the capped permissions map to,
 *   because that setting overrides the permission-derived tier
 *   ({@link codexSandboxRefusal}).
 * - Tools that create, schedule or start unattended allow-all work (job
 *   create/update/spawn/retry/resume; on agent sessions also talk_to_agent,
 *   deploy_agent, cron jobs, triggers, create/update_agent) — refused unless the
 *   caller is itself allow-all on every built-in axis ({@link guardUnattendedTools}).
 *
 * What is NOT covered:
 * - The unattended defaults themselves. Agents, cron jobs, triggers, job steps
 *   and talk_to_agent targets still run `unattendedPermissions()`. An allow-all
 *   caller passes every check above, so their behaviour is unchanged.
 * - A brand-new chat's own policy is read from its creation options for its
 *   whole first session (claude.ts `getDefaultPermissions`), so a permission
 *   change made mid-way through that first session is not seen until the next.
 * - Indirect influence on later allow-all runs that does not start one:
 *   `write_custom_skill`, or content an allow-all run later reads.
 * - The global Codex sandbox setting for a chat's own session (separate finding).
 */
import type { SandboxMode } from "@openai/codex-sdk";
import type { DefaultPermissions, PermissionLevel } from "shared/types/index.js";
import { normalizePermissions } from "shared/types/index.js";
import { resolveSandboxMode } from "../agents/adapters/codex/permissionAdapter.js";
import { jsonResult } from "../agents/ports/tools.js";
import type { AnyToolDefinition } from "../agents/ports/tools.js";
import { unattendedPermissions } from "./session-spawn.js";

const RANK: Record<PermissionLevel, number> = { deny: 0, ask: 1, allow: 2 };

const AXES = ["fileRead", "fileWrite", "codeExecution", "webAccess", "computerControl"] as const satisfies readonly (keyof DefaultPermissions)[];

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
 * Computer control is aside: unattended work always denies it.
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
      description: `${tool.description} Requires THIS chat to allow fileRead, fileWrite, codeExecution and webAccess — it starts unattended allow-all work.`,
      handler: async (args, context) => {
        const looser = axesAboveCeiling(unattendedPermissions(), getPermissions?.() ?? null);
        if (looser.length > 0) {
          return jsonResult({
            ok: false,
            error: "permission_ceiling",
            tool: tool.name,
            looserCategories: looser,
            message:
              `${tool.name} creates or starts work that runs unattended with every category allowed, and this chat does not allow ${looser.join(", ")}. ` +
              "Refused so it cannot reach more than it has. Ask the user to do this, or to allow those categories for this chat.",
          });
        }
        return tool.handler(args, context);
      },
    };
  });
}
