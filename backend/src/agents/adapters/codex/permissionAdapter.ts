/**
 * Permission translation: callboard {@link DefaultPermissions} → Codex
 * `sandboxMode` + `approvalPolicy`.
 *
 * Claude and OpenRouter gate tools *per call* (a `canUseTool` callback fires for
 * each invocation). Codex has no such hook — it decides what the agent may do up
 * front via two coarse `ThreadOptions` knobs, set once when the thread starts:
 *
 *  - **`sandboxMode`** — the filesystem/exec sandbox the `codex exec` subprocess
 *    runs under (`read-only` | `workspace-write` | `danger-full-access`).
 *  - **`approvalPolicy`** — when the agent must pause and ask before escalating
 *    out of the sandbox (`never` | `on-request` | …). callboard only emits the
 *    two the mapping needs: `never` (run unattended) and `on-request` (Codex
 *    surfaces an approval request the user answers).
 *
 * So a fine-grained four-axis permission set collapses onto two axes. The
 * mapping (from `plans/codex-adapter-job.md` Step 5, "Permissions →
 * sandbox/approval"):
 *
 * | callboard permissions                | sandboxMode          | approvalPolicy |
 * | ------------------------------------ | -------------------- | -------------- |
 * | all deny / read-only                 | `read-only`          | `on-request`   |
 * | fileWrite allow                      | `workspace-write`    | `on-request`   |
 * | codeExecution + fileWrite allow      | `danger-full-access` | `never`        |
 * | any "ask"                            | (as above)           | `on-request`   |
 * | all allow                            | (as above)           | `never`        |
 *
 * sandboxMode is driven purely by what is allowed *outright* (an "ask" is not an
 * "allow", so it doesn't widen the sandbox — Codex requests approval to escalate
 * instead). approvalPolicy is `never` only at the fully-permissive
 * `danger-full-access` tier with no "ask" anywhere; everything else is
 * `on-request` so the user stays in the loop.
 *
 * @see plans/codex-adapter-job.md (Step 5 options-perms)
 * @see shared/types/permissions.ts (DefaultPermissions)
 */
import type { ApprovalMode, SandboxMode } from "@openai/codex-sdk";
import type { DefaultPermissions, PermissionLevel } from "shared/types/index.js";

/** Codex permission knobs derived from callboard's {@link DefaultPermissions}. */
export interface CodexPermissionMapping {
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalMode;
}

/** True when any of the four permission axes is set to "ask". */
export function hasAnyAsk(perms: DefaultPermissions): boolean {
  const levels: PermissionLevel[] = [
    perms.fileRead,
    perms.fileWrite,
    perms.codeExecution,
    perms.webAccess,
  ];
  return levels.some((level) => level === "ask");
}

/**
 * Resolve the sandbox tier from what the permission set allows *outright*:
 *  - write **and** exec allowed → `danger-full-access` (no sandbox)
 *  - write allowed only         → `workspace-write` (writes confined to the cwd)
 *  - otherwise                  → `read-only`
 *
 * Exec without write never reaches `danger-full-access` — there is no Codex
 * sandbox tier for "run commands but don't touch files", so it stays
 * `read-only` and escalates through approval.
 */
export function resolveSandboxMode(perms: DefaultPermissions): SandboxMode {
  const writeAllowed = perms.fileWrite === "allow";
  const execAllowed = perms.codeExecution === "allow";
  if (writeAllowed && execAllowed) return "danger-full-access";
  if (writeAllowed) return "workspace-write";
  return "read-only";
}

/**
 * The approval policy paired with a sandbox tier when no axis is "ask":
 * `danger-full-access` runs unattended (`never`); the confined tiers keep
 * `on-request` so the user can approve escalations out of the sandbox.
 */
export function defaultApprovalForSandbox(sandboxMode: SandboxMode): ApprovalMode {
  return sandboxMode === "danger-full-access" ? "never" : "on-request";
}

/**
 * Map callboard's {@link DefaultPermissions} onto Codex's `sandboxMode` +
 * `approvalPolicy`. Any "ask" forces `on-request` regardless of tier; otherwise
 * the policy follows the sandbox tier ({@link defaultApprovalForSandbox}).
 */
export function mapPermissionsToCodex(perms: DefaultPermissions): CodexPermissionMapping {
  const sandboxMode = resolveSandboxMode(perms);
  const approvalPolicy = hasAnyAsk(perms) ? "on-request" : defaultApprovalForSandbox(sandboxMode);
  return { sandboxMode, approvalPolicy };
}
