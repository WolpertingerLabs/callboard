// @vitest-environment jsdom
/**
 * New chats under a space: the panel files the chat into the active space
 * (changeable with the chip), seeds itself from the space's own defaults and
 * recent folders, and writes the choices back to the space.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { SpaceListItem } from "shared/types/space.js";
import { updateSpace } from "../api";
import { SpaceContext, type SpaceContextValue } from "../contexts/SpaceContext";
import NewChatPanel from "./NewChatPanel";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  updateSpace: vi.fn(async () => ({})),
}));

const SPACES: SpaceListItem[] = [
  { id: "default", name: "General", order: 0, chatCount: 0, createdAt: "", updatedAt: "" },
  {
    id: "sp_work",
    name: "Work",
    order: 1,
    chatCount: 0,
    createdAt: "",
    updatedAt: "",
    defaults: { recentDirectories: [{ path: "/work/repo", lastUsed: "2026-01-01" }] },
  },
];

const capture: { landed: { pathname: string; state: any } | null } = { landed: null };
function Landing() {
  const location = useLocation();
  useEffect(() => {
    capture.landed = { pathname: location.pathname + location.search, state: location.state };
  }, [location]);
  return null;
}

function renderPanel(activeSpaceId: string) {
  const ctx: SpaceContextValue = {
    enabled: true,
    spaces: SPACES,
    activeSpaceId,
    activeSpace: SPACES.find((s) => s.id === activeSpaceId),
    setActiveSpace: () => {},
    refreshSpaces: async () => {},
    spaceById: (id) => SPACES.find((s) => s.id === id),
    notice: null,
    dismissNotice: () => {},
  };
  render(
    <MemoryRouter>
      <SpaceContext.Provider value={ctx}>
        <Routes>
          <Route path="/" element={<NewChatPanel onClose={() => {}} />} />
          <Route path="/chat/new" element={<Landing />} />
        </Routes>
      </SpaceContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  capture.landed = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("NewChatPanel in a space", () => {
  it("offers the space's own recent folders and files the chat into it", async () => {
    renderPanel("sp_work");
    expect((screen.getByLabelText("Space for the new chat") as HTMLSelectElement).value).toBe("sp_work");
    fireEvent.click(await screen.findByTitle("/work/repo"));
    await waitFor(() => expect(capture.landed?.pathname).toBe("/chat/new?folder=%2Fwork%2Frepo"));
    expect(capture.landed?.state.spaceId).toBe("sp_work");
    expect(updateSpace).toHaveBeenCalledWith("sp_work", { defaults: expect.objectContaining({ provider: expect.any(String) }) });
  });

  it("lets the chip send the chat somewhere else", async () => {
    renderPanel("sp_work");
    fireEvent.change(screen.getByLabelText("Space for the new chat"), { target: { value: "default" } });
    fireEvent.change(screen.getByPlaceholderText(/Project folder path/), { target: { value: "/elsewhere" } });
    fireEvent.click(screen.getByRole("button", { name: /^(Create|Start|Go|Open)/ }));
    await waitFor(() => expect(capture.landed?.state.spaceId).toBe("default"));
  });

  it("picks General, not 'all', when the tab is in the All view", () => {
    renderPanel("all");
    expect((screen.getByLabelText("Space for the new chat") as HTMLSelectElement).value).toBe("default");
  });
});
