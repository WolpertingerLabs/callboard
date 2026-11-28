/**
 * The Callboard tool gate table is the source of truth for which permission
 * axes each of Callboard's own tools needs (H-01). These tests make it
 * impossible to ship a tool with no entry, and pin the input-aware rows.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DefaultPermissions } from "shared/types/index.js";
import type { ToolServerSpec } from "../ports/tools.js";

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-tool-policy-"));
// claude.ts ⇄ callboard-tools.ts are mutually recursive; only schemas are read here.
vi.mock("../../services/claude.js", () => ({ getActiveSession: () => undefined }));

const { buildCallboardToolsSpec } = await import("../../services/callboard-tools.js");
const { buildAgentToolsSpec } = await import("../../services/agent-tools.js");
const { buildProxyToolsSpec } = await import("../../services/proxy-tools.js");
const { buildJobStepToolsSpec } = await import("../../services/job-step-tools.js");
const { buildObjectiveToolsSpec } = await import("../../services/objective-tools.js");
const { AGENT_UNATTENDED_TOOLS } = await import("../../services/agent-tools.js");
const { JOB_UNATTENDED_TOOLS } = await import("../../services/job-management-tools.js");
const policy = await import("./callboardToolPolicy.js");
const {
  CALLBOARD_TOOL_POLICY,
  CALLBOARD_SERVER_KEYS,
  UNGATED,
  callboardToolGate,
  callboardToolGateByBareName,
  decideGate,
  isAlwaysUngated,
  parseClaudeMcpName,
} = policy;

/** Every spec, built the way claude.ts `inject()` builds it, by server key. */
function specsByKey(): [string, ToolServerSpec][] {
  return [
    ["callboard-tools", buildCallboardToolsSpec(() => "chat-1")],
    [
      "callboard-tools",
      buildCallboardToolsSpec(
        () => "chat-1",
        () => "agent",
        { includeJobTools: false },
      ),
    ],
    ["callboard", buildAgentToolsSpec("agent", () => "chat-1")],
    ["mcp-proxy", buildProxyToolsSpec("default")],
    ["job-tools", buildJobStepToolsSpec(() => undefined)],
    ["objective-tools", buildObjectiveToolsSpec(() => "chat-1")],
  ];
}

const perms = (over: Partial<DefaultPermissions> = {}): DefaultPermissions => ({
  fileRead: "allow",
  fileWrite: "allow",
  codeExecution: "allow",
  webAccess: "allow",
  browserControl: "deny",
  computerControl: "deny",
  sandboxControl: "deny",
  ...over,
});

describe("coverage", () => {
  it("every tool every Callboard server registers has an entry under its own key", () => {
    const missing: string[] = [];
    for (const [key, spec] of specsByKey()) {
      expect(spec.name, "spec.name is the key inject() registers it under").toBe(key);
      for (const tool of spec.tools) if (!(tool.name in CALLBOARD_TOOL_POLICY[key as keyof typeof CALLBOARD_TOOL_POLICY])) missing.push(`${key}/${tool.name}`);
    }
    expect(missing).toEqual([]);
  });

  it("has no entry for a tool no server registers (a rename cannot leave a stale row)", () => {
    const real = new Map<string, Set<string>>();
    for (const [key, spec] of specsByKey()) for (const t of spec.tools) (real.get(key) ?? real.set(key, new Set()).get(key)!).add(t.name);
    const stale: string[] = [];
    for (const key of CALLBOARD_SERVER_KEYS)
      for (const name of Object.keys(CALLBOARD_TOOL_POLICY[key])) if (!real.get(key)?.has(name)) stale.push(`${key}/${name}`);
    expect(stale).toEqual([]);
  });

  it("bare names repeat across servers only with the same gate (pi sees them unprefixed)", () => {
    const seen = new Map<string, string>();
    const samples = [{}, { source_path: "/x", file_path: "/x", url: "https://x", files: [{}], newBranch: "b" }];
    const conflicts: string[] = [];
    for (const key of CALLBOARD_SERVER_KEYS) {
      for (const name of Object.keys(CALLBOARD_TOOL_POLICY[key])) {
        const sig = JSON.stringify(samples.map((s) => callboardToolGate(key, name, s)));
        const prev = seen.get(name);
        if (prev !== undefined && prev !== sig) conflicts.push(name);
        seen.set(name, sig);
        expect(JSON.stringify(samples.map((s) => callboardToolGateByBareName(name, s))), name).toBe(sig);
      }
    }
    expect(conflicts).toEqual([]);
  });

  it("leaves the unattended-work tools ungated: guardUnattendedTools already requires allow-all", () => {
    for (const name of AGENT_UNATTENDED_TOOLS) expect(callboardToolGate("callboard", name), name).toBe(UNGATED);
    for (const name of JOB_UNATTENDED_TOOLS) {
      expect(callboardToolGate("callboard", name), name).toBe(UNGATED);
      expect(callboardToolGate("callboard-tools", name), name).toBe(UNGATED);
    }
  });

  it("fails closed for a name missing from a Callboard server, and is silent for other servers", () => {
    expect(callboardToolGate("callboard-tools", "brand_new_tool")).toEqual(["codeExecution"]);
    expect(callboardToolGate("some-plugin", "anything")).toBeUndefined();
    expect(callboardToolGate("computer_use", "cu_open")).toBeUndefined();
  });
});

