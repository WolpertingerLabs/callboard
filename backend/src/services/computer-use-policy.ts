/** Host-side policy translation. The package service remains authoritative.
 *
 * Two axes govern the two targets, one each:
 *  - `browserControl` ("Browser Use") — the managed browser target. It needs no
 *    other axis; in particular it does NOT require `webAccess`. Browser
 *    networking is unrestricted, and opting into Browser Use opts into that.
 *  - `computerControl` ("Computer Use") — the desktop target. It additionally
 *    requires every other axis, `browserControl` included, on `allow`: a
 *    desktop session can open any app (a browser among them) and cannot honour
 *    a narrower promise, and on `allow` it could do so unattended.
 * A missing or malformed axis reads as `deny`; neither inherits from the other.
 *
 * What each axis's levels mean for its target:
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
 * In-chat `cu_request_control` always waits for human target consent under both
 * Ask and Allow, then starts without the Computer panel’s second Ask click.
 * `open`/`approve` are reached only from the signed-in human's control plane,
 * and the agent's `cu_open` lists ready sessions and grants nothing. `allow`
 * governs what happens after you enable, never who enables.
 *
 * This table governs the FIRST gate — whether the transport call is admitted —
 * and, at `ask`, selects the second: the per-action confirmation, which reads
 * no policy of its own and cannot be answered by anything but the human. See
 * `computer-use.invariant.test.ts`.
 */
import { mostPermissiveLevel, type DefaultPermissions, type PermissionLevel } from "shared/types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("computer-use-policy");

export type ComputerTargetKind = "browser" | "desktop";
export interface ComputerUsePolicy {
  browserControl: PermissionLevel;
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
    browserControl: level("browserControl"),
    computerControl: level("computerControl"),
    fileRead: level("fileRead"),
    fileWrite: level("fileWrite"),
    codeExecution: level("codeExecution"),
    webAccess: level("webAccess"),
  };
}

/** The axis that governs a target. */
export function axisFor(kind: ComputerTargetKind): "browserControl" | "computerControl" {
  return kind === "browser" ? "browserControl" : "computerControl";
}

/** The level of the axis that governs a target. */
export function levelFor(kind: ComputerTargetKind, policy: ComputerUsePolicy): PermissionLevel {
  return policy[axisFor(kind)];
}

/** The most permissive of the two control axes — "does any target accept enabling". */
export function aggregateControlLevel(policy: ComputerUsePolicy): PermissionLevel {
  return mostPermissiveLevel(policy.browserControl, policy.computerControl);
}

/**
 * Record the way a caller that is not a signed-in human can still put a
 * non-`deny` `browserControl` or `computerControl` on a chat: **creating** one —
 * directly (`POST /api/chats`, the stream route) or via a new-chat draft
 * (`POST /api/queue`, whose permissions `execute-now` later creates the chat with).
 *
 * `PATCH /:id/permissions` refuses to *change* either axis for anyone but a
 * same-origin session, because that rewrites the expectation of a human who
 * already chose `ask` — their existing Enable habit becomes the exploit. A
 * brand-new chat has no such expectation to violate, and passing permissions is
 * the documented purpose of the parameter (every in-repo agent-facing spawn
 * hardcodes `deny`), so this is deliberately not blocked. It is merely written
 * down: nothing else would show an operator that a chat was born unattended-
 * capable at the request of an API key.
 *
 * Silent for a signed-in human and for `deny`, which is every ordinary call.
 */
export function noteComputerControlAtCreation(where: string, authMethod: unknown, defaultPermissions: unknown): void {
  if (authMethod === "session") return;
  const policy = readComputerUsePolicy(defaultPermissions);
  const caller = typeof authMethod === "string" ? authMethod : "unauthenticated";
  for (const axis of ["browserControl", "computerControl"] as const) {
    const level = policy[axis];
    if (level !== "deny") log.warn(`[PERM-DIAG] ${where}: a ${caller} caller created a chat with ${axis}=${level}`);
  }
}

/**
 * Whether this chat's policy permits enabling a target, and why not.
 *
 * Browser: `browserControl` alone. Browser file/clipboard bridges and arbitrary
 * evaluation are not exposed, and its network reach is part of what Browser
 * Use opts into, so no other axis is consulted.
 *
 * Desktop: the native driver controls an existing OS session, not a sandbox.
 * It cannot enforce narrower restrictions through arbitrary app pixels, so it
 * requires every other axis — including `browserControl` — on `allow`.
 */
export function computerUseScopeError(kind: ComputerTargetKind, policy: ComputerUsePolicy): string | undefined {
  if (kind === "browser") {
    if (policy.browserControl === "deny") return "Browser Use is denied. Change this chat's Browser Use permission explicitly to enable the managed browser.";
    return undefined;
  }
  if (policy.computerControl === "deny") return "Computer Use is denied. Change this chat's Computer Use permission explicitly to enable the desktop.";
  const required = ["fileRead", "fileWrite", "codeExecution", "webAccess", "browserControl"] as const;
  const restricted = required.filter((key) => policy[key] !== "allow");
  if (restricted.length) {
    return `Native desktop apps cannot enforce narrower ${restricted.join(", ")} restrictions. Use a separately confined target or explicitly allow these permissions before enabling this native OS session.`;
  }
  return undefined;
}
