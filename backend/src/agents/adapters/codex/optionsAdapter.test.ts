/**
 * Unit tests for the Claude-shaped options → Codex construction translation.
 *
 * Covers the Step-5 mapping table (`plans/codex-adapter-job.md`): cwd →
 * workingDirectory + skipGitRepoCheck, model resolution, resume → resumeId,
 * systemPrompt → temp model_instructions_file, the subscription-vs-api-key Codex
 * client construction, env forwarding, and the sandbox/approval resolution that
 * layers an explicit setting over the permission-derived tier.
 *
 * Tests that exercise `writeInstructionsFile` reap the temp dir afterward so the
 * suite leaves nothing under os.tmpdir().
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DefaultPermissions } from "shared/types/index.js";
import {
  buildCodexEnv,
  collectCodexMcpServers,
  resolveCodexInstructions,
  resolveSandboxAndApproval,
  translateCodexOptions,
  writeInstructionsFile,
} from "./optionsAdapter.js";
import type { CodexToolServerHandle } from "./toolAdapter.js";

/** A stub tool-server handle — duck-types {@link isCodexToolServerHandle} so the
 *  options layer can be tested without standing up a real socket. */
function fakeHandle(name: string, socketPath: string): CodexToolServerHandle {
  return {
    name,
    version: "1.0.0",
    socketPath,
    toMcpServerConfig: () => ({ command: "node", args: ["/shim.js", socketPath] }),
    close: async () => {},
  };
}

