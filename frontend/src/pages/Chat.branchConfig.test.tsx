// @vitest-environment jsdom
/**
 * The branch box and the composer, wired together.
 *
 * Both ends of this chain are covered in isolation — `BranchSelector.test.tsx`
 * asserts every config the box emits, `PromptInput.sendBlocked.test.tsx`
 * asserts what a blocked composer does — and neither says anything about the
 * three hops between them: `onChange(null)` → `branchConfig` → the derived
 * `sendBlockedReason` → the prop → `handleSend`'s own guard. A bug living in
 * the wiring is invisible to both files while both stay green, and that is
 * exactly where one lived: a folder change reset the parent and the box, still
 * mounted, never re-emitted, so the toggle stayed checked, the sentence went on
 * promising a worktree, and the chat ran in the user's checkout.
 *
 * So this file mounts the real `Chat` around the real `BranchSelector` and
 * asserts on the **request body** — the one place the whole chain shows up as
 * one fact. The composer is a stub, because what it does with
 * `sendBlockedReason` is another file's subject; what is under test here is
 * that the reason reaches it at all, and that `handleSend` refuses even when
 * something bypasses the button.
 */
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";
import Chat from "./Chat";

/**
 * A composer that publishes the two things this file is about: the block reason
 * it was handed, and a send it will fire regardless.
 *
 * The unconditional send is the point of the second button. The real
 * `PromptInput` greys Send out for a block reason, so the only way to reach
 * `handleSend`'s own guard is to be a caller that never looked — a plan-review
 * auto-reply, a retry — and that guard is the last thing standing between an
 * abandoned branch name and a POST.
 */
vi.mock("../components/PromptInput", () => {
  function PromptInputStub({
    onSend,
    sendBlockedReason,
    onSetValue,
  }: {
    onSend: (prompt: string, images?: File[]) => void;
    sendBlockedReason?: string;
    onSetValue?: (setter: (value: string) => void) => void;
  }) {
    useEffect(() => {
      onSetValue?.(() => (_value: string) => {});
    }, [onSetValue]);
    return (
      <>
        <div data-testid="send-blocked">{sendBlockedReason ?? ""}</div>
        <button type="button" onClick={() => onSend("do the thing")}>
          send prompt
        </button>
      </>
    );
  }
  return { default: PromptInputStub };
});

const REPO_A = "/home/cybil/alpha";
const REPO_B = "/home/cybil/beta";
const PLAIN = "/home/cybil/notes";
const DETACHED = "/home/cybil/gamma";
/** The one repository deliberately *not* on `main` — see `FOLDER_INFO`. */
const REPO_C = "/home/cybil/delta";

/**
 * What `GET /chats/new/info` says about each folder the tests visit.
 *
 * `REPO_A` and `REPO_B` are both on `main`, which is not a detail: `currentBranch`
 * is the one prop a folder change is *likely* to alter, and altering it re-runs
 * the propagate effect through `onBranch` all by itself. Two repositories on
 * the same branch — the overwhelmingly common case — is what leaves the effect
 * with nothing to notice, so a fixture that varies the branch name reports a
 * fix that is not there. Measured, not assumed: give `REPO_B` any other branch
 * and two of the four folder-change tests below go green against the *unfixed*
 * `Chat.tsx`. The assertion under this table is what keeps that loud.
 *
 * `REPO_C` is the deliberate exception, and it is not in that pairing: it exists
 * so the stale-`info` tests can tell "the base we sent came from the folder we
 * left" from "the base we sent happens to be right everywhere".
 */
const FOLDER_INFO: Record<string, { is_git_repo: boolean; git_branch?: string; isDetached?: boolean }> = {
  [REPO_A]: { is_git_repo: true, git_branch: "main" },
  [REPO_B]: { is_git_repo: true, git_branch: "main" },
  [REPO_C]: { is_git_repo: true, git_branch: "develop" },
  [PLAIN]: { is_git_repo: false },
  // `git_branch: "main"` beside `isDetached` is not a contrived pair — it is
  // exactly what the endpoint sends, because `getGitInfo` has always reported
  // "main" for a checkout on no branch.
  [DETACHED]: { is_git_repo: true, git_branch: "main", isDetached: true },
};

