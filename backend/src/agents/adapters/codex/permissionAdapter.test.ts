/**
 * Unit tests for the callboard DefaultPermissions → Codex sandboxMode +
 * approvalPolicy mapping, table-driven against `plans/codex-adapter-job.md`
 * (Step 5, "Permissions → sandbox/approval").
 *
 * The four-axis permission set collapses onto Codex's two coarse knobs, so the
 * tests pin every row of the plan's table plus the edge cases the table implies
 * (exec-without-write, an "ask" overriding an otherwise-`never` tier).
 */
import { describe, expect, it } from "vitest";
import type { DefaultPermissions, PermissionLevel } from "shared/types/index.js";
import {
  defaultApprovalForSandbox,
  hasAnyAsk,
  mapPermissionsToCodex,
  resolveSandboxMode,
} from "./permissionAdapter.js";

/** Build a DefaultPermissions, defaulting every unspecified axis to "deny". */
function perms(overrides: Partial<DefaultPermissions> = {}): DefaultPermissions {
  return {
    fileRead: "deny",
    fileWrite: "deny",
    codeExecution: "deny",
    webAccess: "deny",
    ...overrides,
  };
}

describe("resolveSandboxMode", () => {
  it("all deny → read-only", () => {
    expect(resolveSandboxMode(perms())).toBe("read-only");
  });

  it("read everything but no write → read-only", () => {
    expect(resolveSandboxMode(perms({ fileRead: "allow", webAccess: "allow" }))).toBe("read-only");
  });

  it("fileWrite allow (no exec) → workspace-write", () => {
    expect(resolveSandboxMode(perms({ fileWrite: "allow" }))).toBe("workspace-write");
  });

  it("codeExecution + fileWrite allow → danger-full-access", () => {
    expect(resolveSandboxMode(perms({ fileWrite: "allow", codeExecution: "allow" }))).toBe(
      "danger-full-access",
    );
  });

  it("exec allow WITHOUT write stays read-only (no codex tier for exec-only)", () => {
    expect(resolveSandboxMode(perms({ codeExecution: "allow" }))).toBe("read-only");
  });

  it("an 'ask' is not an 'allow' — fileWrite ask does not widen the sandbox", () => {
    expect(resolveSandboxMode(perms({ fileWrite: "ask" }))).toBe("read-only");
  });
});

describe("defaultApprovalForSandbox", () => {
  it("danger-full-access → never", () => {
    expect(defaultApprovalForSandbox("danger-full-access")).toBe("never");
  });

  it("workspace-write → on-request", () => {
    expect(defaultApprovalForSandbox("workspace-write")).toBe("on-request");
  });

  it("read-only → on-request", () => {
    expect(defaultApprovalForSandbox("read-only")).toBe("on-request");
  });
});

describe("hasAnyAsk", () => {
  it("false when no axis is 'ask'", () => {
    expect(hasAnyAsk(perms({ fileWrite: "allow", codeExecution: "allow" }))).toBe(false);
  });

  it.each<keyof DefaultPermissions>(["fileRead", "fileWrite", "codeExecution", "webAccess"])(
    "true when %s is 'ask'",
    (axis) => {
      expect(hasAnyAsk(perms({ [axis]: "ask" as PermissionLevel }))).toBe(true);
    },
  );
});

describe("mapPermissionsToCodex — plan table rows", () => {
  it("all deny / read-only → read-only + on-request", () => {
    expect(mapPermissionsToCodex(perms())).toEqual({
      sandboxMode: "read-only",
      approvalPolicy: "on-request",
    });
  });

  it("fileWrite allow → workspace-write + on-request", () => {
    expect(mapPermissionsToCodex(perms({ fileWrite: "allow" }))).toEqual({
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
    });
  });

  it("codeExecution + fileWrite allow → danger-full-access + never", () => {
    expect(mapPermissionsToCodex(perms({ fileWrite: "allow", codeExecution: "allow" }))).toEqual({
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    });
  });

  it("all allow → danger-full-access + never", () => {
    expect(
      mapPermissionsToCodex(
        perms({ fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" }),
      ),
    ).toEqual({ sandboxMode: "danger-full-access", approvalPolicy: "never" });
  });

  it("any 'ask' forces on-request even at the danger-full-access tier", () => {
    // write+exec allowed (→ danger-full-access) but webAccess is "ask": the ask
    // pins approval to on-request rather than never.
    expect(
      mapPermissionsToCodex(
        perms({ fileWrite: "allow", codeExecution: "allow", webAccess: "ask" }),
      ),
    ).toEqual({ sandboxMode: "danger-full-access", approvalPolicy: "on-request" });
  });

  it("fileWrite ask → read-only + on-request (sandbox unchanged, approval on-request)", () => {
    expect(mapPermissionsToCodex(perms({ fileWrite: "ask" }))).toEqual({
      sandboxMode: "read-only",
      approvalPolicy: "on-request",
    });
  });
});
