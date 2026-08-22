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
 *  - **A blocked workspace is not actionable as a removal.** Its confirmation
 *    offers to archive the *record*, which touches nothing, and says why the
 *    directory stays.
 *  - **Adoption acts only on ticked paths**, and there is no select-all. The
 *    request that goes out carries exactly the paths the user chose.
 *  - **The listing costs no removal verdicts.** Rows come back without one and
 *    the component never asks for one until a user clicks — the property the
 *    whole surface was reshaped around, because 65 verdicts is 350 synchronous
 *    git subprocesses on a single-threaded daemon.
 *  - **"Check all" is the only thing that buys them in bulk**, it does so on a
 *    click and never on its own, and what it produces decorates rows without
 *    ever becoming what an archive is decided on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UnmanagedWorktreeListing, WorkspaceEntry, WorkspaceWithRemovability } from "../api";

const listWorkspaces = vi.fn();
const listWorkspacesWithVerdicts = vi.fn();
const fetchWorkspaceRemovability = vi.fn();
const listUnmanagedWorktrees = vi.fn();
const adoptWorktrees = vi.fn();
const archiveWorkspace = vi.fn();
const listTrash = vi.fn();
const restoreTrashEntry = vi.fn();
const renameWorkspace = vi.fn();

vi.mock("../api", () => ({
  listWorkspaces: (...args: any[]) => listWorkspaces(...args),
  listWorkspacesWithVerdicts: (...args: any[]) => listWorkspacesWithVerdicts(...args),
  fetchWorkspaceRemovability: (...args: any[]) => fetchWorkspaceRemovability(...args),
  listUnmanagedWorktrees: (...args: any[]) => listUnmanagedWorktrees(...args),
  adoptWorktrees: (...args: any[]) => adoptWorktrees(...args),
  archiveWorkspace: (...args: any[]) => archiveWorkspace(...args),
  listTrash: (...args: any[]) => listTrash(...args),
  restoreTrashEntry: (...args: any[]) => restoreTrashEntry(...args),
  renameWorkspace: (...args: any[]) => renameWorkspace(...args),
  WORKSPACE_NAME_MAX: 200,
}));

const WorkspaceManagerModal = (await import("./WorkspaceManagerModal")).default;

/**
 * The evaluated shape — what `GET /:id/removability` hands back for one record.
 * The listing returns {@link row}, which is this with the verdict taken off.
 */
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
    chatCount: 3,
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
    // Unterminated, like the real blocker details ("<cwd> has uncommitted
    // changes"). The confirmation has to punctuate them or the last one runs
    // into the sentence after it.
    blockers: [
      { code: "not-owned", detail: "Callboard did not create /home/cybil/callboard.feat-dirty — it was found on disk, so it is not ours to remove" },
      { code: "uncommitted-changes", detail: "/home/cybil/callboard.feat-dirty has uncommitted changes" },
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

/**
 * What the listing actually returns: the row, with the verdict stripped.
 *
 * Stripped rather than merely ignored, so a component that reached for
 * `removability` on a row would crash the test rather than quietly read a value
 * production does not send.
 */
function row({ removability: _verdict, ...rest }: WorkspaceWithRemovability): WorkspaceEntry {
  return rest;
}

/**
 * Every fixture, answered three ways — exactly as the backend answers them.
 *
 * The cheap listing drops the verdict; the "Check all" listing carries it; the
 * per-workspace fetch answers by id. Keeping the three consistent here is what
 * lets a test assert *which* of them a given interaction used.
 */
function evaluates(...evaluated: WorkspaceWithRemovability[]) {
  listWorkspaces.mockResolvedValue({ workspaces: evaluated.map(row) });
  listWorkspacesWithVerdicts.mockResolvedValue({ workspaces: evaluated });
  fetchWorkspaceRemovability.mockImplementation(async (id: string) => evaluated.find((w) => w.id === id));
}

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
  evaluates(workspace(), blocked, missing);
  listUnmanagedWorktrees.mockResolvedValue(unmanagedListing);
  listTrash.mockResolvedValue({ root: "/home/cybil/.callboard/trash", retentionDays: 30, entries: [] });
  adoptWorktrees.mockResolvedValue({ outcomes: [], adopted: 0, refused: 0 });
});

