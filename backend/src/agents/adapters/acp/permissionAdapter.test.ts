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
import { acpToolLabel, categorizeAcpToolKind, categorizeAcpToolName, resolveAcpPermission, selectPermissionOption } from "./permissionAdapter.js";
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

describe("categorizeAcpToolKind (logging only — never a gate)", () => {
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

describe("categorizeAcpToolName", () => {
  it("maps the obvious families", () => {
    expect(categorizeAcpToolName("read_file")).toBe("fileRead");
    expect(categorizeAcpToolName("write_file")).toBe("fileWrite");
    expect(categorizeAcpToolName("execute_shell")).toBe("codeExecution");
    expect(categorizeAcpToolName("web_fetch")).toBe("webAccess");
  });

  it("resolves an ambiguous name to the MOST restrictive family it matches", () => {
    // The polarity that shipped inverted. Each of these matched `fileRead`
    // first — the axis users most often set to "allow" — so a run-capable or
    // file-editing tool was gated as read-only. All three are real tool names.
    expect(categorizeAcpToolName("search_and_run")).toBe("codeExecution");
    expect(categorizeAcpToolName("search_replace")).toBe("fileWrite"); // Cursor
    expect(categorizeAcpToolName("web_search")).toBe("webAccess"); // Cursor
    expect(categorizeAcpToolName("list_and_delete")).toBe("fileWrite");
    expect(categorizeAcpToolName("grep_and_exec")).toBe("codeExecution");
  });

  it("matches names across snake_case, camelCase and kebab-case", () => {
    // `_` is a word character, so a `\b`-based matcher silently fails on the
    // dominant naming convention in this ecosystem. Tokenizing is what makes
    // name matching work at all.
    for (const name of ["read_file", "readFile", "read-file", "ReadFile"]) {
      expect(categorizeAcpToolName(name)).toBe("fileRead");
    }
    for (const name of ["run_command", "runCommand", "run-command"]) {
      expect(categorizeAcpToolName(name)).toBe("codeExecution");
    }
  });

  it("accepts the identifier shapes real tools use", () => {
    expect(categorizeAcpToolName("mcp__server__read_file")).toBe("fileRead");
    expect(categorizeAcpToolName("fs.write")).toBe("fileWrite");
    expect(categorizeAcpToolName("web-browse")).toBe("webAccess");
  });

  it("never reads words out of prose", () => {
    // The title fallback is a human sentence, and `name` is optional on ACP's
    // ToolCallUpdate — so this string is reachable. It tokenizes to `search`,
    // which used to make it fileRead.
    expect(categorizeAcpToolName("Run `rm -rf` to clear the search index")).toBe("codeExecution");
    expect(categorizeAcpToolName("List the files in src/")).toBe("codeExecution");
    expect(categorizeAcpToolName("Read README.md")).toBe("codeExecution");
  });

  it("gives anything it cannot identify the strictest gate", () => {
    // One rule for "we don't know what this is", and it is codeExecution — the
    // axis that subsumes the other three — not fileWrite.
    expect(categorizeAcpToolName("frobnicate")).toBe("codeExecution");
    expect(categorizeAcpToolName("unknown_tool")).toBe("codeExecution");
    expect(categorizeAcpToolName("")).toBe("codeExecution");
    expect(categorizeAcpToolName("   ")).toBe("codeExecution");
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

describe("the two-pass rule", () => {
  // callboard decides a tool's permission TWICE: once in resolveAcpPermission,
  // and again in `buildCanUseTool` before it prompts. Pass 2 is reached only for
  // tools pass 1 resolved to "ask" — so if pass 2 reaches a category the user
  // set to "allow", the tool runs and nobody is asked.
  //
  // The shipped bypass: pass 1 read ACP's structured `ToolKind`; pass 2 gets a
  // bare name string. `run_command` — the name every earlier test used — is a
  // name where the two happen to agree, which is why nothing caught it. These
  // tests use names where they DIVERGE.
  const askExec = perms({ codeExecution: "ask", fileWrite: "allow" });

  /** The second pass, exactly as buildCanUseTool performs it. */
  function secondPass(perm: DefaultPermissions) {
    const policy = new ToolPermissionPolicy(categorizeAcpToolName, () => perm);
    return (toolName: string) => policy.decide(toolName);
  }

  it("routes an ACP execute tool to codeExecution, not the Claude map's fileWrite default", () => {
    expect(secondPass(askExec)("run_command")).toEqual({ decision: "ask", category: "codeExecution" });

    // What would happen with the Claude map — the bug this pairing prevents.
    const claudePolicy = new ToolPermissionPolicy(categorizeClaudeTool, () => askExec);
    expect(claudePolicy.decide("run_command")).toEqual({ decision: "allow", category: "fileWrite" });
  });

  // The reproduced bypass, one case per row. Under these permissions every one
  // of these executed with no prompt: pass 1 said codeExecution/webAccess/
  // fileWrite ("ask"), pass 2 said fileRead ("allow").
  const divergent = [
    { kind: "execute", name: "search_and_run", expected: "codeExecution" },
    { kind: "fetch", name: "web_search", expected: "webAccess" },
    { kind: "edit", name: "search_replace", expected: "fileWrite" },
  ] as const;
  const readAllowed = perms({ fileRead: "allow", fileWrite: "ask", codeExecution: "ask", webAccess: "ask" });

  it.each(divergent)("prompts for $name instead of silently executing it", async ({ kind, name, expected }) => {
    const seen: string[] = [];
    // Stands in for buildCanUseTool: re-decide, and only reach the user prompt
    // when the second pass ALSO says "ask".
    const canUseTool = vi.fn(async (toolName: string) => {
      const { decision } = secondPass(readAllowed)(toolName);
      if (decision !== "ask") return { behavior: decision === "allow" ? ("allow" as const) : ("deny" as const) };
      seen.push(toolName);
      return { behavior: "deny" as const };
    });

    const req = request({ toolCall: { toolCallId: "c1", title: "A tool", name, kind, rawInput: {} } as never });
    const res = await resolveAcpPermission(req, { permissions: readAllowed, canUseTool, signal: new AbortController().signal });

    // Pass 1 escalated…
    expect(canUseTool).toHaveBeenCalled();
    // …and pass 2 agreed it needed a human, so the user was actually asked.
    expect(seen).toEqual([name]);
    expect(secondPass(readAllowed)(name).category).toBe(expected);
    // Answer honoured: the prompt above denied.
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
  });

  it("agrees with itself on every category, because it is one function over one string", () => {
    // The structural property, not a sample of it: whatever label the adapter
    // categorized is the same label canUseTool receives, so the two passes
    // cannot reach different answers by construction.
    for (const perm of [askExec, readAllowed, perms()]) {
      for (const name of ["run_command", "search_and_run", "web_search", "search_replace", "read_file", "Run `rm -rf` to clear the search index", "unknown_tool"]) {
        expect(secondPass(perm)(name).category).toBe(categorizeAcpToolName(name));
      }
    }
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

  it("refuses to categorize a tool that has only a title", async () => {
    // No `name`, so the label is a human sentence. ACP's `kind: "read"` is right
    // there and is deliberately ignored: pass 2 cannot see it, and using it here
    // would recreate the disagreement. Prose gets the strictest gate instead —
    // codeExecution: "deny" ⇒ reject.
    const req = request({ toolCall: { toolCallId: "c1", title: "rm -rf /", kind: "read" } as never });
    const res = await resolveAcpPermission(req, { permissions: perms({ fileRead: "allow", codeExecution: "deny" }), signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
  });

  it("survives a request with no toolCall at all", async () => {
    const res = await resolveAcpPermission(request({ toolCall: undefined as never }), { permissions: perms(), signal });
    // No metadata ⇒ strictest gate ⇒ still allowed under these all-allow perms.
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
  });
});
