import { describe, expect, it } from "vitest";
import { parseToolName, getToolDisplayName, getToolSummary, isCallboardTool } from "./toolFormatting";

const j = (input: unknown) => JSON.stringify(input);

describe("parseToolName", () => {
  it("parses Claude MCP names (mcp__server__tool)", () => {
    expect(parseToolName("mcp__callboard-tools__create_canvas")).toEqual({
      server: "callboard-tools",
      tool: "create_canvas",
    });
  });

  it("parses Codex/OR-bridge MCP names (server__tool)", () => {
    expect(parseToolName("callboard-tools__render_file")).toEqual({
      server: "callboard-tools",
      tool: "render_file",
    });
  });

  it("keeps the full remainder as the tool when it contains further separators", () => {
    expect(parseToolName("mcp__plugin_file-search_file-search__semantic_search")).toEqual({
      server: "plugin_file-search_file-search",
      tool: "semantic_search",
    });
  });

  it("passes through bare names", () => {
    expect(parseToolName("Bash")).toEqual({ tool: "Bash" });
    expect(parseToolName("read_file")).toEqual({ tool: "read_file" });
  });
});

describe("getToolDisplayName", () => {
  it("collapses MCP names to the bare tool", () => {
    expect(getToolDisplayName("mcp__callboard-tools__set_chat_title")).toBe("set_chat_title");
    expect(getToolDisplayName("callboard-tools__notify_user")).toBe("notify_user");
  });

  it("renders native names verbatim", () => {
    expect(getToolDisplayName("Bash")).toBe("Bash");
    expect(getToolDisplayName("spawn_subagent")).toBe("spawn_subagent");
  });
});

describe("isCallboardTool", () => {
  it("matches all three provider conventions", () => {
    expect(isCallboardTool("mcp__callboard-tools__render_file", "render_file")).toBe(true); // Claude
    expect(isCallboardTool("callboard-tools__render_file", "render_file")).toBe(true); // Codex
    expect(isCallboardTool("render_file", "render_file")).toBe(true); // OpenRouter (bare)
  });

  it("rejects other servers and other tools", () => {
    expect(isCallboardTool("mcp__other-server__render_file", "render_file")).toBe(false);
    expect(isCallboardTool("mcp__callboard-tools__create_canvas", "render_file")).toBe(false);
  });
});

describe("getToolSummary — Claude Code tools (existing behavior preserved)", () => {
  it("summarizes Read/Write/Edit by basename", () => {
    expect(getToolSummary("Read", j({ file_path: "/a/b/package.json" }))).toBe(" - package.json");
    expect(getToolSummary("Write", j({ file_path: "/x/config.ts" }))).toBe(" - config.ts");
    expect(getToolSummary("Edit", j({ file_path: "/x/main.ts", old_string: "a", new_string: "b" }))).toBe(" - main.ts");
  });

  it("truncates Bash commands at 40 chars", () => {
    const cmd = "npm install --save react react-dom react-router-dom";
    expect(getToolSummary("Bash", j({ command: cmd }))).toBe(` - ${cmd.substring(0, 40)}...`);
    expect(getToolSummary("Bash", j({ command: "ls" }))).toBe(" - ls");
  });

  it("summarizes Grep/Glob patterns and WebFetch hostname", () => {
    expect(getToolSummary("Grep", j({ pattern: "export function" }))).toBe(" - 'export function'");
    expect(getToolSummary("Glob", j({ pattern: "**/*.ts" }))).toBe(" - **/*.ts");
    expect(getToolSummary("WebFetch", j({ url: "https://github.com/foo" }))).toBe(" - github.com");
  });

  it("summarizes WebSearch queries (Claude + Codex)", () => {
    expect(getToolSummary("WebSearch", j({ query: "latest node LTS" }))).toBe(" - 'latest node LTS'");
  });

  it("summarizes callboard MCP tools via the mcp__ prefix", () => {
    expect(getToolSummary("mcp__callboard-tools__create_canvas", j({ name: "Wireframe" }))).toBe(" - Wireframe");
    expect(getToolSummary("mcp__callboard-tools__update_canvas", j({ canvas_id: "cv_123" }))).toBe(" - cv_123");
    expect(getToolSummary("mcp__callboard-tools__render_file", j({ file_path: "/tmp/demo.html" }))).toBe(" - demo.html");
  });

  it("handles OpenRouter server tools with lost input", () => {
    expect(getToolSummary("web_search", j({}))).toBe(" - web search");
    expect(getToolSummary("web_search", j({ query: "latest node" }))).toBe(" - 'latest node'");
    expect(getToolSummary("datetime", j({}))).toBe(" - current date/time");
    expect(getToolSummary("web_fetch", j({ url: "https://x.dev/a" }))).toBe(" - x.dev");
  });

  it("returns empty string on malformed JSON or non-object input", () => {
    expect(getToolSummary("Bash", "not json")).toBe("");
    expect(getToolSummary("Bash", j("just a string"))).toBe("");
    expect(getToolSummary("Bash", j(null))).toBe("");
  });
});