/**
 * The fixture invariant the folder-change tests rest on, asserted rather than
 * described. A doc comment does not fail, and a test that stops discriminating
 * without failing is worse than no test at all: it reports a fix that is not
 * there, in the file whose whole subject is a bug that hid behind a green suite.
 */
if (FOLDER_INFO[REPO_A].git_branch !== FOLDER_INFO[REPO_B].git_branch) {
  throw new Error(
    `Chat.branchConfig.test fixture: REPO_A and REPO_B must be on the same branch (got ` +
      `${FOLDER_INFO[REPO_A].git_branch} and ${FOLDER_INFO[REPO_B].git_branch}). A differing ` +
      `currentBranch re-runs BranchSelector's propagate effect on its own, so the folder-change ` +
      `tests below pass against the unfixed Chat.tsx. Use REPO_C if you need a repository on ` +
      `another branch.`,
  );
}

/**
 * What `GET /git/branches` says about each repository. The second branch is how
 * the tests tell the listings apart on screen, since the first is `main` in
 * every repository that has one.
 */
const FOLDER_BRANCHES: Record<string, string[]> = {
  [REPO_A]: ["main", "feat/a"],
  [REPO_B]: ["main", "feat/b"],
  // No `main` at all: a base branch carried in from another repository is a ref
  // this one cannot resolve, which is the failure the stale-`info` tests are about.
  [REPO_C]: ["develop", "feat/c"],
  [DETACHED]: ["main", "feat/d"],
};

/** Every body POSTed to the new-chat route, in order. */
let sentBodies: any[] = [];

/**
 * Folders whose `GET /chats/new/info` is held open, and the resolvers holding
 * them.
 *
 * The round trip is the subject, not an obstacle: `/new/info` runs `getGitInfo`,
 * `buildWorkspaceIndex` and two plugin scans, so the compose screen spends tens
 * to hundreds of real milliseconds knowing the *previous* folder's answer about
 * this one. A fixture that answers instantly closes that window and can say
 * nothing about what happens inside it.
 */
let holdInfoFor: Set<string>;
let heldInfo: Map<string, () => void>;

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function folderOf(url: string): string {
  return decodeURIComponent(new URL(url, "http://localhost").searchParams.get("folder") ?? "");
}

/**
 * Enough server to get a compose screen up and a send recorded. Unmocked routes
 * reject rather than resolving to `{}`, so a test that quietly takes a path
 * whose data it never supplied is loud on stderr instead of green.
 */
function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const method = (init?.method ?? "GET").toUpperCase();

  if (method === "POST" && url.includes("/chats/new/message")) {
    sentBodies.push(JSON.parse(String(init?.body ?? "{}")));
    // Never answered: these tests are about what was asked for, and a stream
    // that opens would pull the page into its own state machine.
    return new Promise(() => {});
  }

  if (url.includes("/chats/new/info")) {
    const folder = folderOf(url);
    const answer = () => jsonResponse({ folder, slash_commands: [], plugins: [], ...FOLDER_INFO[folder] });
    if (holdInfoFor.has(folder)) {
      return new Promise<Response>((resolve) => heldInfo.set(folder, () => resolve(answer())));
    }
    return Promise.resolve(answer());
  }
  if (url.includes("/git/branches")) {
    const folder = folderOf(url);
    const branches = FOLDER_BRANCHES[folder] ?? [];
    return Promise.resolve(
      jsonResponse({ branches, checkedOut: [{ branch: branches[0], path: folder, isMainWorktree: true }] }),
    );
  }
  if (url.includes("/system-info")) return Promise.resolve(jsonResponse({}));
  if (url.includes("/keywords")) return Promise.resolve(jsonResponse({ keywords: [] }));
  if (url.includes("/mcp-tools")) return Promise.resolve(jsonResponse({ tools: [], servers: [] }));

  return Promise.reject(new Error(`unmocked request: ${method} ${url}`));
}

/** Offers the one move these tests care about: the sidebar's per-row "New chat". */
function Probe() {
  const navigate = useNavigate();
  return (
    <>
      {[REPO_B, REPO_C, PLAIN, DETACHED].map((folder) => (
        <button key={folder} type="button" onClick={() => navigate(`/chat/new?folder=${encodeURIComponent(folder)}`)}>
          {`compose in ${folder}`}
        </button>
      ))}
    </>
  );
}

