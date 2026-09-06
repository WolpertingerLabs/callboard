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
      computerControl: "deny",
    });
  });
  it("handles corrupt and null storage", () => {
    for (const value of ["null", "[]", "broken", '"allow"']) {
      localStorage.setItem("claude-code-settings", value);
      expect(getDefaultPermissions().computerControl).toBe("deny");
    }
  });
  it("persists an explicit choice and normalizes invalid values", () => {
    saveDefaultPermissions({ ...getDefaultPermissions(), computerControl: "ask" });
    expect(getDefaultPermissions().computerControl).toBe("ask");
    localStorage.setItem("claude-code-settings", '{"defaultPermissions":{"computerControl":"ALLOW"}}');
    expect(getDefaultPermissions().computerControl).toBe("deny");
  });
});
