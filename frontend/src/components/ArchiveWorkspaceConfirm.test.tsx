// @vitest-environment jsdom
/**
 * The confirmation that stands between a click and forty gigabytes moving.
 *
 * One assertion here matters more than the rest: **the ignored entries are
 * shown.** `.env` files are invisible to `git status --porcelain`, exist in
 * every worktree on the author's machine with 34 distinct contents, and travel
 * into the trash with the directory. The cleanliness gate cannot see them and
 * quarantine deliberately does not refuse on them, so this screen is the only
 * place a user learns their local secrets are about to move. If these tests go
 * green while that list is gone, they are not testing the right thing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { WorkspaceWithRemovability } from "../api";
import ArchiveWorkspaceConfirm from "./ArchiveWorkspaceConfirm";

afterEach(cleanup);

function makeWorkspace(over: Partial<WorkspaceWithRemovability> = {}): WorkspaceWithRemovability {
  return {
    id: "ws-1",
    name: "callboard.feat-x",
    cwd: "/home/cybil/callboard.feat-x",
    repoPath: "/home/cybil/callboard",
    isolation: "worktree",
    worktree: { owned: true, mode: "branch-off", branch: "feat/x", baseBranch: "main" },
    status: "active",
    createdAt: "2026-07-20T00:00:00.000Z",
    directory: { state: "present", detail: "still a worktree" },
    diskUsage: { bytes: 1_073_741_824 },
    removability: {
      removable: true,
      blockers: [],
      ignored: { entries: [".env", "node_modules", "backend/local.sqlite"], truncated: false },
    },
    ...over,
  };
}

function renderConfirm(workspace = makeWorkspace(), props: Partial<React.ComponentProps<typeof ArchiveWorkspaceConfirm>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<ArchiveWorkspaceConfirm workspace={workspace} chatCount={0} onConfirm={onConfirm} onCancel={onCancel} {...props} />);
  return { onConfirm, onCancel };
}

describe("what will actually move", () => {
  it("names the directory, its size and where it is going", () => {
    renderConfirm();
    expect(screen.getByText("/home/cybil/callboard.feat-x")).toBeTruthy();
    expect(screen.getByText(/~\/\.callboard\/trash · 1\.0 GB/)).toBeTruthy();
  });

  it("names the branch and repository the restore would need", () => {
    renderConfirm();
    expect(screen.getByText("feat/x")).toBeTruthy();
    expect(screen.getByText("/home/cybil/callboard")).toBeTruthy();
  });

  /** The whole reason this screen exists. */
  it("lists the gitignored files that travel with the directory", () => {
    renderConfirm();
    expect(screen.getByText(".env")).toBeTruthy();
    expect(screen.getByText("backend/local.sqlite")).toBeTruthy();
    expect(screen.getByText(/invisible to/)).toBeTruthy();
  });

  it("says the list is capped when it is", () => {
    renderConfirm(makeWorkspace({ removability: { removable: true, blockers: [], ignored: { entries: [".env"], truncated: true } } }));
    expect(screen.getByText(/the list is capped/)).toBeTruthy();
  });

  /**
   * A preview git could not produce must not read as "there is nothing here" —
   * that is the reassuring reading, and it is the wrong one.
   */
  it("warns rather than reassures when the preview could not be computed", () => {
    renderConfirm(
      makeWorkspace({ removability: { removable: true, blockers: [], ignored: { entries: [], truncated: false, error: "git failed: exit 128" } } }),
    );
    expect(screen.getByText(/could not list them/)).toBeTruthy();
    expect(screen.getByText(/assume local configuration and databases are among them/)).toBeTruthy();
  });

  it("says so honestly when there genuinely are none", () => {
    renderConfirm(makeWorkspace({ removability: { removable: true, blockers: [], ignored: { entries: [], truncated: false } } }));
    expect(screen.getByText("Git reports no ignored entries in this worktree.")).toBeTruthy();
  });

  /**
   * `chatCount` is a REQUIRED prop, and that is the whole fix here. It used to
   * be optional, no caller passed it, and this test — which supplies the number
   * by hand — went green against a shipped UI that never rendered the sentence.
   * A unit test cannot prove a caller passes something; the type does, and
   * WorkspaceManagerModal.test.tsx proves the number is the real one.
   */
  it("warns that chats will be interrupted", () => {
    renderConfirm(makeWorkspace(), { chatCount: 4 });
    expect(screen.getByText(/4 chats in this workspace will be interrupted/)).toBeTruthy();
  });

  /**
   * A confirmation that only lists consequences teaches people to click past
   * it. This one has to say what the way back is.
   */
  it("says the move is reversible and how", () => {
    renderConfirm();
    expect(screen.getByText(/Nothing in this directory is deleted/)).toBeTruthy();
    expect(screen.getByText(/restore it from the Trash tab/)).toBeTruthy();
  });

  /**
   * The copy used to say "Nothing is deleted." full stop, while the same click
   * ran the retention sweep — which permanently removes every past-retention
   * trash entry, including ones belonging to workspaces the user has nothing to
   * do with and may have been about to restore.
   */
  it("does not claim the click deletes nothing, because it runs the retention sweep", () => {
    renderConfirm();
    expect(screen.getByText(/archiving runs the retention sweep/)).toBeTruthy();
    expect(screen.getByText(/from any workspace, not just this one/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Nothing is deleted\./);
  });
});

describe("the click itself", () => {
  it("does nothing until the confirm button is pressed", () => {
    const { onConfirm } = renderConfirm();
    expect(onConfirm).not.toHaveBeenCalled();
    (screen.getByText("Archive and move to trash").closest("button") as HTMLButtonElement).click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cannot be double-fired while the archive is running", () => {
    const { onConfirm } = renderConfirm(makeWorkspace(), { busy: true });
    const button = screen.getByText("Archiving…").closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    button.click();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
