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
import { SpaceContext } from "../contexts/SpaceContext";
import { makeSpaceContext } from "../testing/spaceContext";
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
  const ctx = makeSpaceContext(SPACES, { activeSpaceId, refreshSpaces: async () => {} });
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
    // Nothing was changed by hand: the space's defaults are not rewritten.
    expect(updateSpace).not.toHaveBeenCalled();
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

describe("NewChatPanel — space defaults do not leak", () => {
  const ALLOW = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", computerControl: "deny" } as const;
  const LEAKY: SpaceListItem[] = [
    { id: "default", name: "General", order: 0, chatCount: 0, createdAt: "", updatedAt: "" },
    { id: "sp_work", name: "Work", order: 1, chatCount: 0, createdAt: "", updatedAt: "", defaults: { provider: "codex", defaultPermissions: { ...ALLOW } } },
    { id: "sp_home", name: "Home", order: 2, chatCount: 0, createdAt: "", updatedAt: "" },
  ];
  const globalsOf = () => JSON.parse(localStorage.getItem("claude-code-settings") ?? "{}");

  function renderLeaky(activeSpaceId: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({ ok: true, json: async () => (String(url).includes("/system-info") ? { codexConfigured: true } : {}) })),
    );
    render(
      <MemoryRouter>
        <SpaceContext.Provider value={makeSpaceContext(LEAKY, { activeSpaceId })}>
          <Routes>
            <Route path="/" element={<NewChatPanel onClose={() => {}} />} />
            <Route path="/chat/new" element={<Landing />} />
          </Routes>
        </SpaceContext.Provider>
      </MemoryRouter>,
    );
  }
  const createIn = async (folder: string) => {
    fireEvent.change(screen.getByPlaceholderText(/Project folder path/), { target: { value: folder } });
    fireEvent.click(screen.getByRole("button", { name: /^(Create|Start|Go|Open)/ }));
    await waitFor(() => expect(capture.landed).not.toBeNull());
    return capture.landed!.state;
  };

  it("seeds from the space's own defaults", async () => {
    renderLeaky("sp_work");
    const state = await createIn("/repo");
    expect(state.provider).toBe("codex");
    expect(state.defaultPermissions).toMatchObject({ fileWrite: "allow", codeExecution: "allow" });
  });

  it("switching to a space without defaults restores the browser's values, not the first space's", async () => {
    renderLeaky("sp_work");
    fireEvent.change(screen.getByLabelText("Space for the new chat"), { target: { value: "sp_home" } });
    const state = await createIn("/repo");
    expect(state.spaceId).toBe("sp_home");
    expect(state.provider).toBe("claude-code");
    expect(state.defaultPermissions).toMatchObject({ fileWrite: "ask", codeExecution: "ask" });
    // Nothing was changed by hand, so nothing is written to Home.
    expect(updateSpace).not.toHaveBeenCalled();
  });

  it("does not write a space's seeded values into the browser-wide fallback", async () => {
    renderLeaky("sp_work");
    await createIn("/repo");
    expect(globalsOf().defaultProvider).toBeUndefined();
    expect(globalsOf().defaultPermissions).toBeUndefined();
    expect(updateSpace).not.toHaveBeenCalled();
  });

  it("writes only the fields the user changed to the space, and leaves the fallback alone", async () => {
    renderLeaky("sp_work");
    fireEvent.click(screen.getAllByRole("button", { name: "Claude" })[0]);
    await createIn("/repo");
    expect(updateSpace).toHaveBeenCalledWith("sp_work", { defaults: { provider: "claude-code", model: null } });
    expect(globalsOf().defaultProvider).toBeUndefined();
  });

  it("a first choice in a space without defaults goes to that space only, never the browser fallback", async () => {
    renderLeaky("sp_home");
    fireEvent.click(screen.getAllByRole("button", { name: "Codex" })[0]);
    await createIn("/repo");
    expect(updateSpace).toHaveBeenCalledWith("sp_home", { defaults: { provider: "codex", model: null } });
    expect(globalsOf().defaultProvider).toBeUndefined();
    expect(globalsOf().recentDirectories).toBeUndefined();
  });

  it("live repro: picking Codex in a fresh space leaves General on its old provider", async () => {
    localStorage.setItem("claude-code-settings", JSON.stringify({ defaultProvider: "claude-code" }));
    renderLeaky("sp_home");
    fireEvent.click(screen.getAllByRole("button", { name: "Codex" })[0]);
    await createIn("/repo");
    cleanup();
    capture.landed = null;
    renderLeaky("default");
    const state = await createIn("/repo");
    expect(state.spaceId).toBe("default");
    expect(state.provider).toBe("claude-code");
  });

  it("choices made in General write the browser fallback, as before spaces", async () => {
    renderLeaky("default");
    fireEvent.click(screen.getAllByRole("button", { name: "Codex" })[0]);
    await createIn("/repo");
    expect(globalsOf().defaultProvider).toBe("codex");
    expect(globalsOf().recentDirectories?.[0]?.path).toBe("/repo");
    // General has no stored defaults of its own, so nothing is PATCHed.
    expect(updateSpace).not.toHaveBeenCalled();
  });

  it("a field changed by hand survives switching the space picker; untouched ones re-seed", async () => {
    renderLeaky("sp_home");
    fireEvent.click(screen.getAllByRole("button", { name: "Codex" })[0]);
    fireEvent.change(screen.getByLabelText("Space for the new chat"), { target: { value: "sp_work" } });
    const state = await createIn("/repo");
    expect(state.provider).toBe("codex");
    // Work's permissions seeded, since the user never touched permissions.
    expect(state.defaultPermissions).toMatchObject({ fileWrite: "allow" });
    expect(updateSpace).toHaveBeenCalledWith("sp_work", { defaults: { provider: "codex", model: null } });
  });

  it("a model picked for one engine is dropped when the next space switches the engine", async () => {
    renderLeaky("sp_home");
    fireEvent.change(document.getElementById("newChatClaudeModel")!, { target: { value: "opus" } });
    // Work's default engine is Codex; the user never picked an engine.
    fireEvent.change(screen.getByLabelText("Space for the new chat"), { target: { value: "sp_work" } });
    const state = await createIn("/repo");
    expect(state.provider).toBe("codex");
    expect(state.model).toBeUndefined();
    // Nothing the user picked survived, so nothing is written to Work.
    expect(updateSpace).not.toHaveBeenCalled();
  });
});

