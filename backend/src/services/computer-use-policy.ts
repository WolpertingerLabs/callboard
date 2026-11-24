/** Host-side policy translation. The package service remains authoritative.
 *
 * Three axes govern the three targets, one each:
 *  - `browserControl` ("Browser Use") — the managed browser target. It needs no
 *    other axis; in particular it does NOT require `webAccess`. Browser
 *    networking is unrestricted, and opting into Browser Use opts into that.
 *  - `sandboxControl` ("Sandbox desktop") — a Linux desktop in a hardened
 *    container (packages/computer-use/docker): by default a fresh container
 *    Callboard starts per session (managed), or one operator-run container
 *    shared by every chat (endpoint); see sandboxDesktopText. It needs no other axis
 *    either: the container is the boundary. Nothing of this machine is mounted
 *    into it — no files, no credentials, no Docker socket — so the file and
 *    code axes have nothing there to govern. Its outbound network is
 *    unrestricted by default, and, as for Browser Use, opting into the Sandbox desktop
 *    opts into that; `webAccess` is not consulted.
 *  - `computerControl` ("Computer Use") — the desktop target, this machine's
 *    own session. It additionally requires `fileRead`, `fileWrite`,
 *    `codeExecution`, `webAccess` and `browserControl` on `allow`: a desktop
 *    session can open any app (a browser among them) and cannot honour a
 *    narrower promise, and on `allow` it could do so unattended. It does NOT
 *    require `sandboxControl`: the sandbox reaches strictly less than the
 *    user's desktop already does, so allowing it would add no authority the
 *    desktop lacks, and requiring it would only tie two unrelated opt-ins.
 * A missing or malformed axis reads as `deny`; none inherits from another.
 *
 * What each axis's levels mean for its target:
 *  - `deny`  — no target can be enabled; `cu_*` calls are refused by the service
 *              (and, on Claude Code, by `canUseTool` before they reach it).
 *  - `ask`   — the human's Enable click creates a request the human confirms
 *              separately; then EVERY agent GUI action raises its own prompt
 *              in the chat (non-blocking: the tool call returns at once and the
 *              action runs only when that signed-in human approves it).
 *  - `allow` — the human's Enable click opens the target immediately, and the
 *              agent then acts without a per-action prompt. The action is
 *              recorded for the operator instead (`logUnattendedAction`).
 *
 * The one thing no level changes: **only a human can enable a target.**
 * In-chat `cu_request_control` always asks for human target consent under both
 * Ask and Allow (without holding the tool call open), then starts without the
 * Computer panel’s second Ask click.
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

export type ComputerTargetKind = "browser" | "desktop" | "sandbox";
export const COMPUTER_TARGET_KINDS: readonly ComputerTargetKind[] = ["browser", "desktop", "sandbox"];
export type ControlAxis = "browserControl" | "computerControl" | "sandboxControl";
export interface ComputerUsePolicy {
  browserControl: PermissionLevel;
  computerControl: PermissionLevel;
  sandboxControl: PermissionLevel;
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
    sandboxControl: level("sandboxControl"),
    fileRead: level("fileRead"),
    fileWrite: level("fileWrite"),
    codeExecution: level("codeExecution"),
    webAccess: level("webAccess"),
  };
}

const AXIS: Readonly<Record<ComputerTargetKind, ControlAxis>> = { browser: "browserControl", desktop: "computerControl", sandbox: "sandboxControl" };
/** The permission names a person sees, per axis. */
export const AXIS_LABELS: Readonly<Record<ControlAxis, string>> = {
  browserControl: "Browser Use",
  computerControl: "Computer Use",
  sandboxControl: "Sandbox desktop",
};

/** The axis that governs a target. */
export function axisFor(kind: ComputerTargetKind): ControlAxis {
  return AXIS[kind];
}

/** The level of the axis that governs a target. */
export function levelFor(kind: ComputerTargetKind, policy: ComputerUsePolicy): PermissionLevel {
  return policy[axisFor(kind)];
}

/**
 * The most permissive of the control axes of `kinds` (all three by default) —
 * "does any of these targets accept enabling". A client that is not sent the
 * sandbox asks about the other two only, so a chat whose only open axis is
 * `sandboxControl` does not show it an Enable it can do nothing with.
 */
export function aggregateControlLevel(policy: ComputerUsePolicy, kinds: readonly ComputerTargetKind[] = COMPUTER_TARGET_KINDS): PermissionLevel {
  return mostPermissiveLevel(...kinds.map((kind) => levelFor(kind, policy)));
}

/**
 * Record the way a caller that is not a signed-in human can still put a
 * non-`deny` control axis (`browserControl`, `computerControl` or
 * `sandboxControl`) on a chat: **creating** one —
 * directly (`POST /api/chats`, the stream route) or via a new-chat draft
 * (`POST /api/queue`, whose permissions `execute-now` later creates the chat with).
 *
 * `PATCH /:id/permissions` refuses to *change* any of them for anyone but a
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
  for (const axis of Object.values(AXIS)) {
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
 * Sandbox: `sandboxControl` alone. The container is the boundary — it holds
 * nothing of this machine — so the file and code axes have nothing there to
 * protect, and its unrestricted network is part of what the Sandbox desktop
 * opts into.
 *
 * Desktop: the native driver controls an existing OS session, not a sandbox.
 * It cannot enforce narrower restrictions through arbitrary app pixels, so it
 * requires the four built-in axes and `browserControl` on `allow`
 * (`sandboxControl` is not among them; see the module comment).
 */
export function computerUseScopeError(kind: ComputerTargetKind, policy: ComputerUsePolicy): string | undefined {
  if (kind === "browser") {
    if (policy.browserControl === "deny") return "Browser Use is denied. Change this chat's Browser Use permission explicitly to enable the managed browser.";
    return undefined;
  }
  if (kind === "sandbox") {
    if (policy.sandboxControl === "deny")
      return "Sandbox desktop is denied. Change this chat's Sandbox desktop permission explicitly to enable the sandbox desktop.";
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
