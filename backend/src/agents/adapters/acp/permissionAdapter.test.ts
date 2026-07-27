/**
 * Unit tests for the ACP permission bridge.
 *
 * The e2e suite proves the happy paths over a real connection; these cover the
 * menus a hostile or sloppy agent can offer — no options, only the opposite
 * kind, missing metadata — where the requirement is that we always answer with
 * something valid. A hung `session/request_permission` stalls the agent's turn
 * indefinitely, so "never throw, never omit" is the load-bearing property.
 */
import { describe, expect, it, vi } from "vitest";
import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { DefaultPermissions } from "shared/types/index.js";
import { acpToolLabel, categorizeAcpTool, categorizeAcpToolKind, categorizeAcpToolName, resolveAcpPermission, selectPermissionOption } from "./permissionAdapter.js";
import { ToolPermissionPolicy } from "../../permissions/ToolPermissionPolicy.js";
import { categorizeClaudeTool } from "../claude-code/permissionAdapter.js";

const ALLOW_ONCE: PermissionOption = { optionId: "a1", name: "Allow once", kind: "allow_once" };
const ALLOW_ALWAYS: PermissionOption = { optionId: "a2", name: "Always", kind: "allow_always" };
const REJECT_ONCE: PermissionOption = { optionId: "r1", name: "Reject", kind: "reject_once" };
const REJECT_ALWAYS: PermissionOption = { optionId: "r2", name: "Never", kind: "reject_always" };

const perms = (over: Partial<DefaultPermissions> = {}): DefaultPermissions => ({
  fileRead: "allow",
  fileWrite: "allow",
  codeExecution: "allow",
  webAccess: "allow",
  ...over,
});

function request(over: Partial<RequestPermissionRequest> = {}): RequestPermissionRequest {
  return {
    sessionId: "s1",
    toolCall: { toolCallId: "c1", title: "Run something", name: "run_command", kind: "execute", rawInput: { command: "ls" } },
    options: [ALLOW_ONCE, ALLOW_ALWAYS, REJECT_ONCE],
    ...over,
  } as RequestPermissionRequest;
}

describe("categorizeAcpToolKind", () => {
  it("maps ACP's structured tool kinds onto callboard's four axes", () => {
    expect(categorizeAcpToolKind("read")).toBe("fileRead");
    expect(categorizeAcpToolKind("search")).toBe("fileRead");
    expect(categorizeAcpToolKind("edit")).toBe("fileWrite");
    expect(categorizeAcpToolKind("delete")).toBe("fileWrite");
    expect(categorizeAcpToolKind("move")).toBe("fileWrite");
    expect(categorizeAcpToolKind("execute")).toBe("codeExecution");
    expect(categorizeAcpToolKind("fetch")).toBe("webAccess");
  });

  it("returns null for kinds no axis governs", () => {
    expect(categorizeAcpToolKind("think")).toBeNull();
    expect(categorizeAcpToolKind("switch_mode")).toBeNull();
    expect(categorizeAcpToolKind("other")).toBeNull();
    expect(categorizeAcpToolKind(undefined)).toBeNull();
  });
});

describe("categorizeAcpTool", () => {
  it("prefers the structured kind over the free-text name", () => {
    // The name screams "execute", but ACP told us it only reads. The structured
    // signal is vendor-neutral and wins.
    expect(categorizeAcpTool("read", "run_bash_command")).toBe("fileRead");
  });

  it("falls back to name matching when kind is absent or `other`", () => {
    expect(categorizeAcpTool(undefined, "read_file")).toBe("fileRead");
    expect(categorizeAcpTool("other", "execute_shell")).toBe("codeExecution");
    expect(categorizeAcpTool("other", "web_fetch")).toBe("webAccess");
    expect(categorizeAcpTool(undefined, "write_file")).toBe("fileWrite");
  });

  it("matches names across snake_case, camelCase and kebab-case", () => {
    // `_` is a word character, so a `\b`-based matcher silently fails on the
    // dominant naming convention in this ecosystem and defaults everything to
    // fileWrite. Tokenizing is what makes the fallback actually work.
    for (const name of ["read_file", "readFile", "read-file", "ReadFile"]) {
      expect(categorizeAcpTool(undefined, name)).toBe("fileRead");
    }
    for (const name of ["run_command", "runCommand", "run-command"]) {
      expect(categorizeAcpTool(undefined, name)).toBe("codeExecution");
    }
  });

  it("defaults an unrecognized tool to fileWrite, the conservative axis", () => {
    // Mirrors categorizeClaudeTool: an under-reporting vendor must not obtain a
    // weaker gate than it deserves.
    expect(categorizeAcpTool(undefined, "frobnicate")).toBe("fileWrite");
    expect(categorizeAcpTool(undefined, "")).toBe("fileWrite");
    expect(categorizeAcpTool(undefined, null)).toBe("fileWrite");
  });

  it("keeps think/switch_mode ungoverned even when the name looks dangerous", () => {
    expect(categorizeAcpTool("think", "delete_everything")).toBeNull();
    expect(categorizeAcpTool("switch_mode", "run_shell")).toBeNull();
  });
});

describe("selectPermissionOption", () => {
  it("prefers the one-shot variant so callboard keeps control of policy", () => {
    // Accepting allow_always would hand the agent a standing grant that
    // callboard's own settings could no longer revoke.
    expect(selectPermissionOption([ALLOW_ALWAYS, ALLOW_ONCE], "allow")).toBe(ALLOW_ONCE);
    expect(selectPermissionOption([REJECT_ALWAYS, REJECT_ONCE], "deny")).toBe(REJECT_ONCE);
  });

  it("accepts the always variant when it is the only one offered", () => {
    expect(selectPermissionOption([ALLOW_ALWAYS], "allow")).toBe(ALLOW_ALWAYS);
    expect(selectPermissionOption([REJECT_ALWAYS], "deny")).toBe(REJECT_ALWAYS);
  });

  it("returns null rather than picking an option meaning the opposite", () => {
    expect(selectPermissionOption([ALLOW_ONCE], "deny")).toBeNull();
    expect(selectPermissionOption([REJECT_ONCE], "allow")).toBeNull();
    expect(selectPermissionOption([], "allow")).toBeNull();
  });
});

