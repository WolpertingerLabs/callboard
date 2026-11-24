/**
 * The agent's view of Sandbox desktop deliverables: cu_stop waits for the
 * final copy and lists what was delivered with its host path, cu_status lists
 * the chat's deliverables, and no file name ever reaches the ride-along
 * notice channel (whose templates are fixed).
 */
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";

const DATA = mkdtempSync(join(tmpdir(), "cb-cu-deliveries-"));
process.env.CALLBOARD_DATA_DIR = DATA;
vi.mock("./computer-use.js", async (original) => ({
  ...(await original<typeof import("./computer-use.js")>()),
  getComputerUseHost: vi.fn(),
}));
const { ComputerUseHost, getComputerUseHost, withOutboxSync } = await import("./computer-use.js");
const { readComputerUsePolicy } = await import("./computer-use-policy.js");
const { getPendingRequest, respondToPermission, clearOpenApprovalsForTest } = await import("./pending-requests.js");
const { sessionRegistry } = await import("./session-registry.js");
const { beginComputerUseTurn, buildComputerUseToolsSpec, closeComputerUseConnections } = await import("./computer-use-tools.js");
const { chatDeliveryOwner, getSandboxDeliveries } = await import("./sandbox-desktop.js");

const CHAT = "deliveries-tools-chat";
let host: InstanceType<typeof ComputerUseHost> | undefined;
afterEach(async () => {
  await closeComputerUseConnections();
  await host?.dispose();
  host = undefined;
  sessionRegistry.unregister(CHAT);
  clearOpenApprovalsForTest();
});
afterAll(() => rmSync(DATA, { recursive: true, force: true }));
const texts = (result: { content: { type: string }[] }) =>
  result.content.filter((item) => item.type === "text").map((item) => JSON.parse((item as unknown as { text: string }).text));

it("cu_stop lists the files delivered from ~/outbox with their host paths; cu_status lists the chat's; notices never name them", async () => {
  sessionRegistry.register(CHAT, { type: "web", emitter: new EventEmitter(), abortController: new AbortController() });
  const outbox = new Map<string, Buffer>();
  const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const base = (kind: "browser" | "native-desktop", lockDomain?: string): Driver => ({
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
  const endpoint = Object.assign(base("native-desktop", "deliveries-tools:sandbox"), {
    endpoint: "127.0.0.1:7801",
    identity: async () => ({ instanceId: "11111111-1111-4111-8111-111111111111" }),
    openedInstance: () => "11111111-1111-4111-8111-111111111111",
    listOutbox: async () => [...outbox].map(([name, data]) => ({ name, size: data.length, sha256: digest(data), mtimeMs: Date.now() })),
    downloadOutboxFile: async (name: string) => {
      const data = outbox.get(name)!;
      return { name, size: data.length, sha256: digest(data), data };
    },
  });
  const sandbox = withOutboxSync(endpoint, getSandboxDeliveries(), chatDeliveryOwner);
  const drivers = { browser: base("browser"), desktop: base("native-desktop", "deliveries-tools:desktop"), sandbox };
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
    () => ({ policy: readComputerUsePolicy({ sandboxControl: "allow" }), signature: "scope" }),
    undefined,
    (_chatId, text) => notices.push(text),
  );
  vi.mocked(getComputerUseHost).mockResolvedValue(host);
  const end = beginComputerUseTurn(() => CHAT, new AbortController().signal);
  try {
    const spec = buildComputerUseToolsSpec(
      () => CHAT,
      () => ({ mode: "endpoint" }),
    );
    const tool = (name: string) => spec.tools.find((item) => item.name === name)!;
    // The agent is told the outbox convention.
    expect(tool("cu_status").description).toMatch(/~\/outbox\/\.NAME\.part, then rename/);
    await tool("cu_request_control").handler({ kind: "sandbox", reason: "Make the report" });
    await respondToPermission(CHAT, true, undefined, undefined, getPendingRequest(CHAT)?.requestId).completion;
    const [session] = texts(await tool("cu_open").handler({ kind: "sandbox" }))[0].sessions;

    outbox.set("quarterly-report.pdf", Buffer.from("%PDF-1.7 the report"));
    const stopped = texts(await tool("cu_stop").handler({ sessionId: session.id }))[0];
    expect(stopped.sandboxDeliveries).toMatchObject({
      state: "complete",
      deliveredFiles: [{ name: "quarterly-report.pdf", size: 19, sha256: digest(Buffer.from("%PDF-1.7 the report")), path: expect.stringContaining(DATA) }],
    });
    const path = stopped.sandboxDeliveries.deliveredFiles[0].path as string;
    expect(readFileSync(path, "utf8")).toBe("%PDF-1.7 the report");

    const status = texts(await tool("cu_status").handler({}));
    expect(status.at(-1)).toMatchObject({
      sandboxDeliveries: { deliveredFiles: [expect.objectContaining({ name: "quarterly-report.pdf", path, sessionId: session.id })] },
    });

    // The ride-along channel carries only its fixed templates.
    expect(notices.join("\n")).not.toContain("quarterly-report");
  } finally {
    end();
  }
});
