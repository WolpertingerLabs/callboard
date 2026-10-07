/**
 * The permission ceiling for sessions one chat starts or drives on another's
 * behalf (`start_chat_session`, `continue_chat`).
 *
 * The callboard tool servers are pre-approved on Claude Code
 * (`allowedTools.push("mcp__<key>__*")` in claude.ts) and run in-process on
 * every other engine, so calling them never reaches `canUseTool` or a sandbox.
 * Without a ceiling, a chat whose user set "ask" or "deny" for code execution
 * could start an allow-all child and get a shell through it. With one, the
 * pre-approval is safe: nothing reached through these tools can do more than
 * the caller could do itself.
 *
 * Order is deny < ask < allow, per axis. Both sides go through
 * `normalizePermissions`, so `null` (a chat created with no permissions) reads
 * as "ask" on every axis and "deny" for computer control — the same policy
 * `decidePermission` actually holds that chat to.
 *
 * An unattended caller (agent, cron, trigger, job step) runs allow-all with computer control denied, so its
 * children come out exactly as before.
 */
import type { DefaultPermissions, PermissionLevel } from "shared/types/index.js";
import { normalizePermissions } from "shared/types/index.js";

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