describe("getToolSummary — OpenRouter harness tools", () => {
  it("summarizes file tools by path basename", () => {
    expect(getToolSummary("read_file", j({ path: "/a/b/index.ts" }))).toBe(" - index.ts");
    expect(getToolSummary("write_file", j({ path: "out.md", content: "x" }))).toBe(" - out.md");
    expect(getToolSummary("edit_file", j({ path: "/src/app.ts", old_string: "a", new_string: "b" }))).toBe(" - app.ts");
    expect(getToolSummary("edit_notebook", j({ path: "/nb/analysis.ipynb" }))).toBe(" - analysis.ipynb");
  });

  it("summarizes bash/monitor commands", () => {
    expect(getToolSummary("bash", j({ command: "npm test" }))).toBe(" - npm test");
    expect(getToolSummary("monitor", j({ command: "tail -f app.log" }))).toBe(" - tail -f app.log");
  });

  it("summarizes search/navigation tools", () => {
    expect(getToolSummary("grep_files", j({ pattern: "TODO", path: "." }))).toBe(" - 'TODO'");
    expect(getToolSummary("glob", j({ pattern: "src/**/*.test.ts" }))).toBe(" - src/**/*.test.ts");
    expect(getToolSummary("list_directory", j({ path: "src/components" }))).toBe(" - src/components");
  });

  it("summarizes subagents and tasks", () => {
    expect(getToolSummary("spawn_subagent", j({ description: "Review the diff" }))).toBe(" - Review the diff");
    expect(getToolSummary("spawn_subagents", j({ subagents: [{}, {}, {}] }))).toBe(" - 3 subagents");
    expect(getToolSummary("task_create", j({ content: "Run tests" }))).toBe(" - Run tests");
    expect(getToolSummary("task_update", j({ taskId: "1", state: "completed" }))).toBe(" - completed");
  });

  it("summarizes skill/tool_search/tool_load/ask_user_question", () => {
    expect(getToolSummary("skill", j({ name: "deep-research:investigate" }))).toBe(" - deep-research:investigate");
    expect(getToolSummary("tool_search", j({ query: "slack send" }))).toBe(" - 'slack send'");
    expect(getToolSummary("tool_load", j({ names: ["srv__a", "srv__b"] }))).toBe(" - srv__a, srv__b");
    expect(getToolSummary("ask_user_question", j({ question: "Deploy to prod?" }))).toBe(" - Deploy to prod?");
  });

  it("summarizes bare-named callboard tools (OR in-process bridge)", () => {
    expect(getToolSummary("create_canvas", j({ name: "Dashboard" }))).toBe(" - Dashboard");
    expect(getToolSummary("render_file", j({ file_path: "/tmp/chart.png" }))).toBe(" - chart.png");
  });
});

