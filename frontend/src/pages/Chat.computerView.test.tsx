import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Chat from "./Chat";
import { computerUseClient as client } from "../api/computerUse";
import { stopChat } from "../api";

const fixture = vi.hoisted(() => ({ native: false, active: { type: "web" } }));
vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
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
it("places Computer in the existing desktop topbar switcher, not above the composer; preserves Chat/Diff/Debug navigation and independent generation stop", async () => {
  mount();
  const computer = await screen.findByRole("radio", { name: "Show computer control" });
  expect(computer.closest("header")).toBeTruthy();
  expect(within(screen.getByRole("radiogroup", { name: "View mode" })).getAllByRole("radio")).toHaveLength(4);
  expect(screen.queryByLabelText("Target")).toBeNull();
  expect(screen.queryByRole("button", { name: /▸ Browser/ })).toBeNull();
  await screen.findByText(/1 waiting/);
  fireEvent.click(computer);
  expect(screen.getByLabelText("Target")).toBeTruthy();
  expect(screen.getByLabelText("Composer")).toBeTruthy();
  expect(screen.getByLabelText("Target").closest(".computer-use-dedicated")).toBeTruthy();
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
});
it("uses the mobile secondary view bar, with status and emergency stop visible even while overflow is closed", async () => {
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  mount();
  await screen.findByText(/1 waiting/);
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
  expect(screen.getByRole("radio", { name: "Show computer control" }).closest("header")).toBeTruthy();
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
