import { afterEach, expect, it, vi } from "vitest";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
vi.mock("./computer-use.js", async (original) => ({
  ...(await original<typeof import("./computer-use.js")>()),
  getComputerUseHost: vi.fn(),
}));
import { ComputerUseHost, getComputerUseHost } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { beginComputerUseTurn, buildComputerUseToolsSpec, closeComputerUseConnections } from "./computer-use-tools.js";

let host: ComputerUseHost | undefined;
afterEach(async () => {
  await closeComputerUseConnections();
  await host?.dispose();
  host = undefined;
});

it("the real host MCP hop returns pixels and executes only the human-approved action, then fences a revoked grant", async () => {
  const act = vi.fn(async () => {});
  let targetChanged: (() => void) | undefined;
  let authorizeAction: (() => Promise<void>) | undefined = undefined;
  const driver: Driver = {
    kind: "browser",
    probe: async () => ({ kind: "browser", available: true, capabilities: ["screenshot"] }),
    open: async (context) => {
      targetChanged = context.onTargetChanged;
      return {
        act,
        close: async () => {},
        releaseInput: async () => {},
        observe: async () => ({ data: "AA==", mimeType: "image/png", width: 100, height: 100, capturedAt: Date.now() }),
      };
    },
  };
  const service = new ComputerUseService({
    targets: [{ id: "managed-browser", enabled: true, driver }],
    authorize: async (request) => {
      if (request.operation === "act") await authorizeAction?.();
      return host?.authorize(request) ?? "deny";
    },
  });
  host = new ComputerUseHost(service, { browser: driver, desktop: { ...driver, kind: "native-desktop" } }, () => ({
    policy: readComputerUsePolicy({ computerControl: "allow", webAccess: "allow" }),
    signature: "scope",
  }));
  vi.mocked(getComputerUseHost).mockResolvedValue(host);
  const controller = new AbortController();
  const end = beginComputerUseTurn(() => "chat", controller.signal);
  const spec = buildComputerUseToolsSpec(() => "chat");
  const tool = (name: string) => spec.tools.find((item) => item.name === name)!;
  const opened = await host.open("chat", "browser");
  const ref = { sessionId: opened.id, generation: opened.generation };
  const pixels = await tool("cu_observe").handler(ref);
  expect(pixels.content).toContainEqual({ type: "image", data: "AA==", mimeType: "image/png" });
  const frameId = JSON.parse((pixels.content[0] as { text: string }).text).frameId;
  const requested = await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2 } });
  expect(act).not.toHaveBeenCalled();
  const first = requested.content[0];
  expect(first.type).toBe("text");
  const pending = JSON.parse(first.type === "text" ? first.text : "{}");
  const queued = await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 3, y: 4 } });
  const queuedId = JSON.parse((queued.content[0] as { text: string }).text).approvalId;
  // Normal turn completion does not discard a separately scoped human approval.
  end();
  await host.approve("chat", pending.approvalId);
  expect(act).toHaveBeenCalledOnce();
  await expect(host.approve("chat", queuedId)).rejects.toMatchObject({ code: "stale_frame" });
  expect(act).toHaveBeenCalledOnce();
  const nextEnd = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const current = await tool("cu_observe").handler(ref);
  const currentId = JSON.parse((current.content[0] as { text: string }).text).frameId;
  const delayed = await tool("cu_action").handler({ ...ref, frameId: currentId, action: { type: "click", x: 5, y: 6 } });
  const delayedId = JSON.parse((delayed.content[0] as { text: string }).text).approvalId;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let checks = 0;
  authorizeAction = async () => {
    if (++checks === 2) {
      enter();
      await gate;
    }
  };
  const approved = expect(host.approve("chat", delayedId)).rejects.toMatchObject({ code: "driver_error" });
  await entered;
  targetChanged!(); // Changes after host approval, while the MCP service awaits policy.
  release();
  await approved;
  expect(act).toHaveBeenCalledOnce();
  await host.revoke("chat", opened.id);
  expect((await tool("cu_observe").handler(ref)).isError).toBe(true);
  nextEnd();
});

it("an idle facade cannot call the service, even if a model supplies a session identifier", async () => {
  const tool = buildComputerUseToolsSpec(() => "idle").tools.find((item) => item.name === "cu_observe")!;
  const result = await tool.handler({ sessionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", generation: 1 });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("No active authorized chat turn") }]);
});