describe("getToolSummary — Codex tools", () => {
  it("summarizes Edit change-lists (single change)", () => {
    expect(getToolSummary("Edit", j({ changes: [{ path: "/a/hello.txt", kind: "add" }] }))).toBe(" - hello.txt");
  });

  it("summarizes Edit change-lists (multiple changes)", () => {
    const changes = [
      { path: "/a/hello.txt", kind: "add" },
      { path: "/b/world.txt", kind: "update" },
      { path: "/c/gone.txt", kind: "delete" },
    ];
    expect(getToolSummary("Edit", j({ changes }))).toBe(" - hello.txt +2 more");
  });

  it("returns empty for an Edit change-list with no usable paths", () => {
    expect(getToolSummary("Edit", j({ changes: [] }))).toBe("");
  });

  it("summarizes Codex MCP names (server__tool)", () => {
    expect(getToolSummary("callboard-tools__create_canvas", j({ name: "Sketch" }))).toBe(" - Sketch");
    expect(getToolSummary("callboard-tools__read_canvas", j({ canvas_id: "cv_9" }))).toBe(" - cv_9");
  });
});

describe("getToolSummary — ACP vendor tools", () => {
  // OpenCode names its tools in lowercase and its inputs in camelCase, so they
  // reach the fallback rather than a dedicated case. Without `filePath` in the
  // path probe every file operation rendered as a bare "read" / "write" with no
  // indication of which file — the tool card told you nothing.
  it("names the file for OpenCode's camelCase file tools", () => {
    expect(getToolSummary("read", j({ filePath: "/repo/backend/src/index.ts" }))).toBe(" - index.ts");
    expect(getToolSummary("write", j({ filePath: "/repo/notes.md", content: "hi" }))).toBe(" - notes.md");
    expect(getToolSummary("edit", j({ filePath: "/repo/a.ts", oldString: "x", newString: "y" }))).toBe(" - a.ts");
  });

  it("describes a subagent call by what it was sent to do", () => {
    // The one tool with nothing to show while it runs: OpenCode reports no
    // update at all until the subagent finishes, so the description is the only
    // thing the card can say for its whole (often minutes-long) lifetime.
    expect(getToolSummary("task", j({ description: "Explore repo structure", subagent_type: "explore", prompt: "Explore..." }))).toBe(
      " - Explore repo structure",
    );
  });

  it("keeps working for the vendor tools that already matched", () => {
    expect(getToolSummary("bash", j({ command: "npm test" }))).toBe(" - npm test");
    expect(getToolSummary("glob", j({ pattern: "**/*.ts" }))).toBe(" - **/*.ts");
    expect(getToolSummary("grep", j({ pattern: "TODO" }))).toBe(" - 'TODO'");
    expect(getToolSummary("webfetch", j({ url: "https://example.com/docs" }))).toBe(" - example.com");
  });
});

describe("getToolSummary — generic fallback for unknown tools", () => {
  it("probes common fields in priority order", () => {
    expect(getToolSummary("some_unknown_tool", j({ path: "/x/y/z.rs" }))).toBe(" - z.rs");
    expect(getToolSummary("some_unknown_tool", j({ url: "https://api.example.com/v1" }))).toBe(" - api.example.com");
    expect(getToolSummary("some_unknown_tool", j({ query: "find me" }))).toBe(" - 'find me'");
    expect(getToolSummary("some_unknown_tool", j({ command: "make build" }))).toBe(" - make build");
    expect(getToolSummary("some_unknown_tool", j({ name: "thing" }))).toBe(" - thing");
    expect(getToolSummary("mcp__callboard-tools__set_chat_title", j({ title: "My chat" }))).toBe(" - My chat");
  });

  it("returns empty when nothing is recognizable", () => {
    expect(getToolSummary("some_unknown_tool", j({ flag: true, count: 3 }))).toBe("");
  });
});
