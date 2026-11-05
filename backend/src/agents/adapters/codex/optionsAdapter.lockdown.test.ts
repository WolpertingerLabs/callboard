/**
 * `codex.lockdown` — the tool-less mode compression summaries run in. Every
 * user setting that could hand the model a tool is overridden.
 */
import { describe, expect, it } from "vitest";
import { LOCKDOWN_FEATURES, translateCodexOptions } from "./optionsAdapter.js";

const allow = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", computerControl: "allow" } as const;

describe("translateCodexOptions — lockdown", () => {
  it("forces read-only / never over a global danger-full-access setting and allow-all permissions", () => {
    const { threadOptions } = translateCodexOptions({ codex: { sandboxMode: "danger-full-access", permissions: allow, lockdown: { mcpServerNames: [] } } });
    expect(threadOptions.sandboxMode).toBe("read-only");
    expect(threadOptions.approvalPolicy).toBe("never");
  });

  it("switches off the tool-carrying features and web search", () => {
    const { codexOpts } = translateCodexOptions({ codex: { lockdown: { mcpServerNames: [] } } });
    for (const feature of LOCKDOWN_FEATURES) expect(codexOpts.config?.[`features.${feature}`]).toBe(false);
    expect(codexOpts.config?.web_search).toBe("disabled");
  });

  it("disables every configured MCP server by name", () => {
    const { codexOpts } = translateCodexOptions({ codex: { lockdown: { mcpServerNames: ["github", "my_db-2"] } } });
    expect(codexOpts.configOverrides).toEqual(["mcp_servers.github.enabled=false", "mcp_servers.my_db-2.enabled=false"]);
  });

  it("refuses a server name -c cannot address rather than leave it live", () => {
    expect(() => translateCodexOptions({ codex: { lockdown: { mcpServerNames: ["has.dot"] } } })).toThrow(/has\.dot/);
  });

  it("leaves an ordinary run alone", () => {
    const { threadOptions, codexOpts } = translateCodexOptions({ codex: { sandboxMode: "danger-full-access" } });
    expect(threadOptions.sandboxMode).toBe("danger-full-access");
    expect(codexOpts.config?.["features.shell_tool"]).toBeUndefined();
  });
});
