// @vitest-environment jsdom
/**
 * The branch box, after three controls collapsed to two.
 *
 * Two things are asserted about every state: the `BranchConfig` it emits, and
 * the sentence it shows. They are not the same assertion — the emitted config is
 * what the backend acts on, and the sentence is the only place the user finds
 * out. Before this rewrite the box was silent in every state, including the one
 * where picking a branch that already lives in another worktree sends the whole
 * chat to that directory and leaves the current checkout untouched. That
 * behaviour is not new and is not changed here; it is merely no longer secret,
 * which is why it gets the most coverage below.
 *
 * The sticky toggle is asserted through `localStorage` rather than through
 * component state, on the new `worktreeByDefault` key. Reusing the old
 * `useWorktree` key would have been the natural thing and is exactly wrong: a
 * stored `true` was written under semantics where the checkbox was disabled
 * unless a branch change was already pending, so it never meant "isolate my
 * chats by default".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BranchConfig, CheckedOutBranch } from "../api";
import BranchSelector from "./BranchSelector";

const getGitBranches = vi.fn();

vi.mock("../api", () => ({
  getGitBranches: (folder: string) => getGitBranches(folder),
}));

const REPO = "/home/cybil/callboard";
const WORKTREE = "/home/cybil/callboard.feat-a";

/** The default answer: three branches, only the main checkout occupied. */
function stubBranches(over: { branches?: string[]; checkedOut?: CheckedOutBranch[] | undefined } = {}) {
  getGitBranches.mockResolvedValue({
    branches: over.branches ?? ["main", "feat/y", "feat/a"],
    ...("checkedOut" in over ? { checkedOut: over.checkedOut } : { checkedOut: [{ branch: "main", path: REPO, isMainWorktree: true }] }),
  });
}

beforeEach(() => {
  localStorage.clear();
  getGitBranches.mockReset();
  stubBranches();
});

afterEach(cleanup);

/** Render and wait for the branch list to arrive, so the select is real. */
async function open(props: { folder?: string; currentBranch?: string; isDetached?: boolean } = {}) {
  const onChange = vi.fn<(config: BranchConfig | null) => void>();
  render(
    <BranchSelector folder={props.folder ?? REPO} currentBranch={props.currentBranch ?? "main"} isDetached={props.isDetached} onChange={onChange} />,
  );
  await screen.findByLabelText("Base branch");
  return { onChange };
}

/** The most recent config the box handed to its parent — `null` when the typed name is invalid. */
function emitted(onChange: ReturnType<typeof vi.fn>): BranchConfig | null {
  expect(onChange).toHaveBeenCalled();
  return onChange.mock.calls[onChange.mock.calls.length - 1][0];
}

/** The summary sentence as one whitespace-normalized string. */
function summary(): string {
  return (screen.getByTestId("branch-summary").textContent ?? "").replace(/\s+/g, " ").trim();
}

const toggle = () => screen.getByLabelText(/New worktree/) as HTMLInputElement;
const nameField = () => screen.getByLabelText("New branch name") as HTMLInputElement;
const baseSelect = () => screen.getByLabelText("Base branch") as HTMLSelectElement;

const type = (value: string) => fireEvent.change(nameField(), { target: { value } });
const pickBase = (value: string) => fireEvent.change(baseSelect(), { target: { value } });

describe("the state table", () => {
  it("toggle off, nothing typed: emits nothing and says so", async () => {
    const { onChange } = await open();

    expect(emitted(onChange)).toEqual({});
    expect(summary()).toBe("Runs here on main. No branch or worktree change.");
  });

  it("toggle on, name empty: asks for a generated name, and says the name comes from the message", async () => {
    const { onChange } = await open();

    fireEvent.click(toggle());

    expect(emitted(onChange)).toEqual({ useWorktree: true, autoCreateBranch: true, baseBranch: "main" });
    expect(summary()).toBe("Will create a new worktree off main, on a branch named from your first message.");
  });

  /**
   * `autoCreateBranch` is dropped the moment a name exists. The pair
   * `useWorktree` + no `newBranch` already means "check out this existing branch
   * in a worktree" to the backend, so the flag has to be explicit in one state
   * and absent in the other — inferring it from the pair would redefine what
   * every other caller of the route is asking for.
   */
  it("toggle on with a name: creates that branch in a new worktree, named after it", async () => {
    const { onChange } = await open();

    fireEvent.click(toggle());
    type("feat/x");

    expect(emitted(onChange)).toEqual({ useWorktree: true, baseBranch: "main", newBranch: "feat/x" });
    expect(summary()).toBe("Will create callboard.feat-x on new branch feat/x, off main. If that directory already exists, the chat runs in it as it is.");
  });

  it("toggle off with a name: creates the branch here", async () => {
    const { onChange } = await open();

    type("feat/x");

    expect(emitted(onChange)).toEqual({ baseBranch: "main", newBranch: "feat/x" });
    expect(summary()).toBe("Will create branch feat/x off main in this checkout.");
  });

  it("toggle off, a different base with no worktree: switches this checkout", async () => {
    const { onChange } = await open();

    pickBase("feat/y");

    expect(emitted(onChange)).toEqual({ baseBranch: "feat/y" });
    expect(summary()).toBe("Will switch this checkout to feat/y.");
  });

  /** Leading and trailing space is not a branch name, so it is not a new branch. */
  it("treats a whitespace-only name as empty", async () => {
    const { onChange } = await open();

    type("   ");

    expect(emitted(onChange)).toEqual({});
    expect(summary()).toBe("Runs here on main. No branch or worktree change.");
  });
});

