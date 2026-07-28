// @vitest-environment jsdom
/**
 * The one user-visible change in Phase 3: a sidebar row that is a git worktree
 * says so.
 *
 * `FolderSummary.isWorktree` has been served since long before workspaces
 * existed and nothing ever rendered it, so a worktree row and a main-checkout
 * row were indistinguishable — in a sidebar that, on this machine, is 39
 * worktrees to 22 other directories. Phase 3 makes the field answer from the
 * workspace record; this test is what makes that observable.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { FolderSummary } from "../api";
import FolderListItem from "./FolderListItem";

afterEach(cleanup);

function makeFolder(overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    folder: "/home/cybil/callboard.feat-x",
    displayName: "callboard.feat-x",
    mostRecentChatId: "chat-1",
    mostRecentChatCreatedAt: "2026-07-28T10:00:00.000Z",
    lastUpdatedAt: "2026-07-28T11:00:00.000Z",
    status: "stopped",
    isGitRepo: true,
    isWorktree: false,
    gitBranch: "feat/x",
    isTriggered: false,
    chatCount: 3,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-28T11:05:00.000Z");

function renderRow(folder: FolderSummary) {
  return render(<FolderListItem folder={folder} onClick={vi.fn()} onNewChat={vi.fn()} now={NOW} />);
}

describe("worktree marker", () => {
  it("marks a worktree row and names the repo it belongs to", () => {
    renderRow(makeFolder({ isWorktree: true, repoPath: "/home/cybil/callboard" }));
    expect(screen.getByTitle("Worktree of /home/cybil/callboard")).toBeTruthy();
    expect(screen.getByText("worktree")).toBeTruthy();
  });

  it("marks a worktree with no known repo without inventing one", () => {
    renderRow(makeFolder({ isWorktree: true }));
    expect(screen.getByTitle("Git worktree")).toBeTruthy();
  });

  /**
   * The regression the record's `isolation` field would have caused: a record
   * can say `isolation: "worktree"` about the *main checkout* (the branch was
   * already checked out there), and one such record is live today. The
   * projection resolves that to `isWorktree: false`, and the row must be plain.
   */
  it("leaves a main checkout unmarked", () => {
    renderRow(makeFolder({ folder: "/home/cybil/callboard", displayName: "callboard", isWorktree: false }));
    expect(screen.queryByText("worktree")).toBeNull();
  });

  it("leaves a non-git directory unmarked", () => {
    renderRow(makeFolder({ isGitRepo: false, isWorktree: false, gitBranch: undefined }));
    expect(screen.queryByText("worktree")).toBeNull();
  });

  it("still shows the branch alongside the marker", () => {
    renderRow(makeFolder({ isWorktree: true, repoPath: "/home/cybil/callboard" }));
    expect(screen.getByTitle("Branch: feat/x")).toBeTruthy();
    expect(screen.getByText("worktree")).toBeTruthy();
  });
});
