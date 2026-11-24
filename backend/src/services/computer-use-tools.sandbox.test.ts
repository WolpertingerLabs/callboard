/** The agent tools and the Sandbox desktop: asked for by kind, listed by kind, and told apart from the user's desktop. */
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
vi.mock("./computer-use.js", async (original) => ({
  ...(await original<typeof import("./computer-use.js")>()),
  getComputerUseHost: vi.fn(),
}));
import { SANDBOX_DESKTOP_TEXT, sandboxDesktopText } from "shared/types/index.js";
import { ComputerUseHost, getComputerUseHost } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { clearOpenApprovalsForTest, getPendingRequest, respondToPermission } from "./pending-requests.js";
import { sessionRegistry } from "./session-registry.js";
import { beginComputerUseTurn, buildComputerUseToolsSpec, closeComputerUseConnections } from "./computer-use-tools.js";

const CHAT = "sandbox-tools-chat";
let host: ComputerUseHost | undefined;
afterEach(async () => {
  await closeComputerUseConnections();
  await host?.dispose();
  host = undefined;
  sessionRegistry.unregister(CHAT);
  clearOpenApprovalsForTest();
});

const textOf = (result: { content: { type: string }[] }) =>
  JSON.parse((result.content.find((item) => item.type === "text") as unknown as { text: string }).text);

function setup(permissions: Record<string, string>) {
  sessionRegistry.register(CHAT, { type: "web", emitter: new EventEmitter(), abortController: new AbortController() });
  const driver = (kind: "browser" | "native-desktop", lockDomain?: string): Driver => ({
    kind,
    lockDomain,
    probe: async () => ({ kind, available: true, capabilities: [] }),
    open: vi.fn(async () => ({
      close: async () => {},
      releaseInput: async () => {},
      act: async () => {},
      observe: async () => ({ data: "AA==", mimeType: "image/png" as const, width: 100, height: 100, capturedAt: Date.now() }),
    })),
  });
  const sandbox = Object.assign(driver("native-desktop", "sandbox-tools:sandbox"), {
    endpoint: "127.0.0.1:7801",
    identity: async () => ({ instanceId: "11111111-1111-4111-8111-111111111111" }),
    // As the remote driver records it; consent is checked against this after open.
    openedInstance: () => "11111111-1111-4111-8111-111111111111",
  });
  const drivers = { browser: driver("browser"), desktop: driver("native-desktop", "sandbox-tools:desktop"), sandbox };
  const service = new ComputerUseService({
    targets: [
      { id: "managed-browser", enabled: true, driver: drivers.browser },
      { id: "native-desktop", enabled: true, driver: drivers.desktop },
      { id: "sandbox-desktop", enabled: true, driver: drivers.sandbox },
    ],
    authorize: (request) => host!.authorize(request),
  });
  const notices: string[] = [];
  host = new ComputerUseHost(
    service,
    drivers,
    () => ({ policy: readComputerUsePolicy(permissions), signature: "scope" }),
    undefined,
    (_chatId, text) => notices.push(text),
  );
  vi.mocked(getComputerUseHost).mockResolvedValue(host);
  const end = beginComputerUseTurn(() => CHAT, new AbortController().signal);
  const spec = buildComputerUseToolsSpec(() => CHAT);
  const tool = (name: string) => spec.tools.find((item) => item.name === name)!;
  return { end, tool, drivers, notices };
}

