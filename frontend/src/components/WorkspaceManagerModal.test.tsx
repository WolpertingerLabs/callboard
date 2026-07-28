// @vitest-environment jsdom
/**
 * The management surface, tested for the properties that keep it safe rather
 * than for its layout.
 *
 * Three of them, and each has a concrete failure it prevents:
 *
 *  - **No bulk archive exists.** Not "is discouraged" — there is no control
 *    that archives more than one workspace, so there is no path by which forty
 *    gigabytes moves on one click.
 *  - **A blocked workspace is not actionable as a removal.** It offers to
 *    archive the *record*, which touches nothing, and says why the directory
 *    stays.
 *  - **Adoption acts only on ticked paths**, and there is no select-all. The
 *    request that goes out carries exactly the paths the user chose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UnmanagedWorktreeListing, WorkspaceWithRemovability } from "../api";

const listWorkspaces = vi.fn();
const listUnmanagedWorktrees = vi.fn();
const adoptWorktrees = vi.fn();
const archiveWorkspace = vi.fn();
const listTrash = vi.fn();
const restoreTrashEntry = vi.fn();

vi.mock("../api", () => ({
  listWorkspaces: (...args: any[]) => listWorkspaces(...args),
  listUnmanagedWorktrees: (...args: any[]) => listUnmanagedWorktrees(...args),
  adoptWorktrees: (...args: any[]) => adoptWorktrees(...args),
  archiveWorkspace: (...args: any[]) => archiveWorkspace(...args),
  listTrash: (...args: any[]) => listTrash(...args),
  restoreTrashEntry: (...args: any[]) => restoreTrashEntry(...args),
}));

const WorkspaceManagerModal = (await import("./WorkspaceManagerModal")).default;

function workspace(over: Partial<WorkspaceWithRemovability> = {}): WorkspaceWithRemovability {
  return {
    id: "ws-clean",
    name: "callboard.feat-clean",
    cwd: "/home/cybil/callboard.feat-clean",
    repoPath: "/home/cybil/callboard",
    isolation: "worktree",
    worktree: { owned: true, mode: "branch-off", branch: "feat/clean" },
    status: "active",
    createdAt: "2026-07-20T00:00:00.000Z",
    directory: { state: "present", detail: "still a worktree" },
    diskUsage: { bytes: 5_368_709_120 },
    removability: { removable: true, blockers: [], ignored: { entries: [".env"], truncated: false } },
    ...over,
  };
}

const blocked = workspace({
  id: "ws-dirty",
  name: "callboard.feat-dirty",
  cwd: "/home/cybil/callboard.feat-dirty",
  worktree: { owned: false, mode: "branch-off", branch: "feat/dirty" },
  removability: {
    removable: false,
    blockers: [
      { code: "not-owned", detail: "Callboard did not create this worktree, so it will not remove it." },
      { code: "uncommitted-changes", detail: "There are staged or unstaged modifications to tracked files." },
    ],
  },
});

const missing = workspace({
  id: "ws-gone",
  name: "callboard.feat-gone",
  cwd: "/home/cybil/callboard.feat-gone",
  diskUsage: undefined,
  directory: { state: "missing", detail: "/home/cybil/callboard.feat-gone does not exist. Callboard has not touched it." },
  removability: { removable: false, blockers: [{ code: "cwd-missing", detail: "The directory is already gone." }] },
});

const unmanagedListing: UnmanagedWorktreeListing = {
  repoPath: "/home/cybil/callboard",
  totalWorktrees: 4,
  managedWorktrees: 1,
  worktrees: [
    {
      path: "/home/cybil/callboard.feat-a",
      branch: "feat/a",
      repoPath: "/home/cybil/callboard",
      naming: { convention: "current", matches: true, detail: "matches the current convention — a guess" },
      cleanliness: { clean: true, uncommittedChanges: false, untrackedFiles: false, unpushedCommits: false },
      ignored: { entries: [".env"], truncated: false },
      diskUsage: { bytes: 1_073_741_824 },
      adoptable: true,
      adoptionBlockers: [],
    },
    {
      path: "/home/cybil/callboard.feat-b",
      branch: "feat/b",
      repoPath: "/home/cybil/callboard",
      naming: { convention: "unrecognized", matches: false, detail: "does not match any known convention — a guess" },
      cleanliness: { clean: true, uncommittedChanges: false, untrackedFiles: false, unpushedCommits: false },
      ignored: { entries: [], truncated: false },
      diskUsage: { bytes: 2_147_483_648 },
      adoptable: true,
      adoptionBlockers: [],
    },
    {
      path: "/home/cybil/callboard.detached",
      branch: null,
      repoPath: "/home/cybil/callboard",
      naming: { convention: "unrecognized", matches: false, detail: "a guess" },
      cleanliness: { clean: true, uncommittedChanges: false, untrackedFiles: false, unpushedCommits: false },
      ignored: { entries: [], truncated: false },
      diskUsage: { bytes: 512 },
      adoptable: false,
      adoptionBlockers: [{ code: "detached-head", detail: "Git reports no branch here, and a workspace record requires one." }],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  listWorkspaces.mockResolvedValue({ workspaces: [workspace(), blocked, missing] });
  listUnmanagedWorktrees.mockResolvedValue(unmanagedListing);
  listTrash.mockResolvedValue({ root: "/home/cybil/.callboard/trash", retentionDays: 30, entries: [] });
  adoptWorktrees.mockResolvedValue({ outcomes: [], adopted: 0, refused: 0 });
});

afterEach(cleanup);

function open() {
  return render(<WorkspaceManagerModal onClose={vi.fn()} repoCandidates={["/home/cybil/callboard"]} />);
}

/**
 * `fireEvent` rather than a bare `.click()`: React batches state updates, and a
 * native click dispatched outside `act` leaves the tree un-flushed — a test that
 * then asserts "no request went out" would pass for the wrong reason.
 */
