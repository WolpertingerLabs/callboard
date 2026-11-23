export type PermissionLevel = "allow" | "ask" | "deny";

export interface DefaultPermissions {
  fileRead: PermissionLevel;
  fileWrite: PermissionLevel;
  codeExecution: PermissionLevel;
  webAccess: PermissionLevel;
  /** Browser Use: drive the managed browser target. Independent of `webAccess`. */
  browserControl: PermissionLevel;
  /** Computer Use: drive the desktop target. */
  computerControl: PermissionLevel;
  /** Sandbox desktop: drive the disposable desktop in a hardened container. Independent of every other axis. */
  sandboxControl: PermissionLevel;
}

const keys = ["fileRead", "fileWrite", "codeExecution", "webAccess", "browserControl", "computerControl", "sandboxControl"] as const;
const defaults: DefaultPermissions = {
  fileRead: "ask",
  fileWrite: "ask",
  codeExecution: "ask",
  webAccess: "ask",
  browserControl: "deny",
  computerControl: "deny",
  sandboxControl: "deny",
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function level(value: unknown): PermissionLevel {
  return value === "allow" || value === "ask" || value === "deny" ? value : "deny";
}

/** The most permissive of the given levels (`deny` for none) — e.g. "does any control axis accept enabling". */
export function mostPermissiveLevel(...levels: PermissionLevel[]): PermissionLevel {
  if (levels.includes("allow")) return "allow";
  if (levels.includes("ask")) return "ask";
  return "deny";
}

/** Legacy records keep the old four defaults; a missing control axis (`browserControl`,
 * `computerControl`, `sandboxControl`) never grants access — it reads as `deny`, with no
 * inheritance between them.
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

/** Partial updates preserve omitted axes, including existing browser/computer/sandbox-control denial.
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

/**
 * Who else may answer a permission "ask" before (or alongside) the human.
 *
 * Deliberately NOT new `PermissionLevel` values: these do not change what a
 * category decides, only who handles a category that decides "ask". Stored
 * next to `defaultPermissions` in chat metadata (and creation options).
 *
 * The chain, for a call whose policy is "ask":
 *
 *   ask → [model review, if `modelReview`] → [parent, if `parentAnswers` and
 *         the chat has a parent] → human
 *
 * The parent step does not hide the prompt from the human: it is raised as
 * usual and the parent may answer it too — first answer wins.
 */
export interface PermissionReviewSettings {
  /** A one-shot reviewer model screens each ask; approve is final, deny is returned to the agent, escalate passes on. */
  modelReview: boolean;
  /** The parent Callboard chat may answer this chat's permission prompts (within its own permissions). */
  parentAnswers: boolean;
}

/** Only an explicit `true` turns either setting on — absent, malformed or legacy means off. */
export function normalizeReviewSettings(value: unknown): PermissionReviewSettings {
  const source = record(value);
  return { modelReview: source.modelReview === true, parentAnswers: source.parentAnswers === true };
}