it("cu_request_control asks for the sandbox by kind; cu_open and cu_status list it apart from the desktop", async () => {
  const { end, tool, drivers, notices } = setup({ sandboxControl: "allow" });
  try {
    expect(textOf(await tool("cu_request_control").handler({ kind: "sandbox", reason: "Open the downloaded attachment" }))).toMatchObject({
      status: "consent_pending",
      kind: "sandbox",
    });
    expect(getPendingRequest(CHAT)?.input).toMatchObject({ kind: "sandbox", target: "sandbox 127.0.0.1:7801" });
    expect(textOf(await tool("cu_open").handler({ kind: "sandbox" }))).toMatchObject({
      sessions: [],
      pendingRequests: [{ type: "enable_control", kind: "sandbox" }],
    });

    await expect(respondToPermission(CHAT, true, undefined, undefined, getPendingRequest(CHAT)?.requestId).completion).resolves.toEqual({ ok: true });
    expect(drivers.sandbox.open).toHaveBeenCalledOnce();
    expect(drivers.desktop.open).not.toHaveBeenCalled();
    expect(notices.at(-1)).toMatch(/sandbox desktop control enabled/);

    const sandbox = textOf(await tool("cu_open").handler({ kind: "sandbox" }));
    expect(sandbox.sessions).toEqual([expect.objectContaining({ kind: "sandbox", targetId: "sandbox-desktop", targetLabel: "sandbox 127.0.0.1:7801" })]);
    expect(textOf(await tool("cu_open").handler({ kind: "desktop" })).sessions).toEqual([]);

    // The package calls the sandbox's driver `native-desktop`; cu_status says which target it is.
    expect(textOf(await tool("cu_status").handler({}))).toEqual([
      expect.objectContaining({ targetId: "sandbox-desktop", kind: "native-desktop", targetKind: "sandbox", state: "ready" }),
    ]);
  } finally {
    end();
  }
});

it("sandboxControl alone does not let the agent ask for the user's desktop or the browser", async () => {
  const { end, tool } = setup({ sandboxControl: "ask" });
  try {
    for (const kind of ["desktop", "browser"])
      expect(textOf(await tool("cu_request_control").handler({ kind, reason: "Try it" }))).toMatchObject({ error: "denied" });
    expect(getPendingRequest(CHAT)).toBeNull();
  } finally {
    end();
  }
});

it("the tool descriptions say when to use the sandbox rather than the browser or the user's desktop (endpoint: a shared container)", () => {
  const spec = buildComputerUseToolsSpec(
    () => CHAT,
    () => ({ mode: "endpoint" }),
  );
  for (const name of ["cu_status", "cu_open", "cu_request_control"]) {
    const description = spec.tools.find((item) => item.name === name)!.description;
    expect(description).toContain(`Sandbox desktop, ${SANDBOX_DESKTOP_TEXT.what}`);
    expect(description).toContain("shared by every chat and kept until the container is restarted");
    expect(description).toMatch(/not the user's machine/);
    expect(description).toContain("any service on this machine that listens on all interfaces");
    // Not promised until containers are per session: fresh, resettable, safe for anything untrusted.
    expect(description).not.toMatch(/disposable|can be reset|anything untrusted/);
    expect(description).toMatch(/"desktop" — the user's own desktop/);
    expect(description).toContain("later sessions and other chats can see");
  }
});

it("in managed mode the descriptions say each session gets a fresh container that is removed, with the network as configured", () => {
  for (const [network, reach] of [
    ["internet", "it can reach the internet, and any service on this machine that listens on all interfaces"],
    ["none", "no internet access, but it can still reach any service on this machine that listens on all interfaces"],
  ] as const) {
    const spec = buildComputerUseToolsSpec(
      () => CHAT,
      () => ({ mode: "managed", network }),
    );
    for (const name of ["cu_status", "cu_open", "cu_request_control"]) {
      const description = spec.tools.find((item) => item.name === name)!.description;
      expect(description).toContain(`Sandbox desktop, ${sandboxDesktopText({ mode: "managed", network }).what}`);
      expect(description).toContain("starts a fresh one for each session and removes it, with everything in it, when the session ends");
      expect(description).toContain(reach);
      expect(description).toContain("no other chat ever sees it");
      expect(description).not.toContain("shared by every chat");
    }
  }
});

it("reads the mode when the tool spec is built, so a mode change reaches the next session's descriptions", () => {
  let variant: { mode: "managed" | "endpoint" } = { mode: "endpoint" };
  const describe = () =>
    buildComputerUseToolsSpec(
      () => CHAT,
      () => variant,
    ).tools.find((item) => item.name === "cu_open")!.description;
  expect(describe()).toContain("shared by every chat");
  variant = { mode: "managed" };
  expect(describe()).toContain("fresh one for each session");
});
