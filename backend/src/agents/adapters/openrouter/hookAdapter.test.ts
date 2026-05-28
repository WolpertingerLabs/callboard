/**
 * Unit tests for plugin hook dispatch. Uses inline {@link LoadedPlugin} records
 * (the dispatcher only reads `.root` + `.hookConfigs`) and real bash command
 * execution so the stdin→stdout→decision path is tested end-to-end.
 */
import { describe, expect, it } from "vitest";
import type { HookPayload, LoadedPlugin } from "@cybourgeoisie/openrouter-agent-coder";
import { buildOpenRouterHookDispatcher, composeOnHook } from "./hookAdapter.js";

/** Build a minimal LoadedPlugin carrying just a hooks map. */
function pluginWithHooks(name: string, hooks: Record<string, unknown>): LoadedPlugin {
  return {
    manifest: { name },
    root: `/tmp/${name}`,
    dataDir: `/tmp/${name}/data`,
    skillRoots: [],
    commandRoots: [],
    agentRoots: [],
    hookConfigs: [{ pluginName: name, source: `/tmp/${name}/hooks/hooks.json`, hooks }],
    mcpServers: [],
  };
}

const baseCtx = { getSessionId: () => "sess-1", cwd: "/tmp/work" };

const preToolUse = (toolName: string): HookPayload => ({
  event: "PreToolUse",
  toolName,
  input: { a: 1 },
  callId: "c1",
});

describe("buildOpenRouterHookDispatcher", () => {
  it("returns undefined when no plugin contributes command hooks", () => {
    expect(buildOpenRouterHookDispatcher([], baseCtx)).toBeUndefined();
    expect(
      buildOpenRouterHookDispatcher([pluginWithHooks("p", {})], baseCtx),
    ).toBeUndefined();
  });

  it("blocks a PreToolUse call when a matching hook emits a deny decision", async () => {
    const dispatcher = buildOpenRouterHookDispatcher(
      [
        pluginWithHooks("p", {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: `echo '{"decision":"block","reason":"no bash allowed"}'`,
                },
              ],
            },
          ],
        }),
      ],
      baseCtx,
    )!;
    const action = await dispatcher("PreToolUse", preToolUse("Bash"));
    expect(action).toEqual({ action: "block", reason: "no bash allowed" });
  });

  it("honors the hookSpecificOutput.permissionDecision deny shape too", async () => {
    const dispatcher = buildOpenRouterHookDispatcher(
      [
        pluginWithHooks("p", {
          PreToolUse: [
            {
              matcher: "",
              hooks: [
                {
                  type: "command",
                  command: `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"policy"}}'`,
                },
              ],
            },
          ],
        }),
      ],
      baseCtx,
    )!;
    const action = await dispatcher("PreToolUse", preToolUse("Edit"));
    expect(action).toEqual({ action: "block", reason: "policy" });
  });

  it("does not block when the matcher does not match the tool name", async () => {
    const dispatcher = buildOpenRouterHookDispatcher(
      [
        pluginWithHooks("p", {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: `echo '{"decision":"block","reason":"x"}'` }],
            },
          ],
        }),
      ],
      baseCtx,
    )!;
    const action = await dispatcher("PreToolUse", preToolUse("Read"));
    expect(action).toBeUndefined();
  });

  it("continues (no block) on a non-zero exit / broken hook", async () => {
    const dispatcher = buildOpenRouterHookDispatcher(
      [
        pluginWithHooks("p", {
          PreToolUse: [{ hooks: [{ type: "command", command: "exit 3" }] }],
        }),
      ],
      baseCtx,
    )!;
    const action = await dispatcher("PreToolUse", preToolUse("Bash"));
    expect(action).toBeUndefined();
  });

  it("runs PostToolUse hooks but never blocks (only PreToolUse short-circuits)", async () => {
    const dispatcher = buildOpenRouterHookDispatcher(
      [
        pluginWithHooks("p", {
          PostToolUse: [
            { hooks: [{ type: "command", command: `echo '{"decision":"block","reason":"late"}'` }] },
          ],
        }),
      ],
      baseCtx,
    )!;
    const payload: HookPayload = {
      event: "PostToolUse",
      toolName: "Bash",
      input: {},
      output: "ok",
      isError: false,
      callId: "c1",
    };
    const action = await dispatcher("PostToolUse", payload);
    expect(action).toBeUndefined();
  });
});

describe("composeOnHook", () => {
  it("returns the single hook when only one side is present", () => {
    const fn = async () => undefined;
    expect(composeOnHook(fn, undefined)).toBe(fn);
    expect(composeOnHook(undefined, fn)).toBe(fn);
    expect(composeOnHook(undefined, undefined)).toBeUndefined();
  });

  it("short-circuits on a dispatcher block without consulting the passthrough", async () => {
    let passthroughCalled = false;
    const dispatcher = async () => ({ action: "block" as const, reason: "stop" });
    const passthrough = async () => {
      passthroughCalled = true;
      return undefined;
    };
    const composed = composeOnHook(dispatcher, passthrough)!;
    const action = await composed("PreToolUse", preToolUse("Bash"));
    expect(action).toEqual({ action: "block", reason: "stop" });
    expect(passthroughCalled).toBe(false);
  });
});
