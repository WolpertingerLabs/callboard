/** Host-side policy translation. The package service remains authoritative.
 *
 * What the `computerControl` levels actually mean today:
 *  - `deny`  — no target can be enabled; `cu_*` calls are refused by the service
 *              (and, on Claude Code, by `canUseTool` before they reach it).
 *  - `ask`   — the human's Enable click creates a request the human confirms
 *              separately; then EVERY agent GUI action blocks on its own prompt
 *              in the chat, which only that signed-in human can answer.
 *  - `allow` — the human's Enable click opens the target immediately, and the
 *              agent then acts without a per-action prompt. The action is
 *              recorded for the operator instead (`logUnattendedAction`).
 *
 * The one thing no level changes: **only a human can enable a target.**
 * `open`/`approve` are reached only from the signed-in human's control plane,
 * and the agent's `cu_open` lists ready sessions and grants nothing. `allow`
 * governs what happens after you enable, never who enables.
 *
 * This table governs the FIRST gate — whether the transport call is admitted —
 * and, at `ask`, selects the second: the per-action confirmation, which reads
 * no policy of its own and cannot be answered by anything but the human. See
 * `computer-use.invariant.test.ts`.
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
