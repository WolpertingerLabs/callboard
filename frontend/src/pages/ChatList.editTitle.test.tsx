// @vitest-environment jsdom
/**
 * The sidebar's "Edit title" action, tested from the page because the page is
 * where the dialog is mounted and where the row it renames lives.
 *
 * What is worth pinning here is the split between the two ways a title
 * changes, which share one dialog but not one contract:
 *
 *  - typing is *pending*. The menu entry writes nothing, and neither does a
 *    keystroke; only Save does, and Cancel throws the edit away;
 *  - regenerating is *immediate*. The route re-derives, persists and notifies
 *    in one call, so the new title is live before it reaches the field — which
 *    is why it patches the row on arrival rather than waiting for Save, and why
 *    Cancel afterwards cannot take it back; and
 *  - the row is patched in place either way, because the row is what the user
 *    is looking at and a refetch is up to 15s away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, ChatListResponse } from "../api";
import { listChats, listCards, getDrafts, regenerateChatTitle, setChatTitle } from "../api";
import ChatList from "./ChatList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(),
  regenerateChatTitle: vi.fn(),
  setChatTitle: vi.fn(),
}));

vi.mock("../contexts/SessionContext", () => ({
  useSessionContext: () => ({
    activeSessions: new Map(),
    connected: true,
    metadataVersion: 0,
    summonedChatIds: new Set<string>(),
  }),
}));

// Both fetch on mount; neither is what these tests are about.
vi.mock("../components/SidebarHeader", () => ({ default: () => <div /> }));
vi.mock("../components/NewChatPanel", () => ({ default: () => <div /> }));

const mockListChats = vi.mocked(listChats);
const mockRegenerate = vi.mocked(regenerateChatTitle);
const mockSetTitle = vi.mocked(setChatTitle);

const FOLDER = "/home/cybil/projects/callboard";

function makeChat(id: string, meta: Record<string, unknown> = {}): Chat {
  return {
    id,
    folder: FOLDER,
    displayFolder: FOLDER,
    session_id: `sess-${id}`,
    session_log_path: null,
    metadata: JSON.stringify(meta),
    created_at: "2026-08-20T10:00:00.000Z",
    updated_at: "2026-08-20T11:00:00.000Z",
  } as Chat;
}

function listResponse(chats: Chat[]): ChatListResponse {
  return { chats, hasMore: false, total: chats.length, windowRows: chats.length, stale: false };
}

/** A request whose resolution the test controls, so "in flight" is a real state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderList() {
  const view = render(
    <MemoryRouter>
      <ChatList onRefresh={() => {}} />
    </MemoryRouter>,
  );
  await screen.findByText("Old Title");
  return view;
}

/**
 * The row element ChatListItem renders as its root — the one carrying the hover
 * handler that reveals the kebab. Walked up from the title rather than taken
 * from the container, because a row folded into a lineage group is nested one
 * level deeper than a lone one.
 */
function rowOf(title: string): HTMLElement {
  return screen.getByText(title).parentElement!.parentElement!.parentElement!;
}

function openEditor(title = "Old Title") {
  fireEvent.mouseEnter(rowOf(title));
  fireEvent.click(screen.getByTitle("Chat actions"));
  fireEvent.click(screen.getByText("Edit title"));
}

const titleField = () => screen.getByLabelText("Title") as HTMLInputElement;
const saveButton = () => screen.getByText("Save").closest("button")!;