/** Temp dirs created via translate/write so afterEach can remove them. */
const tempDirs: string[] = [];
function trackTempFromFile(filePath: string | null | undefined): void {
  if (filePath) tempDirs.push(dirname(filePath));
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("translateCodexOptions — core option mapping", () => {
  it("cwd → workingDirectory and always sets skipGitRepoCheck", () => {
    const { threadOptions } = translateCodexOptions({ cwd: "/home/cybil/proj" });
    expect(threadOptions.skipGitRepoCheck).toBe(true);
    expect(threadOptions.workingDirectory).toBe("/home/cybil/proj");
  });

  it("skipGitRepoCheck is set even with no cwd; workingDirectory omitted", () => {
    const { threadOptions } = translateCodexOptions({});
    expect(threadOptions.skipGitRepoCheck).toBe(true);
    expect(threadOptions.workingDirectory).toBeUndefined();
  });

  it("resume → resumeId; absent/empty → null (fresh thread)", () => {
    expect(translateCodexOptions({ resume: "thr_abc" }).resumeId).toBe("thr_abc");
    expect(translateCodexOptions({ resume: "" }).resumeId).toBeNull();
    expect(translateCodexOptions({}).resumeId).toBeNull();
  });

  it("model resolves from codex.model, falling back to options.model", () => {
    expect(translateCodexOptions({ model: "gpt-5.1-codex" }).threadOptions.model).toBe("gpt-5.1-codex");
    // codex.model wins over a top-level options.model
    expect(
      translateCodexOptions({ model: "gpt-5.1-codex", codex: { model: "gpt-5.5" } }).threadOptions.model,
    ).toBe("gpt-5.5");
    expect(translateCodexOptions({}).threadOptions.model).toBeUndefined();
  });
});

describe("translateCodexOptions — subscription vs api-key construction", () => {
  it("subscription mode (default): no apiKey, no baseUrl", () => {
    const { codexOpts, authMode } = translateCodexOptions({});
    expect(authMode).toBe("subscription");
    expect(codexOpts.apiKey).toBeUndefined();
    expect(codexOpts.baseUrl).toBeUndefined();
  });

  it("explicit subscription mode ignores any stray apiKey/baseUrl in extras", () => {
    const { codexOpts } = translateCodexOptions({
      codex: { authMode: "subscription", apiKey: "sk-leak", baseUrl: "https://x" },
    });
    expect(codexOpts.apiKey).toBeUndefined();
    expect(codexOpts.baseUrl).toBeUndefined();
  });

  it("api-key mode passes apiKey and baseUrl through to CodexOptions", () => {
    const { codexOpts, authMode } = translateCodexOptions({
      codex: { authMode: "api-key", apiKey: "sk-123", baseUrl: "https://proxy.local/v1" },
    });
    expect(authMode).toBe("api-key");
    expect(codexOpts.apiKey).toBe("sk-123");
    expect(codexOpts.baseUrl).toBe("https://proxy.local/v1");
  });

  it("api-key mode without a key set leaves apiKey undefined", () => {
    const { codexOpts } = translateCodexOptions({ codex: { authMode: "api-key" } });
    expect(codexOpts.apiKey).toBeUndefined();
  });
});

describe("buildCodexEnv", () => {
  it("returns undefined when no env is supplied (SDK inherits process.env)", () => {
    expect(buildCodexEnv(undefined)).toBeUndefined();
  });

  it("forwards a complete env, dropping undefined-valued keys", () => {
    const env = buildCodexEnv({
      PATH: "/usr/bin",
      CODEX_HOME: "/home/cybil/.codex",
      CLAUDECODE: undefined,
    });
    expect(env).toEqual({ PATH: "/usr/bin", CODEX_HOME: "/home/cybil/.codex" });
    expect(env && "CLAUDECODE" in env).toBe(false);
  });

  it("translate forwards options.env to codexOpts.env so CODEX_HOME reaches the CLI", () => {
    const { codexOpts } = translateCodexOptions({
      env: { PATH: "/usr/bin", CODEX_HOME: "/tmp/ch", FOO: undefined },
    });
    expect(codexOpts.env).toEqual({ PATH: "/usr/bin", CODEX_HOME: "/tmp/ch" });
  });

  it("translate leaves codexOpts.env unset when options.env is absent", () => {
    expect(translateCodexOptions({}).codexOpts.env).toBeUndefined();
  });
});

describe("resolveCodexInstructions", () => {
  it("plain non-empty string passes through", () => {
    expect(resolveCodexInstructions("be terse")).toBe("be terse");
  });

  it("empty string → undefined", () => {
    expect(resolveCodexInstructions("")).toBeUndefined();
  });

  it("preset object uses the append; loses the named preset content", () => {
    expect(
      resolveCodexInstructions({ type: "preset", preset: "claude_code", append: "extra rules" }),
    ).toBe("extra rules");
  });

  it("preset object with no append → undefined", () => {
    expect(resolveCodexInstructions({ type: "preset", preset: "claude_code" })).toBeUndefined();
  });

  it("undefined → undefined", () => {
    expect(resolveCodexInstructions(undefined)).toBeUndefined();
  });
});

describe("translateCodexOptions — systemPrompt → temp model_instructions_file", () => {
  it("writes the prompt to a temp file and references it via config.model_instructions_file", () => {
    const { codexOpts, instructionsFilePath } = translateCodexOptions({ systemPrompt: "follow the rules" });
    trackTempFromFile(instructionsFilePath);
    expect(instructionsFilePath).toBeTruthy();
    expect(existsSync(instructionsFilePath!)).toBe(true);
    expect(readFileSync(instructionsFilePath!, "utf-8")).toBe("follow the rules");
    expect((codexOpts.config as { model_instructions_file?: string }).model_instructions_file).toBe(
      instructionsFilePath,
    );
  });

  it("preset append is what lands in the file", () => {
    const { instructionsFilePath } = translateCodexOptions({
      systemPrompt: { type: "preset", preset: "claude_code", append: "appended bit" },
    });
    trackTempFromFile(instructionsFilePath);
    expect(readFileSync(instructionsFilePath!, "utf-8")).toBe("appended bit");
  });

  it("no systemPrompt → no file, no config", () => {
    const { codexOpts, instructionsFilePath } = translateCodexOptions({});
    expect(instructionsFilePath).toBeNull();
    expect(codexOpts.config).toBeUndefined();
  });

  it("writeInstructionsFile uses unique temp dirs per call", () => {
    const a = writeInstructionsFile("a");
    const b = writeInstructionsFile("b");
    trackTempFromFile(a);
    trackTempFromFile(b);
    expect(dirname(a)).not.toBe(dirname(b));
    expect(readFileSync(a, "utf-8")).toBe("a");
    expect(readFileSync(b, "utf-8")).toBe("b");
  });
});

function perms(overrides: Partial<DefaultPermissions> = {}): DefaultPermissions {
  return {
    fileRead: "deny",
    fileWrite: "deny",
    codeExecution: "deny",
    webAccess: "deny",
    ...overrides,
  };
}

describe("resolveSandboxAndApproval", () => {
  it("neither permissions nor explicit sandbox → empty (CLI defaults apply)", () => {
    expect(resolveSandboxAndApproval({})).toEqual({});
  });

  it("permissions only → the permission-mapped tier", () => {
    expect(resolveSandboxAndApproval({ permissions: perms({ fileWrite: "allow" }) })).toEqual({
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
    });
  });

  it("explicit sandbox only → tier + its default approval", () => {
    expect(resolveSandboxAndApproval({ sandboxMode: "danger-full-access" })).toEqual({
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    });
    expect(resolveSandboxAndApproval({ sandboxMode: "read-only" })).toEqual({
      sandboxMode: "read-only",
      approvalPolicy: "on-request",
    });
  });

  it("explicit sandbox overrides the permission-derived tier", () => {
    // permissions alone would yield read-only, but the user forced workspace-write.
    expect(
      resolveSandboxAndApproval({ sandboxMode: "workspace-write", permissions: perms() }),
    ).toEqual({ sandboxMode: "workspace-write", approvalPolicy: "on-request" });
  });

  it("an 'ask' pins approval to on-request even when the explicit tier is danger-full-access", () => {
    expect(
      resolveSandboxAndApproval({
        sandboxMode: "danger-full-access",
        permissions: perms({ fileWrite: "ask" }),
      }),
    ).toEqual({ sandboxMode: "danger-full-access", approvalPolicy: "on-request" });
  });
});

describe("translateCodexOptions — sandbox/approval threaded into ThreadOptions", () => {
  it("permission-derived sandbox + approval land on threadOptions", () => {
    const { threadOptions } = translateCodexOptions({
      codex: { permissions: perms({ fileWrite: "allow", codeExecution: "allow" }) },
    });
    expect(threadOptions.sandboxMode).toBe("danger-full-access");
    expect(threadOptions.approvalPolicy).toBe("never");
  });

  it("no permissions/sandbox → neither set (CLI default)", () => {
    const { threadOptions } = translateCodexOptions({});
    expect(threadOptions.sandboxMode).toBeUndefined();
    expect(threadOptions.approvalPolicy).toBeUndefined();
  });
});

describe("collectCodexMcpServers — tool handles → mcp_servers config", () => {
  it("no mcpServers → empty config, no handles", () => {
    expect(collectCodexMcpServers(undefined)).toEqual({ handles: [] });
  });

  it("maps each handle to a config entry and threads handles out", () => {
    const a = fakeHandle("callboard-tools", "/tmp/a/s.sock");
    const b = fakeHandle("job-tools", "/tmp/b/s.sock");
    const { config, handles } = collectCodexMcpServers({ "callboard-tools": a, "job-tools": b });
    expect(config).toEqual({
      "callboard-tools": { command: "node", args: ["/shim.js", "/tmp/a/s.sock"] },
      "job-tools": { command: "node", args: ["/shim.js", "/tmp/b/s.sock"] },
    });
    expect(handles).toEqual([a, b]);
  });

  it("ignores foreign-shaped entries (e.g. a Claude/OR server object)", () => {
    const a = fakeHandle("callboard-tools", "/tmp/a/s.sock");
    const { config, handles } = collectCodexMcpServers({
      "callboard-tools": a,
      "claude-thing": { name: "x", tools: [] },
    });
    expect(Object.keys(config ?? {})).toEqual(["callboard-tools"]);
    expect(handles).toEqual([a]);
  });

  it("all-foreign → no config key, no handles", () => {
    const { config, handles } = collectCodexMcpServers({ x: { tools: [] } });
    expect(config).toBeUndefined();
    expect(handles).toEqual([]);
  });
});

describe("translateCodexOptions — mcp_servers threaded into codexOpts.config", () => {
  it("tool handles land in config.mcp_servers and ride out as toolServerHandles", () => {
    const a = fakeHandle("callboard-tools", "/tmp/a/s.sock");
    const { codexOpts, toolServerHandles } = translateCodexOptions({
      mcpServers: { "callboard-tools": a },
    });
    expect(codexOpts.config?.mcp_servers).toEqual({
      "callboard-tools": { command: "node", args: ["/shim.js", "/tmp/a/s.sock"] },
    });
    expect(toolServerHandles).toEqual([a]);
  });

  it("coexists with a system-prompt model_instructions_file in the same config", () => {
    const a = fakeHandle("callboard-tools", "/tmp/a/s.sock");
    const result = translateCodexOptions({
      systemPrompt: "be terse",
      mcpServers: { "callboard-tools": a },
    });
    trackTempFromFile(result.instructionsFilePath);
    expect(result.codexOpts.config?.model_instructions_file).toBe(result.instructionsFilePath);
    expect(result.codexOpts.config?.mcp_servers).toBeDefined();
  });

  it("no mcpServers → no mcp_servers key, empty handles", () => {
    const { codexOpts, toolServerHandles } = translateCodexOptions({});
    expect(codexOpts.config?.mcp_servers).toBeUndefined();
    expect(toolServerHandles).toEqual([]);
  });
});
