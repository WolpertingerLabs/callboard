/** Host-side policy translation. The package service remains authoritative. */
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
  const source = value && typeof value === "object" ? value as Partial<DefaultPermissions> : {};
  const level = (key: keyof ComputerUsePolicy): PermissionLevel => {
    const candidate = (source as Record<string, unknown>)[key];
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
