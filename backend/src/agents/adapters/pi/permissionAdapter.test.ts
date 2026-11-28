/**
 * The two guards this adapter exists for.
 *
 * Neither of them is a unit test in the ordinary sense — they are assertions
 * about a *security property* that produces no symptom when it breaks. A pi chat
 * with the trust denial removed works perfectly, having executed the opened
 * repository's TypeScript; a gate that fails open runs the tool and returns a
 * plausible result. Both failures are silent, which is why they are tested
 * rather than commented.
 *
 * @see plans/pi-spike-findings.md (§2, §3)
 */
import { describe, it, expect, vi } from "vitest";
import { SettingsManager, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  assertPiTrustDenied,
  buildPermissionExtension,
  buildToolFilters,
  categorizePiToolName,
  decidePiToolCall,
  isPiToolIdentifier,
  MOST_RESTRICTIVE_CATEGORY,
  piAllowlistBuiltinNames,
  PI_BUILTIN_TOOL_NAMES,
  type PiPermissionContext,
} from "./permissionAdapter.js";
import { buildPiServicesOptions } from "./optionsAdapter.js";
import { callboardToolGateByBareName } from "../../permissions/callboardToolPolicy.js";
import { getCallboardGateResolver, getToolCategorizer } from "../../permissions/categorizers.js";
import { ToolPermissionPolicy } from "../../permissions/ToolPermissionPolicy.js";
import type { DefaultPermissions } from "shared/types/index.js";

const ALL_ALLOW: DefaultPermissions = {
  fileRead: "allow",
  fileWrite: "allow",
  codeExecution: "allow",
  webAccess: "allow",
  browserControl: "deny",
  computerControl: "deny",
  sandboxControl: "deny",
};
const ALL_ASK: DefaultPermissions = {
  fileRead: "ask",
  fileWrite: "ask",
  codeExecution: "ask",
  webAccess: "ask",
  browserControl: "deny",
  computerControl: "deny",
  sandboxControl: "deny",
};
const ALL_DENY: DefaultPermissions = {
  fileRead: "deny",
  fileWrite: "deny",
  codeExecution: "deny",
  webAccess: "deny",
  browserControl: "deny",
  computerControl: "deny",
  sandboxControl: "deny",
};

function toolCall(toolName: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { type: "tool_call", toolCallId: "call-1", toolName, input } as ToolCallEvent;
}

function ctx(over: Partial<PiPermissionContext> = {}): PiPermissionContext {
  return { signal: new AbortController().signal, ...over };
}

// ── The project-trust guard ─────────────────────────────────────────

describe("project trust is denied by construction", () => {
  /**
   * The load-bearing one. `createAgentSession()` resolves no trust and pi's
   * SettingsManager defaults `projectTrusted` to true, so a session built any
   * other way executes `.pi/extensions/*.ts` from the opened repo at load time,
   * before the first model call.
   *
   * If a future edit swaps in the convenience entry point, or drops any of the
   * three settings, this fails.
   */
  it("buildPiServicesOptions produces options with no trust holes", () => {
    const options = buildPiServicesOptions({ cwd: "/tmp/some-repo", extension: () => {} });
    expect(assertPiTrustDenied(options)).toEqual([]);
  });

  it("sets all three mitigations explicitly, not by default", async () => {
    const options = buildPiServicesOptions({ cwd: "/tmp/some-repo", extension: () => {} });

    expect(options.settingsManager?.isProjectTrusted()).toBe(false);
    expect(options.resourceLoaderOptions?.noExtensions).toBe(true);
    // The hook that runs *before* project-local extensions are evaluated.
    await expect(options.resourceLoaderReloadOptions?.resolveProjectTrust?.({ extensionsResult: undefined as never })).resolves.toBe(false);
  });

  it("installs callboard's gate as an inline factory despite noExtensions", () => {
    // `noExtensions` kills project-local extensions but not inline factories —
    // measured in the spike. If that ever inverts, the gate silently vanishes.
    const options = buildPiServicesOptions({ cwd: "/tmp/some-repo", extension: () => {} });
    expect(options.resourceLoaderOptions?.extensionFactories).toHaveLength(1);
  });

  it.each([
    ["settingsManager missing", { settingsManager: undefined }],
    ["resolveProjectTrust missing", { resourceLoaderReloadOptions: {} }],
  ])("assertPiTrustDenied catches %s", (_label, override) => {
    const options = { ...buildPiServicesOptions({ cwd: "/tmp/x", extension: () => {} }), ...override };
    expect(assertPiTrustDenied(options).length).toBeGreaterThan(0);
  });

  it("assertPiTrustDenied catches noExtensions being turned off", () => {
    const base = buildPiServicesOptions({ cwd: "/tmp/x", extension: () => {} });
    const options = { ...base, resourceLoaderOptions: { ...base.resourceLoaderOptions, noExtensions: false } };
    expect(assertPiTrustDenied(options)).toContain("noExtensions is not true — project-local extensions are discoverable");
  });

  it("assertPiTrustDenied catches a settings manager that would warm the cache", () => {
    // pi's own manager, untrusted but otherwise stock: warming follows the
    // global settings, which here ask for "idle" — pi's default anyway.
    const base = buildPiServicesOptions({ cwd: "/tmp/x", extension: () => {} });
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "idle" }, { projectTrusted: false });
    expect(settingsManager.getCacheWarmingMode()).toBe("idle");
    expect(assertPiTrustDenied({ ...base, settingsManager })).toEqual([expect.stringContaining('cache warming "idle"')]);
  });

  it("assertPiTrustDenied catches a session built with no gate at all", () => {
    // The shape `createAgentSession({ cwd })` would produce.
    expect(assertPiTrustDenied({ cwd: "/tmp/x" })).toEqual(
      expect.arrayContaining([
        expect.stringContaining("no settingsManager"),
        expect.stringContaining("no resolveProjectTrust"),
        expect.stringContaining("noExtensions is not true"),
        expect.stringContaining("no extensionFactories"),
      ]),
    );
  });
});

