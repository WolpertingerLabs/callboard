import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Chat from "./Chat";
import { computerUseClient as client } from "../api/computerUse";
import { stopChat, getPending, respondToChat } from "../api";

const fixture = vi.hoisted(() => ({ native: false, active: { type: "web" } }));
vi.mock("../api/computerUse", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/computerUse")>()),
  computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() },
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({
    id,
    title: "Computer test",
    folder: "/tmp",
    is_git_repo: true,
    metadata: fixture.native ? JSON.stringify({ nativeAgent: { parentThreadId: "parent", lifecycle: "running" } }) : "{}",
  })),
  getMessages: vi.fn(async () => []),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0 })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: [], plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
  getNewChatInfo: vi.fn(async () => ({ folder: "/tmp", slash_commands: [], plugins: [] })),
  respondToChat: vi.fn(() => new Promise(() => {})),
  stopChat: vi.fn(async () => ({ stopped: true })),
}));
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => fixture.active, useMetadataVersion: () => 0 }));
vi.mock("../components/PromptInput", () => ({ default: ({ disabled }: { disabled: boolean }) => <textarea aria-label="Composer" disabled={disabled} /> }));
vi.mock("../components/ChatTreeIndicator", () => ({ default: () => null }));
vi.mock("../components/GitDiffView", () => ({ default: () => <div>Git diff view</div> }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => <div>Debug view</div> }));
const mount = (path = "/chat/c1") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/chat/new" element={<Chat />} />
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
beforeEach(() => {
  fixture.native = false;
  vi.mocked(getPending).mockResolvedValue(null);
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
  vi.mocked(client.status).mockResolvedValue({
    permission: "allow",
    capabilities: [],
    sessions: [{ id: "s1", kind: "native", controller: null, state: "awaiting_approval", generation: 0 }],
  });
  vi.mocked(client.control).mockResolvedValue({ id: "s1", state: "stopped" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it.each([768, 900, 1024, 1200, 1920])(
  "separates desktop safety controls from navigation/actions at %s px; preserves view navigation and independent stops",
  async (width) => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    mount();
    const computer = await screen.findByRole("radio", { name: "Show computer control" });
    expect(computer.closest("header")).toBeTruthy();
    expect(computer.closest("header")!.parentElement!.classList.contains("chat-layout")).toBe(true);
    expect(computer.closest("header")!.style.display).toBe("");
    expect(screen.getByTitle("Stop generation").classList.contains("chat-header-generation-stop")).toBe(true);
    expect(within(screen.getByRole("radiogroup", { name: "View mode" })).getAllByRole("radio")).toHaveLength(4);
    expect(screen.queryByLabelText("Target")).toBeNull();
    expect(screen.queryByRole("button", { name: /▸ Browser/ })).toBeNull();
    await screen.findByText(/1 waiting/);
    const strip = screen.getByRole("button", { name: "Stop computer control" }).parentElement!;
    expect(strip.parentElement).toBe(computer.closest("header"));
    expect(strip.closest(".chat-header-actions")).toBeNull();
    expect(computer.closest(".chat-header-actions")).toBeTruthy();
    expect(strip.previousElementSibling).toBe(screen.getByTitle("Stop generation"));
    expect(screen.getAllByRole("button", { name: "Stop computer control" })).toHaveLength(1);
    expect(client.status).toHaveBeenCalledTimes(1);
    fireEvent.click(computer);
    expect(screen.getByLabelText("Target")).toBeTruthy();
    expect(screen.getByLabelText("Composer")).toBeTruthy();
    expect(screen.getByLabelText("Target").closest(".computer-use-panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Show git diff" }));
    expect(screen.getByText("Git diff view")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Show debug metrics" }));
    expect(screen.getByText("Debug view")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Show chat" }));
    expect(screen.queryByLabelText("Target")).toBeNull();
    expect(client.open).not.toHaveBeenCalled();
    expect(client.observe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle("Stop generation"));
    await waitFor(() => expect(stopChat).toHaveBeenCalledWith("c1"));
    expect(client.control).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop computer control" }));
    await waitFor(() => expect(client.control).toHaveBeenCalledWith("c1", "s1", "stop", 0));
    expect(stopChat).toHaveBeenCalledTimes(1);
  },
);
it("uses the mobile secondary view bar, with status and emergency stop visible even while overflow is closed", async () => {
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  mount();
  await screen.findByText(/1 waiting/);
  const strip = screen.getByRole("button", { name: "Stop computer control" }).parentElement!;
  expect(strip.previousElementSibling?.className).toBe("chat-header chat-header-mobile");
  expect(strip.parentElement?.className).toBe("chat-layout");
  expect(strip.className).toBe("computer-use-header");
  expect(screen.getAllByRole("button", { name: "Stop computer control" })).toHaveLength(1);
  expect(client.status).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("radiogroup")).toBeNull();
  expect(screen.getByRole("button", { name: "Stop computer control" }).closest("[hidden]")).toBeNull();
  fireEvent.click(screen.getByTitle("Show actions"));
  const computer = screen.getByRole("radio", { name: "Show computer control" });
  expect(computer.closest("header")).toBeNull();
  fireEvent.click(computer);
  expect(screen.getByLabelText("Target")).toBeTruthy();
  fireEvent.click(screen.getByTitle("Hide actions"));
  expect(screen.getByRole("button", { name: "Stop computer control" })).toBeTruthy();
  act(() => {
    Object.defineProperty(window, "innerWidth", { value: 1200 });
    window.dispatchEvent(new Event("resize"));
  });
  const desktopStop = screen.getByRole("button", { name: "Stop computer control" });
  expect(desktopStop.parentElement?.parentElement).toBe(screen.getByRole("radio", { name: "Show computer control" }).closest("header"));
  expect(screen.getAllByRole("button", { name: "Stop computer control" })).toHaveLength(1);
  // Resizing moves the presentation, not the chat-scoped controller.
  expect(client.status).toHaveBeenCalledTimes(1);
});
it.each(["native child", "new chat"])("does not offer computer controls or polling for %s", async (kind) => {
  fixture.native = kind === "native child";
  mount(kind === "new chat" ? "/chat/new?folder=/tmp" : "/chat/c1");
  await act(async () => {});
  expect(screen.queryByRole("radio", { name: "Show computer control" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Stop computer control" })).toBeNull();
  expect(client.status).not.toHaveBeenCalled();
  expect(client.open).not.toHaveBeenCalled();
  if (fixture.native) expect((screen.getByLabelText("Composer") as HTMLTextAreaElement).disabled).toBe(true);
});

it.each([390, 1200])("keeps unused chat clean at %s px while Computer view offers offline Stop discovery without enabling", async (width) => {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  vi.mocked(client.status).mockRejectedValue(new Error("offline"));
  const { container } = mount();
  await act(async () => {});
  expect(container.querySelector(".computer-use-header")).toBeNull();
  if (width === 390) fireEvent.click(screen.getByTitle("Show actions"));
  fireEvent.click(await screen.findByRole("radio", { name: "Show computer control" }));
  const reads = vi.mocked(client.status).mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Stop computer control" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop computer control" }).hasAttribute("disabled")).toBe(false));
  expect(vi.mocked(client.status).mock.calls.length).toBeGreaterThan(reads);
  expect(screen.getAllByRole("alert").some((node) => node.textContent?.includes("Retry Stop"))).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Show chat" }));
  expect(screen.getByRole("button", { name: "Stop computer control" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("Retry Stop");
  vi.mocked(client.status).mockResolvedValue({ permission: "allow", capabilities: [], sessions: [] });
  fireEvent.click(screen.getByRole("button", { name: "Stop computer control" }));
  await waitFor(() => expect(container.querySelector(".computer-use-header")).toBeNull());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(client.open).not.toHaveBeenCalled();
  expect(client.observe).not.toHaveBeenCalled();
  expect(client.control).not.toHaveBeenCalled();
  expect(client.action).not.toHaveBeenCalled();
});

it.each([390, 1200].flatMap((width) => (["checking", "deny", "ask", "allow"] as const).map((permission) => ({ width, permission }))))(
  "hides unused $permission strip at $width px without hiding Computer entry",
  async ({ width, permission }) => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    if (permission === "checking") vi.mocked(client.status).mockReturnValue(new Promise(() => {}));
    else vi.mocked(client.status).mockResolvedValue({ permission, capabilities: [], sessions: [] });
    const { container } = mount();
    await act(async () => {});
    expect(container.querySelector(".computer-use-header")).toBeNull();
    if (width === 390) fireEvent.click(screen.getByTitle("Show actions"));
    fireEvent.click(await screen.findByRole("radio", { name: "Show computer control" }));
    expect(screen.getByRole("button", { name: "Stop computer control" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Show chat" }));
    expect(container.querySelector(".computer-use-header")).toBeNull();
    expect(client.open).not.toHaveBeenCalled();
    expect(client.observe).not.toHaveBeenCalled();
    expect(client.control).not.toHaveBeenCalled();
    expect(client.action).not.toHaveBeenCalled();
  },
);

it.each([390, 1200])("keeps pending unused Stop visible after switching to Chat at %s px, until empty discovery resolves", async (width) => {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  vi.mocked(client.status).mockRejectedValue(new Error("offline"));
  const { container } = mount();
  await act(async () => {});
  if (width === 390) fireEvent.click(screen.getByTitle("Show actions"));
  fireEvent.click(await screen.findByRole("radio", { name: "Show computer control" }));
  let resolve!: (value: Awaited<ReturnType<typeof client.status>>) => void;
  vi.mocked(client.status).mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Stop computer control" }));
  fireEvent.click(screen.getByRole("radio", { name: "Show chat" }));
  expect(screen.getByRole("button", { name: "Stop computer control" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Stopping…")).toBeTruthy();
  vi.mocked(client.status).mockResolvedValue({ permission: "allow", capabilities: [], sessions: [] });
  await act(async () => resolve({ permission: "allow", capabilities: [], sessions: [] }));
  expect(container.querySelector(".computer-use-header")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(client.control).not.toHaveBeenCalled();
  expect(client.open).not.toHaveBeenCalled();
  expect(client.observe).not.toHaveBeenCalled();
});

const enablePrompt = {
  type: "permission_request",
  toolName: "mcp__computer_use__cu_request_control",
  requestId: "enable-server-id",
  humanOnly: true,
  controlRequest: true,
  input: { kind: "browser", target: "service-host", reason: "Check the page", permission: "ask" },
};
it("replays in-chat enablement after refresh, preserves composer draft and view, and retains failed approvals for retry", async () => {
  vi.mocked(getPending).mockResolvedValue(enablePrompt);
  vi.mocked(respondToChat).mockResolvedValueOnce({ ok: false, error: "This prompt changed" }).mockResolvedValueOnce({ ok: true });
  mount();
  const enable = await screen.findByRole("button", { name: "Enable browser control" });
  const composer = screen.getByLabelText("Composer") as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: "my unfinished draft" } });
  fireEvent.click(enable);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Enable browser control" })).toBeTruthy();
  expect(respondToChat).toHaveBeenCalledWith("c1", true, undefined, undefined, "enable-server-id");
  expect(screen.queryByLabelText("Target")).toBeNull();
  expect(composer.value).toBe("my unfinished draft");
  fireEvent.click(enable);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Enable browser control" })).toBeNull());
  expect(composer.value).toBe("my unfinished draft");
  expect(client.open).not.toHaveBeenCalled();
  expect(client.observe).not.toHaveBeenCalled();
});
it("network failure keeps consent visible and refresh replaces a stale card without approving it", async () => {
  vi.mocked(getPending).mockResolvedValue(enablePrompt);
  vi.mocked(respondToChat).mockRejectedValueOnce(new Error("Network offline"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Enable browser control" }));
  await screen.findByText(/Network offline/);
  vi.mocked(getPending).mockResolvedValue({ ...enablePrompt, requestId: "replacement", input: { ...enablePrompt.input, reason: "New reason" } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh pending request" }));
  await screen.findByText("New reason");
  expect(respondToChat).toHaveBeenCalledTimes(1);
});
it("SSE renders the trusted card and the actual creation failure without changing view or losing draft", async () => {
  let emit!: (event: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!String(_url).endsWith("/stream")) return { ok: true, json: async () => ({}) };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          emit = (event) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          init?.signal?.addEventListener("abort", () => {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
        },
      });
      return { ok: true, body };
    }),
  );
  mount();
  await waitFor(() => expect(emit).toBeDefined());
  const composer = screen.getByLabelText("Composer") as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: "retain this draft" } });
  act(() => emit(enablePrompt));
  await screen.findByRole("button", { name: "Enable browser control" });
  act(() =>
    emit({
      type: "message_update",
      controlRequestResult: { requestId: "enable-server-id", message: "Target is no longer available. Fix host setup before retrying." },
    }),
  );
  await screen.findByText(/Target is no longer available/);
  expect(screen.queryByRole("button", { name: "Enable browser control" })).toBeNull();
  expect(screen.queryByLabelText("Target")).toBeNull();
  expect(composer.value).toBe("retain this draft");
  expect(client.observe).not.toHaveBeenCalled();
});