beforeEach(() => {
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  vi.mocked(getDrafts).mockResolvedValue([]);
  mockListChats.mockResolvedValue(listResponse([makeChat("chat-1", { title: "Old Title", preview: "add a dark mode toggle" })]));
  mockRegenerate.mockResolvedValue({ title: "A Much Better Title" });
  mockSetTitle.mockImplementation((_id, title) => Promise.resolve({ title: title.trim() || null }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatList edit title", () => {
  it("opens the editor seeded with the current title and writes nothing", async () => {
    await renderList();
    openEditor();

    expect(screen.getByText("Edit Title")).toBeTruthy();
    expect(titleField().value).toBe("Old Title");
    // The row's own fallback, offered as the placeholder so an emptied field
    // shows what clearing the title actually gets you.
    expect(titleField().placeholder).toBe("add a dark mode toggle");
    expect(mockSetTitle).not.toHaveBeenCalled();
    expect(mockRegenerate).not.toHaveBeenCalled();
  });

  it("saves what the user typed and shows it on the row", async () => {
    await renderList();
    openEditor();

    fireEvent.change(titleField(), { target: { value: "Dark mode toggle" } });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(mockSetTitle).toHaveBeenCalledWith("chat-1", "Dark mode toggle");
    await screen.findByText("Dark mode toggle");
    // Closed on success — the edit is done.
    expect(screen.queryByText("Edit Title")).toBeNull();
    // One list fetch, the mount's: the handler patches the row rather than
    // refetching. In production the route's `notifyMetadata` also bumps
    // `metadataVersion` into a `load()`, which the SessionContext mock above
    // freezes at 0, so this assertion cannot see it.
    expect(mockListChats).toHaveBeenCalledTimes(1);
  });

  it("keeps Save inert until the title actually changes", async () => {
    await renderList();
    openEditor();

    expect(saveButton().hasAttribute("disabled")).toBe(true);

    fireEvent.change(titleField(), { target: { value: "Old Title  " } });
    // Whitespace is not an edit — the route would trim it back to the same
    // string and spend a write, a notify and a cache clear saying nothing.
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    fireEvent.change(titleField(), { target: { value: "Something else" } });
    expect(saveButton().hasAttribute("disabled")).toBe(false);
  });

  it("clears the title when the field is emptied, falling the row back to its preview", async () => {
    await renderList();
    openEditor();

    fireEvent.change(titleField(), { target: { value: "" } });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(mockSetTitle).toHaveBeenCalledWith("chat-1", "");
    // Not a blank row: the chat goes back to being labelled by its opening
    // message, which is what it looked like before it was ever titled.
    await screen.findByText("add a dark mode toggle");
  });

  it("discards the edit when the dialog is cancelled", async () => {
    await renderList();
    openEditor();

    fireEvent.change(titleField(), { target: { value: "Never saved" } });
    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.queryByText("Edit Title")).toBeNull();
    expect(mockSetTitle).not.toHaveBeenCalled();
    expect(screen.getByText("Old Title")).toBeTruthy();
  });

  it("regenerates into the field, and the row with it", async () => {
    await renderList();
    openEditor();

    await act(async () => {
      fireEvent.click(screen.getByText("Regenerate"));
    });

    expect(mockRegenerate).toHaveBeenCalledWith("chat-1");
    // The route has already persisted and notified, so the field is showing a
    // title that is live — hence the row changes now, not on Save.
    expect(titleField().value).toBe("A Much Better Title");
    await screen.findByText("A Much Better Title");
    // The dialog stays open so the generated words can be edited.
    expect(screen.getByText("Edit Title")).toBeTruthy();
    expect(mockSetTitle).not.toHaveBeenCalled();
  });

  it("locks the dialog while a regeneration is in flight", async () => {
    const pending = deferred<{ title: string }>();
    mockRegenerate.mockReturnValue(pending.promise);

    await renderList();
    openEditor();
    await act(async () => {
      fireEvent.click(screen.getByText("Regenerate"));
    });

    const button = screen.getByText("Regenerating…").closest("button")!;
    expect(button.hasAttribute("disabled")).toBe(true);
    // A second click cannot start a second model call — the point of the lock.
    fireEvent.click(button);
    expect(mockRegenerate).toHaveBeenCalledTimes(1);
    // And nothing can be saved on top of a title that is still arriving.
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    await act(async () => {
      pending.resolve({ title: "A Much Better Title" });
    });
    await screen.findByText("A Much Better Title");
  });

  it("keeps the dialog open and says why when a save fails", async () => {
    mockSetTitle.mockRejectedValue(new Error("Chat not found"));

    await renderList();
    openEditor();
    fireEvent.change(titleField(), { target: { value: "Doomed" } });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    // Inline, in the dialog the user will retry from — and still open, so the
    // typed title is not lost to a failed request.
    await waitFor(() => expect(screen.getByText("Chat not found")).toBeTruthy());
    expect(titleField().value).toBe("Doomed");
    expect(saveButton().hasAttribute("disabled")).toBe(false);
  });

  it("reports why a regeneration failed rather than swallowing it", async () => {
    // The route distinguishes its failures in prose (422 no readable
    // conversation, 400 retired harness, 502 nothing generated) and `assertOk`
    // carries that through as the Error message. Swallowed, a 422 is
    // indistinguishable from a regeneration that picked the same title: the
    // user clicks, waits, and the field never changes.
    mockRegenerate.mockRejectedValue(new Error("This chat has no readable conversation to title"));

    await renderList();
    openEditor();
    await act(async () => {
      fireEvent.click(screen.getByText("Regenerate"));
    });

    await waitFor(() => expect(screen.getByText("This chat has no readable conversation to title")).toBeTruthy());
    // Released, not wedged: the button is offered again rather than staying
    // disabled for the life of the dialog.
    expect(screen.getByText("Regenerate").closest("button")!.hasAttribute("disabled")).toBe(false);
    expect(titleField().value).toBe("Old Title");
  });
});
