/**
 * The agent-facing MCP surface is blind in the same way the HTTP route was: it
 * hands the model a small error object and returns. These pin that a driver
 * fault reaches the operator's log, that a stopped turn does not, and that the
 * one failure a human is waiting on carries its cause.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";

const logs = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("../utils/logger.js", () => ({ createLogger: () => logs, default: () => logs }));
vi.mock("./computer-use.js", async (original) => ({
  ...(await original<typeof import("./computer-use.js")>()),
  getComputerUseHost: vi.fn(),
}));

import { ComputerUseHost, getComputerUseHost } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { beginComputerUseTurn, buildComputerUseToolsSpec, closeComputerUseConnections } from "./computer-use-tools.js";

let host: ComputerUseHost | undefined;
beforeEach(() => {
  logs.error.mockClear();
  logs.warn.mockClear();
  logs.debug.mockClear();
});
afterEach(async () => {
  await closeComputerUseConnections();
  await host?.dispose();
  host = undefined;
});

const frame = { data: "AA==", mimeType: "image/png" as const, width: 100, height: 100, capturedAt: Date.now() };
/** A real service and host over a stub driver: the MCP hop is what is under test. */
function harness(observe: () => Promise<typeof frame>) {
  const driver: Driver = {
    kind: "browser",
    probe: async () => ({ kind: "browser", available: true, capabilities: ["screenshot"] }),
    open: async () => ({ act: async () => {}, close: async () => {}, releaseInput: async () => {}, observe }),
  };
  const service = new ComputerUseService({
    targets: [{ id: "managed-browser", enabled: true, driver }],
    authorize: (request) => host?.authorize(request) ?? "deny",
  });
  host = new ComputerUseHost(service, { browser: driver, desktop: { ...driver, kind: "native-desktop" } }, () => ({
    policy: readComputerUsePolicy({ computerControl: "allow", webAccess: "allow" }),
    signature: "scope",
  }));
  vi.mocked(getComputerUseHost).mockResolvedValue(host);
  const spec = buildComputerUseToolsSpec(() => "chat");
  return { host: host!, tool: (name: string) => spec.tools.find((item) => item.name === name)! };
}

it("records a driver fault the model only sees as an error tool result", async () => {
  const { host: live, tool } = harness(async () => {
    throw new Error("Target page, context or browser has been closed");
  });
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await live.open("chat", "browser");

  const result = await tool("cu_observe").handler({ sessionId: opened.id, generation: opened.generation });
  end();

  expect(result.isError).toBe(true);
  expect(logs.error).toHaveBeenCalledOnce();
  expect(String(logs.error.mock.calls[0][0])).toContain(`computer_observe chat=chat session=${opened.id} code=driver_error`);
});

it("does not log a refusal from an idle facade at error level", async () => {
  const result = await buildComputerUseToolsSpec(() => "idle")
    .tools.find((item) => item.name === "cu_observe")!
    .handler({ sessionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", generation: 1 });

  expect(result.isError).toBe(true);
  expect(logs.error).not.toHaveBeenCalled();
  expect(logs.warn).not.toHaveBeenCalled();
  expect(String(logs.debug.mock.calls.at(0)?.[0])).toContain("code=cancelled");
});

it("treats a turn stopped mid-call as cancelled, not as a fault", async () => {
  // The pre-check before the MCP hop is the easy case. This is the common one:
  // the abort lands while `client.callTool` is in flight, and comes back as a
  // numeric -32001 McpError that carries no string code at all.
  const { host: live, tool } = harness(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return frame;
  });
  const controller = new AbortController();
  beginComputerUseTurn(() => "chat", controller.signal);
  const opened = await live.open("chat", "browser");

  const inflight = tool("cu_observe").handler({ sessionId: opened.id, generation: opened.generation });
  setTimeout(() => controller.abort(), 60);
  const result = await inflight;

  expect(result.isError).toBe(true);
  expect(logs.error).not.toHaveBeenCalled();
  expect(logs.warn).not.toHaveBeenCalled();
  expect(String(logs.debug.mock.calls.at(-1)?.[0])).toContain("code=cancelled");
  expect(String(logs.debug.mock.calls.at(-1)?.[0])).toContain("This operation was aborted");
});

it("gives an approved action that never happened a cause, at a level the operator sees", async () => {
  const { host: live, tool } = harness(async () => frame);
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await live.open("chat", "browser");
  const ref = { sessionId: opened.id, generation: opened.generation };
  const observed = await tool("cu_observe").handler(ref);
  const frameId = JSON.parse((observed.content[0] as { text: string }).text).frameId;

  // `cu_action`'s outer schema is a loose record, so an extra key queues an
  // approval and only fails the strict `computer_act` schema once the human
  // confirms — at which point the host relabels it a bare `driver_error`.
  const queued = await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2, bogus: 9 } });
  const approvalId = JSON.parse((queued.content[0] as { text: string }).text).approvalId;
  await expect(live.approve("chat", approvalId)).rejects.toMatchObject({ code: "driver_error" });
  end();

  // Without the escalation this classifies as a routine `invalid_request` and
  // vanishes at the default level, leaving only the host's content-free
  // relabel — the exact blindness this change exists to remove.
  expect(logs.error).toHaveBeenCalledOnce();
  const line = String(logs.error.mock.calls[0][0]);
  expect(line).toContain(`computer_act chat=chat session=${opened.id} code=invalid_request`);
  expect(line).toContain("Unrecognized key");
  expect(line).toContain("bogus");
  expect(line.split("\n")[0]).toContain("bogus"); // multi-line SDK text folded onto our line
});