// ── Categorization ──────────────────────────────────────────────────

describe("categorizePiToolName", () => {
  it.each([
    ["read", "fileRead"],
    ["grep", "fileRead"],
    ["find", "fileRead"],
    ["ls", "fileRead"],
    ["edit", "fileWrite"],
    ["write", "fileWrite"],
    ["bash", "codeExecution"],
    ["powershell", "codeExecution"],
  ] as const)("maps the built-in %s to %s", (name, expected) => {
    expect(categorizePiToolName(name)).toBe(expected);
  });

  it("covers every built-in pi ships — no tool falls through to the token table", () => {
    // `find` and `ls` carry no token from any family; without the exact table
    // they would land on codeExecution and prompt on every directory listing.
    for (const name of PI_BUILTIN_TOOL_NAMES) {
      expect(categorizePiToolName(name)).not.toBe(null);
    }
    // Paired with the it.each above, which names all eight explicitly: the
    // length is what makes that table a *complete* enumeration rather than a
    // sample, so a built-in pi adds (as 0.84.3 added `powershell`) fails here
    // instead of quietly falling through to the token fallback — and, worse,
    // dropping out of the allowlist `buildToolFilters` derives from this list.
    //
    // The catalogue is platform-free on purpose: `powershell` is counted here on
    // Linux too, because categorization must agree on every platform. Only the
    // derived allowlist is gated — see the platform describe below.
    expect(PI_BUILTIN_TOOL_NAMES).toHaveLength(8);
  });

  it.each(["render_file", "vault_get", "save_storage_item", "set_chat_title"])(
    "leaves callboard's own %s to the shared gate table, not the name map",
    (name) => {
      // Owned by permissions/callboardToolPolicy.ts; both passes consult it first
      // (see "callboard's own tools" below), so the name map never sees them.
      expect(callboardToolGateByBareName(name)).toBeDefined();
    },
  );

  it.each([
    ["spawn_job", "codeExecution"],
    ["run_something", "codeExecution"],
    ["update_card", "fileWrite"],
    ["fetch_page", "webAccess"],
    ["list_cards", "fileRead"],
  ] as const)("falls back to the token table for a name no table knows: %s", (name, expected) => {
    expect(categorizePiToolName(name)).toBe(expected);
  });

  it("sends a name with no recognizable token to codeExecution", () => {
    // `set_chat_title` carries no token from any family — "set" is deliberately
    // not a fileWrite word in any of the four adapter tables. So the name map
    // alone lands it on the strictest axis rather than guessing. (In a real
    // call it never gets here: it is ungated in the callboard table.)
    expect(categorizePiToolName("set_chat_title")).toBe(MOST_RESTRICTIVE_CATEGORY);
  });

  it("resolves most-restrictive-first when a name matches two families", () => {
    // "search_and_run" is both fileRead (search) and codeExecution (run).
    expect(categorizePiToolName("search_and_run")).toBe("codeExecution");
  });

  it("never returns null — an unknown name is codeExecution, not ask", () => {
    // `decidePermission(null, …)` returns "ask" unconditionally, which would
    // hang an unattended job step on a prompt nobody answers.
    expect(categorizePiToolName("totally_unknown_xyz")).toBe(MOST_RESTRICTIVE_CATEGORY);
    expect(categorizePiToolName("")).toBe(MOST_RESTRICTIVE_CATEGORY);
  });

  it("refuses to parse prose for a gate", () => {
    expect(isPiToolIdentifier("run the command rm -rf /")).toBe(false);
    expect(categorizePiToolName("please read the file")).toBe(MOST_RESTRICTIVE_CATEGORY);
  });
});

