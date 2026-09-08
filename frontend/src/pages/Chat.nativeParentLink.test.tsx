/**
 * The "Open parent thread" link on a native Codex child. It must take the
 * router (no full reload) to the parent's *chat* id — explicit parentage
 * first, then the parent the daemon inferred from the rollout, and the raw
 * thread id only when neither exists.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Chat from "./Chat";
import { getChat } from "../api";

const fixture = vi.hoisted(() => ({ metadata: "{}" }));
vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: "Native child", folder: "/tmp", is_git_repo: true, metadata: id === "child" ? fixture.metadata : "{}" })),
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
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => null, useMetadataVersion: () => 0 }));
vi.mock("../components/PromptInput", () => ({ default: ({ disabled }: { disabled: boolean }) => <textarea aria-label="Composer" disabled={disabled} /> }));
vi.mock("../components/ChatTreeIndicator", () => ({ default: () => null }));
vi.mock("../components/GitDiffView", () => ({ default: () => <div>Git diff view</div> }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => <div>Debug view</div> }));

const native = (extra: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) =>
  JSON.stringify({
    provider: "codex",
    ...meta,
    nativeAgent: { parentThreadId: "0000-thread", lifecycle: "complete", management: "read-only", controlNote: "Ask the parent.", ...extra },
  });

const mount = () =>
  render(
    <MemoryRouter initialEntries={["/chat/child"]}>
      <Routes>
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  for (const name of ["IntersectionObserver", "ResizeObserver"])
    vi.stubGlobal(
      name,
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
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["explicit parentage", native({ inferredParentChatId: "inferred-chat" }, { parentChatId: "explicit-chat" }), "explicit-chat"],
  ["the daemon's inferred parent", native({ inferredParentChatId: "inferred-chat" }), "inferred-chat"],
  ["the raw thread id as a last resort", native(), "0000-thread"],
])("links to %s", async (_label, metadata, expected) => {
  fixture.metadata = metadata;
  mount();
  const link = await screen.findByRole("link", { name: "Open parent thread" });
  expect(link.getAttribute("href")).toBe(`/chat/${expected}`);
});

it("navigates through the router instead of reloading the page", async () => {
  fixture.metadata = native({ inferredParentChatId: "inferred-chat" });
  mount();
  const link = await screen.findByRole("link", { name: "Open parent thread" });
  await act(async () => {
    fireEvent.click(link);
  });
  await waitFor(() => expect(getChat).toHaveBeenCalledWith("inferred-chat"));
  // The parent is an ordinary chat: the banner is gone and the composer is live.
  await waitFor(() => expect(screen.queryByRole("link", { name: "Open parent thread" })).toBeNull());
  expect((screen.getByLabelText("Composer") as HTMLTextAreaElement).disabled).toBe(false);
});
