import { afterEach, expect, it, vi } from "vitest";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
vi.mock("./computer-use.js", async (original) => ({
  ...(await original<typeof import("./computer-use.js")>()),
  getComputerUseHost: vi.fn(),
}));
import { ComputerUseHost, getComputerUseHost, type ActionConfirmationRequest, type ConfirmAgentAction } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { beginComputerUseTurn, buildComputerUseToolsSpec, closeComputerUseConnections } from "./computer-use-tools.js";

let host: ComputerUseHost | undefined;
afterEach(async () => {
  await closeComputerUseConnections();
  await host?.dispose();
  host = undefined;
});

/** A stand-in human the test answers for, one question at a time. */
function human() {
  const queue: { request: ActionConfirmationRequest; answer: (outcome: { approved: boolean; reason: "human" | "denied" }) => void }[] = [];
  const waiters: (() => void)[] = [];
  const confirm: ConfirmAgentAction = (request) =>
    new Promise((resolve) => {
      queue.push({ request, answer: resolve });
      waiters.splice(0).forEach((wake) => wake());
    });
  const asked = async (index: number) => {
    while (queue.length <= index) await new Promise<void>((resolve) => waiters.push(resolve));
    return queue[index].request;
  };
  return { confirm, asked, approve: (index = 0) => queue[index].answer({ approved: true, reason: "human" }), deny: (index = 0) => queue[index].answer({ approved: false, reason: "denied" }) };
}

const textOf = (result: { content: { type: string }[] }) => {
  const block = result.content.find((item) => item.type === "text") as { text: string } | undefined;
  return block ? JSON.parse(block.text) : undefined;
};

it("an ask chat's real host MCP hop blocks on the human, executes only what they confirmed, and fences a revoked grant", async () => {
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
  const person = human();
  host = new ComputerUseHost(
    service,
    { browser: driver, desktop: { ...driver, kind: "native-desktop" } },
    () => ({ policy: readComputerUsePolicy({ computerControl: "ask", webAccess: "allow" }), signature: "scope" }),
    person.confirm,
  );
  vi.mocked(getComputerUseHost).mockResolvedValue(host);
  const controller = new AbortController();
  const end = beginComputerUseTurn(() => "chat", controller.signal);
  const spec = buildComputerUseToolsSpec(() => "chat");
  const tool = (name: string) => spec.tools.find((item) => item.name === name)!;
  const opened = (await host.approve("chat", (await host.open("chat", "browser")).id)) as { id: string; generation: number };
  const ref = { sessionId: opened.id, generation: opened.generation };
  const pixels = await tool("cu_observe").handler(ref);
  expect(pixels.content).toContainEqual({ type: "image", data: "AA==", mimeType: "image/png" });
  const frameId = JSON.parse((pixels.content[0] as { text: string }).text).frameId;

  // ── The call blocks; nothing reaches the driver until the human answers ──
  const requested = tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2 } });
  const question = await person.asked(0);
  expect(question.summary).toMatch(/^Click at \(1, 2\) in the managed browser on \S+$/);
  expect(act).not.toHaveBeenCalled();
  // A second concurrent request is refused, not queued behind the first.
  expect(textOf(await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 3, y: 4 } }))).toMatchObject({ error: "queue_full" });
  person.approve(0);
  const result = await requested;
  expect(result.isError).toBeUndefined();
  expect(act).toHaveBeenCalledOnce();

  // ── A refusal comes back as a refusal, and never runs ──
  const nextFrame = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;
  const refused = tool("cu_action").handler({ ...ref, frameId: nextFrame, action: { type: "navigate", url: "https://example.com" } });
  await person.asked(1);
  person.deny(1);
  expect(textOf(await refused)).toMatchObject({ error: "denied", message: expect.stringContaining("NOT performed") });
  expect(act).toHaveBeenCalledOnce();

  // ── A target change between the human's yes and the driver's act is not a success ──
  const currentId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  authorizeAction = async () => {
    enter();
    await gate;
  };
  const delayed = tool("cu_action").handler({ ...ref, frameId: currentId, action: { type: "click", x: 5, y: 6 } });
  await person.asked(2);
  person.approve(2);
  await entered;
  targetChanged!(); // Changes after the human's yes, while the MCP service awaits policy.
  release();
  expect(textOf(await delayed)).toMatchObject({ error: "driver_error" });
  expect(act).toHaveBeenCalledOnce();

  authorizeAction = undefined;
  await host.revoke("chat", opened.id);
  expect((await tool("cu_observe").handler(ref)).isError).toBe(true);
  end();
});

it("an allow chat's MCP hop reaches the driver with nobody asked", async () => {
  const act = vi.fn(async () => {});
  const driver: Driver = {
    kind: "browser",
    probe: async () => ({ kind: "browser", available: true, capabilities: ["screenshot"] }),
    open: async () => ({
      act,
      close: async () => {},
      releaseInput: async () => {},
      observe: async () => ({ data: "AA==", mimeType: "image/png", width: 100, height: 100, capturedAt: Date.now() }),
    }),
  };
  const service = new ComputerUseService({
    targets: [{ id: "managed-browser", enabled: true, driver }],
    authorize: (request) => host?.authorize(request) ?? "deny",
  });
  // The confirmation double would say yes if it were reached; the point is that
  // it is not, so a reintroduced prompt fails here as a call rather than a hang.
  const confirm = vi.fn<ConfirmAgentAction>(async () => ({ approved: true, reason: "human" }));
  host = new ComputerUseHost(
    service,
    { browser: driver, desktop: { ...driver, kind: "native-desktop" } },
    () => ({ policy: readComputerUsePolicy({ computerControl: "allow", webAccess: "allow" }), signature: "scope" }),
    confirm,
  );
  vi.mocked(getComputerUseHost).mockResolvedValue(host);
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  const spec = buildComputerUseToolsSpec(() => "chat");
  const tool = (name: string) => spec.tools.find((item) => item.name === name)!;
  const opened = await host.open("chat", "browser");
  const ref = { sessionId: opened.id, generation: opened.generation };
  const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;

  const result = await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2 } });

  expect(result.isError).toBeUndefined();
  expect(act).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
  end();
});

it("an idle facade cannot call the service, even if a model supplies a session identifier", async () => {
  const tool = buildComputerUseToolsSpec(() => "idle").tools.find((item) => item.name === "cu_observe")!;
  const result = await tool.handler({ sessionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", generation: 1 });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("No active authorized chat turn") }]);
});
