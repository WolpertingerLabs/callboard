// @vitest-environment jsdom
/**
 * A single row's "Delete", when the server refuses it.
 *
 * The confirm dialog closes the moment the user confirms, so a rejected delete
 * used to leave nothing behind but the row it was about — which is exactly how
 * a read-only native Codex child looked: "delete does nothing". The failure
 * now lands in the sidebar's failure banner, worded with the server's
 * explanation rather than its error code, and stays until dismissed — a later
 * successful delete does not clear it, since a bulk message it might be
 * sharing the banner with would still be true.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Chat, ChatListResponse } from "../api";
import { deleteChat, listChats, listCards, getDrafts } from "../api";
import ChatList from "./ChatList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(),
  deleteChat: vi.fn(),
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
const mockDelete = vi.mocked(deleteChat);

const FOLDER = "/home/cybil/projects/callboard";
const NOTE = "Native Codex child: read-only in Callboard. Ask its parent Codex thread to close it.";

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

async function renderList() {
  const view = render(
    <MemoryRouter>
      <ChatList onRefresh={() => {}} />
    </MemoryRouter>,
  );
  await screen.findByText("Ramanujan");
  return view;
}

/** The row element ChatListItem renders as its root — see ChatList.editTitle.test.tsx. */
function rowOf(title: string): HTMLElement {
  return screen.getByText(title).parentElement!.parentElement!.parentElement!;
}

/** Row kebab → "Delete" → the dialog's own Delete button. */
async function deleteViaMenu(title = "Ramanujan") {
  fireEvent.mouseEnter(rowOf(title));
  fireEvent.click(screen.getByTitle("Chat actions"));
  fireEvent.click(screen.getByText("Delete"));
  expect(screen.getByText("Delete Chat")).toBeTruthy();
  const confirm = screen.getAllByRole("button", { name: "Delete" }).at(-1)!;
  await act(async () => {
    fireEvent.click(confirm);
  });
}

beforeEach(() => {
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  vi.mocked(getDrafts).mockResolvedValue([]);
  mockListChats.mockResolvedValue(listResponse([makeChat("child", { title: "Ramanujan", preview: "native child" })]));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatList single delete failure", () => {
  it("closes the dialog and says why the delete was refused, in the server's words", async () => {
    mockDelete.mockRejectedValue(new Error(NOTE));
    await renderList();

    await deleteViaMenu();

    expect(mockDelete).toHaveBeenCalledWith("child");
    expect(screen.queryByText("Delete Chat")).toBeNull();
    const banner = await screen.findByRole("alert");
    // Named the way the confirm dialog named it: by preview, the row's own
    // fallback label (see handleDelete), not the title.
    expect(banner.textContent).toContain('"native child" could not be deleted');
    expect(banner.textContent).toContain(NOTE);
    // The list is still refetched, so a row the server did remove after all
    // (or one that vanished meanwhile) is not left behind.
    expect(mockListChats).toHaveBeenCalledTimes(2);
  });

  it("can be dismissed, since a single delete has no selection to exit", async () => {
    mockDelete.mockRejectedValue(new Error(NOTE));
    await renderList();
    await deleteViaMenu();
    await screen.findByRole("alert");

    fireEvent.click(screen.getByLabelText("Dismiss"));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows nothing when the delete succeeds", async () => {
    mockDelete.mockResolvedValue(undefined);
    await renderList();

    await deleteViaMenu();

    expect(screen.queryByText("Delete Chat")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mockListChats).toHaveBeenCalledTimes(2);
  });
});
