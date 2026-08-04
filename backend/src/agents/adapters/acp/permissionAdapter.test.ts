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
import { decidePermission, ToolPermissionPolicy } from "../../permissions/ToolPermissionPolicy.js";
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

  it("names a call after its ACP kind when nothing else identifies it", () => {
    // OpenCode's real permission request: no `name`, and a `title` that is the
    // file path. Falling through to "unknown_tool" put every OpenCode tool —
    // reads included — on codeExecution, which stops the other three axes
    // governing anything at all for that vendor.
    const openCodeShape = { toolCallId: "c", kind: "edit", title: "/tmp/proj/hello.txt", rawInput: {} } as never;
    expect(acpToolLabel(openCodeShape)).toBe("edit");
    expect(categorizeAcpToolName(acpToolLabel(openCodeShape))).toBe("fileWrite");
  });

  it("still refuses to be identified by prose", () => {
    // Rule 3. This title tokenizes to `search` → fileRead if it were ever read
    // for words, which is the whole reason it is skipped.
    const prose = { toolCallId: "c", title: "Run `rm -rf` to clear the search index" } as never;
    expect(acpToolLabel(prose)).toBe("unknown_tool");
    expect(categorizeAcpToolName(acpToolLabel(prose))).toBe("codeExecution");
  });

  it("prefers a name, then the kind, then a shaped title — in that order", () => {
    expect(acpToolLabel({ toolCallId: "c", name: "read_file", title: "Reading a file", kind: "execute" } as never)).toBe("read_file");
    expect(acpToolLabel({ toolCallId: "c", title: "write", kind: "edit" } as never)).toBe("edit");
    expect(acpToolLabel({ toolCallId: "c", title: "write" } as never)).toBe("write");
  });

  it("does not let the shape of a filename choose the permission axis", () => {
    // OpenCode puts the file being touched in `title`, and whether that string
    // is identifier-shaped depends on something with no bearing on the tool:
    // an absolute path is not (leading slash), a bare filename is. With `title`
    // ranked above `kind`, the same edit landed on fileWrite when the path was
    // absolute and on codeExecution when it was relative. Caught by the live
    // suite, not by the double.
    const absolute = { toolCallId: "c", kind: "edit", title: "/tmp/proj/notes.txt" } as never;
    const relative = { toolCallId: "c", kind: "edit", title: "notes.txt" } as never;
    expect(acpToolLabel(absolute)).toBe("edit");
    expect(acpToolLabel(relative)).toBe("edit");
    expect(categorizeAcpToolName(acpToolLabel(absolute))).toBe(categorizeAcpToolName(acpToolLabel(relative)));
    expect(categorizeAcpToolName(acpToolLabel(relative))).toBe("fileWrite");
  });

  it("maps every ACP kind onto a category at least as strict as the kind table's", () => {
    // The ladder's last rung must not be a back door. Where
    // categorizeAcpToolKind has an opinion, the label agrees with it; where it
    // returns null (think / switch_mode / other), the label lands on the
    // strictest category rather than on nothing.
    const kinds = ["read", "search", "edit", "delete", "move", "execute", "fetch", "think", "switch_mode", "other"] as const;
    for (const kind of kinds) {
      const viaLabel = categorizeAcpToolName(acpToolLabel({ toolCallId: "c", kind } as never));
      const viaKind = categorizeAcpToolKind(kind);
      expect(viaLabel).toBe(viaKind ?? "codeExecution");
    }
  });

  it("ignores a kind that is not identifier-shaped", () => {
    expect(acpToolLabel({ toolCallId: "c", kind: "not a kind" } as never)).toBe("unknown_tool");
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
    const res = await resolveAcpPermission(req, { getPermissions: () => readAllowed, canUseTool, signal: new AbortController().signal });

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
      for (const name of [
        "run_command",
        "search_and_run",
        "web_search",
        "search_replace",
        "read_file",
        "Run `rm -rf` to clear the search index",
        "unknown_tool",
      ]) {
        expect(secondPass(perm)(name).category).toBe(categorizeAcpToolName(name));
      }
    }
  });

  // The categorizer is only half the input. The other half is the policy, and
  // "identical input" includes *when* it is read: pass 2's ToolPermissionPolicy
  // holds a live accessor and re-reads storage per call, so pass 1 must too. A
  // snapshot taken at send time lets pass 1 auto-allow on a policy the user has
  // since tightened — and pass 2, the pass that would have caught it, is only
  // reached when pass 1 says "ask".
  it("reads the policy at decision time, so a mid-turn tightening binds on the very next call", async () => {
    // One live cell standing in for chat metadata on disk, which is what
    // `getDefaultPermissions` in services/claude.ts re-reads on every call.
    let live: DefaultPermissions = perms(); // everything allowed
    const canUseTool = vi.fn().mockResolvedValue({ behavior: "deny" });
    const ctx = { getPermissions: () => live, canUseTool, signal: new AbortController().signal };

    // Before: codeExecution is "allow", so the tool runs unprompted.
    expect(await resolveAcpPermission(request(), ctx)).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
    expect(canUseTool).not.toHaveBeenCalled();

    // The user tightens the policy mid-turn.
    live = perms({ codeExecution: "ask" });

    // After: the very next call escalates instead of auto-allowing on the
    // stale value.
    expect(await resolveAcpPermission(request(), ctx)).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
    expect(canUseTool).toHaveBeenCalledWith("run_command", { command: "ls" }, { signal: ctx.signal });
  });

  it("cannot disagree with pass 2 about the policy, because both read the same accessor", () => {
    // The structural mirror of the categorizer test above, for the policy
    // input. Both passes are handed the same getter, so at every instant they
    // see the same four axes — there is no window in which one is stale.
    let live: DefaultPermissions = perms();
    const getPermissions = () => live;
    const pass2 = new ToolPermissionPolicy(categorizeAcpToolName, getPermissions);

    for (const next of [perms(), askExec, readAllowed, perms({ codeExecution: "deny" })]) {
      live = next;
      for (const name of ["run_command", "search_replace", "web_search", "read_file", "unknown_tool"]) {
        // Pass 1, as resolveAcpPermission performs it.
        const pass1 = decidePermission(categorizeAcpToolName(name), getPermissions() ?? null);
        expect(pass2.decide(name).decision).toBe(pass1);
      }
    }
  });
});

