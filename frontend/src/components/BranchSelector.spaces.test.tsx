// @vitest-environment jsdom
/**
 * The "New worktree" toggle under a space: seeded from the space's own
 * default, written back to the space when flipped, and written to the
 * browser-wide fallback only when the space has no defaults of its own — so a
 * preference set in one space never leaks into General.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SpaceContext } from "../contexts/SpaceContext";
import { makeSpaceContext, testSpace } from "../testing/spaceContext";
import BranchSelector from "./BranchSelector";

const getGitBranches = vi.fn();
const updateSpace = vi.fn(async () => ({}));
vi.mock("../api", () => ({
  getGitBranches: (folder: string) => getGitBranches(folder),
  updateSpace: (...args: unknown[]) => (updateSpace as any)(...args),
}));

const SPACES = [testSpace("default", "General"), testSpace("sp_work", "Work", { defaults: { worktreeByDefault: true } }), testSpace("sp_home", "Home")];

async function open(spaceId: string) {
  render(
    <SpaceContext.Provider value={makeSpaceContext(SPACES, { activeSpaceId: spaceId })}>
      <BranchSelector folder="/repo" spaceId={spaceId} currentBranch="main" onChange={() => {}} />
    </SpaceContext.Provider>,
  );
  await screen.findByLabelText("Base branch");
  return screen.getByLabelText(/New worktree/) as HTMLInputElement;
}
const globalWorktree = () => JSON.parse(localStorage.getItem("claude-code-settings") ?? "{}").worktreeByDefault;

beforeEach(() => {
  localStorage.clear();
  getGitBranches.mockResolvedValue({ branches: ["main"], checkedOut: [{ branch: "main", path: "/repo", isMainWorktree: true }] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BranchSelector in a space", () => {
  it("seeds from the space's own worktree default", async () => {
    expect((await open("sp_work")).checked).toBe(true);
    cleanup();
    expect((await open("sp_home")).checked).toBe(false);
  });

  it("a flip in a space with its own defaults writes the space only", async () => {
    fireEvent.click(await open("sp_work"));
    expect(updateSpace).toHaveBeenCalledWith("sp_work", { defaults: { worktreeByDefault: false } });
    expect(globalWorktree()).toBeUndefined();
  });

  it("a flip in a space without defaults also updates the browser fallback", async () => {
    fireEvent.click(await open("sp_home"));
    expect(updateSpace).toHaveBeenCalledWith("sp_home", { defaults: { worktreeByDefault: true } });
    expect(globalWorktree()).toBe(true);
  });
});
