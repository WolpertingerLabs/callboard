// @vitest-environment jsdom
/**
 * The commands browser, in an ordinary chat.
 *
 * `handleCommandSelect = insertCommandPrompt` is a one-line alias, and it
 * changes the behaviour of a modal that every existing chat can open: picking a
 * command over a typed paragraph used to replace the paragraph, and now
 * prefixes it. That is the better trade — `/compact <paragraph>` is a thing the
 * composer already knows how to send, and the chip makes the result visible,
 * where destroying the text was silent and unrecoverable — but it was shipped
 * by two fix commits that both scoped their tests to the new-chat screen, so
 * nothing covered the surface the alias actually changed.
 *
 * This is that surface: a chat with an id, no launchpad anywhere, reached
 * through the header's own slash-command button.
 *
 * The modal's own exits are checked here for the same reason. They are
 * pre-existing gaps (a close button with no accessible name, no Escape), and
 * this PR is what makes the modal easy to reach — it added two routes into it
 * from the new-chat drawer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Chat from "./Chat";

const COMMANDS = ["compact", "clear"];

vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: "A chat", folder: "/tmp/project", is_git_repo: true, metadata: "{}" })),
  getMessages: vi.fn(async () => []),
  getPending: vi.fn(async () => null),
  getActivity: vi.fn(async () => ({ activities: [], conditionWatch: null, awaitingChildren: 0 })),
  markAsRead: vi.fn(async () => ({})),
  getSlashCommandsAndPlugins: vi.fn(async () => ({ slashCommands: COMMANDS, plugins: [] })),
  getSystemInfo: vi.fn(async () => ({})),
  getMcpTools: vi.fn(async () => ({ tools: [], servers: [] })),
  listKeywords: vi.fn(async () => ({ keywords: [] })),
  respondToChat: vi.fn(() => new Promise(() => {})),
  stopChat: vi.fn(async () => ({ stopped: true })),
}));
vi.mock("../contexts/SessionContext", () => ({ useIsSessionActive: () => null, useMetadataVersion: () => 0 }));
vi.mock("../components/ChatTreeIndicator", () => ({ default: () => null }));
vi.mock("../components/GitDiffView", () => ({ default: () => <div>Git diff view</div> }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => <div>Debug view</div> }));
vi.mock("./ChatList", () => ({ default: () => <div>chat list</div> }));

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
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" })),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function openChat() {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={["/chat/abc"]}>
        <Routes>
          <Route path="/chat/:id" element={<Chat />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await waitFor(() => expect(document.querySelector("textarea")).toBeTruthy());
}

const composer = () => document.querySelector("textarea") as HTMLTextAreaElement;

/** The header's slash icon — the only route into the browser from a chat. */
const openBrowser = () => fireEvent.click(screen.getByTitle("View available slash commands"));

describe("the commands browser in an existing chat", () => {
  it("prefixes the picked command onto the message instead of replacing it", async () => {
    await openChat();
    fireEvent.change(composer(), { target: { value: "everything above this line" } });

    openBrowser();
    fireEvent.click(await screen.findByText("/compact"));

    // A known command chips, so the textarea keeps only the argument — and the
    // argument is what the user typed, not an empty string.
    await waitFor(() => expect(composer().value).toBe("everything above this line"));
    expect(screen.getByText("/compact")).toBeTruthy();
  });

  it("still fills an empty composer, and closes behind itself", async () => {
    await openChat();

    openBrowser();
    fireEvent.click(await screen.findByText("/clear"));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Commands & Plugins" })).toBeNull());
    expect(screen.getByText("/clear")).toBeTruthy();
    expect(composer().value).toBe("");
  });

  it("gives its close button a name, and closes on Escape", async () => {
    // The button was an svg inside a bare <button>: nameless to a screen
    // reader, and Escape did nothing either, on a dialog now reachable from
    // two more places than when it was written.
    await openChat();

    openBrowser();
    expect(await screen.findByRole("button", { name: "Close" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Commands & Plugins" })).toBeNull());
  });
});