describe("a branch that is checked out somewhere else", () => {
  /**
   * The row this rewrite exists for. The emitted config is byte-for-byte what
   * the old box emitted — only the sentence is new, because the redirect it
   * describes has always happened and has never been mentioned.
   */
  it("says where the chat will actually run, and that this checkout is safe", async () => {
    stubBranches({
      checkedOut: [
        { branch: "main", path: REPO, isMainWorktree: true },
        { branch: "feat/y", path: "/home/cybil/callboard.feat-y", isMainWorktree: false },
      ],
    });
    const { onChange } = await open();

    pickBase("feat/y");

    expect(emitted(onChange)).toEqual({ baseBranch: "feat/y" });
    expect(summary()).toBe("feat/y is checked out at callboard.feat-y — the chat will run there. This checkout is untouched.");
  });

  /**
   * The redirect is symmetric, and this is the direction nobody expects: start
   * a chat inside a worktree, pick `main`, and the chat runs in the main
   * checkout. `isMainWorktree` is not a reason to stay silent.
   */
  it("is symmetric — from a worktree, picking main redirects into the main checkout", async () => {
    stubBranches({
      checkedOut: [
        { branch: "main", path: REPO, isMainWorktree: true },
        { branch: "feat/a", path: WORKTREE, isMainWorktree: false },
      ],
    });
    await open({ folder: WORKTREE, currentBranch: "feat/a" });

    pickBase("main");

    expect(summary()).toBe("main is checked out at callboard — the chat will run there. This checkout is untouched.");
  });

  /**
   * The listing includes the directory you are standing in, and reporting that
   * as a redirect would say the chat is going somewhere else when it is going
   * nowhere at all.
   *
   * What this pins is the *early exit*, not the path filter: the target is the
   * branch this folder is on, so the ladder answers before the listing is
   * consulted at all. That is worth a test of its own — the exit is what keeps
   * the sentence true when the endpoint sends no listing — but it is not
   * coverage of `wt.path !== here`, which the sibling below reaches.
   */
  it("answers 'nothing changes' without consulting the listing", async () => {
    stubBranches({
      checkedOut: [{ branch: "feat/a", path: WORKTREE, isMainWorktree: false }],
    });
    await open({ folder: WORKTREE, currentBranch: "feat/a" });

    expect(summary()).toBe("Runs here on feat/a. No branch or worktree change.");
  });

  /**
   * The path filter, reached. `currentBranch` and `checkedOut` come from two
   * different requests at two different moments, so they disagree whenever
   * something switches the branch in this directory in between — an agent in
   * another chat, a terminal, the user. The listing is then the fresher of the
   * two and says `feat/y` is checked out *here*, while the box still believes
   * `main`.
   *
   * Without `wt.path !== here` the box reads its own directory out of the
   * listing and calls it a redirect: "the chat will run there. This checkout is
   * untouched" — about the very checkout it is describing. `switchBranch`
   * applies the same exclusion, finds no other worktree, and checks the branch
   * out here, which is what the sentence below says.
   */
  it("does not call this very directory 'elsewhere' when the listing is fresher than the branch it was told", async () => {
    stubBranches({
      checkedOut: [{ branch: "feat/y", path: REPO, isMainWorktree: true }],
    });
    await open();

    type("feat/y");

    expect(summary()).toBe("feat/y already exists — will switch this checkout to it.");
  });

  /**
   * A new worktree branches *off* the base; it does not take it over. So an
   * occupied base is not a redirect and must not be described as one.
   */
  it("stays quiet about an occupied base when a new worktree is being made off it", async () => {
    stubBranches({
      checkedOut: [
        { branch: "main", path: REPO, isMainWorktree: true },
        { branch: "feat/y", path: "/home/cybil/callboard.feat-y", isMainWorktree: false },
      ],
    });
    await open();

    fireEvent.click(toggle());
    pickBase("feat/y");

    expect(summary()).toBe("Will create a new worktree off feat/y, on a branch named from your first message.");
  });

  /**
   * A daemon older than this bundle sends no `checkedOut` at all. Absence is
   * unknown, not "nothing is checked out", so the box falls back to the
   * sentence it would have shown before the field existed rather than asserting
   * a switch it cannot vouch for... which is the same sentence. The point of
   * pinning it is that the missing key must not throw.
   */
  it("survives a response with no checkedOut field", async () => {
    stubBranches({ checkedOut: undefined });
    const { onChange } = await open();

    pickBase("feat/y");

    expect(emitted(onChange)).toEqual({ baseBranch: "feat/y" });
    expect(summary()).toBe("Will switch this checkout to feat/y.");
  });
});