describe("NewChatPanel — General's recent folders are the browser's", () => {
  it("ignores a server recent-folder list on General and shows the browser list", async () => {
    localStorage.setItem("claude-code-settings", JSON.stringify({ recentDirectories: [{ path: "/old/a", lastUsed: "2026-01-01" }] }));
    const spaces: SpaceListItem[] = [
      { id: "default", name: "General", order: 0, chatCount: 0, createdAt: "", updatedAt: "", defaults: { recentDirectories: [{ path: "/server/only", lastUsed: "2026-02-01" }] } },
      { id: "sp_work", name: "Work", order: 1, chatCount: 0, createdAt: "", updatedAt: "", defaults: { recentDirectories: [{ path: "/work/repo", lastUsed: "2026-01-01" }] } },
    ];
    render(
      <MemoryRouter>
        <SpaceContext.Provider value={makeSpaceContext(spaces, { activeSpaceId: "default" })}>
          <NewChatPanel onClose={() => {}} />
        </SpaceContext.Provider>
      </MemoryRouter>,
    );
    expect(await screen.findByTitle("/old/a")).toBeTruthy();
    expect(screen.queryByTitle("/server/only")).toBeNull();
    // Another space still shows its own server list.
    fireEvent.change(screen.getByLabelText("Space for the new chat"), { target: { value: "sp_work" } });
    expect(await screen.findByTitle("/work/repo")).toBeTruthy();
    expect(screen.queryByTitle("/old/a")).toBeNull();
  });
});