// ── The gate is fail-closed ─────────────────────────────────────────

describe("decidePiToolCall is fail-closed", () => {
  it("blocks a tool name it cannot categorize when the axis says ask", async () => {
    const result = await decidePiToolCall(ctx({ getPermissions: () => ALL_ASK }), toolCall("totally_unknown_xyz"));
    expect(result?.block).toBe(true);
  });

  it("blocks when there is no toolName at all", async () => {
    const result = await decidePiToolCall(ctx({ getPermissions: () => ALL_ALLOW }), toolCall(""));
    expect(result).toEqual({ block: true, reason: "callboard could not identify this tool" });
  });

  it("blocks on ask with no canUseTool — nobody to ask", async () => {
    const result = await decidePiToolCall(ctx({ getPermissions: () => ALL_ASK }), toolCall("bash"));
    expect(result).toEqual({ block: true, reason: "No approval channel available for this run" });
  });

  it("blocks when canUseTool throws", async () => {
    const canUseTool = vi.fn().mockRejectedValue(new Error("prompt channel died"));
    const result = await decidePiToolCall(ctx({ getPermissions: () => ALL_ASK, canUseTool }), toolCall("bash"));
    expect(result).toEqual({ block: true, reason: "Approval failed" });
  });

  it("blocks when the run was aborted mid-prompt", async () => {
    const controller = new AbortController();
    const canUseTool = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { behavior: "allow" as const };
    });
    const result = await decidePiToolCall({ signal: controller.signal, getPermissions: () => ALL_ASK, canUseTool }, toolCall("bash"));
    expect(result).toEqual({ block: true, reason: "Aborted" });
  });

  it("blocks with no permissions configured at all", async () => {
    // No getPermissions ⇒ every category is "ask" ⇒ no canUseTool ⇒ block.
    const result = await decidePiToolCall(ctx(), toolCall("bash"));
    expect(result?.block).toBe(true);
  });

  it("denies on a deny axis without consulting the user", async () => {
    const canUseTool = vi.fn();
    const result = await decidePiToolCall(ctx({ getPermissions: () => ALL_DENY, canUseTool }), toolCall("bash"));
    expect(result).toEqual({ block: true, reason: "Auto-denied by default codeExecution policy" });
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it("returns undefined (not {block:false}) on allow — pi's 'no opinion' shape", async () => {
    const result = await decidePiToolCall(ctx({ getPermissions: () => ALL_ALLOW }), toolCall("bash"));
    expect(result).toBeUndefined();
  });

  it("escalates to canUseTool on ask and honours the user's allow", async () => {
    const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
    const result = await decidePiToolCall(ctx({ getPermissions: () => ALL_ASK, canUseTool }), toolCall("bash", { command: "ls" }));
    expect(result).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledWith("bash", { command: "ls" }, expect.objectContaining({ signal: expect.anything() }));
  });

  it("passes the user's own rejection message back to the model", async () => {
    const canUseTool = vi.fn().mockResolvedValue({ behavior: "deny", message: "not on prod" });
    const result = await decidePiToolCall(ctx({ getPermissions: () => ALL_ASK, canUseTool }), toolCall("bash"));
    expect(result).toEqual({ block: true, reason: "not on prod" });
  });

  it("reads permissions at decision time, not at construction", async () => {
    // A user tightening a policy mid-chat must take effect on the next call.
    let permissions = ALL_ALLOW;
    const context = ctx({ getPermissions: () => permissions });
    expect(await decidePiToolCall(context, toolCall("bash"))).toBeUndefined();
    permissions = ALL_DENY;
    expect((await decidePiToolCall(context, toolCall("bash")))?.block).toBe(true);
  });
});

// ── callboard's own tools: the shared gate table, in both passes ──────