/** Mount the compose screen for `folder` and wait until its branch box is live. */
async function compose(folder = REPO_A) {
  render(
    <MemoryRouter initialEntries={[`/chat/new?folder=${encodeURIComponent(folder)}`]}>
      <Routes>
        <Route path="/chat/new" element={<Chat />} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  );
  await screen.findByLabelText("Base branch");
}

/**
 * Move to another folder the way the sidebar's per-row "New chat" does: one
 * click, same screen, only the query parameter changes.
 *
 * Settles on the new repository's own listing rather than on a timer — the
 * second branch name is the only thing on screen that distinguishes the two,
 * since both are on `main`.
 */
async function goTo(folder: string) {
  await act(async () => {
    fireEvent.click(screen.getByText(`compose in ${folder}`));
  });
  const marker = FOLDER_BRANCHES[folder]?.[1];
  if (marker) await screen.findByRole("option", { name: marker });
  else await waitFor(() => expect(screen.queryByLabelText("Base branch")).toBeNull());
}

/**
 * The same move as `goTo`, but stopping inside the window `goTo` waits out: the
 * new folder's `/new/info` is held, so `folder` has changed and `info` has not.
 *
 * Nothing is waited *for* here, deliberately — the two states this has to
 * distinguish disagree about what is on screen (a box built from the previous
 * repository's branch, or no box at all), so any DOM settle point would only
 * exist in one of them. What makes it deterministic instead is that the emission
 * under test is synchronous: the box is keyed on `folder`, so the change
 * remounts it in the same commit, and its propagate effect reads `currentBranch`
 * and emits without waiting for a listing. If the config is coming, it is here
 * by the time this returns.
 */
async function goToWithInfoHeld(folder: string) {
  holdInfoFor.add(folder);
  await act(async () => {
    fireEvent.click(screen.getByText(`compose in ${folder}`));
  });
}

/** Let the held answer through, and wait for the screen to take it. */
async function releaseInfo(folder: string) {
  holdInfoFor.delete(folder);
  const release = heldInfo.get(folder);
  heldInfo.delete(folder);
  await act(async () => {
    release?.();
  });
}

const nameField = () => screen.getByLabelText("New branch name") as HTMLInputElement;
const toggle = () => screen.getByLabelText(/New worktree/) as HTMLInputElement;
const summary = () => (screen.getByTestId("branch-summary").textContent ?? "").replace(/\s+/g, " ").trim();
const blockedReason = () => screen.getByTestId("send-blocked").textContent;

async function send() {
  await act(async () => {
    fireEvent.click(screen.getByText("send prompt"));
  });
}

beforeEach(() => {
  localStorage.clear();
  sentBodies = [];
  holdInfoFor = new Set();
  heldInfo = new Map();
  vi.stubGlobal("fetch", vi.fn(fakeServer));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a name git would refuse blocks the send it would have failed", () => {
  it("carries the box's rejection to the composer, and refuses a send that ignores it", async () => {
    await compose();

    fireEvent.change(nameField(), { target: { value: "feat/my thing" } });

    // Hop one: the box reported the invalid name rather than staying silent.
    expect(screen.getByRole("alert").textContent).toContain("nothing will send until this is fixed");
    // Hop two and three: the parent turned that into a reason and handed it on.
    expect(blockedReason()).toBe("The branch name above is not one git will accept.");

    // Hop four: a caller that never looked at the button still gets nowhere.
    await send();
    expect(sentBodies).toHaveLength(0);
  });

  /**
   * The other half, without which the test above passes on a page that can
   * never send at all: the block lifts, and what goes out is the *fixed* name
   * — not the last valid prefix the user typed on the way to it, which is what
   * a skipped `onChange` would have left the parent holding.
   */
  it("lets the fixed name through, and sends that name rather than an abandoned prefix", async () => {
    await compose();

    fireEvent.change(nameField(), { target: { value: "feat/my thing" } });
    fireEvent.change(nameField(), { target: { value: "feat/my-thing" } });

    expect(blockedReason()).toBe("");
    await send();

    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0].branchConfig).toMatchObject({ baseBranch: "main", newBranch: "feat/my-thing" });
  });
});

