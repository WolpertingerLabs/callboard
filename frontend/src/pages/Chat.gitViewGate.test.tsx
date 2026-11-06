/**
 * When the git view is offered. A git folder always gets it; a chat whose
 * folder is no longer a checkout (its worktree deleted) still gets it when its
 * git trail recorded a branch — the PRs it worked on are still worth showing —
 * and its Changes half says the folder is gone rather than erroring.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Chat from "./Chat";

const fixture = vi.hoisted(() => ({ isGitRepo: true, metadata: "{}" }));
vi.mock("../api/computerUse", () => ({ computerUseClient: { status: vi.fn(), open: vi.fn(), observe: vi.fn(), control: vi.fn(), action: vi.fn() } }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getChat: vi.fn(async (id: string) => ({ id, title: "A chat", folder: "/home/u/app.gone", is_git_repo: fixture.isGitRepo, metadata: fixture.metadata })),
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
vi.mock("../components/PromptInput", () => ({ default: () => <textarea aria-label="Composer" /> }));
vi.mock("../components/GitDiffView", () => ({ default: () => <div>Git diff view</div> }));
vi.mock("../components/git/ChatPrsView", () => ({ default: ({ folder }: { folder: string }) => <div>PRs of {folder}</div> }));
vi.mock("../components/ChatDebugPanel", () => ({ default: () => <div>Debug view</div> }));

const TRAIL = JSON.stringify({ gitTrail: [{ cwd: "/home/u/app.gone", repoPath: "/home/u/app", branch: "feat/gone", firstSeen: "t0", lastSeen: "t1" }] });

const mount = () =>
  render(
    <MemoryRouter initialEntries={["/chat/c1"]}>
      <Routes>
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  localStorage.clear();
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

/** The header's git-view button, once the chat has loaded. */
const gitButton = async () => {
  await screen.findAllByText(/app\.gone/);
  return screen.queryByTitle("Show git diff");
};

it("offers the git view for a git folder, as before", async () => {
  fixture.isGitRepo = true;
  fixture.metadata = "{}";
  mount();
  fireEvent.click((await gitButton())!);
  expect(await screen.findByText("Git diff view")).toBeDefined();
});

it("does not offer it for a folder that is no checkout and never was one", async () => {
  fixture.isGitRepo = false;
  fixture.metadata = "{}";
  mount();
  expect(await gitButton()).toBeNull();
});

it("offers it for a deleted worktree with a git trail: Changes says the folder is gone, PRs works", async () => {
  fixture.isGitRepo = false;
  fixture.metadata = TRAIL;
  mount();
  fireEvent.click((await gitButton())!);
  expect(await screen.findByText("This folder is no longer a git checkout.")).toBeDefined();
  expect(screen.queryByText("Git diff view")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "PRs" }));
  expect(await screen.findByText("PRs of /home/u/app.gone")).toBeDefined();
});

it("shows the diff as usual for a live checkout that has a trail", async () => {
  fixture.isGitRepo = true;
  fixture.metadata = TRAIL;
  mount();
  fireEvent.click((await gitButton())!);
  expect(await screen.findByText("Git diff view")).toBeDefined();
  expect(screen.queryByText("This folder is no longer a git checkout.")).toBeNull();
});
