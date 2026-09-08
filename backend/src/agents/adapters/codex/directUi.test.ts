import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import type { ThreadEvent } from "@openai/codex-sdk";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexToolServer, type CodexToolServerHandle } from "./toolAdapter.js";
import { collectCodexMcpServers, translateCodexOptions } from "./optionsAdapter.js";
import { parseCodexRollout } from "./sessionParser.js";
import { translateCodexEvent } from "./messageAdapter.js";
import { directUiNamespacesFromConfig } from "../../../services/codex-execution-route.js";

const handles: CodexToolServerHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const image = JSON.stringify({
  type: "render_file",
  url: "https://example.com/smoke.png",
  media_type: "image",
  mime_type: "image/png",
  display_mode: "inline",
  file_size: 0,
});
const use = (id: string, name = "render_file", namespace = "mcp__callboard_ui") => ({
  type: "response_item",
  payload: { type: "function_call", call_id: id, name, namespace, arguments: "{}" },
});
const result = (id: string, text = image) => ({
  type: "response_item",
  payload: {
    type: "function_call_output",
    call_id: id,
    output: [
      { type: "input_text", text: "Wall time: 0.0048 seconds\nOutput:" },
      { type: "input_text", text },
    ],
  },
});
function parse(records: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "cb-ui-test-"));
  dirs.push(dir);
  const file = join(dir, "rollout.jsonl");
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n"));
  return parseCodexRollout(file);
}

describe("direct UI config", () => {
  it("preserves the user's list only for a verified supporting CLI/config shape", () => {
    const agent = "codex_sdk_ts/0.153.4 (Linux)";
    expect(directUiNamespacesFromConfig("callboard-config/0.153.4 (Linux)", {})).toEqual([]);
    expect(directUiNamespacesFromConfig(agent, {})).toEqual([]);
    for (const code_mode of [true, false]) expect(directUiNamespacesFromConfig(agent, { features: { code_mode } })).toEqual([]);
    expect(directUiNamespacesFromConfig(agent, { features: { code_mode: { enabled: false, direct_only_tool_namespaces: ["custom"] } } })).toEqual(["custom"]);
    for (const version of [undefined, "codex_sdk_ts/0.152.0 (Linux)", "codex_sdk_ts/0.153.3 (Linux)", "alternate/0.153.4"])
      expect(directUiNamespacesFromConfig(version, {})).toBeUndefined();
    for (const code_mode of [null, 7, { direct_only_tool_namespaces: 3 }, { direct_only_tool_namespaces: [false] }])
      expect(directUiNamespacesFromConfig(agent, { features: { code_mode } })).toBeUndefined();
  });
  it("uses two filtered views of the same owned socket, without altering code mode or routing", () => {
    const handle = buildCodexToolServer({ name: "callboard-tools", version: "1", tools: [] });
    handles.push(handle);
    const options = {
      mcpServers: { "callboard-tools": handle },
      codex: {
        directUiNamespaces: ["custom", "mcp__callboard_ui"],
        directUiPolicy: "unconfigured" as const,
        uiAliasPresence: { "callboard-ui": false, callboard_ui: false },
      },
    };
    const translated = translateCodexOptions(options);
    const config = translated.codexOpts.config!;
    expect(config["features.code_mode.direct_only_tool_namespaces"]).toEqual(["custom", "mcp__callboard_ui"]);
    expect(config).not.toHaveProperty("features.code_mode.enabled");
    expect(translated.codexOpts.configOverrides).toContain("mcp_servers.callboard_ui.enabled=false");
    expect(translated.codexOpts.configOverrides?.some((value) => value.startsWith("mcp_servers.callboard-ui."))).toBe(false);
    const servers = collectCodexMcpServers(options.mcpServers, true);
    expect(servers.handles).toEqual([handle]);
    expect(servers.config!["callboard-ui"].args).toEqual(servers.config!["callboard-tools"].args);
    expect(servers.config!["callboard-ui"].enabled_tools).toEqual(["render_file", "create_canvas", "update_canvas"]);
    expect(servers.config!["callboard-tools"].disabled_tools).toEqual(servers.config!["callboard-ui"].enabled_tools);
    for (const enabled of [true, false]) {
      expect(
        translateCodexOptions({
          ...options,
          codex: {
            directUiNamespaces: [],
            directUiPolicy: "unconfigured",
            uiAliasPresence: { "callboard-ui": false, callboard_ui: false },
            directUiCodeModeEnabled: enabled,
          },
        }).codexOpts.config?.["features.code_mode.enabled"],
      ).toBe(enabled);
    }
    const legacy = translateCodexOptions({ ...options, codex: { useOpenRouter: true, uiAliasPresence: { "callboard-ui": false, callboard_ui: false } } });
    expect(legacy.codexOpts.config).not.toHaveProperty("features.code_mode.direct_only_tool_namespaces");
    expect(legacy.codexOpts.configOverrides).toContain("mcp_servers.callboard-ui.enabled=false");
    expect(collectCodexMcpServers(options.mcpServers).config).not.toHaveProperty("callboard-ui");
  });
  it("does not promote a third-party handle/command or let an external entry overwrite the reserved alias", () => {
    const handle = buildCodexToolServer({ name: "other", version: "1", tools: [] });
    handles.push(handle);
    const servers = collectCodexMcpServers({ "callboard-tools": handle, "callboard-ui": { command: "evil" }, callboard_ui: { command: "evil" } }, true);
    expect(servers.config).not.toHaveProperty("callboard-ui");
    expect(servers.config).not.toHaveProperty("callboard_ui");
    expect(collectCodexMcpServers({ "callboard-tools": { command: "third-party" } }, true).config).not.toHaveProperty("callboard-ui");
  });
});