describe("a folder change cannot leave the parent holding the previous folder's answer", () => {
  /**
   * The headline promise of this PR, failing quietly. The toggle is sticky, so
   * it is still checked in the new repository and the box still says a worktree
   * is coming — but `folder` is a query parameter, not a remount key, and the
   * propagate effect depends on none of the things a folder change touches. The
   * box re-rendered, said the same confident sentence, and never told the parent
   * anything; the parent had just reset itself to `{}`. Isolation asked for,
   * isolation not delivered, nothing on screen saying so.
   */
  it("re-emits the sticky toggle for the new folder", async () => {
    await compose();
    fireEvent.click(toggle());

    await goTo(REPO_B);

    // The box is still promising isolation...
    expect(toggle().checked).toBe(true);
    expect(summary()).toBe("Will create a new worktree off main, on a branch named from your first message.");

    // ...and the request agrees with it, instead of the parent's empty reset.
    await send();
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0].branchConfig).toEqual({ useWorktree: true, autoCreateBranch: true, baseBranch: "main" });
  });

  /**
   * The second consequence: a base picked in the old repository is a ref the
   * new one has never heard of. The parent's reset hid it until the next
   * keystroke, at which point the box emitted the stale base alongside the
   * fresh name and the backend answered `fatal: invalid reference`.
   */
  it("does not carry a base branch into a repository that has no such ref", async () => {
    await compose();
    fireEvent.change(screen.getByLabelText("Base branch"), { target: { value: "feat/a" } });

    await goTo(REPO_B);
    fireEvent.change(nameField(), { target: { value: "feat/new" } });
    await send();

    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0].branchConfig).toEqual({ baseBranch: "main", newBranch: "feat/new" });
  });

  /**
   * The third: the send-block survived the folder change while the reason for
   * it did not. The `role="alert"` went on saying "nothing will send until this
   * is fixed" about a field that had been cleared, and Send posted anyway.
   */
  it("clears a rejected name along with the block it caused", async () => {
    await compose();
    fireEvent.change(nameField(), { target: { value: "feat/my thing" } });
    expect(blockedReason()).not.toBe("");

    await goTo(REPO_B);

    expect(nameField().value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(blockedReason()).toBe("");
    await send();
    expect(sentBodies).toHaveLength(1);
  });

  /**
   * And the case the box cannot re-emit for, because it is not there to: a
   * folder that is not a repository renders no branch box at all. The config
   * the previous folder left behind has to stop travelling on its own, or
   * `useWorktree` arrives at a plain directory and the backend refuses a chat
   * nobody asked to isolate.
   */
  it("stops sending a config once the folder has no branch box", async () => {
    await compose();
    fireEvent.click(toggle());

    await goTo(PLAIN);

    expect(screen.queryByLabelText("New branch name")).toBeNull();
    await send();

    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0].branchConfig).toBeUndefined();
  });
});

/**
 * The folder changes on a click; what the server says about it does not. In
 * between, `info` is the *previous* directory's answer — and everything on the
 * compose screen that names a branch, including the branch box's own
 * `currentBranch`, was reading it about the new one.
 *
 * That is a config built from repository A, in a box mounted on repository B,
 * with the parent's gate open because `info.is_git_repo` was A's. Press Enter
 * inside that window — a typed prompt and a click on the sidebar's "New chat" is
 * all it takes — and it goes out. `git worktree add -b … main` in a repository
 * with no `main` is a 500; in a repository that happens to have one it is a
 * worktree off the wrong base, silently.
 *
 * The window is not hypothetical and not short: `/new/info` does `getGitInfo`,
 * `buildWorkspaceIndex` and two plugin scans before it answers, which is why
 * these two hold it open rather than racing it.
 */
