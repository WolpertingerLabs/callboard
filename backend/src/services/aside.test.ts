import { describe, expect, it } from "vitest";
import type { DefaultPermissions } from "shared/types/index.js";
import { ASIDE_INSTRUCTION, asideInstructionFor, resolveAsidePermissions } from "./aside.js";

const parent: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "ask", webAccess: "deny", computerControl: "deny" };

describe("asideInstructionFor", () => {
  it("is the instruction for an aside and empty for anything else", () => {
    expect(asideInstructionFor({ chatRole: "aside" })).toBe(ASIDE_INSTRUCTION);
    expect(asideInstructionFor({ chatRole: "fork" })).toBe("");
    expect(asideInstructionFor({})).toBe("");
  });
});

describe("resolveAsidePermissions", () => {
  it("inherits the parent's when none are given", () => {
    expect(resolveAsidePermissions(parent, undefined)).toEqual({ ok: true, permissions: parent });
    expect(resolveAsidePermissions(undefined, undefined)).toEqual({ ok: true, permissions: null });
  });

  it("merges a partial set over the parent's — the read-only toggle", () => {
    expect(resolveAsidePermissions(parent, { fileWrite: "ask", codeExecution: "ask" })).toEqual({
      ok: true,
      permissions: { ...parent, fileWrite: "ask", codeExecution: "ask" },
    });
  });

  it("never grants more than the parent has", () => {
    const all = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", computerControl: "allow" };
    expect(resolveAsidePermissions(parent, all)).toEqual({ ok: true, permissions: parent });
    // A parent with no stored permissions runs as "ask" everywhere.
    expect(resolveAsidePermissions(null, { fileRead: "allow" })).toEqual({
      ok: true,
      permissions: { fileRead: "ask", fileWrite: "ask", codeExecution: "ask", webAccess: "ask", computerControl: "deny" },
    });
  });

  it("allows stricter than the parent", () => {
    expect(resolveAsidePermissions(parent, { fileRead: "deny" })).toEqual({ ok: true, permissions: { ...parent, fileRead: "deny" } });
  });

  it.each([
    ["a non-object", "allow", /object/],
    ["an array", [], /object/],
    ["an unknown category", { network: "allow" }, /Unknown/],
    ["a bad level", { fileRead: "yes" }, /allow, ask, deny/],
  ])("refuses %s", (_label, value, error) => {
    const result = resolveAsidePermissions(parent, value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(error);
  });
});
