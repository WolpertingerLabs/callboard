// @vitest-environment jsdom
/**
 * The board under a space: the request is scoped with cross-space Needs-you
 * on, and a blocked card from another space carries a chip naming its space.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CardSummary } from "../api";
import { listCards } from "../api";
import type { SpaceListItem } from "shared/types/space.js";
import { SpaceContext } from "../contexts/SpaceContext";
import { makeSpaceContext } from "../testing/spaceContext";
import Board from "./Board";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listCards: vi.fn(),
  bulkSetCardLifecycle: vi.fn(),
  updateCard: vi.fn(),
}));
vi.mock("../contexts/SessionContext", () => ({ useMetadataVersion: () => 0 }));

const SPACES: SpaceListItem[] = [
  { id: "default", name: "General", order: 0, chatCount: 0, createdAt: "", updatedAt: "" },
  { id: "sp_work", name: "Work", emoji: "💼", order: 1, chatCount: 0, createdAt: "", updatedAt: "" },
];

function card(id: string, spaceId: string, rollup: CardSummary["rollup"]): CardSummary {
  return {
    id,
    spaceId,
    title: id,
    description: "",
    emoji: "🗂",
    lifecycle: "open",
    pinned: false,
    rollup,
    lastActivityAt: "2026-01-01T00:00:00Z",
    chatCount: 1,
    unread: false,
    memberChats: [],
    memberRuns: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Board in a space", () => {
  it("asks for the active space plus other spaces' blocked cards, and chips the foreign ones", async () => {
    vi.mocked(listCards).mockResolvedValue({ cards: [card("own card", "sp_work", "idle"), card("general blocked", "default", "needs_you")] });
    const ctx = makeSpaceContext(SPACES, { activeSpaceId: "sp_work" });
    render(
      <MemoryRouter>
        <SpaceContext.Provider value={ctx}>
          <Board />
        </SpaceContext.Provider>
      </MemoryRouter>,
    );
    await screen.findByText("general blocked");
    expect(listCards).toHaveBeenCalledWith(false, expect.anything(), { space: "sp_work", crossSpaceNeedsYou: true });
    await waitFor(() => expect(screen.getAllByTestId("space-chip").map((c) => c.textContent)).toEqual(["General"]));
  });
});
