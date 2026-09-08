/** Host-side policy translation. The package service remains authoritative.
 *
 * What the `computerControl` levels actually mean today:
 *  - `deny`  — no target can be enabled; `cu_*` calls are refused by the service
 *              (and, on Claude Code, by `canUseTool` before they reach it).
 *  - `ask`   — the human's Enable click creates a request the human confirms
 *              separately; then each agent action is confirmed.
 *  - `allow` — the human's Enable click opens the target immediately. Only a
 *              human can enable a target at any level (`cu_open` lists ready
 *              sessions and grants nothing). Each agent action STILL needs a
 *              human confirmation — the agent's `cu_action` call blocks on a
 *              prompt in the chat (`ComputerUseHost.requestAgentAction` is
 *              unconditional and reads no level). The level does not grant
 *              autonomous control; any UI or description that says otherwise
 *              is wrong, not this table.
 *
 * Note that this table governs the FIRST gate only — whether the transport
 * call is admitted. The per-action confirmation is a second, independent gate
 * that exists precisely because the first one passed, and it takes no input
 * from here. See `computer-use.invariant.test.ts`.
 */
import type { DefaultPermissions, PermissionLevel } from "shared/types/index.js";

export type ComputerTargetKind = "browser" | "desktop";
export interface ComputerUsePolicy {
  computerControl: PermissionLevel;
  fileRead: PermissionLevel;
  fileWrite: PermissionLevel;
  codeExecution: PermissionLevel;
  webAccess: PermissionLevel;
}

/** Never fall back to a previously allowed snapshot when metadata cannot be read. */
export function readComputerUsePolicy(value: unknown): ComputerUsePolicy {
  const source = value && typeof value === "object" ? (value as Partial<DefaultPermissions>) : {};
  const level = (key: keyof ComputerUsePolicy): PermissionLevel => {
    const candidate = Object.hasOwn(source, key) ? (source as Record<string, unknown>)[key] : undefined;
    return candidate === "allow" || candidate === "ask" ? candidate : "deny";
  };
  return {
    computerControl: level("computerControl"),
    fileRead: level("fileRead"),
    fileWrite: level("fileWrite"),
    codeExecution: level("codeExecution"),
    webAccess: level("webAccess"),
  };
}

/**
 * The initial native driver controls an existing OS session, not a sandbox.
 * Refuse narrower promises we cannot enforce through arbitrary app pixels.
 * Browser file/clipboard bridges and arbitrary evaluation are not exposed.
 */
export function computerUseScopeError(kind: ComputerTargetKind, policy: ComputerUsePolicy): string | undefined {
  if (policy.computerControl === "deny") return "Browser & Computer Control is denied. Change this chat's permission explicitly to enable managed access.";
  if (kind === "desktop") {
    const required = ["fileRead", "fileWrite", "codeExecution", "webAccess"] as const;
    const restricted = required.filter((key) => policy[key] !== "allow");
    if (restricted.length) {
      return `Native desktop apps cannot enforce narrower ${restricted.join(", ")} restrictions. Use a separately confined target or explicitly allow these permissions before enabling this native OS session.`;
    }
  }
  if (kind === "browser" && policy.webAccess !== "allow") {
    return "This browser driver requires Web Access allow; it does not implement per-origin network approval or an offline network sandbox. No browser will be started.";
  }
  return undefined;
}
