/**
 * The managed computer tools must reach `canUseTool` on Claude Code.
 *
 * `allowedTools` entries are auto-approved by the Agent SDK *before* the
 * `canUseTool` callback fires (the `[PERM-DIAG]` log history never showed an
 * `mcp__callboard-tools__*` decision while that wildcard was allow-listed). The first cut
 * of #414 pushed `mcp__computer_use__*` onto that list, which made the chat's
 * `computerControl: deny` unenforceable at this layer: the categorizer's
 * computerControl arm and `decidePermission`'s deny were dead code, and only
 * the service's own authorizer stood between a denied chat and the browser.
 *
 * This observes what `sendMessage` actually hands the provider, the same seam
 * `claude.binaryOverrides.test.ts` established: the server is registered, and
 * it is NOT allow-listed. Re-adding the push fails here and nowhere else.
 *
 * The same holds for Callboard's own servers since H-01: only their tools
 * that are ungated for every input are allow-listed, by exact name.
 */
import { afterAll, afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../agents/ports/AgentProvider.js";
import type { ToolServerSpec } from "../agents/ports/tools.js";
import type { StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-cu-gate-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-cu-gate-work-"));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");

function recordingProvider() {
  const requests: AgentQueryRequest[] = [];
  const provider: AgentProvider = {
    kind: "mock",
    query(req: AgentQueryRequest): AgentQuery {
      requests.push(req);
      let ended = false;
      const waiter: { wake: (() => void) | null } = { wake: null };
      const nudge = () => {
        const w = waiter.wake;
        waiter.wake = null;
        w?.();
      };
      const queued: AgentEvent[] = [
        { type: "session_started", sessionId: `s-${requests.length}` },
        { type: "text", content: "ok" },
        { type: "result", status: "success" },
      ];
      void (async () => {
        for await (const _message of req.prompt as AsyncIterable<unknown>) {
          // drain
        }
        ended = true;
        nudge();
      })();
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queued.length > 0) yield queued.shift()!;
            if (ended) return;
            await new Promise<void>((resolve) => {
              waiter.wake = resolve;
            });
          }
        },
        accountInfo: async () => null,
        supportedModels: async () => [],
        close: async () => {
          ended = true;
          nudge();
        },
      };
    },
    // Tag each built server with its spec name so the options can be inspected.
    buildToolServer: (spec: ToolServerSpec) => ({ mock: spec.name }),
  };
  return { provider, requests };
}

afterEach(() => setAgentProviderForTesting(null));
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

async function optionsForOneTurn() {
  const ctrl = recordingProvider();
  setAgentProviderForTesting(ctrl.provider, "claude-code");
  const emitter = await sendMessage({ prompt: "hello", folder: workDir } as never);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 15s")), 15_000);
    emitter.on("event", (e: StreamEvent) => {
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return ctrl.requests[0].options as { mcpServers?: Record<string, unknown>; allowedTools?: string[] };
}

it("registers the computer_use server without allow-listing it, so every cu_* call reaches canUseTool", async () => {
  const options = await optionsForOneTurn();
  expect(options.mcpServers?.computer_use).toEqual({ mock: "computer_use" });
  const allowed = options.allowedTools ?? [];
  expect(allowed.filter((pattern) => /computer_use/.test(pattern))).toEqual([]);
});

it("pre-approves no Callboard server by wildcard — only tools ungated for every input, by exact name", async () => {
  // A wildcard let a chat whose policy denies fileRead/webAccess run
  // save_storage_item(source_path), secure_request or vault_get without the
  // policy ever being consulted (H-01). Everything else must reach canUseTool.
  const allowed = (await optionsForOneTurn()).allowedTools ?? [];
  for (const key of ["callboard-tools", "mcp-proxy", "callboard", "job-tools", "objective-tools"]) {
    expect(allowed).not.toContain(`mcp__${key}__*`);
  }
  expect(allowed.filter((p) => p.endsWith("*"))).toEqual([]);
  expect(allowed).toContain("mcp__callboard-tools__set_chat_title");
  expect(allowed).toContain("mcp__callboard-tools__wait");
  for (const gated of [
    "save_storage_item",
    "read_session_messages",
    "write_custom_skill",
    "render_file",
    "start_chat_session",
    "create_canvas",
    "search_chats",
  ]) {
    expect(allowed).not.toContain(`mcp__callboard-tools__${gated}`);
  }
  expect(allowed).not.toContain("mcp__mcp-proxy__vault_get");
});

it.each(["callboard-tools", "mcp-proxy", "callboard", "job-tools", "objective-tools"])(
  "a plugin MCP server named %s cannot re-open a wildcard for a reserved Callboard server",
  async (name) => {
    writeFileSync(
      join(dataDir, "app-plugins.json"),
      JSON.stringify({
        scanRoots: [],
        plugins: [
          {
            id: "shadow",
            pluginPath: workDir,
            marketplacePath: workDir,
            scanRoot: workDir,
            manifest: { name: "shadow" },
            commands: [],
            enabled: true,
            mcpServers: [{ id: "shadow-cb", name, sourcePluginId: "shadow", enabled: true, type: "stdio", command: "true", args: [] }],
          },
        ],
      }),
    );
    try {
      const allowed = (await optionsForOneTurn()).allowedTools ?? [];
      expect(allowed).not.toContain(`mcp__${name}__*`);
      expect(allowed.filter((p) => p.endsWith("*"))).toEqual([]);
    } finally {
      rmSync(join(dataDir, "app-plugins.json"), { force: true });
    }
  },
);

it("a plugin MCP server named computer_use cannot re-open the allow-list bypass", async () => {
  // Enabled plugin servers are pushed as `mcp__<name>__*`; the reserved name
  // would land `mcp__computer_use__*` back on the list while the in-process
  // server replaces the plugin's under the same key.
  writeFileSync(
    join(dataDir, "app-plugins.json"),
    JSON.stringify({
      scanRoots: [],
      plugins: [
        {
          id: "shadow",
          pluginPath: workDir,
          marketplacePath: workDir,
          scanRoot: workDir,
          manifest: { name: "shadow" },
          commands: [],
          enabled: true,
          mcpServers: [{ id: "shadow-cu", name: "computer_use", sourcePluginId: "shadow", enabled: true, type: "stdio", command: "true", args: [] }],
        },
      ],
    }),
  );
  try {
    const options = await optionsForOneTurn();
    expect(options.mcpServers?.computer_use).toEqual({ mock: "computer_use" });
    expect((options.allowedTools ?? []).filter((pattern) => /computer_use/.test(pattern))).toEqual([]);
  } finally {
    rmSync(join(dataDir, "app-plugins.json"), { force: true });
  }
});

it("a third-party plugin MCP server is registered with no allow-list entry, so every call reaches canUseTool", async () => {
  writeFileSync(
    join(dataDir, "app-plugins.json"),
    JSON.stringify({
      scanRoots: [],
      plugins: [
        {
          id: "third",
          pluginPath: workDir,
          marketplacePath: workDir,
          scanRoot: workDir,
          manifest: { name: "third" },
          commands: [],
          enabled: true,
          mcpServers: [{ id: "third-gh", name: "github", sourcePluginId: "third", enabled: true, type: "stdio", command: "true", args: [] }],
        },
      ],
    }),
  );
  try {
    const options = await optionsForOneTurn();
    expect(options.mcpServers?.github).toBeDefined();
    expect((options.allowedTools ?? []).filter((p) => p.startsWith("mcp__github__"))).toEqual([]);
  } finally {
    rmSync(join(dataDir, "app-plugins.json"), { force: true });
  }
});
