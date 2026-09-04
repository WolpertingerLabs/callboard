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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
async function open(props: { folder?: string; currentBranch?: string } = {}) {
  const onChange = vi.fn<(config: BranchConfig) => void>();
  render(<BranchSelector folder={props.folder ?? REPO} currentBranch={props.currentBranch ?? "main"} onChange={onChange} />);
  await screen.findByLabelText("Base branch");
  return { onChange };
}

/** The most recent config the box handed to its parent. */
function emitted(onChange: ReturnType<typeof vi.fn>): BranchConfig {
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
    expect(summary()).toBe("Will create callboard.feat-x on new branch feat/x, off main.");
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
   * The listing includes the directory you are standing in. Reporting that as a
   * redirect would tell the user their chat is going somewhere else when it is
   * going nowhere at all.
   */
  it("does not call this very directory 'elsewhere'", async () => {
    stubBranches({
      checkedOut: [{ branch: "feat/a", path: WORKTREE, isMainWorktree: false }],
    });
    await open({ folder: WORKTREE, currentBranch: "feat/a" });

    expect(summary()).toBe("Runs here on feat/a. No branch or worktree change.");
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
    expect(summary()).toBe("feat/y already exists — will check it out in a new worktree at callboard.feat-y.");
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
    expect(summary()).toBe("main is already checked out here — the chat will run here, with no worktree.");
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

    expect(summary()).toBe("main is already checked out here — the chat will run here, with no worktree.");
  });

  /** From inside a worktree, "here" is that worktree and its branch. */
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

    expect(summary()).toBe("feat/a is already checked out here — the chat will run here, with no worktree.");
  });

  /** A name nobody has used still reads as a creation, on both sides. */
  it("leaves a genuinely new name on the create sentences", async () => {
    stubBranches({ checkedOut: occupiedElsewhere });
    await open();

    type("feat/brand-new");
    expect(summary()).toBe("Will create branch feat/brand-new off main in this checkout.");

    fireEvent.click(toggle());
    expect(summary()).toBe("Will create callboard.feat-brand-new on new branch feat/brand-new, off main.");
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
   * An invalid name is never propagated, so the last config the parent holds
   * would describe a state the user has since left. The sentence would be a lie
   * about what the box is about to do; the error explains why nothing will.
   */
  it("shows the error instead of a sentence while the name is invalid", async () => {
    const { onChange } = await open();

    type("feat/x");
    const good = emitted(onChange);
    type("bad name");

    expect(screen.queryByTestId("branch-summary")).toBeNull();
    expect(screen.getByText("Branch name cannot contain spaces")).toBeTruthy();
    expect(emitted(onChange)).toEqual(good);

    type("feat/x2");
    expect(summary()).toBe("Will create branch feat/x2 off main in this checkout.");
  });

  it("reports a failed branch listing rather than an empty picker", async () => {
    getGitBranches.mockRejectedValue(new Error("not a git repository"));
    render(<BranchSelector folder={REPO} currentBranch="main" onChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("not a git repository")).toBeTruthy());
  });
});