/**
 * `loading` and `error` used to gate only the `<select>`. The sentence rendered
 * off `branches = []` and `checkedOut = []` regardless, and in this ladder an
 * empty listing reads as "the branch does not exist" and "it is checked out
 * nowhere" — the optimistic end of every rung. So mid-fetch, and permanently
 * after a failed fetch, the box asserted creation for a branch it had not been
 * told anything about.
 */
describe("a branch listing that has not arrived, or never will", () => {
  /** A request that stays in flight, so the wait itself is the state under test. */
  const stubPending = () => getGitBranches.mockReturnValue(new Promise(() => {}));

  it("does not claim a name is new while the listing is still loading", () => {
    stubPending();
    render(<BranchSelector folder={REPO} currentBranch="main" onChange={vi.fn()} />);

    type("feat/y");
    expect(summary()).toBe("Still loading this repository's branches — cannot say yet whether feat/y exists, or where the chat will run.");

    fireEvent.click(toggle());
    expect(summary()).toBe("Still loading this repository's branches — cannot say yet whether feat/y exists, or where the chat will run.");
  });

  /**
   * The failed fetch is the worse of the two, because it never resolves into
   * anything: the box would have gone on saying "Will create branch `feat/y`"
   * for as long as the compose screen was open.
   */
  it("says it cannot tell after a failed fetch, rather than promising creation", async () => {
    getGitBranches.mockRejectedValue(new Error("not a git repository"));
    render(<BranchSelector folder={REPO} currentBranch="main" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("not a git repository")).toBeTruthy());

    type("feat/y");

    expect(summary()).toBe("Could not load this repository's branches — cannot say whether feat/y exists, or where the chat will run.");
  });

  /**
   * `folder` is a query parameter, not a remount key, so a folder change
   * re-runs the fetch underneath a component that keeps everything it already
   * had. The picked base outlives the repository it was picked in, and the
   * redirect sentence — the row this rewrite exists for — went on describing a
   * worktree in a repository the user had left.
   */
  it("stops describing the previous repository the moment the folder changes", async () => {
    stubBranches({
      checkedOut: [
        { branch: "main", path: REPO, isMainWorktree: true },
        { branch: "feat/y", path: "/home/cybil/callboard.feat-y", isMainWorktree: false },
      ],
    });
    const view = render(<BranchSelector folder={REPO} currentBranch="main" onChange={vi.fn()} />);
    await screen.findByLabelText("Base branch");
    pickBase("feat/y");
    expect(summary()).toBe("feat/y is checked out at callboard.feat-y — the chat will run there. This checkout is untouched.");

    stubPending();
    view.rerender(<BranchSelector folder="/home/cybil/other-repo" currentBranch="main" onChange={vi.fn()} />);

    expect(summary()).toBe("Still loading this repository's branches — cannot say yet whether feat/y exists, or where the chat will run.");
  });

  /**
   * Two folder changes in flight land in the order the server answers them, not
   * the order they were asked. Without the guard the slower first request wins
   * by arriving last, and the box describes a repository nobody is looking at.
   */
  it("ignores a listing that arrives after the folder has moved on", async () => {
    let answerFirst: (value: { branches: string[]; checkedOut: CheckedOutBranch[] }) => void = () => {};
    getGitBranches.mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)));
    const view = render(<BranchSelector folder={REPO} currentBranch="main" onChange={vi.fn()} />);

    stubPending();
    view.rerender(<BranchSelector folder="/home/cybil/other-repo" currentBranch="main" onChange={vi.fn()} />);
    await act(async () => answerFirst({ branches: ["main", "feat/y"], checkedOut: [] }));

    type("feat/y");
    expect(summary()).toBe("Still loading this repository's branches — cannot say yet whether feat/y exists, or where the chat will run.");
  });
});

