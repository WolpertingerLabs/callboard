import { describe, expect, it } from "vitest";
import { mergePermissions, normalizePermissions } from "../types/permissions.js";

const oldAllow = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" } as const;
describe("permission migration and settings merges", () => {
  it("never turns four legacy allows into computer control", () => {
    expect(normalizePermissions(oldAllow)).toEqual({ ...oldAllow, computerControl: "deny" });
  });
  it("preserves all existing old-axis values", () => {
    for (const fileRead of ["allow", "ask", "deny"]) {
      expect(normalizePermissions({ ...oldAllow, fileRead })).toEqual({ ...oldAllow, fileRead, computerControl: "deny" });
    }
  });
  it("defaults absent records safely and returns fresh objects", () => {
    for (const value of [undefined, null, [], false, "allow", 9]) {
      expect(normalizePermissions(value)).toEqual({ fileRead: "ask", fileWrite: "ask", codeExecution: "ask", webAccess: "ask", computerControl: "deny" });
    }
    const first = normalizePermissions(undefined);
    first.computerControl = "allow";
    expect(normalizePermissions(undefined).computerControl).toBe("deny");
  });
  it("rejects malformed, unknown and inherited values", () => {
    for (const value of [undefined, null, true, "", "ALLOW", {}, ["allow"]]) {
      expect(normalizePermissions({ computerControl: value }).computerControl).toBe("deny");
      expect(normalizePermissions({ fileRead: value }).fileRead).toBe("deny");
    }
    expect(normalizePermissions(Object.create(oldAllow)).fileRead).toBe("ask");
    expect(normalizePermissions({ ...oldAllow, unexpected: "allow" })).not.toHaveProperty("unexpected");
  });
  it("accepts all explicit fifth-axis levels", () => {
    for (const computerControl of ["allow", "ask", "deny"]) {
      expect(normalizePermissions({ computerControl }).computerControl).toBe(computerControl);
    }
  });
  it("does not widen omitted axes on legacy partial updates", () => {
    expect(mergePermissions({ ...oldAllow, fileRead: "deny" }, { webAccess: "ask" })).toEqual({
      ...oldAllow,
      fileRead: "deny",
      webAccess: "ask",
      computerControl: "deny",
    });
    expect(mergePermissions({ ...oldAllow, computerControl: "ask" }, oldAllow).computerControl).toBe("ask");
    expect(mergePermissions(oldAllow, { computerControl: undefined }).computerControl).toBe("deny");
    expect(mergePermissions(oldAllow, null)).toEqual(normalizePermissions(oldAllow));
  });
});
