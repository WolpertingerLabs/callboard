export type PermissionLevel = "allow" | "ask" | "deny";

export interface DefaultPermissions {
  fileRead: PermissionLevel;
  fileWrite: PermissionLevel;
  codeExecution: PermissionLevel;
  webAccess: PermissionLevel;
  computerControl: PermissionLevel;
}

const keys = ["fileRead", "fileWrite", "codeExecution", "webAccess", "computerControl"] as const;
const defaults: DefaultPermissions = {
  fileRead: "ask",
  fileWrite: "ask",
  codeExecution: "ask",
  webAccess: "ask",
  computerControl: "deny",
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function level(value: unknown): PermissionLevel {
  return value === "allow" || value === "ask" || value === "deny" ? value : "deny";
}

/** Legacy records keep the old four defaults; missing computer control never grants access.
 * Explicit malformed values fail closed. Unknown/inherited keys are discarded.
 */
export function normalizePermissions(value: unknown): DefaultPermissions {
  const source = record(value);
  const result = { ...defaults };
  for (const key of keys) {
    if (Object.hasOwn(source, key)) result[key] = level(source[key]);
  }
  return result;
}

/** Partial updates preserve omitted axes, including existing computer-control denial.
 * This is a settings merge, not a child-grant operation or authority intersection.
 */
export function mergePermissions(current: unknown, patch: unknown): DefaultPermissions {
  const result = normalizePermissions(current);
  const source = record(patch);
  for (const key of keys) {
    if (Object.hasOwn(source, key)) result[key] = level(source[key]);
  }
  return result;
}
