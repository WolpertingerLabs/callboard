import { afterEach, expect, it, vi } from "vitest";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
vi.mock("./computer-use.js", async (original) => ({
  ...(await original<typeof import("./computer-use.js")>()),
  getComputerUseHost: vi.fn(),
  peekComputerUseHost: vi.fn(),
}));
import { ComputerUseHost, getComputerUseHost, peekComputerUseHost, type RaiseHumanApproval } from "./computer-use.js";
import type { HumanApprovalRequest } from "./pending-requests.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { beginComputerUseTurn, buildComputerUseToolsSpec, closeComputerUseConnections } from "./computer-use-tools.js";

let host: ComputerUseHost | undefined;
afterEach(async () => {
  await closeComputerUseConnections();
  await host?.dispose();
  host = undefined;
});

/** A stand-in human the test answers for, one question at a time. Nothing waits on them. */
function human() {
  const queue: { request: HumanApprovalRequest; onAnswer: (approved: boolean) => unknown; open: boolean }[] = [];
  const raise: RaiseHumanApproval = vi.fn((_chatId, request, onAnswer) => {
    const entry = { request, onAnswer, open: true };
    queue.push(entry);
    return {
      requestId: `prompt-${queue.length}`,
      isOpen: () => entry.open,
      cancel: () => {
        const was = entry.open;
        entry.open = false;
        return was;
      },
    };
  });
  const answer = (index: number, approved: boolean) => {
    queue[index].open = false;
    return queue[index].onAnswer(approved);
  };
  return {
    raise,
    queue,
    approve: (index = 0) => answer(index, true),
    deny: (index = 0) => answer(index, false),
  };
}

const textOf = (result: { content: { type: string }[] }) => {
  const block = result.content.find((item) => item.type === "text") as { text: string } | undefined;
  return block ? JSON.parse(block.text) : undefined;
};

it("an ask chat's real host MCP hop returns at once, executes only what the human confirmed, and fences a revoked grant", async () => {
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
  const notices: string[] = [];
  host = new ComputerUseHost(
    service,
    { browser: driver, desktop: { ...driver, kind: "native-desktop" } },
    () => ({ policy: readComputerUsePolicy({ browserControl: "ask", computerControl: "ask", webAccess: "allow" }), signature: "scope" }),
    person.raise,
    (_chatId, text) => notices.push(text),
  );
  vi.mocked(getComputerUseHost).mockResolvedValue(host);
  const controller = new AbortController();
  const end = beginComputerUseTurn(() => "chat", controller.signal);
  const spec = buildComputerUseToolsSpec(() => "chat");
  const tool = (name: string) => spec.tools.find((item) => item.name === name)!;
  const opened = (await host.approve("chat", (await host.open("chat", "browser")).id)) as { id: string; generation: number };
  const ref = { sessionId: opened.id, generation: opened.generation };
  const observe = async () => JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId as string;
  const pixels = await tool("cu_observe").handler(ref);
  expect(pixels.content).toContainEqual({ type: "image", data: "AA==", mimeType: "image/png" });
  const frameId = JSON.parse((pixels.content[0] as { text: string }).text).frameId;

  // ── The call returns at once; nothing reaches the driver until the human answers ──
  const requested = await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2 } });
  expect(requested.isError).toBeUndefined();
  expect(textOf(requested)).toMatchObject({ status: "approval_pending", requestId: expect.any(String) });
  expect(person.queue[0].request.input.summary).toMatch(/^Click at \(1, 2\) in the managed browser on \S+$/);
  expect(act).not.toHaveBeenCalled();
  // While it waits, the agent can neither replace the card nor move the frame
  // under it: cu_action and cu_observe both answer with the waiting request.
  const firstId = textOf(requested).requestId;
  const again = await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 3, y: 4 } });
  expect(again.isError).toBeUndefined();
  expect(textOf(again)).toMatchObject({ status: "approval_pending", alreadyPending: true, requestId: firstId });
  const looked = await tool("cu_observe").handler(ref);
  expect(textOf(looked)).toMatchObject({ status: "approval_pending", alreadyPending: true, requestId: firstId });
  expect(looked.content.some((block) => block.type === "image")).toBe(false);
  expect(person.queue).toHaveLength(1);
  person.approve(0);
  await vi.waitFor(() => expect(notices).toEqual([expect.stringContaining("was performed")]));
  expect(act).toHaveBeenCalledOnce();

  // ── A refusal comes back as a refusal, and never runs ──
  await tool("cu_action").handler({ ...ref, frameId: await observe(), action: { type: "navigate", url: "https://example.com" } });
  person.deny(1);
  await vi.waitFor(() => expect(notices).toHaveLength(2));
  expect(notices[1]).toContain("NOT performed");
  expect(act).toHaveBeenCalledOnce();

  // ── A target change between the human's yes and the driver's act is not a success ──
  const currentId = await observe();
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
  await tool("cu_action").handler({ ...ref, frameId: currentId, action: { type: "click", x: 5, y: 6 } });
  person.approve(2);
  await entered;
  targetChanged!(); // Changes after the human's yes, while the service awaits policy.
  release();
  await vi.waitFor(() => expect(notices).toHaveLength(3));
  expect(notices[2]).toContain("NOT performed");
  expect(act).toHaveBeenCalledOnce();

  authorizeAction = undefined;
  await host.revoke("chat", opened.id);
  expect((await tool("cu_observe").handler(ref)).isError).toBe(true);
  end();
});

