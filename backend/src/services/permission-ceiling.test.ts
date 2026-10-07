import { describe, it, expect, vi } from "vitest";
import type { DefaultPermissions } from "shared/types/index.js";
import { axesAboveCeiling, capPermissions, codexSandboxRefusal, guardUnattendedTools } from "./permission-ceiling.js";
import { defineTool, textResult } from "../agents/ports/tools.js";
import type { ToolCallResult } from "../agents/ports/tools.js";
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
    expect(axesAboveCeiling(unattendedPermissions(), { ...unattendedPermissions(), codeExecution: "ask", webAccess: "deny" })).toEqual([
      "codeExecution",
      "webAccess",
    ]);
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

describe("codexSandboxRefusal", () => {
  it("allows anything when no explicit sandbox is set", () => {
    expect(codexSandboxRefusal(ALL_ASK, undefined)).toBeNull();
  });

  it("refuses an explicit tier looser than the one the permissions map to", () => {
    expect(codexSandboxRefusal({ ...unattendedPermissions(), codeExecution: "ask" }, "danger-full-access")).toContain("codexSandboxMode");
    expect(codexSandboxRefusal(ALL_ASK, "workspace-write")).toContain('"read-only"');
  });

  it("accepts an explicit tier at or under the mapped one", () => {
    expect(codexSandboxRefusal(unattendedPermissions(), "danger-full-access")).toBeNull();
    expect(codexSandboxRefusal({ ...unattendedPermissions(), codeExecution: "ask" }, "workspace-write")).toBeNull();
    expect(codexSandboxRefusal(ALL_ASK, "read-only")).toBeNull();
  });
});

/** The text of a tool result's text blocks. */
function textOf(result: ToolCallResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

describe("guardUnattendedTools", () => {
  const inner = vi.fn(async () => textResult("ran"));
  const tools = () => [defineTool("starts_work", "Starts work.", {}, inner), defineTool("reads", "Reads.", {}, async () => textResult("read"))];

  it("passes an allow-all caller straight through to the original handler", async () => {
    inner.mockClear();
    const [guarded] = guardUnattendedTools(tools(), ["starts_work"], () => unattendedPermissions());
    expect(textOf(await guarded.handler({}))).toBe("ran");
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("refuses anyone else without calling the handler, and leaves other tools alone", async () => {
    inner.mockClear();
    const [guarded, other] = guardUnattendedTools(tools(), ["starts_work"], () => ({ ...unattendedPermissions(), webAccess: "deny" }));
    expect(JSON.parse(textOf(await guarded.handler({})))).toMatchObject({ error: "permission_ceiling", looserCategories: ["webAccess"] });
    expect(inner).not.toHaveBeenCalled();
    expect(textOf(await other.handler({}))).toBe("read");
  });

  it("throws on a name that is not in the list, so a rename cannot drop the guard", () => {
    expect(() => guardUnattendedTools(tools(), ["renamed_away"], undefined)).toThrow('no tool named "renamed_away"');
  });
});
