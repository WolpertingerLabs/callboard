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

/**
 * What `GET /chats/new/info` says about each folder the tests visit.
 *
 * Both repositories are on `main`, which is not a detail: `currentBranch` is
 * the one prop a folder change is *likely* to alter, and altering it re-runs
 * the propagate effect through `onBranch` all by itself. Two repositories on
 * the same branch — the overwhelmingly common case — is what leaves the effect
 * with nothing to notice, so a fixture that varies the branch name reports a
 * fix that is not there.
 */
const FOLDER_INFO: Record<string, { is_git_repo: boolean; git_branch?: string }> = {
  [REPO_A]: { is_git_repo: true, git_branch: "main" },
  [REPO_B]: { is_git_repo: true, git_branch: "main" },
  [PLAIN]: { is_git_repo: false },
};

/**
 * What `GET /git/branches` says about each repository. The second branch is how
 * the tests tell the two listings apart on screen, since the first is `main` in
 * both.
 */
const FOLDER_BRANCHES: Record<string, string[]> = {
  [REPO_A]: ["main", "feat/a"],
  [REPO_B]: ["main", "feat/b"],
};

/** Every body POSTed to the new-chat route, in order. */
let sentBodies: any[] = [];

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
    return Promise.resolve(jsonResponse({ folder, slash_commands: [], plugins: [], ...FOLDER_INFO[folder] }));
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
      {[REPO_B, PLAIN].map((folder) => (
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