describe("a config built from the folder that was left cannot ride out on a stale answer", () => {
  /**
   * The base branch case, which is the one that can fail quietly. `REPO_C` is on
   * `develop` and has no `main` at all, so a `main` in the request could only
   * have come from the repository the user just left.
   */
  it("does not post a base branch read from the previous folder", async () => {
    await compose(); // REPO_A, on main
    fireEvent.click(toggle());

    await goToWithInfoHeld(REPO_C);

    await send();
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0].folder).toBe(REPO_C);
    expect(sentBodies[0].branchConfig).toBeUndefined();

    // The stale header goes with it: naming REPO_A's branch above a box mounted
    // on REPO_C is the same wrong fact, one line up. `queryAll` because the
    // failure to catch is the name being present, and `queryByText` throws on
    // *two* of them rather than reporting the one thing this asserts.
    expect(screen.queryAllByText("main", { selector: ":not(option)" })).toHaveLength(0);

    // And the other half, without which "send nothing, ever" would pass: once
    // REPO_C's own answer lands the box is back, and what it emits is its own.
    await releaseInfo(REPO_C);
    await screen.findByRole("option", { name: "feat/c" });
    await send();
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[1].branchConfig).toEqual({ useWorktree: true, autoCreateBranch: true, baseBranch: "develop" });
  });

  /**
   * The louder case, and the reviewer's repro: the new folder is not a
   * repository at all. Nothing on screen should be offering isolation, but
   * `branchBoxShown` was reading the previous folder's `is_git_repo` — so the
   * box rendered, emitted, and `useWorktree` was posted at a plain directory.
   */
  it("does not post a worktree request at a folder that is not a repository", async () => {
    await compose();
    fireEvent.click(toggle());

    await goToWithInfoHeld(PLAIN);

    expect(screen.queryByLabelText("Base branch")).toBeNull();

    await send();
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0].folder).toBe(PLAIN);
    expect(sentBodies[0].branchConfig).toBeUndefined();

    // Still none once the answer arrives — a plain directory renders no box.
    await releaseInfo(PLAIN);
    expect(screen.queryByLabelText("Base branch")).toBeNull();
  });

  /**
   * The same staleness reached from the other side. Two folder changes in flight
   * land in the order the server answers them, so clearing `info` on the way out
   * is not enough on its own: the slower request for the folder the user left
   * would install its answer over the one they are standing in, and the window
   * reopens with nothing to close it.
   */
  it("ignores an answer for a folder that has already been left", async () => {
    holdInfoFor.add(REPO_A);
    render(
      <MemoryRouter initialEntries={[`/chat/new?folder=${encodeURIComponent(REPO_A)}`]}>
        <Routes>
          <Route path="/chat/new" element={<Chat />} />
        </Routes>
        <Probe />
      </MemoryRouter>,
    );

    // Leave before REPO_A ever answers, settle in REPO_C, ask for isolation
    // there — and only then let REPO_A's answer turn up.
    await goTo(REPO_C);
    fireEvent.click(toggle());
    await releaseInfo(REPO_A);

    await send();
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0].branchConfig).toEqual({ useWorktree: true, autoCreateBranch: true, baseBranch: "develop" });
    expect(screen.queryAllByText("main", { selector: ":not(option)" })).toHaveLength(0);
  });
});

/**
 * The compose screen makes two claims about the branch — the header's, and the
 * box's — and this PR is what put them at odds. Teaching the box to say "on no
 * branch" left the header a few lines above it still reading `git_branch`,
 * which is `"main"` for a detached HEAD and always has been.
 *
 * Asserted together, in one render, because the bug is not in either sentence:
 * it is in the pair.
 */
describe("what the compose screen calls a checkout that is on no branch", () => {
  it("does not put 'main' above a box that says there is no branch", async () => {
    await compose(DETACHED);

    // The header, in both of its new-chat spellings. `main` survives as an
    // *option* in the base picker and should — it is a branch this repository
    // has, merely not one it is on — so the exclusion is of everything else.
    expect(screen.queryByText("main", { selector: ":not(option)" })).toBeNull();
    expect(screen.getByText("(no branch)")).toBeTruthy();
    expect(screen.getByText("detached HEAD")).toBeTruthy();

    // ...and the box below it, agreeing.
    expect(summary()).toBe("Runs here. This checkout is on no branch, and nothing here changes that.");
  });

  /** The same two sites, unchanged for the ordinary case they already served. */
  it("still names the branch when there is one", async () => {
    await compose();

    expect(screen.getByText("Branch:")).toBeTruthy();
    expect(screen.getAllByText("main", { selector: ":not(option)" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("(no branch)")).toBeNull();
    expect(summary()).toBe("Runs here on main. No branch or worktree change.");
  });
});