describe("specific gates", () => {
  it.each([
    ["callboard-tools", "set_chat_title", UNGATED],
    ["callboard-tools", "wait", UNGATED],
    ["callboard-tools", "read_session_messages", ["fileRead"]],
    ["callboard-tools", "write_custom_skill", ["fileWrite", "codeExecution"]],
    ["mcp-proxy", "vault_get", ["codeExecution"]],
    ["mcp-proxy", "vault_list", ["fileRead"]],
    ["mcp-proxy", "secure_request", ["webAccess"]],
    ["mcp-proxy", "poll_events", ["webAccess"]],
  ] as const)("%s/%s", (key, name, gate) => {
    expect(callboardToolGate(key, name, {})).toEqual(gate);
  });

  it("save_storage_item: fileWrite, plus fileRead for source_path", () => {
    expect(callboardToolGate("callboard-tools", "save_storage_item", { content: "x" })).toEqual(["fileWrite"]);
    expect(callboardToolGate("callboard-tools", "save_storage_item", { source_path: "/etc/passwd" })).toEqual(["fileWrite", "fileRead"]);
  });

  it("render_file: fileRead for a path, webAccess for a url", () => {
    expect(callboardToolGate("callboard-tools", "render_file", { file_path: "/x" })).toEqual(["fileRead"]);
    expect(callboardToolGate("callboard-tools", "render_file", { url: "https://x" })).toEqual(["webAccess"]);
  });

  it("start_chat_session: ungated, unless a branch or worktree argument makes the daemon run git", () => {
    expect(callboardToolGate("callboard-tools", "start_chat_session", { prompt: "p" })).toBe(UNGATED);
    for (const arg of [{ newBranch: "b" }, { baseBranch: "main" }, { useWorktree: true }]) {
      expect(callboardToolGate("callboard-tools", "start_chat_session", arg), JSON.stringify(arg)).toEqual(["fileWrite", "codeExecution"]);
    }
    // `useWorktree: false` is still an argument the daemon reads — gated, the safe side.
    expect(callboardToolGate("callboard-tools", "start_chat_session", { useWorktree: false })).toEqual(["fileWrite", "codeExecution"]);
  });

  it("secure_request: also fileRead when it uploads files", () => {
    expect(callboardToolGate("mcp-proxy", "secure_request", { url: "u", files: [{ path: "/x" }] })).toEqual(["webAccess", "fileRead"]);
    expect(callboardToolGate("mcp-proxy", "secure_request", { url: "u", files: [] })).toEqual(["webAccess"]);
  });

  it("canvases: inline content is ungated, a file_path reads the host", () => {
    expect(callboardToolGate("callboard-tools", "create_canvas", { content: "x" })).toBe(UNGATED);
    expect(callboardToolGate("callboard-tools", "create_canvas", { file_path: "/x" })).toEqual(["fileRead"]);
  });

  it("only always-ungated tools may be pre-approved by name — never an input-aware one", () => {
    expect(isAlwaysUngated("callboard-tools", "set_chat_title")).toBe(true);
    expect(isAlwaysUngated("callboard-tools", "start_chat_session")).toBe(false);
    expect(isAlwaysUngated("callboard-tools", "create_canvas")).toBe(false);
    expect(isAlwaysUngated("callboard-tools", "save_storage_item")).toBe(false);
    expect(isAlwaysUngated("some-plugin", "x")).toBe(false);
  });
});

describe("parseClaudeMcpName", () => {
  it("parses Callboard servers only", () => {
    expect(parseClaudeMcpName("mcp__callboard-tools__save_storage_item")).toEqual({ server: "callboard-tools", name: "save_storage_item" });
    expect(parseClaudeMcpName("mcp__mcp-proxy__vault_get")).toEqual({ server: "mcp-proxy", name: "vault_get" });
    expect(parseClaudeMcpName("mcp__callboard__talk_to_agent")).toEqual({ server: "callboard", name: "talk_to_agent" });
    expect(parseClaudeMcpName("mcp__computer_use__cu_open")).toBeNull();
    expect(parseClaudeMcpName("mcp__github__create_issue")).toBeNull();
    expect(parseClaudeMcpName("mcp__callboard-toolsX__x")).toBeNull();
    expect(parseClaudeMcpName("Bash")).toBeNull();
  });
});

describe("decideGate", () => {
  it("ungated always allows, whatever the policy", () => {
    expect(decideGate(UNGATED, perms({ fileRead: "deny", codeExecution: "deny" })).decision).toBe("allow");
    expect(decideGate(UNGATED, null).decision).toBe("allow");
  });

  it("all axes allow → allow", () => {
    expect(decideGate(["fileRead", "fileWrite"], perms()).decision).toBe("allow");
  });

  it("any deny → deny, binding the first denied axis even after an ask", () => {
    expect(decideGate(["fileWrite", "fileRead"], perms({ fileWrite: "ask", fileRead: "deny" }))).toEqual({
      decision: "deny",
      category: "fileRead",
      pending: ["fileRead"],
    });
  });

  it("otherwise any ask → ask, binding the first asking axis and listing every asking one", () => {
    expect(decideGate(["fileWrite", "codeExecution"], perms({ fileWrite: "ask", codeExecution: "ask" }))).toEqual({
      decision: "ask",
      category: "fileWrite",
      pending: ["fileWrite", "codeExecution"],
    });
    expect(decideGate(["fileWrite", "codeExecution"], perms({ codeExecution: "ask" }))).toEqual({
      decision: "ask",
      category: "codeExecution",
      pending: ["codeExecution"],
    });
  });

  it("null permissions ask on every axis", () => {
    expect(decideGate(["fileRead", "webAccess"], null)).toEqual({ decision: "ask", category: "fileRead", pending: ["fileRead", "webAccess"] });
  });
});
