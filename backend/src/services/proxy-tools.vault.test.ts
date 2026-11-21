/**
 * The vault tools forward to drawlatch under drawlatch's own tool names and
 * render results the way drawlatch's MCP server does (`forwardVaultTool`):
 * strings verbatim, objects as JSON, and errors as `Error: <message>` with
 * `isError` set so the model sees a failed call rather than a result.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallResult } from "../agents/ports/tools.js";

const callTool = vi.fn<(name: string, input?: Record<string, unknown>) => Promise<unknown>>();
let proxyAvailable = true;
vi.mock("./proxy-singleton.js", () => ({ getProxy: () => (proxyAvailable ? { callTool } : null) }));

const { buildProxyToolsSpec } = await import("./proxy-tools.js");

const VAULT_TOOLS = [
  "vault_list",
  "vault_create",
  "vault_update",
  "vault_delete",
  "vault_get",
  "vault_request_access",
  "vault_list_requests",
  "vault_cancel_request",
];

function tool(name: string) {
  const def = buildProxyToolsSpec("alias").tools.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def.handler as (input: Record<string, unknown>) => Promise<ToolCallResult>;
}

/** The text of a result's first (only) content block. */
function text(res: ToolCallResult): string {
  const block = res.content[0];
  if (block.type !== "text") throw new Error(`expected a text block, got ${block.type}`);
  return block.text;
}

beforeEach(() => {
  callTool.mockReset();
  proxyAvailable = true;
});

describe("vault proxy tools", () => {
  it("are all advertised", () => {
    const names = buildProxyToolsSpec("alias").tools.map((t) => t.name);
    for (const name of VAULT_TOOLS) expect(names).toContain(name);
  });

  it("forward under drawlatch's tool name with the input unchanged", async () => {
    callTool.mockResolvedValue({ ok: true });
    const input = { name: "gh", kind: "token", values: { value: "s3cret" }, connections: ["github"] };
    await tool("vault_create")(input);
    expect(callTool).toHaveBeenCalledWith("vault_create", input);

    await tool("vault_cancel_request")({ requestId: "r1" });
    expect(callTool).toHaveBeenLastCalledWith("vault_cancel_request", { requestId: "r1" });
  });

  it("vault_list omits an absent tag, like drawlatch", async () => {
    callTool.mockResolvedValue({ items: [] });
    await tool("vault_list")({});
    expect(callTool).toHaveBeenLastCalledWith("vault_list", {});
    await tool("vault_list")({ tag: "ci" });
    expect(callTool).toHaveBeenLastCalledWith("vault_list", { tag: "ci" });
  });

  it("renders objects as JSON and strings verbatim", async () => {
    callTool.mockResolvedValueOnce({ items: [{ name: "gh" }] });
    const obj = await tool("vault_list")({});
    expect(JSON.parse(text(obj))).toEqual({ items: [{ name: "gh" }] });
    expect(obj.isError).toBeUndefined();

    callTool.mockResolvedValueOnce("deleted");
    const str = await tool("vault_delete")({ name: "gh" });
    expect(text(str)).toBe("deleted");
  });

  it("reports a daemon error as an error result", async () => {
    callTool.mockRejectedValue(new Error("item is inject-only"));
    const res = await tool("vault_get")({ name: "gh" });
    expect(res).toEqual({ content: [{ type: "text", text: "Error: item is inject-only" }], isError: true });
  });

  it("reports a missing proxy as an error result", async () => {
    proxyAvailable = false;
    const res = await tool("vault_list_requests")({});
    expect(res.isError).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });
});