describe("direct UI native history", () => {
  it("pairs mixed/parallel out-of-order output by call_id and dedupes delivery; reparse is identical", () => {
    const canvas = JSON.stringify({ type: "render_canvas", canvas_id: "smoke-canvas", version: 1, name: "Smoke canvas", content_type: "html" });
    const records = [
      result("image"),
      use("canvas", "create_canvas"),
      use("image"),
      result("canvas", canvas),
      use("image"),
      result("image"),
      use("edit", "update_canvas"),
      result("edit", canvas),
    ];
    const messages = parse(records);
    expect(messages).toHaveLength(6);
    expect(messages.filter((message) => message.type === "tool_use").map((message) => message.toolName)).toEqual([
      "callboard-ui__create_canvas",
      "callboard-ui__render_file",
      "callboard-ui__update_canvas",
    ]);
    expect(messages.filter((message) => message.type === "tool_result").map((message) => [message.toolUseId, message.content])).toEqual([
      ["image", image],
      ["canvas", canvas],
      ["edit", canvas],
    ]);
    expect(parse(records)).toEqual(messages);
  });
  it("never unwraps exec/lookalike/foreign/unpaired or ambiguous call IDs", () => {
    const records = [
      use("foreign", "render_file", "mcp__other"),
      result("foreign"),
      use("exec", "exec", "functions"),
      result("exec"),
      result("orphan"),
      use("collision"),
      use("collision", "other", "mcp__other"),
      result("collision"),
    ];
    for (const message of parse(records).filter((message) => message.type === "tool_result")) expect(message.content).toContain("Wall time:");
  });
  it("does not search for JSON in malformed or failed result envelopes", () => {
    const bad = result("bad");
    bad.payload.output[0].text = "Error: tool failed\nOutput:";
    expect(parse([use("bad"), bad])[1].content).toContain("Error:");
  });
});

it.each(["render_file", "create_canvas", "update_canvas"])("native SDK %s retains stable live pair IDs", (tool) => {
  const item = { id: "item_2", type: "mcp_tool_call" as const, server: "callboard-ui", tool, arguments: {}, status: "in_progress" as const };
  const started = translateCodexEvent({ type: "item.started", item });
  expect(started).toMatchObject({ type: "tool_use", toolName: `callboard-ui__${tool}`, callId: "item_2" });
  expect(translateCodexEvent({ type: "item.updated", item })).toEqual(started);
  expect(
    translateCodexEvent({
      type: "item.completed",
      item: { ...item, status: "completed", result: { content: [{ type: "text", text: image }], structured_content: null } },
    }),
  ).toMatchObject({ type: "tool_result", callId: "item_2", content: image, isError: false });
  expect(translateCodexEvent({ type: "item.completed", item: { ...item, status: "failed", error: { message: "failed" } } })).toMatchObject({
    type: "tool_result",
    callId: "item_2",
    isError: true,
  });
});

it("replays the sanitized real native start/resume capture in both event domains", () => {
  const rollout = new URL("./__fixtures__/direct-ui-rollout.jsonl", import.meta.url);
  const messages = parseCodexRollout(rollout.pathname);
  expect(messages.filter((message) => message.type === "tool_use").map((message) => [message.toolUseId, message.toolName])).toEqual([
    ["call-1", "callboard-ui__render_file"],
    ["call-2", "callboard-ui__create_canvas"],
    ["call-3", "exec"],
    ["call-4", "callboard-ui__update_canvas"],
  ]);
  const results = messages.filter((message) => message.type === "tool_result");
  expect(JSON.parse(results[0].content).type).toBe("render_file");
  expect(JSON.parse(results[1].content).version).toBe(1);
  expect(results[2].content).toContain("CALLBOARD_UI_IN_EXEC=false");
  expect(JSON.parse(results[3].content).version).toBe(2);
  expect(parseCodexRollout(rollout.pathname)).toEqual(messages);
  const events = JSON.parse(readFileSync(new URL("./__fixtures__/direct-ui-sdk.json", import.meta.url), "utf8")) as ThreadEvent[];
  const translated = events.map(translateCodexEvent);
  for (let i = 0; i < translated.length; i += 2) {
    expect(translated[i]).toMatchObject({ type: "tool_use" });
    expect(translated[i + 1]).toMatchObject({ type: "tool_result", isError: false, callId: (translated[i] as { callId: string }).callId });
  }
});