/**
 * The sentence describes the *target* branch — the typed name when there is
 * one, the base branch otherwise — and follows the same ladder the backend
 * walks: is a worktree already on it, does it exist at all, otherwise create.
 *
 * None of this changes a single emitted config. Every case below is the box
 * telling the truth about a request it was already making.
 */
describe("a typed name that is not new", () => {
  const occupiedElsewhere: CheckedOutBranch[] = [
    { branch: "main", path: REPO, isMainWorktree: true },
    { branch: "feat/y", path: "/home/cybil/callboard.feat-y", isMainWorktree: false },
  ];

  it("worktree on, name already has a worktree: names the directory the chat will land in", async () => {
    stubBranches({ checkedOut: occupiedElsewhere });
    const { onChange } = await open();

    fireEvent.click(toggle());
    type("feat/y");

    // Unchanged request — `ensureWorktreeDetailed` finds the branch checked out
    // and hands back that path instead of making anything.
    expect(emitted(onChange)).toEqual({ useWorktree: true, baseBranch: "main", newBranch: "feat/y" });
    expect(summary()).toBe("feat/y is checked out at callboard.feat-y — the chat will run there.");
  });

  it("worktree on, name exists with no worktree: says it will be checked out, not created", async () => {
    stubBranches();
    const { onChange } = await open();

    fireEvent.click(toggle());
    type("feat/y");

    expect(emitted(onChange)).toEqual({ useWorktree: true, baseBranch: "main", newBranch: "feat/y" });
    expect(summary()).toBe("feat/y already exists — will check it out in a new worktree at callboard.feat-y. If that directory already exists, the chat runs in it as it is.");
  });

  /**
   * `ensureWorktreeDetailed`'s *first* rung, which the box used to skip
   * entirely: `existsSync(derivedPath)` reuses whatever is at that path before
   * asking a single question about the branch. Someone ran `git switch other`
   * inside `callboard.feat-y`, so asking for a worktree on `feat/y` runs the
   * chat there, on `other` — and the box used to say it would check `feat/y`
   * out somewhere new.
   *
   * Detectable only because `checkedOut` carries paths: the directory is still
   * a worktree of this repo, merely on a different branch.
   */
  it("worktree on, the derived directory is a worktree that moved to another branch", async () => {
    stubBranches({
      branches: ["main", "feat/y", "other"],
      checkedOut: [
        { branch: "main", path: REPO, isMainWorktree: true },
        { branch: "other", path: "/home/cybil/callboard.feat-y", isMainWorktree: false },
      ],
    });
    const { onChange } = await open();

    fireEvent.click(toggle());
    type("feat/y");

    // The request is unchanged and still asks for `feat/y` — the resolver just
    // never gets as far as looking at it.
    expect(emitted(onChange)).toEqual({ useWorktree: true, baseBranch: "main", newBranch: "feat/y" });
    expect(summary()).toBe("callboard.feat-y already exists and is on other — the chat will run there, on other rather than feat/y.");
  });

  /**
   * The directory check outranks the branch you are standing on, because it
   * does in the resolver: `existsSync` is asked first and returns before
   * `getGitWorktrees` is ever called. Ordering the box's rungs the other way
   * round would claim the worktree request was simply dropped, when the chat is
   * in fact leaving this directory for another one.
   */
  it("puts the directory check ahead of the branch this checkout is on", async () => {
    stubBranches({
      branches: ["main", "other"],
      checkedOut: [
        { branch: "main", path: REPO, isMainWorktree: true },
        { branch: "other", path: "/home/cybil/callboard.main", isMainWorktree: false },
      ],
    });
    await open();

    fireEvent.click(toggle());
    type("main");

    expect(summary()).toBe("callboard.main already exists and is on other — the chat will run there, on other rather than main.");
  });

  /**
   * A worktree elsewhere on the same repo does not become "the derived
   * directory" by having a similar name. The match is on the whole path — the
   * sibling of this folder — not on the last segment, so a worktree someone put
   * in a different parent cannot be mistaken for the one the resolver will
   * reach for.
   */
  it("matches the derived directory by path, not by name", async () => {
    stubBranches({
      branches: ["main", "feat/y", "other"],
      checkedOut: [
        { branch: "main", path: REPO, isMainWorktree: true },
        { branch: "other", path: "/somewhere/else/callboard.feat-y", isMainWorktree: false },
      ],
    });
    await open();

    fireEvent.click(toggle());
    type("feat/y");

    expect(summary()).toBe("feat/y already exists — will check it out in a new worktree at callboard.feat-y. If that directory already exists, the chat runs in it as it is.");
  });

  it("worktree off, name already has a worktree: the same redirect, plus the reassurance", async () => {
    stubBranches({ checkedOut: occupiedElsewhere });
    const { onChange } = await open();

    type("feat/y");

    expect(emitted(onChange)).toEqual({ baseBranch: "main", newBranch: "feat/y" });
    expect(summary()).toBe("feat/y is checked out at callboard.feat-y — the chat will run there. This checkout is untouched.");
  });

  /**
   * True only since `switchBranch` stopped passing `-b` unconditionally — this
   * exact request was a 500 before that, so the sentence would have been
   * describing a crash.
   */
  it("worktree off, name exists with no worktree: says it will switch, not create", async () => {
    stubBranches();
    const { onChange } = await open();

    type("feat/y");

    expect(emitted(onChange)).toEqual({ baseBranch: "main", newBranch: "feat/y" });
    expect(summary()).toBe("feat/y already exists — will switch this checkout to it.");
  });

  /**
   * The asymmetry, and it is not a slip in either direction: the two backend
   * functions disagree about whether the current directory counts, so the two
   * sentences have to as well.
   *
   * `ensureWorktreeDetailed` matches any worktree on the branch — including
   * this one — and returns its path, so asking for a worktree on the branch you
   * are already on gets you this directory and no isolation at all. The news
   * there is the dropped worktree, not a redirect: nobody is being sent
   * anywhere. `switchBranch` excludes the current directory, and checking out
   * the branch you are already on is a no-op git completes without comment.
   */
  it("with the toggle on, the branch you are already on means no worktree at all", async () => {
    stubBranches();
    const { onChange } = await open();

    fireEvent.click(toggle());
    type("main");

    // The request still asks for isolation. It just will not get any, which is
    // exactly why the sentence has to say so.
    expect(emitted(onChange)).toEqual({ useWorktree: true, baseBranch: "main", newBranch: "main" });
    expect(summary()).toBe(
      "main is already checked out here — the chat will run here, with no worktree. If callboard.main already exists, the chat runs in it as it is.",
    );
  });

  it("with the toggle off, the same name is a no-op and says nothing will change", async () => {
    stubBranches();
    await open();

    type("main");

    expect(summary()).toBe("Runs here on main. No branch or worktree change.");
  });

  /**
   * `newBranch` wins over `baseBranch` in `resolveBranch`, so a base picked
   * alongside a name that is already the current branch is never consulted —
   * the sentence must not promise the switch the base implies.
   */
  it("does not promise a switch the ignored base branch implies", async () => {
    stubBranches();
    const { onChange } = await open();

    pickBase("feat/y");
    type("main");

    expect(emitted(onChange)).toEqual({ baseBranch: "feat/y", newBranch: "main" });
    expect(summary()).toBe("Runs here on main. No branch or worktree change.");
  });

  /**
   * The no-worktree sentence does not depend on the endpoint's listing. Git's
   * own worktree list always contains the directory you are standing in, so the
   * outcome holds whether or not `checkedOut` arrived.
   */
  it("says it with no checkedOut listing at all", async () => {
    stubBranches({ checkedOut: undefined });
    await open();

    fireEvent.click(toggle());
    type("main");

    expect(summary()).toBe(
      "main is already checked out here — the chat will run here, with no worktree. If callboard.main already exists, the chat runs in it as it is.",
    );
  });

  /**
   * From inside a worktree, "here" is that worktree and its branch — not the
   * main checkout, and not `main`.
   *
   * Like its sibling above, this pins the guard rather than the lookup behind
   * it: the target is the branch this folder is on, so the ladder answers
   * before `worktreeOn` is reached. That is the point — the guard is what makes
   * the sentence hold with no listing at all — and the listing is stubbed here
   * only so the folder is a plausible worktree of it.
   */
  it("is about the branch this folder is on, not about main", async () => {
    stubBranches({
      checkedOut: [
        { branch: "main", path: REPO, isMainWorktree: true },
        { branch: "feat/a", path: WORKTREE, isMainWorktree: false },
      ],
    });
    await open({ folder: WORKTREE, currentBranch: "feat/a" });

    fireEvent.click(toggle());
    type("feat/a");

    expect(summary()).toBe(
      "feat/a is already checked out here — the chat will run here, with no worktree. " +
        "If callboard.feat-a.feat-a already exists, the chat runs in it as it is.",
    );
  });

  /**
   * The redirect is right about *which branch* and can still be wrong about
   * *which directory*. `existsSync(derivedPath)` is the resolver's first rung,
   * and a directory sitting there that is not a registered worktree of this
   * repository — a leftover, an unrelated clone, a worktree on a detached HEAD
   * — is invisible to `checkedOut`. So a worktree on `feat/y` that lives
   * somewhere other than `callboard.feat-y` loses to whatever is at
   * `callboard.feat-y`, and the sentence names a directory the chat may never
   * reach. The listing cannot answer it, so the sentence hedges instead.
   */
  it("hedges the redirect when the worktree is not the one at the derived path", async () => {
    stubBranches({
      checkedOut: [
        { branch: "main", path: REPO, isMainWorktree: true },
        { branch: "feat/y", path: "/somewhere/else/y-work", isMainWorktree: false },
      ],
    });
    await open();

    fireEvent.click(toggle());
    type("feat/y");

    expect(summary()).toBe(
      "feat/y is checked out at y-work — the chat will run there. If callboard.feat-y already exists, the chat runs in it as it is.",
    );
  });

  /**
   * ...and does not hedge when there is nothing left to hedge. A worktree on
   * the branch that *is* at the derived path is the very directory the reuse
   * would land in, so "if that directory already exists" would be asking the
   * user to worry about a case the listing has already answered.
   */
  it("drops the hedge when the worktree on the branch is the derived directory", async () => {
    stubBranches({
      checkedOut: [
        { branch: "main", path: REPO, isMainWorktree: true },
        { branch: "feat/y", path: "/home/cybil/callboard.feat-y", isMainWorktree: false },
      ],
    });
    await open();

    fireEvent.click(toggle());
    type("feat/y");

    expect(summary()).toBe("feat/y is checked out at callboard.feat-y — the chat will run there.");
  });

  /** A name nobody has used still reads as a creation, on both sides. */
  it("leaves a genuinely new name on the create sentences", async () => {
    stubBranches({ checkedOut: occupiedElsewhere });
    await open();

    type("feat/brand-new");
    expect(summary()).toBe("Will create branch feat/brand-new off main in this checkout.");

    fireEvent.click(toggle());
    expect(summary()).toBe("Will create callboard.feat-brand-new on new branch feat/brand-new, off main. If that directory already exists, the chat runs in it as it is.");
  });
});

