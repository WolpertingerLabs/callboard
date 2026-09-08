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

import { ComputerUseHost, getComputerUseHost, type ConfirmAgentAction } from "./computer-use.js";
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
/**
 * A real service and host over a stub driver: the MCP hop is what is under test.
 *
 * `confirm` stands in for the human at the chat prompt, and every caller states
 * its own — there is no approving default here, because a fixture that silently
 * says yes is the shape `computer-use.invariant.test.ts` exists to forbid.
 */
function harness(observe: () => Promise<typeof frame>, confirm?: ConfirmAgentAction) {
  const driver: Driver = {
    kind: "browser",
    probe: async () => ({ kind: "browser", available: true, capabilities: ["screenshot"] }),
    open: async () => ({ act: async () => {}, close: async () => {}, releaseInput: async () => {}, observe }),
  };
  const service = new ComputerUseService({
    targets: [{ id: "managed-browser", enabled: true, driver }],
    authorize: (request) => host?.authorize(request) ?? "deny",
  });
  host = new ComputerUseHost(
    service,
    { browser: driver, desktop: { ...driver, kind: "native-desktop" } },
    () => ({ policy: readComputerUsePolicy({ computerControl: "allow", webAccess: "allow" }), signature: "scope" }),
    confirm,
  );
  vi.mocked(getComputerUseHost).mockResolvedValue(host);
  const spec = buildComputerUseToolsSpec(() => "chat");
  return { host: host!, tool: (name: string) => spec.tools.find((item) => item.name === name)! };
}

/** The one call that reached the driver, or undefined. */
const errorLine = (operation: string) => logs.error.mock.calls.map((call) => String(call[0])).find((line) => line.includes(operation));

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
  // The confirmation now blocks inside `cu_action` rather than being redeemed
  // later through the panel, so the escalation no longer keys on a signal that
  // only the redemption path held. It keys on the same condition: this human
  // said yes. Stand in for them saying it.
  const { host: live, tool } = harness(
    async () => frame,
    async () => ({ approved: true, reason: "human" }),
  );
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await live.open("chat", "browser");
  const ref = { sessionId: opened.id, generation: opened.generation };
  const observed = await tool("cu_observe").handler(ref);
  const frameId = JSON.parse((observed.content[0] as { text: string }).text).frameId;

  // `cu_action`'s outer schema is a loose record, so an extra key survives the
  // prompt and only fails the strict `computer_act` schema once the human has
  // confirmed — at which point the host relabels it a bare `driver_error`.
  const result = await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2, bogus: 9 } });
  expect(result.isError).toBe(true);
  end();

  // Without the escalation this classifies as a routine `invalid_request` and
  // vanishes at the default level, leaving only the host's content-free
  // relabel — the exact blindness this change exists to remove.
  const line = errorLine("computer_act")!;
  expect(line).toBeDefined();
  expect(line).toContain(`computer_act chat=chat session=${opened.id} code=invalid_request`);
  expect(line).toContain("Unrecognized key");
  expect(line).toContain("bogus");
  expect(line.split("\n")[0]).toContain("bogus"); // multi-line SDK text folded onto our line
  // The host's own relabel still lands too, naming the tool call the human
  // confirmed. `driver_error` is not routine, so it needs no escalation.
  expect(errorLine("cu_action")).toContain("code=driver_error");
});

it("escalates the rest of the confirmed window too: the human said yes and the world moved", async () => {
  // A takeover, a scope change or a fresh capture during the human's
  // think-time throws AFTER the confirmation, before the driver is reached.
  // Those codes are routine on their own — `stale_frame` at error level is the
  // noise the level table exists to prevent — but not here, where a human
  // clicked Confirm and nothing happened. Their click already returned 200
  // from `/respond`, so this log line is the only trace anyone gets.
  // The human is at the prompt (`asked`) and has not answered yet (`decide`),
  // which is the window the world moves in.
  let asked!: () => void, decide!: () => void;
  const prompted = new Promise<void>((resolve) => {
    asked = resolve;
  });
  const deciding = new Promise<void>((resolve) => {
    decide = resolve;
  });
  const { host: live, tool } = harness(
    async () => frame,
    async () => {
      asked();
      await deciding;
      return { approved: true, reason: "human" };
    },
  );
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await live.open("chat", "browser");
  const ref = { sessionId: opened.id, generation: opened.generation };
  const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;

  const inflight = tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2 } });
  await prompted;
  await tool("cu_observe").handler(ref); // a new capture invalidates the frame they are looking at
  decide(); // …and only now do they click Confirm
  expect((await inflight).isError).toBe(true);
  end();

  expect(errorLine("cu_action")).toContain("code=stale_frame");
});

it("does not escalate a refusal, a timeout or an occupied prompt: nobody approved those", async () => {
  const { host: live, tool } = harness(
    async () => frame,
    async () => ({ approved: false, reason: "denied" }),
  );
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await live.open("chat", "browser");
  const ref = { sessionId: opened.id, generation: opened.generation };
  const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;

  expect((await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2 } })).isError).toBe(true);
  end();

  // `denied` is warn, not error: an operator should see repeated refusals
  // (a prompt-injection signal) without them masquerading as faults.
  expect(logs.error).not.toHaveBeenCalled();
  expect(String(logs.warn.mock.calls.at(-1)?.[0])).toContain("code=denied");
});

it.each([
  ["approval_timeout", { approved: false, reason: "timeout" as const }],
  ["approval_unavailable", { approved: false, reason: "no_session" as const }],
  ["approval_unavailable", { approved: false, reason: "prompt_busy" as const }],
])("logs %s at debug — the control plane working, not a fault", async (code, outcome) => {
  const { host: live, tool } = harness(async () => frame, async () => outcome);
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const opened = await live.open("chat", "browser");
  const ref = { sessionId: opened.id, generation: opened.generation };
  const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;

  expect((await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2 } })).isError).toBe(true);
  end();

  expect(logs.error).not.toHaveBeenCalled();
  expect(logs.warn).not.toHaveBeenCalled();
  expect(String(logs.debug.mock.calls.at(-1)?.[0])).toContain(`code=${code}`);
});
