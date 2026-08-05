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
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  assertPiTrustDenied,
  buildPermissionExtension,
  buildToolFilters,
  categorizePiToolName,
  decidePiToolCall,
  isPiToolIdentifier,
  MOST_RESTRICTIVE_CATEGORY,
  PI_BUILTIN_TOOL_NAMES,
  type PiPermissionContext,
} from "./permissionAdapter.js";
import { buildPiServicesOptions } from "./optionsAdapter.js";
import type { DefaultPermissions } from "shared/types/index.js";

const ALL_ALLOW: DefaultPermissions = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow" };
const ALL_ASK: DefaultPermissions = { fileRead: "ask", fileWrite: "ask", codeExecution: "ask", webAccess: "ask" };
const ALL_DENY: DefaultPermissions = { fileRead: "deny", fileWrite: "deny", codeExecution: "deny", webAccess: "deny" };

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
  ] as const)("maps the built-in %s to %s", (name, expected) => {
    expect(categorizePiToolName(name)).toBe(expected);
  });

  it("covers every built-in pi ships — no tool falls through to the token table", () => {
    // `find` and `ls` carry no token from any family; without the exact table
    // they would land on codeExecution and prompt on every directory listing.
    for (const name of PI_BUILTIN_TOOL_NAMES) {
      expect(categorizePiToolName(name)).not.toBe(null);
    }
    expect(PI_BUILTIN_TOOL_NAMES).toHaveLength(7);
  });

  it("special-cases render_file, as the Claude/OR/Cline maps do", () => {
    expect(categorizePiToolName("render_file")).toBe("fileRead");
  });

  it.each([
    ["spawn_job", "codeExecution"],
    ["run_something", "codeExecution"],
    ["update_card", "fileWrite"],
    ["fetch_page", "webAccess"],
    ["list_cards", "fileRead"],
  ] as const)("falls back to the token table for callboard's own %s", (name, expected) => {
    expect(categorizePiToolName(name)).toBe(expected);
  });

  it("sends a name with no recognizable token to codeExecution", () => {
    // `set_chat_title` carries no token from any family — "set" is deliberately
    // not a fileWrite word in any of the four adapter tables. So it lands on the
    // strictest axis rather than being guessed at. Matching the Cline and OR
    // tables here is worth more than a marginally kinder default: widening the
    // token list is a cross-adapter change, not a side effect of adding pi.
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
    expect(filters.excludeTools).toEqual(["bash"]);
    expect(filters.tools).not.toContain("bash");
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