/**
 * `git_branch` reports `"main"` for a checkout on no branch — the "empty means
 * main" fallback the whole UI reads — so every sentence keyed on it was false
 * here, and `main` may exist and be checked out somewhere else entirely. The
 * separate `isDetached` flag is what the box goes on instead; it is sent only
 * when true, and covers both a detached HEAD and the vanishing case of a HEAD
 * symref outside `refs/heads`, which is why nothing below names either.
 *
 * `currentBranch` is deliberately still `"main"` in these renders: that is what
 * the endpoint sends, and the point is that the box no longer believes it.
 */
describe("a checkout that is on no branch", () => {
  it("does not tell the user the chat runs here on main", async () => {
    const { onChange } = await open({ isDetached: true });

    expect(summary()).toBe("Runs here. This checkout is on no branch, and nothing here changes that.");
    expect(emitted(onChange)).toEqual({});
  });

  /** The picker used to open on a value matching none of its options. */
  it("gives the base picker a value it actually has, and marks nothing current", async () => {
    await open({ isDetached: true });

    expect(baseSelect().value).toBe("");
    expect([...baseSelect().options].map((o) => o.textContent)).toEqual(["(not on a branch)", "main", "feat/y", "feat/a"]);
  });

  /**
   * No base is sent rather than an invented one, and the backend reads that as
   * `HEAD` — this checkout's commit. Which is the only true thing to say: there
   * is no branch here to name as the base.
   */
  it("branches off this checkout's commit, and says so", async () => {
    const { onChange } = await open({ isDetached: true });

    fireEvent.click(toggle());

    expect(emitted(onChange)).toEqual({ useWorktree: true, autoCreateBranch: true });
    expect(summary()).toBe("Will create a new worktree off this checkout's current commit, on a branch named from your first message.");

    type("feat/x");

    expect(emitted(onChange)).toEqual({ useWorktree: true, newBranch: "feat/x" });
    expect(summary()).toBe(
      "Will create callboard.feat-x on new branch feat/x, off this checkout's current commit. If that directory already exists, the chat runs in it as it is.",
    );
  });

  /**
   * The consequence that bites: with `currentBranch` believed, typing `main`
   * was a no-op ("Runs here on main") when it is in fact a checkout — the one
   * the backend's dirty guard now refuses over uncommitted work rather than
   * running it silently.
   */
  it("treats main as a branch like any other, not as the branch it is on", async () => {
    // Git drops the detached directory from its own listing — it has no branch
    // to be listed under — so nothing here is checked out anywhere.
    stubBranches({ checkedOut: [] });
    const { onChange } = await open({ isDetached: true });

    type("main");

    expect(emitted(onChange)).toEqual({ newBranch: "main" });
    expect(summary()).toBe("main already exists — will switch this checkout to it.");
  });

  it("still switches to a base the user picks", async () => {
    stubBranches({ checkedOut: [] });
    const { onChange } = await open({ isDetached: true });

    pickBase("feat/y");

    expect(emitted(onChange)).toEqual({ baseBranch: "feat/y" });
    expect(summary()).toBe("Will switch this checkout to feat/y.");
  });
});