describe("callboard's own tools", () => {
  const DENY_READ: DefaultPermissions = { ...ALL_ALLOW, fileRead: "deny" };

  it.each(["set_chat_title", "wait", "notify_user", "complete_job_step"])("runs ungated %s under an all-ask policy without asking", async (name) => {
    const canUseTool = vi.fn();
    expect(await decidePiToolCall(ctx({ getPermissions: () => ALL_ASK, canUseTool }), toolCall(name))).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it("blocks save_storage_item with source_path when fileRead is denied, without asking", async () => {
    const canUseTool = vi.fn();
    const result = await decidePiToolCall(
      ctx({ getPermissions: () => DENY_READ, canUseTool }),
      toolCall("save_storage_item", { key: "k", name: "n", source_path: "/etc/passwd" }),
    );
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/fileRead/);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it("lets save_storage_item with inline content through when only fileRead is denied", async () => {
    const result = await decidePiToolCall(ctx({ getPermissions: () => DENY_READ }), toolCall("save_storage_item", { key: "k", name: "n", content: "x" }));
    expect(result).toBeUndefined();
  });

  it("gates vault_get at codeExecution", async () => {
    const result = await decidePiToolCall(ctx({ getPermissions: () => ({ ...ALL_ALLOW, codeExecution: "deny" }) }), toolCall("vault_get", { name: "x" }));
    expect(result?.block).toBe(true);
  });

  it("two-pass rule: pass 2 (ToolPermissionPolicy over the same name and input) agrees with pass 1", async () => {
    const cases: [string, Record<string, unknown>, DefaultPermissions][] = [
      ["save_storage_item", { source_path: "/x" }, DENY_READ],
      ["save_storage_item", { content: "x" }, DENY_READ],
      ["render_file", { url: "https://example.com" }, { ...ALL_ALLOW, webAccess: "deny" }],
      ["render_file", { file_path: "/x" }, { ...ALL_ALLOW, webAccess: "deny" }],
      ["vault_get", {}, ALL_ASK],
      ["wait", {}, ALL_ASK],
      ["bash", {}, ALL_ASK],
    ];
    for (const [name, input, perms] of cases) {
      const policy = new ToolPermissionPolicy(getToolCategorizer("pi"), () => perms, getCallboardGateResolver("pi"));
      const pass2 = policy.decide(name, input).decision;
      const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
      const pass1 = await decidePiToolCall(ctx({ getPermissions: () => perms, canUseTool }), toolCall(name, input));
      const pass1Decision = canUseTool.mock.calls.length > 0 ? "ask" : pass1?.block ? "deny" : "allow";
      expect(pass1Decision, `${name} ${JSON.stringify(input)}`).toBe(pass2);
      if (pass1Decision === "ask") expect(canUseTool).toHaveBeenCalledWith(name, input, expect.anything());
    }
  });
});

describe("buildPermissionExtension", () => {
  it("registers a tool_call handler and nothing else", () => {
    const on = vi.fn();
    buildPermissionExtension(ctx())({ on } as never);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("tool_call");
  });

  it("wires the handler to the fail-closed decision", async () => {
    const on = vi.fn();
    buildPermissionExtension(ctx({ getPermissions: () => ALL_DENY }))({ on } as never);
    const handler = on.mock.calls[0]?.[1] as (e: ToolCallEvent) => Promise<{ block?: boolean }>;
    expect((await handler(toolCall("bash")))?.block).toBe(true);
  });

  it("does NOT register project_trust — that event is dead on the SDK path", () => {
    // `resolveProjectTrusted()` emits it, and the SDK path never calls that
    // function. A handler here would read like a working mitigation while doing
    // nothing; the real denial is resolveProjectTrust in the services options.
    const on = vi.fn();
    buildPermissionExtension(ctx())({ on } as never);
    expect(on.mock.calls.map((c) => c[0])).not.toContain("project_trust");
  });
});

// ── The allowlist must not delete callboard's tools ─────────────────

describe("buildToolFilters", () => {
  it("returns nothing when no axis denies", () => {
    expect(buildToolFilters(ALL_ALLOW, ["set_chat_title"])).toEqual({});
    expect(buildToolFilters(ALL_ASK, ["set_chat_title"])).toEqual({});
  });

  it("returns nothing with no permissions configured", () => {
    expect(buildToolFilters(null, ["set_chat_title"])).toEqual({});
  });

  it("hides denied built-ins from the model", () => {
    const filters = buildToolFilters({ ...ALL_ALLOW, codeExecution: "deny" }, []);
    // Both shells: `powershell` is pi's second one (0.84.3), and a
    // `codeExecution: deny` that excluded only `bash` would leave the axis
    // half-open on Windows, where powershell is allowlistable.
    expect(filters.excludeTools).toEqual(["bash", "powershell"]);
    expect(filters.tools).not.toContain("bash");
    expect(filters.tools).not.toContain("powershell");
  });

  /**
   * The §3 trap, and the reason `customToolNames` is a parameter at all.
   *
   * `tools` is an allowlist over `customTools` too. Narrowing the built-ins for
   * a permission axis without re-listing callboard's own tools silently removes
   * them from the model's tool list — the chat keeps working, minus every
   * callboard capability.
   */
  it("keeps callboard's own tools in the allowlist when an axis narrows it", () => {
    const filters = buildToolFilters({ ...ALL_ALLOW, codeExecution: "deny" }, ["set_chat_title", "spawn_job"]);
    expect(filters.tools).toContain("set_chat_title");
    expect(filters.tools).toContain("spawn_job");
  });

  it("keeps callboard's tools even when every built-in is denied", () => {
    const filters = buildToolFilters(ALL_DENY, ["set_chat_title"]);
    expect(filters.tools).toEqual(["set_chat_title"]);
    expect(filters.excludeTools).toEqual([...PI_BUILTIN_TOOL_NAMES]);
  });

  it("never lists a denied tool in the allowlist", () => {
    const filters = buildToolFilters({ ...ALL_ALLOW, fileWrite: "deny" }, ["set_chat_title"]);
    for (const denied of filters.excludeTools ?? []) {
      expect(filters.tools).not.toContain(denied);
    }
    expect(filters.excludeTools).toEqual(expect.arrayContaining(["edit", "write"]));
  });
});

// ── The allowlist must not offer a tool that cannot run ─────────────

/**
 * `tools` is pi's *active set*, not a filter over it: `initialActiveToolNames`
 * comes straight from it and every allowlisted name in the registry is then
 * activated. `powershell` is built on every platform but its
 * `getPowerShellConfig()` throws off win32, so allowlisting it on Linux offers
 * the model a tool that can only error.
 *
 * Every case passes `platform` explicitly — a test that read `process.platform`
 * would assert one branch on CI and the other on a developer's Windows box.
 */
describe("the allowlist is platform-gated (the catalogue is not)", () => {
  it("piAllowlistBuiltinNames drops Windows-only built-ins off Windows", () => {
    expect(piAllowlistBuiltinNames("win32")).toEqual([...PI_BUILTIN_TOOL_NAMES]);
    expect(piAllowlistBuiltinNames("linux")).toEqual(PI_BUILTIN_TOOL_NAMES.filter((n) => n !== "powershell"));
    expect(piAllowlistBuiltinNames("darwin")).not.toContain("powershell");
  });

  it("keeps powershell out of the allowlist off Windows", () => {
    // The regression: post-bump, a `fileWrite: deny` chat on linux offered
    // ["read","bash","powershell","grep","find","ls"].
    for (const platform of ["linux", "darwin"] as const) {
      const filters = buildToolFilters({ ...ALL_ALLOW, fileWrite: "deny" }, ["set_chat_title"], platform);
      expect(filters.tools).toEqual(["read", "bash", "grep", "find", "ls", "set_chat_title"]);
    }
  });

  it("admits powershell on Windows, where it resolves", () => {
    const filters = buildToolFilters({ ...ALL_ALLOW, fileWrite: "deny" }, ["set_chat_title"], "win32");
    expect(filters.tools).toEqual(["read", "bash", "powershell", "grep", "find", "ls", "set_chat_title"]);
  });

  it("still excludes powershell on a codeExecution deny, on every platform", () => {
    // Free on Linux (pi's `isAllowedTool` is a Set test, so a name it never
    // activated simply never matches) and load-bearing on Windows. Keeping the
    // deny side ungated is what stops a platform gate from half-opening an axis.
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(buildToolFilters({ ...ALL_ALLOW, codeExecution: "deny" }, [], platform).excludeTools).toEqual(["bash", "powershell"]);
    }
  });

  it("categorizes powershell the same on every platform", () => {
    // Pass 1 and pass 2 must agree, and neither reads the platform: the gate's
    // answer for a name cannot depend on which machine runs the daemon.
    expect(categorizePiToolName("powershell")).toBe("codeExecution");
  });
});