describe("acpToolLabel", () => {
  it("prefers the programmatic name, falls back to the title, then a placeholder", () => {
    expect(acpToolLabel({ toolCallId: "c", name: "run_command", title: "Run" })).toBe("run_command");
    expect(acpToolLabel({ toolCallId: "c", title: "Run" })).toBe("Run");
    expect(acpToolLabel({ toolCallId: "c" } as never)).toBe("unknown_tool");
  });
});

describe("the categorizer paired with ToolPermissionPolicy in claude.ts", () => {
  // Regression guard for a two-pass hazard. The ACP adapter evaluates policy
  // itself and only calls `canUseTool` when the answer is "ask" — but
  // `buildCanUseTool` re-evaluates the policy before prompting. If that second
  // pass used `categorizeClaudeTool`, an unrecognized ACP tool name would fall
  // to its `fileWrite` default and be auto-allowed, running a command the user
  // asked to be consulted about. Both passes must agree on what a tool is.
  const askExec = perms({ codeExecution: "ask", fileWrite: "allow" });

  it("routes an ACP execute tool to codeExecution, not the fileWrite default", () => {
    const acpPolicy = new ToolPermissionPolicy(categorizeAcpToolName, () => askExec);
    expect(acpPolicy.decide("run_command")).toEqual({ decision: "ask", category: "codeExecution" });

    // What would happen with the Claude map — the bug this pairing prevents.
    const claudePolicy = new ToolPermissionPolicy(categorizeClaudeTool, () => askExec);
    expect(claudePolicy.decide("run_command")).toEqual({ decision: "allow", category: "fileWrite" });
  });

  it("keeps agreeing with the adapter's own decision for read tools", () => {
    const readAsk = perms({ fileRead: "ask", fileWrite: "allow" });
    const acpPolicy = new ToolPermissionPolicy(categorizeAcpToolName, () => readAsk);
    expect(acpPolicy.decide("read_file")).toEqual({ decision: "ask", category: "fileRead" });
  });
});

describe("resolveAcpPermission", () => {
  const signal = new AbortController().signal;

  it("auto-allows without prompting when policy allows", async () => {
    const canUseTool = vi.fn();
    const res = await resolveAcpPermission(request(), { permissions: perms(), canUseTool, signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it("auto-rejects without prompting when policy denies", async () => {
    const canUseTool = vi.fn();
    const res = await resolveAcpPermission(request(), { permissions: perms({ codeExecution: "deny" }), canUseTool, signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('escalates "ask" to canUseTool with the tool name and raw input', async () => {
    const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
    const res = await resolveAcpPermission(request(), { permissions: perms({ codeExecution: "ask" }), canUseTool, signal });
    expect(canUseTool).toHaveBeenCalledWith("run_command", { command: "ls" }, { signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
  });

  it("treats absent permissions as ask", async () => {
    const canUseTool = vi.fn().mockResolvedValue({ behavior: "deny" });
    const res = await resolveAcpPermission(request(), { permissions: null, canUseTool, signal });
    expect(canUseTool).toHaveBeenCalled();
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
  });

  it('rejects an "ask" when nothing can surface a prompt', async () => {
    // e.g. a quick-completion run. There is no one to ask, so refusing is the
    // only safe reading.
    const res = await resolveAcpPermission(request(), { permissions: perms({ codeExecution: "ask" }), signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
  });

  it("rejects when canUseTool throws instead of propagating the error", async () => {
    const canUseTool = vi.fn().mockRejectedValue(new Error("emitter gone"));
    const res = await resolveAcpPermission(request(), { permissions: perms({ codeExecution: "ask" }), canUseTool, signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
  });

  it("answers cancelled when the agent offers no options at all", async () => {
    const res = await resolveAcpPermission(request({ options: [] }), { permissions: perms(), signal });
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("answers cancelled when no offered option matches the decision", async () => {
    // Policy says deny, but the agent only offered allow. Selecting it would
    // invert callboard's decision.
    const res = await resolveAcpPermission(request({ options: [ALLOW_ONCE] }), { permissions: perms({ codeExecution: "deny" }), signal });
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("filters out malformed options before deciding", async () => {
    const res = await resolveAcpPermission(request({ options: [null, { name: "no id" }, ALLOW_ONCE] as never }), { permissions: perms(), signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
  });

  it("answers cancelled when the run aborts while the user is being asked", async () => {
    const controller = new AbortController();
    const canUseTool = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { behavior: "allow" as const };
    });
    const res = await resolveAcpPermission(request(), { permissions: perms({ codeExecution: "ask" }), canUseTool, signal: controller.signal });
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("categorizes from the tool kind, not the scary-looking title", async () => {
    // kind: "read" with fileRead allowed ⇒ allow, despite the title.
    const req = request({ toolCall: { toolCallId: "c1", title: "rm -rf /", kind: "read" } as never });
    const res = await resolveAcpPermission(req, { permissions: perms({ fileRead: "allow", codeExecution: "deny" }), signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
  });

  it("survives a request with no toolCall at all", async () => {
    const res = await resolveAcpPermission(request({ toolCall: undefined as never }), { permissions: perms(), signal });
    // No metadata ⇒ conservative fileWrite ⇒ allowed under these perms.
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
  });
});
