// @vitest-environment jsdom
/**
 * The human step that closes Phase 2b's stated gap.
 *
 * `POST /api/workspaces/adopt` takes paths and trusts them; the plan says
 * outright that the backend cannot distinguish "the user named this path" from
 * "an agent named it", and that a human confirmation is the only real fix. This
 * component is that fix, so the test that matters is the boring one: **every
 * path is rendered in full**, because a user who agreed to "12 worktrees" has
 * not agreed to the twelve.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { UnmanagedWorktree } from "../api";
import AdoptWorktreesConfirm from "./AdoptWorktreesConfirm";

afterEach(cleanup);

function makeWorktree(over: Partial<UnmanagedWorktree> = {}): UnmanagedWorktree {
  return {
    path: "/home/cybil/callboard.feat-a",
    branch: "feat/a",
    repoPath: "/home/cybil/callboard",
    naming: { convention: "current", matches: true, detail: "matches the current convention — a guess, not proof" },
    cleanliness: { clean: true, uncommittedChanges: false, untrackedFiles: false, unpushedCommits: false },
    ignored: { entries: [".env"], truncated: false },
    diskUsage: { bytes: 2_147_483_648 },
    adoptable: true,
    adoptionBlockers: [],
    ...over,
  };
}

function renderConfirm(worktrees: UnmanagedWorktree[], busy?: boolean) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<AdoptWorktreesConfirm worktrees={worktrees} busy={busy} onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel };
}

describe("naming every path", () => {
  it("renders each selected path in full, not a count", () => {
    const paths = ["/home/cybil/callboard.feat-a", "/home/cybil/callboard.feat-b", "/home/cybil/other-repo.wip"];
    renderConfirm(paths.map((path) => makeWorktree({ path })));
    for (const path of paths) expect(screen.getByText(path)).toBeTruthy();
  });

  it("shows the branch and size next to each one", () => {
    renderConfirm([makeWorktree()]);
    expect(screen.getByText("feat/a")).toBeTruthy();
    expect(screen.getByText("· 2.0 GB")).toBeTruthy();
  });

  it("flags a candidate that has work in it", () => {
    renderConfirm([makeWorktree({ cleanliness: { clean: false, uncommittedChanges: true, untrackedFiles: false, unpushedCommits: true } })]);
    expect(screen.getByText(/has uncommitted or unpushed work/)).toBeTruthy();
  });
});

describe("what adoption is and is not", () => {
  /**
   * A user who reads "adopt" as "clean up" will click it far too readily, and
   * the copy is the only thing standing between that reading and the truth:
   * adoption writes a token and a record, and removes nothing.
   */
  it("says that nothing is deleted, moved or modified", () => {
    renderConfirm([makeWorktree()]);
    expect(screen.getByText(/does not delete, move or modify anything/)).toBeTruthy();
    expect(screen.getByText(/Removal stays a separate, per-worktree action/)).toBeTruthy();
  });
});

describe("the click itself", () => {
  it("does nothing until confirmed", () => {
    const { onConfirm } = renderConfirm([makeWorktree(), makeWorktree({ path: "/home/cybil/b" })]);
    expect(onConfirm).not.toHaveBeenCalled();
    (screen.getByText("Adopt these 2").closest("button") as HTMLButtonElement).click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cannot be double-fired while adoption is running", () => {
    const { onConfirm } = renderConfirm([makeWorktree()], true);
    const button = screen.getByText("Adopting…").closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    button.click();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