afterEach(cleanup);

function open(props: { focusCwd?: string } = {}) {
  return render(<WorkspaceManagerModal onClose={vi.fn()} repoCandidates={["/home/cybil/callboard"]} {...props} />);
}

/**
 * `fireEvent` rather than a bare `.click()`: React batches state updates, and a
 * native click dispatched outside `act` leaves the tree un-flushed — a test that
 * then asserts "no request went out" would pass for the wrong reason.
 */
function click(element: Element | null | undefined) {
  fireEvent.click(element as Element);
}

/**
 * Click the Archive button in the directory group for `cwd`, and wait for that
 * record's verdict to come back. The verdict is what chooses the confirmation,
 * so nothing is on screen to assert against until it has.
 */
async function archiveRow(cwd: string) {
  const group = (await screen.findByText(cwd)).parentElement as HTMLElement;
  click(
    within(group)
      .getAllByText(/^Archive…$/)[0]
      .closest("button"),
  );
  await waitFor(() => expect(fetchWorkspaceRemovability).toHaveBeenCalled());
}

/**
 * The scan, and the line it must not cross.
 *
 * Verdicts in bulk are ~150 synchronous git subprocesses — the cost this PR
 * exists to take off the automatic paths. They are worth paying for a scan
 * ("which of my sixty worktrees can I clean up?"), which is why the button
 * exists; they are never worth paying for someone who merely opened a modal,
 * which is why every test here is about *when* they are not fetched.
 */
