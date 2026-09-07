/**
 * `resolveServerPaths` — the hop that turns a plugin's `.mcp.json` entry into a
 * spawnable stdio command.
 *
 * ## Why this file exists
 *
 * The original implementation ran `command` and `args` through one resolver.
 * That is right for args (always paths) and wrong for `command`, which is
 * usually a program NAME. A real plugin on disk declares:
 *
 *     { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"] }
 *
 * `node` contains no `${CLAUDE_PLUGIN_ROOT}` and is not absolute, so it was
 * rewritten to `<plugin-dir>/node` — a file that does not exist — and the server
 * died with `ENOENT: posix_spawn`. Every `.mcp.json` using a bare interpreter
 * (node, npx, python3, uvx, bun, deno) broke the same way, which is most of them.
 *
 * The rule these tests pin is execvp(3)'s own: a command containing a path
 * separator is a path and gets resolved; a bare name is a PATH lookup and must
 * pass through byte-for-byte. `bareCommandRegressionCase` is the exact config
 * that was failing in production.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServerConfig } from "shared/types/appPlugins.js";

const { resolveServerPaths, isCommandLaunchable } = await import("./claude.js");

const PLUGIN_DIR = "/home/someone/file-search";

/** Build a stdio server config the way `parseMcpJsonFile` does. */
function server(overrides: Partial<McpServerConfig>): McpServerConfig {
  return {
    id: "srv-1",
    name: "file-search",
    sourcePluginId: "plugin-1",
    enabled: true,
    type: "stdio",
    mcpJsonDir: PLUGIN_DIR,
    ...overrides,
  };
}

describe("resolveServerPaths — command is a program name, args are paths", () => {
  it("leaves a bare interpreter alone so PATH lookup still works", () => {
    // The regression. Before the fix this returned "/home/someone/file-search/node".
    const { command, args } = resolveServerPaths(
      server({ command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"] }),
      PLUGIN_DIR,
    );
    expect(command).toBe("node");
    expect(args).toEqual([`${PLUGIN_DIR}/dist/server.js`]);
  });

  it.each(["npx", "python3", "uvx", "bun", "deno"])("leaves bare %s alone", (bin) => {
    const { command } = resolveServerPaths(server({ command: bin, args: [] }), PLUGIN_DIR);
    expect(command).toBe(bin);
  });

  it("resolves npx args against the plugin dir while npx itself passes through", () => {
    const { command, args } = resolveServerPaths(
      server({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "./data"] }),
      PLUGIN_DIR,
    );
    expect(command).toBe("npx");
    // The flag and the package spec cannot be relative paths, so they survive
    // as written; only the path-shaped arg is anchored. Before the fix this
    // produced "<plugin>/-y" and "<plugin>/@modelcontextprotocol/...".
    expect(args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", `${PLUGIN_DIR}/data`]);
  });

  it("leaves a URL arg alone", () => {
    const { args } = resolveServerPaths(
      server({ command: "node", args: ["./server.js", "--endpoint", "https://example.com/mcp"] }),
      PLUGIN_DIR,
    );
    expect(args).toEqual([`${PLUGIN_DIR}/server.js`, "--endpoint", "https://example.com/mcp"]);
  });

  it("still anchors a bare relative path arg", () => {
    // No leading ./ — this is the case that keeps working as it always did.
    const { args } = resolveServerPaths(server({ command: "node", args: ["dist/server.js"] }), PLUGIN_DIR);
    expect(args).toEqual([`${PLUGIN_DIR}/dist/server.js`]);
  });

  it("resolves an explicitly relative command against the base dir", () => {
    const { command } = resolveServerPaths(server({ command: "./bin/server.js", args: [] }), PLUGIN_DIR);
    expect(command).toBe(`${PLUGIN_DIR}/bin/server.js`);
  });

  it("resolves a parent-relative command", () => {
    const { command } = resolveServerPaths(server({ command: "../shared/server.js", args: [] }), PLUGIN_DIR);
    expect(command).toBe("/home/someone/shared/server.js");
  });

  it("resolves a bare-but-separated command as a path, matching execvp", () => {
    // "bin/server.js" is never a PATH lookup in a shell either.
    const { command } = resolveServerPaths(server({ command: "bin/server.js", args: [] }), PLUGIN_DIR);
    expect(command).toBe(`${PLUGIN_DIR}/bin/server.js`);
  });

  it("leaves an already-absolute command untouched", () => {
    const { command } = resolveServerPaths(server({ command: "/usr/local/bin/node", args: [] }), PLUGIN_DIR);
    expect(command).toBe("/usr/local/bin/node");
  });

  it("expands ${CLAUDE_PLUGIN_ROOT} inside a command", () => {
    const { command } = resolveServerPaths(
      server({ command: "${CLAUDE_PLUGIN_ROOT}/bin/server", args: [] }),
      PLUGIN_DIR,
    );
    expect(command).toBe(`${PLUGIN_DIR}/bin/server`);
  });

  it("expands ${CLAUDE_PLUGIN_ROOT} to the plugin root, not the .mcp.json dir", () => {
    // The two differ when .mcp.json is nested. ${CLAUDE_PLUGIN_ROOT} means the
    // plugin root by definition; bare relative paths stay relative to the file.
    const { command, args } = resolveServerPaths(
      server({
        mcpJsonDir: `${PLUGIN_DIR}/config`,
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/dist/server.js", "./local.json"],
      }),
      PLUGIN_DIR,
    );
    expect(command).toBe("node");
    expect(args).toEqual([`${PLUGIN_DIR}/dist/server.js`, `${PLUGIN_DIR}/config/local.json`]);
  });

  it("falls back to mcpJsonDir when the plugin path is unknown", () => {
    const { args } = resolveServerPaths(server({ command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"] }), undefined);
    expect(args).toEqual([`${PLUGIN_DIR}/dist/server.js`]);
  });

  it("passes everything through when there is no base directory at all", () => {
    const { command, args } = resolveServerPaths(
      server({ mcpJsonDir: undefined, command: "node", args: ["./dist/server.js"] }),
      undefined,
    );
    expect(command).toBe("node");
    expect(args).toEqual(["./dist/server.js"]);
  });

  it("leaves a server with no command untouched", () => {
    const { command, args } = resolveServerPaths(server({ command: undefined, args: undefined }), PLUGIN_DIR);
    expect(command).toBeUndefined();
    expect(args).toBeUndefined();
  });
});

describe("isCommandLaunchable — the preflight behind the warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "callboard-mcp-launchable-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const exe = join(binDir, "my-server");
  writeFileSync(exe, "#!/bin/sh\n");
  chmodSync(exe, 0o755);
  const notExe = join(dir, "plain.txt");
  writeFileSync(notExe, "hello");

  it("finds a bare name on PATH", () => {
    expect(isCommandLaunchable("my-server", { PATH: binDir })).toBe(true);
  });

  it("rejects a bare name that is not on PATH", () => {
    expect(isCommandLaunchable("definitely-not-a-real-binary", { PATH: binDir })).toBe(false);
  });

  it("accepts an executable absolute path", () => {
    expect(isCommandLaunchable(exe, {})).toBe(true);
  });

  it("rejects the mangled-path shape that started all this", () => {
    // What the old resolver produced for `"command": "node"`.
    expect(isCommandLaunchable(join(dir, "node"), { PATH: binDir })).toBe(false);
  });

  it("rejects a path that exists but is not executable", () => {
    expect(isCommandLaunchable(notExe, {})).toBe(false);
  });

  it("rejects a directory", () => {
    expect(isCommandLaunchable(binDir, {})).toBe(false);
  });
});