function click(element: Element | null | undefined) {
  fireEvent.click(element as Element);
}

describe("the workspaces tab", () => {
  it("offers exactly one archive control per workspace and none that acts on many", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");
    // One removable workspace → one danger action. Two blocked ones → two
    // record-only actions. No control anywhere claims a selection.
    expect(screen.getAllByText(/Archive & trash…/)).toHaveLength(1);
    expect(screen.getAllByText("Archive record…")).toHaveLength(2);
    expect(screen.queryByText(/Archive all|Archive selected|Clean up all|Select all/i)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("does not archive anything until the confirmation is passed", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");
    click(screen.getByText(/Archive & trash…/).closest("button"));
    // The confirmation opened; the call has not gone out.
    expect(archiveWorkspace).not.toHaveBeenCalled();
    expect(await screen.findByText(/Archive .*and move its worktree to the trash\?/)).toBeTruthy();
    // ...and it shows the ignored entries, which is what makes it a decision.
    expect(screen.getByText(".env")).toBeTruthy();

    click(screen.getByText("Archive and move to trash").closest("button"));
    await waitFor(() => expect(archiveWorkspace).toHaveBeenCalledWith("ws-clean"));
    expect(archiveWorkspace).toHaveBeenCalledTimes(1);
  });

  /**
   * A blocked workspace must not present a removal it cannot perform. What it
   * does offer — archiving the record — is a genuinely different action, and it
   * is the only way to clear the seven live records that point at directories
   * which no longer exist.
   */
  it("shows every blocker instead of an action it cannot perform", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-dirty");
    expect(screen.getByText("not owned by Callboard")).toBeTruthy();
    expect(screen.getByText("uncommitted changes")).toBeTruthy();
    expect(screen.getByText(/Adopting this worktree from the Unmanaged tab would clear that/)).toBeTruthy();
  });

  it("says plainly that a record's directory is gone", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-gone");
    // The chip on the group and the blocker on the record both say it.
    expect(screen.getAllByText("directory is gone").length).toBeGreaterThan(0);
    expect(screen.getByText(/does not exist\. Callboard has not touched it\./)).toBeTruthy();
  });

  it("asks for sizes, since that is the number the cleanup is about", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");
    expect(listWorkspaces).toHaveBeenCalledWith("active", true);
    expect(screen.getAllByText("5.0 GB").length).toBeGreaterThan(0);
  });
});