describe("the sticky toggle", () => {
  it("starts off on a browser that has never set it", async () => {
    await open();
    expect(toggle().checked).toBe(false);
  });

  it("writes worktreeByDefault, and comes back checked on the next chat", async () => {
    await open();

    fireEvent.click(toggle());
    expect(JSON.parse(localStorage.getItem("claude-code-settings")!).worktreeByDefault).toBe(true);

    cleanup();
    const { onChange } = await open();
    expect(toggle().checked).toBe(true);
    expect(emitted(onChange)).toEqual({ useWorktree: true, autoCreateBranch: true, baseBranch: "main" });
  });

  it("unchecking is just as sticky", async () => {
    localStorage.setItem("claude-code-settings", JSON.stringify({ worktreeByDefault: true }));
    await open();

    fireEvent.click(toggle());
    expect(JSON.parse(localStorage.getItem("claude-code-settings")!).worktreeByDefault).toBe(false);
  });

  /**
   * The old `useWorktree` key meant "checked while a branch change was pending",
   * and on a chat with no branch change it did nothing. Honouring it now would
   * silently start creating worktrees for a preference the user never expressed.
   */
  it("ignores a value left behind under the old useWorktree key", async () => {
    localStorage.setItem("claude-code-settings", JSON.stringify({ useWorktree: true, autoCreateBranch: true }));
    const { onChange } = await open();

    expect(toggle().checked).toBe(false);
    expect(emitted(onChange)).toEqual({});
  });

  /**
   * The store is JSON some other build wrote, so a value that is not a boolean
   * has to be read as one rather than handed to `checked=` as a string.
   */
  it("reads a non-boolean stored value as off", async () => {
    localStorage.setItem("claude-code-settings", JSON.stringify({ worktreeByDefault: "yes" }));
    const { onChange } = await open();

    expect(toggle().checked).toBe(false);
    expect(emitted(onChange)).toEqual({});
  });

  /** Nothing else in the store is collateral damage when the toggle is written. */
  it("leaves the rest of the store alone", async () => {
    localStorage.setItem("claude-code-settings", JSON.stringify({ maxTurns: 42, useWorktree: true }));
    await open();

    fireEvent.click(toggle());
    const stored = JSON.parse(localStorage.getItem("claude-code-settings")!);
    expect(stored.maxTurns).toBe(42);
    expect(stored.useWorktree).toBe(true);
  });
});

