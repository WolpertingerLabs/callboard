import { describe, expect, it } from "vitest";
import { categorizeClaudeTool } from "./permissionAdapter.js";

describe("categorizeClaudeTool", () => {
  it("files Monitor under codeExecution — it runs a shell command (or opens a socket) and streams its output", () => {
    // Before, Monitor fell to the unknown-tool default (fileWrite), so a chat
    // with writes denied but shell allowed had every Monitor call auto-denied
    // with `interrupt: true`, ending the turn as an `[ede_diagnostic]` error.
    expect(categorizeClaudeTool("Monitor")).toBe("codeExecution");
  });

  it("keeps the established axes", () => {
    expect(categorizeClaudeTool("Read")).toBe("fileRead");
    expect(categorizeClaudeTool("Write")).toBe("fileWrite");
    expect(categorizeClaudeTool("Bash")).toBe("codeExecution");
    expect(categorizeClaudeTool("WebFetch")).toBe("webAccess");
    expect(categorizeClaudeTool("AskUserQuestion")).toBeNull();
    expect(categorizeClaudeTool("SomeFutureTool")).toBe("fileWrite");
  });

  it("gates every third-party MCP tool at codeExecution — a server picks its own names", () => {
    expect(categorizeClaudeTool("mcp__thirdparty__do_thing")).toBe("codeExecution");
    // A friendly-looking name buys nothing.
    expect(categorizeClaudeTool("mcp__github__read_file")).toBe("codeExecution");
    expect(categorizeClaudeTool("mcp__computer_use__cu_open")).toBe("computerControl");
  });
});
