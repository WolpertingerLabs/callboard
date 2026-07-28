// @vitest-environment jsdom
/**
 * Phase 4a's additions to the row: size on disk, and — where it matters — why
 * this directory cannot be cleaned up.
 *
 * The two states that must not look normal have their own block. A row whose
 * directory is gone, or whose directory is no longer a worktree, is a record
 * that has outlived the thing it describes; seven of the ten records on the
 * author's machine are in the first state. Rendering those as ordinary rows is
 * what made forty gigabytes invisible in the first place.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { FolderSummary, FolderWorkspaceRecord } from "../api";
import FolderListItem from "./FolderListItem";

afterEach(cleanup);

function makeRecord(over: Partial<FolderWorkspaceRecord> = {}): FolderWorkspaceRecord {
  return {
    id: "ws-1",
    name: "callboard.feat-x",
    isolation: "worktree",
    owned: true,
    branch: "feat/x",
    createdAt: "2026-07-20T00:00:00.000Z",
    directory: { state: "present", detail: "/home/cybil/callboard.feat-x is still a worktree of /home/cybil/callboard" },
    ...over,
  };
}

function makeFolder(overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    folder: "/home/cybil/callboard.feat-x",
    displayName: "callboard.feat-x",
    mostRecentChatId: "chat-1",
    mostRecentChatCreatedAt: "2026-07-28T10:00:00.000Z",
    lastUpdatedAt: "2026-07-28T11:00:00.000Z",
    status: "stopped",
    isGitRepo: true,
    isWorktree: true,
    repoPath: "/home/cybil/callboard",
    gitBranch: "feat/x",
    isTriggered: false,
    chatCount: 3,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-28T11:05:00.000Z");

function renderRow(folder: FolderSummary, onNewChat = vi.fn()) {
  return { onNewChat, ...render(<FolderListItem folder={folder} onClick={vi.fn()} onNewChat={onNewChat} now={NOW} />) };
}

describe("size on disk", () => {
  it("shows the size when the listing measured one", () => {
    renderRow(makeFolder({ diskUsage: { bytes: 10_100_000_000 } }));
    expect(screen.getByText("9.4 GB")).toBeTruthy();
  });

  /**
   * Sizes are opt-in, so an unmeasured row must show nothing at all rather than
   * a zero — "0 B" would read as "this is free to keep", which is the opposite
   * of true for every directory in this list.
   */
  it("shows nothing when the listing did not measure", () => {
    const { container } = renderRow(makeFolder());
    expect(container.textContent).not.toContain("B");
    expect(screen.queryByText(/GB|MB|size unknown/)).toBeNull();
  });

  it("says the size is unknown rather than inventing one when du failed", () => {
    renderRow(makeFolder({ diskUsage: { error: "du failed: timed out after 15000ms" } }));
    expect(screen.getByText("size unknown")).toBeTruthy();
  });
});

describe("a row that is not what it looks like", () => {
  it("says plainly that the directory is gone, and does not let a chat start there", () => {
    const { onNewChat } = renderRow(
      makeFolder({
        directoryState: "missing",
        directoryDetail: "/home/cybil/callboard.feat-x does not exist. Callboard has not touched it.",
        workspaces: [makeRecord({ directory: { state: "missing", detail: "gone" } })],
      }),
    );
    // Short in the row, in full on hover: the backend's sentence wrapped to
    // five lines in a ~330px column, and seven stale records — the real number
    // on this machine — turned most of the sidebar into the same paragraph.
    expect(screen.getByText(/Directory is gone — nothing was deleted/)).toBeTruthy();
    expect(screen.getByTitle(/does not exist\. Callboard has not touched it\./)).toBeTruthy();
    expect(screen.queryByText(/does not exist\. Callboard has not touched it\./)).toBeNull();
    const button = screen.getByTitle("The directory no longer exists") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    button.click();
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it("says plainly when a directory is no longer a worktree", () => {
    renderRow(
      makeFolder({
        directoryState: "not-a-worktree",
        directoryDetail: "/home/cybil/callboard.feat-x exists but is no longer a git worktree — it may have been pruned.",
        workspaces: [makeRecord({ directory: { state: "not-a-worktree", detail: "pruned" } })],
      }),
    );
    expect(screen.getByText(/No longer a git worktree — contents untouched/)).toBeTruthy();
    expect(screen.getByTitle(/exists but is no longer a git worktree — it may have been pruned\./)).toBeTruthy();
  });

  it("leaves a healthy row unadorned", () => {
    renderRow(makeFolder({ workspaces: [makeRecord()] }));
    expect(screen.queryByText(/does not exist|no longer a git worktree/i)).toBeNull();
    expect(screen.queryByText("not owned")).toBeNull();
    expect(screen.queryByText("unmanaged")).toBeNull();
  });
});

describe("why this cannot be cleaned up", () => {
  /**
   * The backlog, and the single most common state on this machine: 43 of 44
   * worktrees have no record at all, so Phase 2 will never touch them. The row
   * has to say so — otherwise a worktree Callboard can clean up and one it
   * never will look identical.
   */
  it("marks a worktree with no workspace record as unmanaged", () => {
    renderRow(makeFolder());
    expect(screen.getByText("unmanaged")).toBeTruthy();
    expect(screen.getByTitle(/Adopt it from Manage worktrees/)).toBeTruthy();
  });

  it("marks a recorded worktree Callboard did not create as not owned", () => {
    renderRow(makeFolder({ workspaces: [makeRecord({ owned: false })] }));
    expect(screen.getByText("not owned")).toBeTruthy();
    expect(screen.getByTitle(/Callboard did not create this worktree/)).toBeTruthy();
  });

  it("says nothing about an owned worktree, which is the one case that can be cleaned up", () => {
    renderRow(makeFolder({ workspaces: [makeRecord({ owned: true })] }));
    expect(screen.queryByText("not owned")).toBeNull();
    expect(screen.queryByText("unmanaged")).toBeNull();
  });

  /**
   * A plain checkout is never Callboard's to remove and nobody expects it to
   * be, so labelling it "unmanaged" would be noise on every non-worktree row.
   */
  it("says nothing about a directory that is not a worktree at all", () => {
    renderRow(makeFolder({ isWorktree: false, repoPath: undefined }));
    expect(screen.queryByText("unmanaged")).toBeNull();
  });
});

describe("several workspaces on one directory", () => {
  /**
   * Supported, not a bug — and after the registry-hygiene fix a `useWorktree`
   * chat on the main checkout produces exactly this. The row stays one row and
   * reports the count; splitting it is what Phase 3 exists to prevent.
   */
  it("stays one row and reports how many records share the directory", () => {
    renderRow(
      makeFolder({
        folder: "/home/cybil/callboard",
        displayName: "callboard",
        isWorktree: false,
        repoPath: undefined,
        workspaces: [makeRecord({ id: "ws-a", isolation: "worktree" }), makeRecord({ id: "ws-b", isolation: "local", branch: undefined })],
      }),
    );
    expect(screen.getByText("2 workspaces")).toBeTruthy();
    expect(screen.getAllByText("callboard")).toHaveLength(1);
  });

  it("does not report a count for the ordinary one-record directory", () => {
    renderRow(makeFolder({ workspaces: [makeRecord()] }));
    expect(screen.queryByText(/\d+ workspaces/)).toBeNull();
  });
});