describe("the controls themselves", () => {
  /**
   * The old name field was replaced by static text whenever `Auto-create` was
   * checked, and the old worktree checkbox was disabled until some other control
   * had already implied a branch change. Both are gone: there is no state in
   * which either input refuses input.
   */
  it("never disables the name field or the toggle", async () => {
    await open();

    expect(nameField().disabled).toBe(false);
    expect(toggle().disabled).toBe(false);

    fireEvent.click(toggle());

    expect(nameField().disabled).toBe(false);
    expect(toggle().disabled).toBe(false);
  });

  /** Empty means two different things, so the hint has to track the toggle. */
  it("says the name will be generated only when it will be", async () => {
    await open();

    expect(nameField().placeholder).toBe("new-branch (optional)");
    fireEvent.click(toggle());
    expect(nameField().placeholder).toBe("auto");
  });

  /** Neither the name nor the base survives to the next chat — only the toggle. */
  it("does not persist the name or the base branch", async () => {
    await open();

    type("feat/x");
    pickBase("feat/y");

    cleanup();
    await open();
    expect(nameField().value).toBe("");
    expect(baseSelect().value).toBe("main");
  });

  /**
   * An invalid name **withdraws** the config rather than merely failing to
   * replace it. The distinction is the whole bug: skipping the callback reads
   * as "nothing was propagated", and what it actually does is leave the parent
   * holding the last valid config — the name the user typed on the way to the
   * one they meant. `feat/my thing` sent `feat/my`, silently, with the box
   * showing nothing but a validation error.
   *
   * `null` is the box saying there is no config to send, which is what
   * `sendBlockedReason` in `pages/Chat.tsx` greys the Send button on.
   */
  it("withdraws the config while the name is invalid, rather than leaving a stale one", async () => {
    const { onChange } = await open();

    type("feat/x");
    expect(emitted(onChange)).toEqual({ baseBranch: "main", newBranch: "feat/x" });

    type("feat/my thing");

    expect(emitted(onChange)).toBeNull();
    expect(screen.queryByTestId("branch-summary")).toBeNull();
    expect(screen.getByText(/Branch name cannot contain spaces/)).toBeTruthy();

    type("feat/x2");
    expect(emitted(onChange)).toEqual({ baseBranch: "main", newBranch: "feat/x2" });
    expect(summary()).toBe("Will create branch feat/x2 off main in this checkout.");
  });

  /**
   * The P0 in miniature, and the reason the withdrawal has to be per-keystroke.
   * `m` is a perfectly good branch name, so it is emitted; the space that
   * follows it is what makes the name invalid, and before this the parent went
   * on holding `m`. Send then made a worktree `callboard.m` on a branch `m`.
   */
  it("withdraws a half-typed name as soon as the rest makes it invalid", async () => {
    const { onChange } = await open();

    fireEvent.click(toggle());
    type("m");
    expect(emitted(onChange)).toEqual({ useWorktree: true, baseBranch: "main", newBranch: "m" });

    type("my branch");

    expect(emitted(onChange)).toBeNull();
  });

  /**
   * The sentence is the entire reason this box was rewritten, and a plain
   * `<div>` rewriting itself as the checkbox toggles is invisible to anyone not
   * looking at it. Live regions rather than focus management: nothing here
   * steals the caret out of the field the user is typing in.
   *
   * The two roles are not interchangeable. The sentence is `status` (polite —
   * it narrates a choice) and the rejection is `alert` (assertive — the send is
   * blocked until it is dealt with), and the rejection is also *associated*
   * with the field, so a screen reader reaching the input reads the reason
   * rather than announcing it once into the void.
   */
  it("announces the sentence, and ties a rejected name to the field it was typed in", async () => {
    await open();

    expect(screen.getByRole("status").textContent).toContain("Runs here on main");
    expect(nameField().getAttribute("aria-invalid")).toBeNull();
    expect(nameField().getAttribute("aria-describedby")).toBeNull();

    fireEvent.click(toggle());
    expect(screen.getByRole("status").textContent).toContain("Will create a new worktree off main");

    type("bad name");

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Branch name cannot contain spaces — nothing will send until this is fixed.");
    expect(nameField().getAttribute("aria-invalid")).toBe("true");
    expect(nameField().getAttribute("aria-describedby")).toBe(alert.id);
    expect(alert.id).toBeTruthy();
  });

  /**
   * Three names the client-side rules used to wave through and `validateGitRef`
   * refuses on arrival. Each one got "Will create branch `-x` off `main` in this
   * checkout" — a confident sentence about a request that could only ever end in
   * an error, since the backend answers 500 rather than creating anything.
   *
   * `.x` is the odd one out and worth keeping: `validateGitRef` does not refuse
   * it either, but git does, so the rule is stricter than the backend on purpose
   * rather than by drift.
   */
  it.each([
    ["-x", 'Branch name cannot start with "-"'],
    ["feat/a[b", "Branch name contains invalid characters"],
    [".x", 'No part of a branch name can start with "."'],
    ["feat/.x", 'No part of a branch name can start with "."'],
    ["x".repeat(256), "Branch name must be 255 characters or fewer"],
  ])("refuses %s rather than promising to create it", async (name, message) => {
    const { onChange } = await open();

    type(name);

    expect(screen.getByRole("alert").textContent).toContain(message);
    expect(screen.queryByTestId("branch-summary")).toBeNull();
    expect(emitted(onChange)).toBeNull();
  });

  it("reports a failed branch listing rather than an empty picker", async () => {
    getGitBranches.mockRejectedValue(new Error("not a git repository"));
    render(<BranchSelector folder={REPO} currentBranch="main" onChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("not a git repository")).toBeTruthy());
  });
});