it("a run's abort — Stop or an interrupting send alike — does not withdraw open requests by itself", async () => {
  // The chat's Stop button withdraws them from the stream route; an
  // interrupting send aborts the run the same way and must not.
  const withdrawChatRequests = vi.fn();
  vi.mocked(peekComputerUseHost).mockReturnValue(Promise.resolve({ withdrawChatRequests } as unknown as ComputerUseHost));
  try {
    const aborted = new AbortController();
    const end = beginComputerUseTurn(() => "stop-chat", aborted.signal);
    aborted.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(withdrawChatRequests).not.toHaveBeenCalled();
    end();
  } finally {
    vi.mocked(peekComputerUseHost).mockReturnValue(undefined);
  }
});

it("cu_stop withdraws a pending action only when the stop happened, and names it in the result", async () => {
  const driver: Driver = {
    kind: "browser",
    probe: async () => ({ kind: "browser", available: true, capabilities: ["screenshot"] }),
    open: async () => ({
      act: async () => {},
      close: async () => {},
      releaseInput: async () => {},
      observe: async () => ({ data: "AA==", mimeType: "image/png", width: 100, height: 100, capturedAt: Date.now() }),
    }),
  };
  const service = new ComputerUseService({
    targets: [{ id: "managed-browser", enabled: true, driver }],
    authorize: (request) => host?.authorize(request) ?? "deny",
  });
  const person = human();
  host = new ComputerUseHost(
    service,
    { browser: driver, desktop: { ...driver, kind: "native-desktop" } },
    () => ({ policy: readComputerUsePolicy({ browserControl: "ask", computerControl: "ask", webAccess: "allow" }), signature: "scope" }),
    person.raise,
    () => {},
  );
  vi.mocked(getComputerUseHost).mockResolvedValue(host);
  const end = beginComputerUseTurn(() => "chat", new AbortController().signal);
  try {
    const tool = (name: string) => buildComputerUseToolsSpec(() => "chat").tools.find((item) => item.name === name)!;
    const opened = (await host.approve("chat", (await host.open("chat", "browser")).id)) as { id: string; generation: number };
    const ref = { sessionId: opened.id, generation: opened.generation };
    const frameId = JSON.parse(((await tool("cu_observe").handler(ref)).content[0] as { text: string }).text).frameId;
    const pending = textOf(await tool("cu_action").handler({ ...ref, frameId, action: { type: "click", x: 1, y: 2 } }));
    // A stop that failed (no such session) withdraws nothing.
    expect((await tool("cu_stop").handler({ sessionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" })).isError).toBe(true);
    expect(person.queue[0].open).toBe(true);
    const stopped = await tool("cu_stop").handler({ sessionId: opened.id });
    expect(stopped.isError).toBeUndefined();
    expect(textOf(stopped)).toMatchObject({ withdrawnRequestId: pending.requestId });
    expect(person.queue[0].open).toBe(false);
  } finally {
    end();
  }
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
  // The stand-in human records any question; the point is that none is raised.
  const person = human();
  host = new ComputerUseHost(
    service,
    { browser: driver, desktop: { ...driver, kind: "native-desktop" } },
    () => ({ policy: readComputerUsePolicy({ browserControl: "allow", computerControl: "allow", webAccess: "allow" }), signature: "scope" }),
    person.raise,
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
  expect(person.raise).not.toHaveBeenCalled();
  end();
});

it("an idle facade cannot call the service, even if a model supplies a session identifier", async () => {
  const tool = buildComputerUseToolsSpec(() => "idle").tools.find((item) => item.name === "cu_observe")!;
  const result = await tool.handler({ sessionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", generation: 1 });
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("No active authorized chat turn") }]);
});

it("cu_request_control returns consent_pending through the provider-neutral spec; the agent is told the enabled session later", async () => {
  const { EventEmitter } = await import("node:events");
  const { sessionRegistry } = await import("./session-registry.js");
  const { clearOpenApprovalsForTest, getPendingRequest, respondToPermission } = await import("./pending-requests.js");
  const controller = new AbortController();
  sessionRegistry.register("enable-tool-chat", { type: "web", emitter: new EventEmitter(), abortController: controller });
  const driver: Driver = {
    kind: "browser",
    probe: async () => ({ kind: "browser", available: true, capabilities: [] }),
    open: vi.fn(async () => ({
      close: async () => {},
      releaseInput: async () => {},
      act: async () => {},
      observe: async () => ({ data: "AA==", mimeType: "image/png" as const, width: 100, height: 100, capturedAt: Date.now() }),
    })),
  };
  const notices: string[] = [];
  const service = new ComputerUseService({ targets: [{ id: "managed-browser", enabled: true, driver }], authorize: (request) => host!.authorize(request) });
  host = new ComputerUseHost(
    service,
    { browser: driver, desktop: driver },
    () => ({ policy: readComputerUsePolicy({ browserControl: "allow", computerControl: "allow", webAccess: "allow" }), signature: "scope" }),
    undefined,
    (_chatId, text) => notices.push(text),
  );
  vi.mocked(getComputerUseHost).mockResolvedValue(host);
  const end = beginComputerUseTurn(() => "enable-tool-chat", controller.signal);
  try {
    const spec = buildComputerUseToolsSpec(() => "enable-tool-chat");
    const tool = spec.tools.find((tool) => tool.name === "cu_request_control")!;
    expect(textOf(await tool.handler({ kind: "browser", reason: "Read the page" }))).toMatchObject({ status: "consent_pending", kind: "browser" });
    expect(getPendingRequest("enable-tool-chat")?.humanOnly).toBe(true);
    expect(driver.open).not.toHaveBeenCalled();
    // cu_open shows the agent its own open request, never the prompt identity.
    const listed = textOf(await spec.tools.find((tool) => tool.name === "cu_open")!.handler({ kind: "browser" }));
    expect(listed).toMatchObject({ sessions: [], pendingRequests: [{ type: "enable_control", kind: "browser" }] });
    expect(JSON.stringify(listed)).not.toContain(getPendingRequest("enable-tool-chat")!.requestId!);
    end(); // The turn can end; the request does not.
    const completion = respondToPermission("enable-tool-chat", true, undefined, undefined, getPendingRequest("enable-tool-chat")?.requestId).completion;
    await expect(completion).resolves.toEqual({ ok: true });
    expect(driver.open).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([expect.stringMatching(/Session \S+ \(generation 1\) is ready and agent-controlled/)]);
    expect(textOf(await tool.handler({ kind: "browser", reason: "Again" }))).toMatchObject({ error: "cancelled" });
  } finally {
    end();
    sessionRegistry.unregister("enable-tool-chat");
    clearOpenApprovalsForTest();
  }
});

it("a replacement turn cancels an older pending enable request before provider cleanup", async () => {
  const requestControl = vi.fn(async (_chat: string, _kind: string, _reason: string, signal: AbortSignal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    signal.throwIfAborted();
  });
  vi.mocked(getComputerUseHost).mockResolvedValue({ requestControl } as unknown as ComputerUseHost);
  const endOld = beginComputerUseTurn(() => "replace-chat", new AbortController().signal);
  const tool = buildComputerUseToolsSpec(() => "replace-chat").tools.find((tool) => tool.name === "cu_request_control")!;
  const result = tool.handler({ kind: "browser", reason: "Check page" });
  await vi.waitFor(() => expect(requestControl).toHaveBeenCalled());
  const endNew = beginComputerUseTurn(() => "replace-chat", new AbortController().signal);
  expect(await result).toMatchObject({ isError: true });
  expect(requestControl.mock.calls[0][3].aborted).toBe(true);
  endOld();
  endNew();
});
