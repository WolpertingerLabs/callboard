import { beforeEach, describe, expect, it } from "vitest";
import { getDefaultPermissions, saveDefaultPermissions } from "./localStorage";
describe("stored permission defaults", () => {
  beforeEach(() => localStorage.clear());
  it("migrates legacy allows without broadening computer control", () => {
    localStorage.setItem(
      "claude-code-settings",
      JSON.stringify({
        defaultPermissions: {
          fileRead: "allow",
          fileWrite: "allow",
          codeExecution: "allow",
          webAccess: "allow",
        },
      }),
    );
    expect(getDefaultPermissions()).toEqual({
      fileRead: "allow",
      fileWrite: "allow",
      codeExecution: "allow",
      webAccess: "allow",
      browserControl: "deny",
      computerControl: "deny",
    });
  });
  it("handles corrupt and null storage", () => {
    for (const value of ["null", "[]", "broken", '"allow"']) {
      localStorage.setItem("claude-code-settings", value);
      expect(getDefaultPermissions().computerControl).toBe("deny");
      expect(getDefaultPermissions().browserControl).toBe("deny");
    }
  });
  it("migrates a saved pre-split Browser & Computer Control to Computer Use only", () => {
    // A default saved before the split has computerControl and no browserControl.
    localStorage.setItem("claude-code-settings", '{"defaultPermissions":{"computerControl":"allow"}}');
    expect(getDefaultPermissions()).toMatchObject({ browserControl: "deny", computerControl: "allow" });
  });
  it("persists an explicit choice and normalizes invalid values", () => {
    saveDefaultPermissions({ ...getDefaultPermissions(), browserControl: "ask", computerControl: "ask" });
    expect(getDefaultPermissions().computerControl).toBe("ask");
    expect(getDefaultPermissions().browserControl).toBe("ask");
    saveDefaultPermissions({ ...getDefaultPermissions(), browserControl: "allow", computerControl: "deny" });
    expect(getDefaultPermissions()).toMatchObject({ browserControl: "allow", computerControl: "deny" });
    localStorage.setItem("claude-code-settings", '{"defaultPermissions":{"computerControl":"ALLOW"}}');
    expect(getDefaultPermissions().computerControl).toBe("deny");
  });
});