describe("checking every workspace at once", () => {
  /**
   * The regression guard for the entire PR.
   *
   * Opening the modal, switching tabs and coming back, renaming, and archiving
   * must all leave the expensive listing untouched. Each of these was, at some
   * point in this feature's design, a plausible-sounding place to "just refresh
   * the verdicts".
   */
  it("fetches no verdicts on open, on tab switches, or after a mutation", async () => {
    renameWorkspace.mockResolvedValue({ ...workspace(), name: "Renamed" });
    archiveWorkspace.mockResolvedValue({
      workspace: workspace(),
      chats: [],
      worktree: { removed: true, disposition: "quarantined", path: "/x", trashPath: "/trash/x", blockers: [] },
    });

    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");
    expect(listWorkspacesWithVerdicts).not.toHaveBeenCalled();

    // Round trip through both other tabs and back.
    click(screen.getByText("Unmanaged worktrees"));
    click(screen.getByText("Trash"));
    click(screen.getByText("Workspaces"));
    await screen.findByText("/home/cybil/callboard.feat-clean");
    expect(listWorkspacesWithVerdicts).not.toHaveBeenCalled();

    // A rename.
    click(screen.getAllByTitle(/Rename this workspace/)[0]);
    const input = screen.getByLabelText("Rename callboard.feat-clean") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(renameWorkspace).toHaveBeenCalled());
    expect(listWorkspacesWithVerdicts).not.toHaveBeenCalled();

    // And a completed archive, which reloads the list.
    await archiveRow("/home/cybil/callboard.feat-clean");
    click((await screen.findByText("Archive and move to trash")).closest("button"));
    await waitFor(() => expect(archiveWorkspace).toHaveBeenCalled());
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    expect(listWorkspacesWithVerdicts).not.toHaveBeenCalled();
  });

  it("issues exactly one request, and only when the button is pressed", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");
    expect(listWorkspacesWithVerdicts).not.toHaveBeenCalled();

    click(screen.getByText("Check all").closest("button"));
    await waitFor(() => expect(listWorkspacesWithVerdicts).toHaveBeenCalledTimes(1));
    expect(listWorkspacesWithVerdicts).toHaveBeenCalledWith("active", true);
  });

  it("decorates every row with its blockers, which is the scan that was lost", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");
    // Nothing before the click: this is what the regression looked like. The
    // group chip already says the directory is gone; the *blocker* does not.
    expect(screen.queryByText("uncommitted changes")).toBeNull();
    expect(screen.getAllByText("directory is gone")).toHaveLength(1);

    click(screen.getByText("Check all").closest("button"));

    // Every blocker on the blocked record, labelled, with the backend's sentence.
    expect(await screen.findByText("uncommitted changes")).toBeTruthy();
    expect(screen.getByText(/has uncommitted changes/)).toBeTruthy();
    expect(screen.getAllByText("not owned by Callboard").length).toBeGreaterThan(0);
    expect(screen.getByText(/Adopting this worktree from the Unmanaged tab would clear that/)).toBeTruthy();
    // The record whose directory is gone now says so as a blocker as well as on
    // the group chip above it.
    expect(screen.getAllByText("directory is gone")).toHaveLength(2);
    // ...and the removable one is marked as such.
    expect(screen.getByText(/can be trashed/)).toBeTruthy();
  });

  /**
   * The cost is a foreground cost now, so it has to look like one.
   */
  it("disables the button and says it is working while the check runs", async () => {
    let release: (value: unknown) => void = () => {};
    listWorkspacesWithVerdicts.mockReturnValue(new Promise((resolve) => (release = resolve)));
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");

    click(screen.getByText("Check all").closest("button"));
    const checking = await screen.findByText("Checking…");
    expect((checking.closest("button") as HTMLButtonElement).disabled).toBe(true);
    // A second press while it runs would double the ~150 subprocesses.
    click(checking.closest("button"));
    expect(listWorkspacesWithVerdicts).toHaveBeenCalledTimes(1);

    release({ workspaces: [workspace(), blocked, missing] });
    await waitFor(() => expect(screen.getByText("Check all again")).toBeTruthy());
  });

  it("leaves the list usable and explains itself when the check fails", async () => {
    listWorkspacesWithVerdicts.mockRejectedValue(new Error("Failed to list workspaces: 500"));
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");

    click(screen.getByText("Check all").closest("button"));

    expect(await screen.findByText(/Failed to list workspaces: 500/)).toBeTruthy();
    // The rows are still there, still archivable, and the button is live again.
    expect(screen.getByText("/home/cybil/callboard.feat-clean")).toBeTruthy();
    expect(screen.getAllByText(/^Archive…$/).length).toBe(3);
    expect((screen.getByText("Check all").closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * Decoration is a point-in-time answer and has to read as one. Saying "checked
   * at 14:32" is the difference between a label and a promise.
   */
  it("dates the answer, and says so louder once something has changed underneath it", async () => {
    archiveWorkspace.mockResolvedValue({
      workspace: workspace(),
      chats: [],
      worktree: { removed: true, disposition: "quarantined", path: "/x", trashPath: "/trash/x", blockers: [] },
    });
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");
    click(screen.getByText("Check all").closest("button"));
    expect(await screen.findByText(/Checked at .*A point in time, not a live view/)).toBeTruthy();

    // Archiving can move another row's verdict — the ref-count is the obvious
    // case — so what is on screen is now out of date and must say so.
    await archiveRow("/home/cybil/callboard.feat-clean");
    click((await screen.findByText("Archive and move to trash")).closest("button"));

    expect(await screen.findByText(/before your last change/)).toBeTruthy();
    // Marked, not silently re-fetched: that would be the automatic bulk listing.
    expect(listWorkspacesWithVerdicts).toHaveBeenCalledTimes(1);
  });

  /**
   * The constraint that keeps one code path and one stale-verdict story: a
   * decorated row does not become the confirmation's source of truth. A bulk
   * verdict can be minutes old by the time somebody clicks.
   */
  it("still fetches a fresh verdict on click even when the row is already decorated", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");
    click(screen.getByText("Check all").closest("button"));
    await screen.findByText(/can be trashed/);

    // The bulk answer said removable. The fresh one says otherwise — someone
    // wrote into the worktree in between — and the fresh one is what decides.
    fetchWorkspaceRemovability.mockResolvedValue({
      ...workspace(),
      removability: { removable: false, blockers: [{ code: "untracked-files", detail: "/home/cybil/callboard.feat-clean has untracked files" }] },
    });
    await archiveRow("/home/cybil/callboard.feat-clean");

    expect(await screen.findByText(/Archive the record for/)).toBeTruthy();
    expect(screen.queryByText("Archive and move to trash")).toBeNull();
  });
});

describe("the workspaces tab", () => {
  /**
   * The listing is the thing that used to freeze the daemon, and it did it by
   * asking for a verdict per record. Drawing the list must therefore cost zero
   * of them — not "fewer", zero.
   */
  it("draws the whole list without evaluating a single workspace for removal", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
    expect(fetchWorkspaceRemovability).not.toHaveBeenCalled();
  });

  it("offers exactly one archive control per workspace and none that acts on many", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");
    // Three records, three archive controls — and each one names a single
    // workspace. No control anywhere claims a selection.
    expect(screen.getAllByText(/^Archive…$/)).toHaveLength(3);
    expect(screen.queryByText(/Archive all|Archive selected|Clean up all|Select all/i)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  /**
   * The verdict is fetched for the record the user pointed at, and for no
   * other. A click that evaluated its neighbours would put the freeze back one
   * button at a time.
   */
  it("evaluates only the workspace whose archive was clicked", async () => {
    open();
    await archiveRow("/home/cybil/callboard.feat-dirty");
    expect(fetchWorkspaceRemovability).toHaveBeenCalledTimes(1);
    expect(fetchWorkspaceRemovability).toHaveBeenCalledWith("ws-dirty");
  });

  it("does not archive anything until the confirmation is passed", async () => {
    open();
    await archiveRow("/home/cybil/callboard.feat-clean");
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
   *
   * Since the row no longer carries a verdict, the confirmation is where every
   * blocker has to be named. All of them, with their labels: a user who fixes
   * one and finds another waiting has learned nothing about what to do next.
   */
  it("shows every blocker instead of an action it cannot perform", async () => {
    open();
    await archiveRow("/home/cybil/callboard.feat-dirty");
    expect(await screen.findByText(/Archive the record for/)).toBeTruthy();
    expect(screen.queryByText("Archive and move to trash")).toBeNull();

    const message = document.body.textContent ?? "";
    expect(message).toContain("not owned by Callboard — Callboard did not create /home/cybil/callboard.feat-dirty");
    expect(message).toContain("uncommitted changes — /home/cybil/callboard.feat-dirty has uncommitted changes.");
    expect(message).toContain("Adopting this worktree from the Unmanaged tab would clear that.");
    // Each blocker is terminated, so the last one does not run into the
    // sentence that follows it.
    expect(message).toContain("so it is not ours to remove. uncommitted changes");
    expect(message).not.toContain("uncommitted changes Adopting");
  });

  /**
   * The one thing about removability a row can say without asking git: a
   * worktree Callboard did not create is never removable, and that is on the
   * record itself.
   */
  it("marks an unowned worktree on the row, from the record alone", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-dirty");
    expect(screen.getByText("not owned by Callboard")).toBeTruthy();
    expect(fetchWorkspaceRemovability).not.toHaveBeenCalled();
  });

  it("says plainly that a record's directory is gone", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-gone");
    // The chip on the group and the blocker on the record both say it.
    expect(screen.getAllByText("directory is gone").length).toBeGreaterThan(0);
    expect(screen.getByText(/does not exist\. Callboard has not touched it\./)).toBeTruthy();
  });

  /**
   * The confirmation's chat sentence, driven by the real caller.
   *
   * `chatCount` was an optional prop that **no caller passed**, so the sentence
   * was dead in production while ArchiveWorkspaceConfirm's own test — which
   * supplied the number by hand — stayed green. That is a test proving a
   * behaviour the shipped UI did not have. This one goes through the component
   * that actually renders the confirmation, so it cannot pass unless the wiring
   * is there.
   */
  it("tells the user how many chats the archive will interrupt", async () => {
    evaluates(workspace({ chatCount: 4 }));
    open();
    await archiveRow("/home/cybil/callboard.feat-clean");

    expect(await screen.findByText(/4 chats in this workspace will be interrupted and archived/)).toBeTruthy();
  });

  /**
   * The record-only path said "This marks the workspace record archived and
   * nothing else." It kills every live session linked to the workspace: the
   * interrupt-and-stamp happens before the removability gate is even
   * evaluated, so it runs on exactly this path too.
   */
  it("does not pretend the record-only archive leaves running chats alone", async () => {
    evaluates(blocked);
    open();
    await archiveRow("/home/cybil/callboard.feat-dirty");

    expect(await screen.findByText(/3 chats linked to this workspace are interrupted and archived first/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("archived and nothing else");
  });

  /**
   * The verdict call does not measure disk usage — putting a synchronous `du`
   * on the click path is the thing this change exists to stop — so the size the
   * listing already measured has to survive the merge into the confirmation.
   * "This directory moves → ~/.callboard/trash" with no size next to it is the
   * regression.
   */
  it("shows the size the listing measured, without re-measuring on the click", async () => {
    const measured = workspace();
    listWorkspaces.mockResolvedValue({ workspaces: [row(measured)] });
    // What the verdict endpoint really returns: no diskUsage key at all.
    fetchWorkspaceRemovability.mockResolvedValue({ ...measured, diskUsage: undefined });
    open();
    await archiveRow("/home/cybil/callboard.feat-clean");

    expect(await screen.findByText(/~\/\.callboard\/trash · 5\.0 GB/)).toBeTruthy();
  });

  /**
   * The click path now has a network hop, so it now has a way to fail. A
   * verdict that did not arrive is not a verdict: no confirmation may open on
   * one, because the two confirmations describe *different actions* and picking
   * between them is the only thing the verdict is for. Guessing would mean
   * showing "this directory moves to the trash" for a workspace nobody has
   * established is removable.
   */
  it("opens no confirmation when the verdict cannot be fetched, and says so", async () => {
    fetchWorkspaceRemovability.mockRejectedValue(new Error("Failed to evaluate the workspace: 500"));
    open();
    await archiveRow("/home/cybil/callboard.feat-clean");

    expect(await screen.findByText(/Failed to evaluate the workspace: 500/)).toBeTruthy();
    // Neither confirmation, in either direction.
    expect(screen.queryByText(/and move its worktree to the trash\?/)).toBeNull();
    expect(screen.queryByText(/Archive the record for/)).toBeNull();
    expect(archiveWorkspace).not.toHaveBeenCalled();
    // And the row is usable again rather than stuck on "Checking…".
    await waitFor(() => expect(screen.getAllByText(/^Archive…$/).length).toBeGreaterThan(0));
    expect((screen.getAllByText(/^Archive…$/)[0].closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * The window the verdict fetch opened. Before it, a click opened a modal
   * synchronously and the overlay swallowed everything after it; now there is a
   * gap in which a second row's button is still on screen — and this is a
   * surface whose whole premise is a daemon under load, so the gap is not
   * always ~120ms. Two stacked confirmations, each correctly scoped to its own
   * record, with the second click silently discarded behind the first.
   */
  it("will not let a second archive be started while a verdict is in flight", async () => {
    let release: (value: WorkspaceWithRemovability) => void = () => {};
    fetchWorkspaceRemovability.mockReturnValue(new Promise((resolve) => (release = resolve)));
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");

    const buttons = () => screen.getAllByText(/^Archive…$|^Checking…$/).map((el) => el.closest("button") as HTMLButtonElement);
    click(buttons()[0]);
    await waitFor(() => expect(screen.getByText("Checking…")).toBeTruthy());

    // Every archive button is inert while one verdict is outstanding, so the
    // second click is refused rather than dropped.
    for (const button of buttons()) expect(button.disabled).toBe(true);
    click(buttons()[1]);
    expect(fetchWorkspaceRemovability).toHaveBeenCalledTimes(1);

    release(workspace());
    // Exactly one confirmation, for the record that was actually clicked.
    expect(await screen.findByText(/Archive .*and move its worktree to the trash\?/)).toBeTruthy();
    expect(screen.queryByText(/Archive the record for/)).toBeNull();
    expect(screen.getAllByRole("button", { name: /Archive and move to trash/ })).toHaveLength(1);
  });

  /**
   * The other half of "exactly one": the two targets are set as a pair, so a
   * verdict that opens one confirmation closes the other. Without that, a
   * blocked record evaluated after a removable one would stack its dialog on
   * top of a still-mounted first.
   */
  it("replaces the open confirmation rather than stacking a second one", async () => {
    open();
    await archiveRow("/home/cybil/callboard.feat-clean");
    expect(await screen.findByText(/and move its worktree to the trash\?/)).toBeTruthy();

    // Dismiss nothing — go straight at the blocked record, as a user who
    // clicked past the overlay would.
    fetchWorkspaceRemovability.mockClear();
    await archiveRow("/home/cybil/callboard.feat-dirty");

    expect(await screen.findByText(/Archive the record for/)).toBeTruthy();
    expect(screen.queryByText(/and move its worktree to the trash\?/)).toBeNull();
  });

  /**
   * Archiving ends by running the retention sweep, which permanently deletes
   * every past-retention trash entry — including entries from workspaces the
   * user never touched. It was logged and never surfaced.
   */
  it("reports what the retention sweep deleted on the way out", async () => {
    archiveWorkspace.mockResolvedValue({
      workspace: workspace(),
      chats: [],
      worktree: { removed: true, disposition: "quarantined", path: "/home/cybil/callboard.feat-clean", trashPath: "/trash/ws-clean-2026", blockers: [] },
      trashSweep: { removed: ["ws-old-2026-01-01", "ws-older-2025-12-01"] },
    });
    open();
    await archiveRow("/home/cybil/callboard.feat-clean");
    click((await screen.findByText("Archive and move to trash")).closest("button"));

    expect(await screen.findByText(/permanently deleted 2 trash entries/)).toBeTruthy();
    expect(screen.getByText(/ws-old-2026-01-01, ws-older-2025-12-01/)).toBeTruthy();
  });

  it("asks for sizes, since that is the number the cleanup is about", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");
    // Sizes yes, verdicts no: `du` is memoised for five minutes and bounded by
    // a shared wall-clock budget, which is what makes it affordable per listing
    // where the removal verdict is not.
    expect(listWorkspaces).toHaveBeenCalledWith("active", true);
    expect(screen.getAllByText("5.0 GB").length).toBeGreaterThan(0);
  });
});

/**
 * Rename (Phase 4b). Per record, because the name belongs to a record and a
 * directory may hold several — and record-only, because a name is a label and
 * nothing derives a path from it.
 */
describe("renaming a workspace", () => {
  /** The first record on the list — `workspace()`, the removable one. */
  async function startRename(name = "callboard.feat-clean") {
    open();
    await screen.findByText(`/home/cybil/${name}`);
    click(screen.getAllByTitle(/Rename this workspace/)[0]);
    return screen.getByLabelText(`Rename ${name}`) as HTMLInputElement;
  }

  it("sends the new name and says that nothing on disk moved", async () => {
    renameWorkspace.mockResolvedValue({ ...workspace(), name: "Clean one" });
    const input = await startRename();
    fireEvent.change(input, { target: { value: "Clean one" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(renameWorkspace).toHaveBeenCalledWith("ws-clean", "Clean one"));
    expect(await screen.findByText(/Nothing on disk moved/)).toBeTruthy();
    // Patched in place: the rename response already carries the only field a
    // rename can change, so a refetch would re-`du` every directory and redraw
    // the list under a user who is still reading it.
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
    // Both the record and the group heading it names, since one record claims
    // this directory — the same rule the sidebar row follows.
    expect(screen.getAllByText("Clean one")).toHaveLength(2);
  });

  /**
   * The one mutation on this surface with no confirmation. That is deliberate —
   * it is undone by typing the old name back — but it must therefore also be
   * the one mutation that cannot touch a directory, so the control offers
   * nothing but the name.
   */
  it("offers one rename per record, and opening the editor sends nothing", async () => {
    open();
    await screen.findByText("/home/cybil/callboard.feat-clean");
    // Three records on the list, three rename controls: the name belongs to a
    // record, not to the directory group above it.
    const controls = screen.getAllByTitle(/Rename this workspace/);
    expect(controls).toHaveLength(3);
    // …and each says what it will and will not do, on the control itself.
    expect(screen.getAllByTitle(/the directory, the branch and the worktree are not touched/i)).toHaveLength(3);
    click(controls[0]);
    expect(renameWorkspace).not.toHaveBeenCalled();
  });

  it("keeps the editor open with the rejected text when the server refuses a name", async () => {
    renameWorkspace.mockRejectedValue(new Error("A workspace name may not contain control or text-direction characters (found U+000A at position 5)"));
    const input = await startRename();
    fireEvent.change(input, { target: { value: "bad name" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText(/may not contain control or text-direction characters/)).toBeTruthy();
    expect((screen.getByLabelText("Rename callboard.feat-clean") as HTMLInputElement).value).toBe("bad name");
  });

  it("sends nothing when the name did not change", async () => {
    const input = await startRename();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameWorkspace).not.toHaveBeenCalled();
  });
});

/**
 * The drill-down a sidebar row links to. The row is per-directory and cannot
 * say *which* record it would act on when there are two — this is where that is
 * resolved, so it has to arrive filtered, say that it is filtered, and offer a
 * way back.
 */
describe("opening on one directory", () => {
  it("shows only that directory, says so, and can show the rest", async () => {
    open({ focusCwd: "/home/cybil/callboard.feat-dirty" });
    await screen.findByText("/home/cybil/callboard.feat-dirty");
    expect(screen.queryByText("/home/cybil/callboard.feat-clean")).toBeNull();
    expect(screen.getByText(/Showing 1 of 3 directories/)).toBeTruthy();

    click(screen.getByText("Show all").closest("button"));
    expect(await screen.findByText("/home/cybil/callboard.feat-clean")).toBeTruthy();
  });

  it("says the record is not there rather than showing an empty list", async () => {
    open({ focusCwd: "/home/cybil/somewhere-else" });
    expect(await screen.findByText(/No active workspace record for \/home\/cybil\/somewhere-else/)).toBeTruthy();
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

  async function restoreOnce(result: Record<string, unknown>) {
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
    restoreTrashEntry.mockResolvedValue({ entry: "ws-1-2026", originalPath: "/home/cybil/callboard.feat-old", trashRetained: true, ...result });
    open();
    click(screen.getByText("Trash"));
    click((await screen.findByText("Restore")).closest("button"));
    click(screen.getAllByRole("button", { name: "Restore" }).at(-1));
    await waitFor(() => expect(restoreTrashEntry).toHaveBeenCalled());
  }

  /**
   * `skippedEntries` came back from the API and nothing rendered it. Even shown
   * raw it reads as "git already had those" rather than as anything a user
   * could act on, so the count is stated in terms of what actually happened:
   * git wrote those paths, and they were left exactly as it wrote them.
   */
  it("states what the restore left alone, not just what it copied", async () => {
    await restoreOnce({ ok: true, copiedEntries: 12, skippedEntries: ["backend/server.js"], skippedCount: 431, branchOutcome: "branch" });
    expect(await screen.findByText(/12 files that git does not track were copied back/)).toBeTruthy();
    expect(screen.getByText(/431 paths already existed and were left exactly as git checked it out/)).toBeTruthy();
  });

  /**
   * The paths a restore could NOT bring back are the only part a user can act
   * on — the originals are still in the trash entry, and the sweep will take
   * them. Collapsing this to "the restore failed" is how they get lost.
   */
  it("names the paths that were not restored and says where they still are", async () => {
    await restoreOnce({
      ok: false,
      copiedEntries: 2,
      failedEntries: [{ path: "node_modules/locked", error: "could not be read (EACCES)" }],
      failedCount: 1,
      failure: { code: "copy-failed", detail: "1 path(s) could not be copied and are still only in the trash." },
    });
    expect(await screen.findByText(/node_modules\/locked \(could not be read \(EACCES\)\)/)).toBeTruthy();
    expect(screen.getByText(/Copy them out by hand before the retention sweep takes it/)).toBeTruthy();
  });

  /**
   * A restore that had to detach because the branch moved is not the same
   * outcome as one that followed the branch, and the difference is which
   * commit is now checked out. Saying so is the visible half of the manifest
   * recording a SHA at all.
   */
  it("says when it had to detach because the branch no longer points at that commit", async () => {
    await restoreOnce({ ok: true, copiedEntries: 1, branchOutcome: "detached", restoredCommit: "d72a6f21cafe0000000000000000000000000000" });
    expect(await screen.findByText(/recreated detached at d72a6f21/)).toBeTruthy();
    expect(screen.getByText(/Nothing followed the branch name to a different tree/)).toBeTruthy();
  });
});
