import { describe, expect, it } from "vitest";
import { mergePermissions, normalizePermissions } from "../types/permissions.js";

const oldAllow = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" } as const;
describe("permission migration and settings merges", () => {
  it("never turns four legacy allows into computer control", () => {
    expect(normalizePermissions(oldAllow)).toEqual({ ...oldAllow, browserControl: "deny", computerControl: "deny", sandboxControl: "deny" });
  });
  it("preserves all existing old-axis values", () => {
    for (const fileRead of ["allow", "ask", "deny"]) {
      expect(normalizePermissions({ ...oldAllow, fileRead })).toEqual({
        ...oldAllow,
        fileRead,
        browserControl: "deny",
        computerControl: "deny",
        sandboxControl: "deny",
      });
    }
  });
  it("defaults absent records safely and returns fresh objects", () => {
    for (const value of [undefined, null, [], false, "allow", 9]) {
      expect(normalizePermissions(value)).toEqual({
        fileRead: "ask",
        fileWrite: "ask",
        codeExecution: "ask",
        webAccess: "ask",
        browserControl: "deny",
        computerControl: "deny",
        sandboxControl: "deny",
      });
    }
    const first = normalizePermissions(undefined);
    first.computerControl = "allow";
    expect(normalizePermissions(undefined).computerControl).toBe("deny");
  });
  it("rejects malformed, unknown and inherited values", () => {
    for (const value of [undefined, null, true, "", "ALLOW", {}, ["allow"]]) {
      expect(normalizePermissions({ browserControl: value, computerControl: value }).computerControl).toBe("deny");
      expect(normalizePermissions({ browserControl: value, computerControl: value }).browserControl).toBe("deny");
      expect(normalizePermissions({ sandboxControl: value }).sandboxControl).toBe("deny");
      expect(normalizePermissions({ fileRead: value }).fileRead).toBe("deny");
    }
    expect(normalizePermissions(Object.create(oldAllow)).fileRead).toBe("ask");
    expect(normalizePermissions({ ...oldAllow, unexpected: "allow" })).not.toHaveProperty("unexpected");
  });
  it("accepts all explicit control-axis levels", () => {
    for (const level of ["allow", "ask", "deny"]) {
      expect(normalizePermissions({ computerControl: level }).computerControl).toBe(level);
      expect(normalizePermissions({ browserControl: level }).browserControl).toBe(level);
      expect(normalizePermissions({ sandboxControl: level }).sandboxControl).toBe(level);
    }
  });
  it("never lets one control axis stand in for the other", () => {
    expect(normalizePermissions({ computerControl: "allow" }).browserControl).toBe("deny");
    expect(normalizePermissions({ browserControl: "allow" }).computerControl).toBe("deny");
    expect(mergePermissions({ computerControl: "allow" }, { fileRead: "allow" }).browserControl).toBe("deny");
    // The sandbox inherits from neither, and neither from it.
    for (const axis of ["browserControl", "computerControl"] as const) {
      expect(normalizePermissions({ [axis]: "allow" }).sandboxControl).toBe("deny");
      expect(normalizePermissions({ sandboxControl: "allow" })[axis]).toBe("deny");
    }
    expect(mergePermissions({ sandboxControl: "allow" }, { fileRead: "allow" })).toMatchObject({
      sandboxControl: "allow",
      browserControl: "deny",
      computerControl: "deny",
    });
  });
  it("does not widen omitted axes on legacy partial updates", () => {
    expect(mergePermissions({ ...oldAllow, fileRead: "deny" }, { webAccess: "ask" })).toEqual({
      ...oldAllow,
      fileRead: "deny",
      webAccess: "ask",
      browserControl: "deny",
      computerControl: "deny",
      sandboxControl: "deny",
    });
    expect(mergePermissions({ ...oldAllow, browserControl: "ask", computerControl: "ask", sandboxControl: "ask" }, oldAllow).computerControl).toBe("ask");
    expect(mergePermissions({ ...oldAllow, browserControl: "ask", computerControl: "ask", sandboxControl: "ask" }, oldAllow).browserControl).toBe("ask");
    expect(mergePermissions(oldAllow, { browserControl: undefined, computerControl: undefined }).computerControl).toBe("deny");
    expect(mergePermissions({ ...oldAllow, sandboxControl: "ask" }, oldAllow).sandboxControl).toBe("ask");
    expect(mergePermissions(oldAllow, { browserControl: undefined, computerControl: undefined }).browserControl).toBe("deny");
    expect(mergePermissions(oldAllow, null)).toEqual(normalizePermissions(oldAllow));
  });
});
