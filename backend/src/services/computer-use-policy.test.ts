import { describe, expect, it } from "vitest";
import { computerUseScopeError, readComputerUsePolicy } from "./computer-use-policy.js";

describe("computer-use host policy", () => {
  it("fails closed for absent, malformed and legacy computer-control settings", () => {
    for (const value of [undefined, null, false, "allow", {}, { fileRead: "allow" }, { computerControl: "invalid" }]) {
      expect(readComputerUsePolicy(value).computerControl).toBe("deny");
    }
  });
  it("preserves ask without making it allow", () => {
    expect(readComputerUsePolicy({ computerControl: "ask" }).computerControl).toBe("ask");
  });
  it("does not pretend a native screen driver enforces file/network boundaries", () => {
    const policy = readComputerUsePolicy({ computerControl: "allow", webAccess: "allow" });
    expect(computerUseScopeError("browser", policy)).toBeUndefined();
    expect(computerUseScopeError("desktop", policy)).toContain("fileRead");
    expect(computerUseScopeError("desktop", { ...policy, fileRead: "allow", fileWrite: "allow", codeExecution: "allow" })).toBeUndefined();
  });
  it("does not start a networked browser for denied or unapproved network authority", () => {
    for (const webAccess of ["deny", "ask"]) {
      expect(computerUseScopeError("browser", readComputerUsePolicy({ computerControl: "allow", webAccess }))).toContain("Web Access");
    }
  });
  it("deny blocks both targets even with all other permissions allowed", () => {
    const policy = readComputerUsePolicy({ fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" });
    expect(computerUseScopeError("browser", policy)).toContain("denied");
    expect(computerUseScopeError("desktop", policy)).toContain("denied");
  });
});
