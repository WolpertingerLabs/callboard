import { describe, it, expect } from "vitest";
import type { DefaultPermissions } from "shared/types/index.js";
import { axesAboveCeiling, capPermissions } from "./permission-ceiling.js";
import { unattendedPermissions } from "./session-spawn.js";

const ALL_ASK: DefaultPermissions = { fileRead: "ask", fileWrite: "ask", codeExecution: "ask", webAccess: "ask", computerControl: "deny" };

describe("capPermissions", () => {
  it("takes the stricter level on every axis (deny < ask < allow)", () => {
    const requested: DefaultPermissions = { fileRead: "allow", fileWrite: "ask", codeExecution: "allow", webAccess: "deny", computerControl: "allow" };
    const ceiling: DefaultPermissions = { fileRead: "ask", fileWrite: "allow", codeExecution: "deny", webAccess: "allow", computerControl: "ask" };
    expect(capPermissions(requested, ceiling)).toEqual({ fileRead: "ask", fileWrite: "ask", codeExecution: "deny", webAccess: "deny", computerControl: "ask" });
  });

  it("is the identity on unattended permissions under an unattended ceiling", () => {
    expect(capPermissions(unattendedPermissions(), unattendedPermissions())).toEqual(unattendedPermissions());
  });

  it("reads a null or legacy ceiling as the policy that chat actually runs under", () => {
    expect(capPermissions(unattendedPermissions(), null)).toEqual(ALL_ASK);
    // A legacy four-axis record has no computerControl: absent is deny.
    const legacy = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" } as unknown as DefaultPermissions;
    expect(capPermissions({ ...unattendedPermissions(), computerControl: "allow" }, legacy).computerControl).toBe("deny");
  });

  it("does not mutate its inputs", () => {
    const requested = unattendedPermissions();
    capPermissions(requested, ALL_ASK);
    expect(requested).toEqual(unattendedPermissions());
  });
});

describe("axesAboveCeiling", () => {
  it("lists only the axes where the target is looser", () => {
    expect(axesAboveCeiling(unattendedPermissions(), { ...unattendedPermissions(), codeExecution: "ask", webAccess: "deny" })).toEqual(["codeExecution", "webAccess"]);
  });

  it("is empty when the target is equal or stricter", () => {
    expect(axesAboveCeiling(ALL_ASK, unattendedPermissions())).toEqual([]);
    expect(axesAboveCeiling(unattendedPermissions(), unattendedPermissions())).toEqual([]);
  });

  it("treats a target with no permissions as ask-everything", () => {
    expect(axesAboveCeiling(null, ALL_ASK)).toEqual([]);
    expect(axesAboveCeiling(null, { ...ALL_ASK, fileRead: "deny" })).toEqual(["fileRead"]);
  });
});
