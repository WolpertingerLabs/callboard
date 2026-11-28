import { describe, it, expect, vi } from "vitest";
import type { DefaultPermissions } from "shared/types/index.js";
import { axesAboveCeiling, capPermissions, codexSandboxRefusal, guardSpecByPolicy, guardUnattendedTools, parentApprovalRefusal } from "./permission-ceiling.js";
import { defineTool, textResult } from "../agents/ports/tools.js";
import { z } from "zod";
import type { ToolCallResult } from "../agents/ports/tools.js";
import { unattendedPermissions } from "./session-spawn.js";

const ALL_ASK: DefaultPermissions = {
  fileRead: "ask",
  fileWrite: "ask",
  codeExecution: "ask",
  webAccess: "ask",
  browserControl: "deny",
  computerControl: "deny",
  sandboxControl: "deny",
};

describe("capPermissions", () => {
  it("takes the stricter level on every axis (deny < ask < allow)", () => {
    const requested: DefaultPermissions = {
      fileRead: "allow",
      fileWrite: "ask",
      codeExecution: "allow",
      webAccess: "deny",
      browserControl: "allow",
      computerControl: "allow",
      sandboxControl: "deny",
    };
    const ceiling: DefaultPermissions = {
      fileRead: "ask",
      fileWrite: "allow",
      codeExecution: "deny",
      webAccess: "allow",
      browserControl: "ask",
      computerControl: "ask",
      sandboxControl: "deny",
    };
    expect(capPermissions(requested, ceiling)).toEqual({
      fileRead: "ask",
      fileWrite: "ask",
      codeExecution: "deny",
      webAccess: "deny",
      browserControl: "ask",
      computerControl: "ask",
      sandboxControl: "deny",
    });
  });

  it("is the identity on unattended permissions under an unattended ceiling", () => {
    expect(capPermissions(unattendedPermissions(), unattendedPermissions())).toEqual(unattendedPermissions());
  });

  it("reads a null or legacy ceiling as the policy that chat actually runs under", () => {
    expect(capPermissions(unattendedPermissions(), null)).toEqual(ALL_ASK);
    // A legacy four-axis record has no computerControl: absent is deny.
    const legacy = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" } as unknown as DefaultPermissions;
    expect(
      capPermissions({ ...unattendedPermissions(), browserControl: "allow", computerControl: "allow", sandboxControl: "deny" }, legacy).computerControl,
    ).toBe("deny");
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

describe("guardSpecByPolicy", () => {
  const ALL_ALLOW: DefaultPermissions = { ...ALL_ASK, fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" };

  function storageSpec() {
    const save = vi.fn(async (): Promise<ToolCallResult> => textResult("saved"));
    const title = vi.fn(async (): Promise<ToolCallResult> => textResult("titled"));
    const spec = {
      name: "callboard-tools",
      version: "1",
      tools: [
        defineTool("save_storage_item", "d", { key: z.string(), name: z.string(), source_path: z.string().optional(), content: z.string().optional() }, save),
        defineTool("set_chat_title", "d", { title: z.string() }, title),
      ],
    };
    return { spec, save, title };
  }
  const parse = (r: ToolCallResult) => JSON.parse((r.content[0] as { text: string }).text);

  it("refuses a denied axis with permission_policy and never calls the handler", async () => {
    const { spec, save } = storageSpec();
    const guarded = guardSpecByPolicy(spec, "callboard-tools", { getPermissions: () => ({ ...ALL_ALLOW, fileRead: "deny" }), onAsk: "harness" });
    const result = await guarded.tools[0].handler({ key: "k", name: "n", source_path: "/etc/passwd" });
    expect(parse(result)).toMatchObject({ ok: false, error: "permission_policy", tool: "save_storage_item", category: "fileRead" });
    expect(save).not.toHaveBeenCalled();
  });

  it("the same call with inline content needs only fileWrite", async () => {
    const { spec, save } = storageSpec();
    const guarded = guardSpecByPolicy(spec, "callboard-tools", { getPermissions: () => ({ ...ALL_ALLOW, fileRead: "deny" }), onAsk: "harness" });
    await guarded.tools[0].handler({ key: "k", name: "n", content: "x" });
    expect(save).toHaveBeenCalledOnce();
  });

  it("reads the policy live on every call", async () => {
    const { spec, save } = storageSpec();
    let current = ALL_ALLOW;
    const guarded = guardSpecByPolicy(spec, "callboard-tools", { getPermissions: () => current, onAsk: "harness" });
    await guarded.tools[0].handler({ key: "k", name: "n", content: "x" });
    current = { ...ALL_ALLOW, fileWrite: "deny" };
    const second = await guarded.tools[0].handler({ key: "k", name: "n", content: "x" });
    expect(parse(second).error).toBe("permission_policy");
    expect(save).toHaveBeenCalledOnce();
  });

  it('"harness" mode runs an ask call: the engine\'s own gate already asked', async () => {
    const { spec, save } = storageSpec();
    const guarded = guardSpecByPolicy(spec, "callboard-tools", { getPermissions: () => ALL_ASK, onAsk: "harness" });
    await guarded.tools[0].handler({ key: "k", name: "n", content: "x" });
    expect(save).toHaveBeenCalledOnce();
  });

  it("a function onAsk is asked with the qualified name; its deny means the handler never runs", async () => {
    const { spec, save } = storageSpec();
    const onAsk = vi.fn(async () => ({ behavior: "deny" as const, message: "User denied" }));
    const guarded = guardSpecByPolicy(spec, "callboard-tools", { getPermissions: () => ALL_ASK, onAsk });
    const result = await guarded.tools[0].handler({ key: "k", name: "n", source_path: "/x" });
    expect(onAsk).toHaveBeenCalledWith(
      "mcp__callboard-tools__save_storage_item",
      { key: "k", name: "n", source_path: "/x" },
      expect.objectContaining({ category: "fileWrite", pending: ["fileWrite", "fileRead"] }),
    );
    expect(parse(result)).toMatchObject({ error: "permission_policy" });
    expect(save).not.toHaveBeenCalled();
  });

  it("a function onAsk that allows runs the handler once", async () => {
    const { spec, save } = storageSpec();
    const guarded = guardSpecByPolicy(spec, "callboard-tools", { getPermissions: () => ALL_ASK, onAsk: async () => ({ behavior: "allow" }) });
    await guarded.tools[0].handler({ key: "k", name: "n", content: "x" });
    expect(save).toHaveBeenCalledOnce();
  });

  it("a missing getter reads as ask on every axis", async () => {
    const { spec, save } = storageSpec();
    const onAsk = vi.fn(async () => ({ behavior: "deny" as const }));
    const guarded = guardSpecByPolicy(spec, "callboard-tools", { getPermissions: undefined, onAsk });
    await guarded.tools[0].handler({ key: "k", name: "n", content: "x" });
    expect(onAsk).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it("ungated tools run under an all-deny policy without asking", async () => {
    const { spec, title } = storageSpec();
    const onAsk = vi.fn();
    const ALL_DENY: DefaultPermissions = { ...ALL_ASK, fileRead: "deny", fileWrite: "deny", codeExecution: "deny", webAccess: "deny" };
    const guarded = guardSpecByPolicy(spec, "callboard-tools", { getPermissions: () => ALL_DENY, onAsk });
    await guarded.tools[1].handler({ title: "t" });
    expect(title).toHaveBeenCalledOnce();
    expect(onAsk).not.toHaveBeenCalled();
  });
});

describe("parentApprovalRefusal with several required axes", () => {
  const PARENT: DefaultPermissions = { ...ALL_ASK, fileWrite: "allow", codeExecution: "ask" };
  it("refuses unless the parent allows every axis the call is asking about", () => {
    expect(parentApprovalRefusal("fileWrite", PARENT)).toBeNull();
    expect(parentApprovalRefusal("fileWrite", PARENT, ["fileWrite", "codeExecution"])).toMatch(/codeExecution/);
    expect(parentApprovalRefusal("fileWrite", { ...PARENT, codeExecution: "allow" }, ["fileWrite", "codeExecution"])).toBeNull();
  });
});