describe("resolveAcpPermission", () => {
  const signal = new AbortController().signal;

  it("auto-allows without prompting when policy allows", async () => {
    const canUseTool = vi.fn();
    const res = await resolveAcpPermission(request(), { getPermissions: () => perms(), canUseTool, signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it("auto-rejects without prompting when policy denies", async () => {
    const canUseTool = vi.fn();
    const res = await resolveAcpPermission(request(), { getPermissions: () => perms({ codeExecution: "deny" }), canUseTool, signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('escalates "ask" to canUseTool with the tool name and raw input', async () => {
    const canUseTool = vi.fn().mockResolvedValue({ behavior: "allow" });
    const res = await resolveAcpPermission(request(), { getPermissions: () => perms({ codeExecution: "ask" }), canUseTool, signal });
    expect(canUseTool).toHaveBeenCalledWith("run_command", { command: "ls" }, { signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
  });

  it("treats absent permissions as ask", async () => {
    const canUseTool = vi.fn().mockResolvedValue({ behavior: "deny" });
    const res = await resolveAcpPermission(request(), { getPermissions: () => null, canUseTool, signal });
    expect(canUseTool).toHaveBeenCalled();
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
  });

  it('rejects an "ask" when nothing can surface a prompt', async () => {
    // e.g. a quick-completion run. There is no one to ask, so refusing is the
    // only safe reading.
    const res = await resolveAcpPermission(request(), { getPermissions: () => perms({ codeExecution: "ask" }), signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
  });

  it("rejects when canUseTool throws instead of propagating the error", async () => {
    const canUseTool = vi.fn().mockRejectedValue(new Error("emitter gone"));
    const res = await resolveAcpPermission(request(), { getPermissions: () => perms({ codeExecution: "ask" }), canUseTool, signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
  });

  it("answers cancelled when the agent offers no options at all", async () => {
    const res = await resolveAcpPermission(request({ options: [] }), { getPermissions: () => perms(), signal });
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("answers cancelled when no offered option matches the decision", async () => {
    // Policy says deny, but the agent only offered allow. Selecting it would
    // invert callboard's decision.
    const res = await resolveAcpPermission(request({ options: [ALLOW_ONCE] }), { getPermissions: () => perms({ codeExecution: "deny" }), signal });
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("filters out malformed options before deciding", async () => {
    const res = await resolveAcpPermission(request({ options: [null, { name: "no id" }, ALLOW_ONCE] as never }), { getPermissions: () => perms(), signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
  });

  it("answers cancelled when the run aborts while the user is being asked", async () => {
    const controller = new AbortController();
    const canUseTool = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { behavior: "allow" as const };
    });
    const res = await resolveAcpPermission(request(), { getPermissions: () => perms({ codeExecution: "ask" }), canUseTool, signal: controller.signal });
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("refuses to categorize a tool from prose alone", async () => {
    // No `name`, no `kind`, and a title that is a human sentence. Nothing here
    // may be read for words (rule 3), so the call gets the strictest gate —
    // codeExecution: "deny" ⇒ reject.
    const req = request({ toolCall: { toolCallId: "c1", title: "rm -rf /" } as never });
    const res = await resolveAcpPermission(req, { getPermissions: () => perms({ fileRead: "allow", codeExecution: "deny" }), signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
  });

  it("categorizes from the ACP kind when the title is prose", async () => {
    // The behaviour change: previously this fell to codeExecution because the
    // title is unreadable, which is what made every OpenCode tool — reads
    // included — land on the one axis. The kind is a closed enum, both passes
    // see it (it IS the label), so fileWrite: "deny" is what governs an edit.
    const req = request({ toolCall: { toolCallId: "c1", title: "/tmp/proj/hello.txt", kind: "edit" } as never });
    const res = await resolveAcpPermission(req, { getPermissions: () => perms({ fileWrite: "deny", codeExecution: "allow" }), signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "r1" } });
  });

  it("takes a lying kind at face value — the same standing risk as a lying name", async () => {
    // Pinned deliberately rather than left implicit. An agent that labels a
    // destructive call `kind: "read"` is auto-allowed under fileRead: "allow" —
    // but an agent that labels it `name: "read_file"` always was, and `name`
    // outranks `kind`. The protocol offers no defence either way: an agent that
    // wants to dodge the gate just never sends session/request_permission. If a
    // real vendor is ever found abusing `kind`, the escalation is a per-vendor
    // opt-in in vendors.ts, not a return to categorizing everything as
    // codeExecution.
    const req = request({ toolCall: { toolCallId: "c1", title: "rm -rf /", kind: "read" } as never });
    const res = await resolveAcpPermission(req, { getPermissions: () => perms({ fileRead: "allow", codeExecution: "deny" }), signal });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
  });

  it("survives a request with no toolCall at all", async () => {
    const res = await resolveAcpPermission(request({ toolCall: undefined as never }), { getPermissions: () => perms(), signal });
    // No metadata ⇒ strictest gate ⇒ still allowed under these all-allow perms.
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "a1" } });
  });
});