describe("the unmanaged tab", () => {
  async function scan() {
    open();
    click(screen.getByText("Unmanaged worktrees"));
    click(screen.getByText("Scan"));
    await screen.findByText("/home/cybil/callboard.feat-a");
  }

  it("scans without writing anything, and offers no select-all", async () => {
    await scan();
    expect(listUnmanagedWorktrees).toHaveBeenCalledWith("/home/cybil/callboard");
    expect(adoptWorktrees).not.toHaveBeenCalled();
    expect(screen.queryByText(/Select all|Adopt all/i)).toBeNull();
  });

  it("labels the naming heuristic as a guess in both directions", async () => {
    await scan();
    expect(screen.getByText("looks like Callboard's naming (a guess)")).toBeTruthy();
    expect(screen.getAllByText("unfamiliar name (a guess)").length).toBeGreaterThan(0);
  });

  it("will not let an unadoptable candidate be ticked, and says why", async () => {
    await scan();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(3);
    expect(boxes[2].disabled).toBe(true);
    expect(screen.getByText(/Git reports no branch here/)).toBeTruthy();
  });

  it("adopts exactly the ticked paths, and only after the confirmation", async () => {
    await scan();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    click(boxes[1]);

    click(screen.getByText("Adopt selected…").closest("button"));
    expect(adoptWorktrees).not.toHaveBeenCalled();
    // The confirmation names the path rather than a count.
    expect(await screen.findByText("Adopt 1 worktree?")).toBeTruthy();

    click(screen.getByText("Adopt this worktree").closest("button"));
    await waitFor(() => expect(adoptWorktrees).toHaveBeenCalledWith(["/home/cybil/callboard.feat-b"]));
  });

  it("keeps the adopt button inert until something is ticked", async () => {
    await scan();
    const button = screen.getByText("Adopt selected…").closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    click(button);
    expect(adoptWorktrees).not.toHaveBeenCalled();
  });
});

describe("the trash tab", () => {
  it("counts down to the sweep, and refuses to promise a restore it cannot do", async () => {
    // 27 days in, so the countdown lands unambiguously on 2 whole days left.
    const quarantinedAt = new Date(Date.now() - 27 * 86_400_000).toISOString();
    listTrash.mockResolvedValue({
      root: "/home/cybil/.callboard/trash",
      retentionDays: 30,
      entries: [
        {
          entry: "ws-1-2026",
          originalPath: "/home/cybil/callboard.feat-old",
          branch: "feat/old",
          quarantinedAt,
          expiresAt: new Date(Date.parse(quarantinedAt) + 30 * 86_400_000).toISOString(),
          diskUsage: { bytes: 3_221_225_472 },
          restore: ["git -C /home/cybil/callboard worktree add /home/cybil/callboard.feat-old feat/old"],
          restorable: false,
          restoreBlocker: "/home/cybil/callboard.feat-old exists again; restoring would write over it",
        },
        {
          entry: "orphan",
          sweepBlocked: "it has no readable .callboard-trash.json, so the sweep will never take it",
          restore: [],
          restorable: false,
          restoreBlocker: "no readable manifest",
        },
      ],
    });
    open();
    click(screen.getByText("Trash"));
    await screen.findByText("/home/cybil/callboard.feat-old");
    expect(screen.getByText("deleted in 2 days")).toBeTruthy();
    // An entry the sweep cannot date is kept forever; a countdown would be a
    // lie in the direction that costs a user their data.
    expect(screen.getByText("never swept")).toBeTruthy();
    for (const button of screen.getAllByText("Restore")) {
      expect((button.closest("button") as HTMLButtonElement).disabled).toBe(true);
    }
    expect(restoreTrashEntry).not.toHaveBeenCalled();
  });

  it("restores only through a confirmation", async () => {
    listTrash.mockResolvedValue({
      root: "/home/cybil/.callboard/trash",
      retentionDays: 30,
      entries: [
        {
          entry: "ws-1-2026",
          originalPath: "/home/cybil/callboard.feat-old",
          branch: "feat/old",
          quarantinedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          restore: [],
          restorable: true,
        },
      ],
    });
    restoreTrashEntry.mockResolvedValue({
      ok: true,
      entry: "ws-1-2026",
      originalPath: "/home/cybil/callboard.feat-old",
      copiedEntries: 3,
      trashRetained: true,
    });

    open();
    click(screen.getByText("Trash"));
    click((await screen.findByText("Restore")).closest("button"));
    expect(restoreTrashEntry).not.toHaveBeenCalled();
    expect(await screen.findByText("Restore this worktree?")).toBeTruthy();
    // The confirmation states the property that makes restore safe to offer.
    expect(screen.getByText(/quarantined copy stays in the trash/)).toBeTruthy();

    // The confirmation's own button, not the row's — the row's is behind the overlay.
    click(screen.getAllByRole("button", { name: "Restore" }).at(-1));
    await waitFor(() => expect(restoreTrashEntry).toHaveBeenCalledWith("ws-1-2026"));
  });
});
