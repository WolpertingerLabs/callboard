// @vitest-environment jsdom
/**
 * The new-chat screen's two command surfaces, wired to the real composer.
 *
 * Two things only hold at this seam, so they are only testable here:
 *
 * 1. **Clicking a command must not eat the message.** Every chip on this screen
 *    called a bare *set* on the composer, so picking `release-notes` after
 *    typing 95 characters left the textarea empty — no undo, no warning. The
 *    launchpad's own doc-comment justified not sending on click on the grounds
 *    that it would "discard the message they came here to write", and then
 *    discarded it anyway. Chat.tsx now prefixes, and only Chat.tsx can: the
 *    prefix rule needs the composer's current value and the command list it
 *    parses against, and neither chip has either.
 *
 * 2. **One list, one surface.** With nothing starred the launchpad falls back
 *    to the commands grid, and the nav's Commands pill has to stand down —
 *    otherwise the same four entries render twice, four rows apart. The prop
 *    exists; this checks it is actually passed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Chat from "./Chat";
import type { ResolvedFavorites } from "../hooks/useResolvedFavorites";
import type { CustomSkillListItem } from "../api";

const SKILL: CustomSkillListItem = { name: "release-notes", description: "Write release notes", updatedAt: new Date().toISOString() };

const FOLDER = "/tmp/project";
const COMMANDS = ["compact", "clear"];

/**
 * Stubbed rather than driven through its fetches: the module-level favorites
 * cache outlives a test file, and what is under test here is the wiring
 * between Chat and its two children, not the resolve.
 */
let favorites: ResolvedFavorites;
vi.mock("../hooks/useResolvedFavorites", () => ({
  useResolvedFavorites: () => favorites,
}));

vi.mock("./ChatList", () => ({ default: () => <div>chat list</div> }));

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

/**
 * Enough of the server for a compose screen. Unmocked routes reject rather
 * than resolving to `{}`, so a path this file never supplied data for is loud
 * on stderr instead of quietly exercising the wrong thing.
 */
function fakeServer(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;

  if (url.includes("/chats/new/info")) return Promise.resolve(jsonResponse({ folder: FOLDER, slash_commands: COMMANDS, plugins: [] }));
  if (url.includes("/system-info")) return Promise.resolve(jsonResponse({}));
  if (url.includes("/keywords")) return Promise.resolve(jsonResponse({ keywords: [] }));
  if (url.includes("/mcp-tools")) return Promise.resolve(jsonResponse({ tools: [], servers: [] }));
  if (url.includes("/plugins")) return Promise.resolve(jsonResponse({ plugins: [] }));

  return Promise.reject(new Error(`unmocked request: ${url}`));
}

const resolved = (overrides: Partial<ResolvedFavorites> = {}): ResolvedFavorites => ({
  skills: [],
  jobs: [],
  missingSkills: [],
  missingJobs: [],
  settled: true,
  jobsResolved: true,
  error: null,
  retry: vi.fn(),
  dropMissing: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  favorites = resolved();
  vi.stubGlobal("fetch", vi.fn(fakeServer));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Mount the compose screen and wait for the composer to register its setter. */
async function openNewChat() {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: "/chat/new", search: `?folder=${encodeURIComponent(FOLDER)}` }]}>
        <Routes>
          <Route path="/chat/new" element={<Chat />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await waitFor(() => expect(document.querySelector("textarea")).toBeTruthy());
}

const composer = () => document.querySelector("textarea") as HTMLTextAreaElement;

function type(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
}

describe("new-chat command surfaces — nothing typed is ever lost", () => {
  it("prefixes a skill chip onto the message instead of replacing it", async () => {
    favorites = resolved({ skills: [SKILL] });
    await openNewChat();

    type("for the v2 release, grouped by area");
    fireEvent.click(screen.getByRole("button", { name: /release-notes/ }));

    await waitFor(() => expect(composer().value).toContain("for the v2 release, grouped by area"));
    expect(composer().value).toBe("/callboard:release-notes for the v2 release, grouped by area");
  });

  it("still just fills an empty composer", async () => {
    favorites = resolved({ skills: [SKILL] });
    await openNewChat();

    fireEvent.click(screen.getByRole("button", { name: /release-notes/ }));

    await waitFor(() => expect(composer().value).toBe("/callboard:release-notes "));
  });

  it("keeps the message when the chip comes from the nav drawer's commands panel", async () => {
    await openNewChat();

    type("the whole backlog");
    // The launchpad has the fallback grid, so the nav's Commands pill is down —
    // reach the panel through the grid's own chips, which are the same list.
    fireEvent.click(screen.getByRole("button", { name: "compact" }));

    // A known command chips, so the textarea holds only the argument.
    await waitFor(() => expect(composer().value).toBe("the whole backlog"));
    expect(screen.getByText("/compact")).toBeTruthy();
  });

  it("swaps a command already in the composer rather than stacking a second one", async () => {
    await openNewChat();

    type("the whole backlog");
    fireEvent.click(screen.getByRole("button", { name: "compact" }));
    await waitFor(() => expect(screen.getByText("/compact")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "clear" }));

    await waitFor(() => expect(screen.getByText("/clear")).toBeTruthy());
    expect(screen.queryByText("/compact")).toBeNull();
    expect(composer().value).toBe("the whole backlog");
  });
});

describe("new-chat command surfaces — one list, one surface", () => {
  it("drops the Commands pill while the launchpad is showing the fallback grid", async () => {
    await openNewChat();

    expect(screen.getByText("Available Commands")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Commands/ })).toBeNull();
  });

  it("shows no Commands pill at all until the launchpad has decided", async () => {
    // "hidden" is not "commands", so the pill used to render on every cold
    // load and then be pulled out from under the cursor the moment the
    // fallback grid arrived — 79 consecutive frames of it measured in Chromium
    // against a 1400ms favorites read over the tunnel, 0 on localhost. The
    // launchpad's no-flash rule has to cover the nav beside it.
    favorites = resolved({ settled: false });
    await openNewChat();

    expect(screen.queryByRole("button", { name: /^Commands/ })).toBeNull();
    expect(screen.queryByText("Available Commands")).toBeNull();
  });

  it("brings the pill back once something is starred", async () => {
    favorites = resolved({ skills: [SKILL] });
    await openNewChat();

    expect(screen.getByText("Quick start")).toBeTruthy();
    expect(screen.queryByText("Available Commands")).toBeNull();
    expect(screen.getByRole("button", { name: /Commands/ })).toBeTruthy();
  });
});
