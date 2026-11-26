// @vitest-environment jsdom
/**
 * A submitted content search says so under the search box — the query, how
 * many chats it matched, and a way out. Keyed on the submitted query, not the
 * draft in the box: typing alone narrows nothing, so it shows nothing.
 */
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { resetChatTreeCollapse } from "../hooks/useChatTreeCollapse";
import type { Chat, ChatListResponse } from "../api";
import { listChats, listCards, searchChatContents } from "../api";
import ChatList from "./ChatList";
import { resetChatSectionExpansion } from "../hooks/useChatSectionExpansion";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(async () => []),
  searchChatContents: vi.fn(),
}));
vi.mock("../contexts/SessionContext", () => ({
  useSessionContext: () => ({
    activeSessions: new Map(),
    connected: true,
    metadataVersion: 0,
    summonedChatIds: new Set<string>(),
    awaitingChatIds: new Set<string>(),
  }),
}));
vi.mock("../components/SidebarHeader", () => ({ default: () => <div /> }));
vi.mock("../components/NewChatPanel", () => ({ default: () => <div /> }));

afterEach(() => {
  resetChatTreeCollapse();
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  resetChatSectionExpansion();
});

const FOLDER = "/home/cybil/projects/callboard";

/**
 * The indicator's sentence, matched on its live region as a whole: the query
 * and the count are separate spans inside it, so plain text matching would
 * see only the pieces.
 */
function indicatorText(text: string) {
  return (_: string, el: Element | null) => el?.getAttribute("role") === "status" && el.textContent === text;
}
function makeChat(id: string, preview: string): Chat {
  return {
    id,
    folder: FOLDER,
    displayFolder: FOLDER,
    session_id: `sess-${id}`,
    session_log_path: null,
    metadata: JSON.stringify({ preview }),
    created_at: "2026-08-20T10:00:00.000Z",
    updated_at: "2026-08-20T11:00:00.000Z",
  } as Chat;
}
const CHATS = [makeChat("one", "chat one"), makeChat("two", "chat two"), makeChat("three", "chat three")];
const listResponse = (chats: Chat[], hasMore = false): ChatListResponse => ({ chats, hasMore, total: CHATS.length, windowRows: chats.length, stale: false });

function renderList() {
  render(
    <MemoryRouter>
      <ChatList onRefresh={() => {}} />
    </MemoryRouter>,
  );
}
function submitSearch(query: string) {
  const search = screen.getByPlaceholderText("Search chat contents...") as HTMLInputElement;
  fireEvent.change(search, { target: { value: query } });
  fireEvent.keyDown(search, { key: "Enter" });
  return search;
}

it("shows the submitted query and its count, and Clear search restores the full list", async () => {
  vi.mocked(listChats).mockResolvedValue(listResponse(CHATS));
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  vi.mocked(searchChatContents).mockResolvedValue({ chatIds: ["two"] } as never);
  renderList();
  await screen.findByText("chat one");
  expect(screen.queryByText(/Searching for/)).toBeNull();

  const search = screen.getByPlaceholderText("Search chat contents...") as HTMLInputElement;
  // A draft alone is not a search.
  fireEvent.change(search, { target: { value: "cache" } });
  expect(screen.queryByText(/Searching for/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

  fireEvent.keyDown(search, { key: "Enter" });
  expect(await screen.findByText(indicatorText('Searching for "cache" · 1 match'))).toBeTruthy();
  expect(searchChatContents).toHaveBeenCalledWith("cache");
  expect(screen.getByText("chat two")).toBeTruthy();
  expect(screen.queryByText("chat one")).toBeNull();
  expect(screen.queryByText("chat three")).toBeNull();

  // From the keyboard: the button has focus, and the click carries no pointer.
  const clear = screen.getByRole("button", { name: "Clear search" });
  clear.focus();
  fireEvent.click(clear, { detail: 0 });
  expect(screen.queryByText(/Searching for/)).toBeNull();
  expect(search.value).toBe("");
  // Keyboard users land back in the box, not on <body>.
  expect(document.activeElement).toBe(search);
  expect(await screen.findByText("chat one")).toBeTruthy();
  expect(screen.getByText("chat two")).toBeTruthy();
  expect(screen.getByText("chat three")).toBeTruthy();
});

it("does not focus the search box after a pointer clear, so a tap does not pop the on-screen keyboard", async () => {
  vi.mocked(listChats).mockResolvedValue(listResponse(CHATS));
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  vi.mocked(searchChatContents).mockResolvedValue({ chatIds: ["two"] } as never);
  renderList();
  await screen.findByText("chat one");
  const search = submitSearch("cache");
  await screen.findByText(indicatorText('Searching for "cache" · 1 match'));
  search.blur();

  fireEvent.click(screen.getByRole("button", { name: "Clear search" }), { detail: 1 });
  expect(screen.queryByText(/Searching for/)).toBeNull();
  expect(search.value).toBe("");
  expect(document.activeElement).not.toBe(search);
});

it("never shows a count taken over the first page while the full list for the search is loading", async () => {
  // The first page has only "one"; the hits are both outside it.
  let resolveFull!: (r: ChatListResponse) => void;
  vi.mocked(listChats).mockImplementation((limit) =>
    limit === 9999 ? new Promise<ChatListResponse>((r) => (resolveFull = r)) : Promise.resolve(listResponse([CHATS[0]], true)),
  );
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  let resolveSearch!: (r: { chatIds: string[] }) => void;
  vi.mocked(searchChatContents).mockImplementation(() => new Promise((r) => (resolveSearch = r)) as never);
  renderList();
  await screen.findByText("chat one");

  const seen: string[] = [];
  const observer = new MutationObserver(() => {
    const status = screen.queryByRole("status");
    if (status?.textContent) seen.push(status.textContent);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });

  submitSearch("cache");
  // The full list is requested as soon as the query is submitted, while the search itself is still in flight.
  await vi.waitFor(() =>
    expect(listChats).toHaveBeenCalledWith(9999, 0, undefined, true, undefined, true, undefined, expect.anything(), true, undefined, true),
  );
  expect(screen.getByRole("status").textContent).toBe('Searching for "cache" · …');
  // The hits land before the full list: still pending, not "0 matches".
  await act(async () => resolveSearch({ chatIds: ["two", "three"] }));
  expect(screen.getByRole("status").textContent).toBe('Searching for "cache" · …');

  await act(async () => resolveFull(listResponse(CHATS)));
  expect(await screen.findByText(indicatorText('Searching for "cache" · 2 matches'))).toBeTruthy();
  observer.disconnect();
  expect(seen.filter((t) => !t.endsWith("…") && t !== 'Searching for "cache" · 2 matches')).toEqual([]);
});
