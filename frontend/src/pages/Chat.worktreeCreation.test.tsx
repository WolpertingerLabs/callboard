// @vitest-environment jsdom
/**
 * The new-chat screen while the daemon creates the chat's worktree.
 *
 * `POST /new/message` answers only once the checkout is done, so the wait for
 * its response is the checkout. These cases mount the real `Chat` and the real
 * composer and assert what that wait looks like — the indicator, its Cancel —
 * and the one promise every way out of it keeps: the prompt the composer
 * emptied on send comes back, whether the creation was cancelled, refused, or
 * timed out. The branch box is a stub that asks for a worktree, because what it
 * emits is `BranchSelector.test.tsx`'s subject; this file is about what the page
 * does with the request once it is out.
 */
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Chat from "./Chat";
import { getComposerDraft, NEW_CHAT_DRAFT_KEY, saveComposerDraft } from "../utils/localStorage";

/** What the stubbed branch box emits on mount. Worktree by default; a case may change it. */
let emittedConfig: Record<string, unknown>;

vi.mock("../components/BranchSelector", () => ({
  default: function BranchSelectorStub({ onChange }: { onChange: (config: Record<string, unknown>) => void }) {
    useEffect(() => {
      onChange(emittedConfig);
    }, [onChange]);
    return <div data-testid="branch-box" />;
  },
}));

const FOLDER = "/tmp/project";
const PROMPT = "refactor the parser into its own module";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

/** Every body POSTed to the new-chat route, and the signal it went out with. */
let sends: Array<{ body: { branchConfig?: Record<string, unknown>; clientTrackingId?: string }; signal?: AbortSignal | null }>;
/** Every `/stop` the page sent, by id. */
let stops: string[];
/** How the next new-chat POST is answered: held open (the checkout is running), or a given response. */
let answerSend: () => Promise<Response>;
/** Releases a held POST with the response to give it. */
let releaseSend: ((res: Response) => void) | null;

function fakeServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "POST" && url.includes("/chats/new/message")) {
    sends.push({ body: JSON.parse(init!.body as string), signal: init?.signal });
    return new Promise<Response>((resolve, reject) => {
      // A real fetch rejects with AbortError when its signal fires.
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      answerSend().then(resolve, reject);
    });
  }
  if (method === "POST" && url.endsWith("/stop")) {
    stops.push(decodeURIComponent(url.split("/chats/")[1].replace(/\/stop$/, "")));
    return Promise.resolve(jsonResponse({ stopped: true }));
  }
  if (url.includes("/chats/new/info")) {
    return Promise.resolve(jsonResponse({ folder: FOLDER, slash_commands: [], plugins: [], is_git_repo: true, git_branch: "main" }));
  }
  if (url.includes("/system-info")) return Promise.resolve(jsonResponse({}));
  if (url.includes("/keywords")) return Promise.resolve(jsonResponse({ keywords: [] }));
  if (url.includes("/mcp-tools")) return Promise.resolve(jsonResponse({ tools: [], servers: [] }));
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => "" } as unknown as Response);
}

function renderCompose() {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/chat/new", search: `?folder=${encodeURIComponent(FOLDER)}` }]}>
      <Routes>
        <Route path="/chat/new" element={<Chat />} />
      </Routes>
    </MemoryRouter>,
  );
}

const textarea = () => screen.getByPlaceholderText("Send a message...") as HTMLTextAreaElement;
const indicator = () => screen.queryByTestId("worktree-creation-indicator");

/** Type the prompt and send it, once the branch box is up (it is what makes the request ask for a worktree). */
async function typeAndSend(text = PROMPT) {
  await screen.findByTestId("branch-box");
  fireEvent.change(textarea(), { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(textarea(), { key: "Enter" });
  });
  await waitFor(() => expect(sends).toHaveLength(1));
}

beforeEach(() => {
  localStorage.clear();
  sends = [];
  stops = [];
  releaseSend = null;
  emittedConfig = { baseBranch: "main", newBranch: "feat/parser", useWorktree: true };
  answerSend = () => new Promise<Response>((resolve) => (releaseSend = resolve));
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
  localStorage.clear();
});

describe("creating a new chat's worktree", () => {
  it("shows the indicator while the checkout runs, with elapsed and remaining time that tick", async () => {
    renderCompose();
    await typeAndSend();

    expect(sends[0].body.branchConfig).toMatchObject({ useWorktree: true, newBranch: "feat/parser" });
    await waitFor(() => expect(indicator()).toBeTruthy());
    expect(screen.getByText("Creating worktree…")).toBeTruthy();
    expect(screen.getByTestId("worktree-creation-elapsed").textContent).toBe("0s elapsed");
    expect(screen.getByTestId("worktree-creation-remaining").textContent).toBe("1:00 left");

    await waitFor(() => expect(screen.getByTestId("worktree-creation-elapsed").textContent).toBe("1s elapsed"), { timeout: 2500 });
    expect(screen.getByTestId("worktree-creation-remaining").textContent).toBe("59s left");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("60");
  });

  it("goes away once the route answers — the worktree exists and the chat is starting", async () => {
    renderCompose();
    await typeAndSend();
    await waitFor(() => expect(indicator()).toBeTruthy());

    const stream = new ReadableStream({ start: (controller) => controller.close() });
    await act(async () => {
      releaseSend!({ ok: true, status: 200, body: stream, json: async () => ({}) } as unknown as Response);
    });
    await waitFor(() => expect(indicator()).toBeNull());
  });

  it("is not shown for a chat that asked for no worktree", async () => {
    emittedConfig = { baseBranch: "main" };
    renderCompose();
    await typeAndSend();
    expect(sends[0].body.branchConfig?.useWorktree).toBeUndefined();
    expect(indicator()).toBeNull();
  });

  it("Cancel stops the creation by its tracking id, aborts the request, and puts the prompt back", async () => {
    renderCompose();
    await typeAndSend();
    await waitFor(() => expect(indicator()).toBeTruthy());
    // The composer emptied itself on send.
    expect(textarea().value).toBe("");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    // The daemon is told by id — the same id the POST carried.
    expect(stops).toEqual([sends[0].body.clientTrackingId]);
    expect(sends[0].body.clientTrackingId).toMatch(/^new-/);
    // …and the request itself is let go.
    expect(sends[0].signal?.aborted).toBe(true);
    await waitFor(() => expect(indicator()).toBeNull());
    await waitFor(() => expect(textarea().value).toBe(PROMPT));
    expect(getComposerDraft(NEW_CHAT_DRAFT_KEY)).toBe(PROMPT);
    // A cancel the user asked for is not an error.
    expect(screen.queryByText("network error")).toBeNull();
    // And the composer is usable again, with the branch box still asking for a worktree.
    expect(textarea().disabled).toBe(false);
    expect(screen.getByTestId("branch-box")).toBeTruthy();
  });

  it("a creation that timed out shows the daemon's error and keeps the prompt", async () => {
    answerSend = () => Promise.resolve(jsonResponse({ error: "Could not prepare the branch or worktree: git worktree add timed out after 60s" }, 500));
    renderCompose();
    await typeAndSend();

    await screen.findByText("Could not prepare the branch or worktree: git worktree add timed out after 60s");
    await waitFor(() => expect(textarea().value).toBe(PROMPT));
    expect(indicator()).toBeNull();
    expect(stops).toEqual([]);
  });

  it("a request that never reached the daemon keeps the prompt too", async () => {
    answerSend = () => Promise.reject(new TypeError("Failed to fetch"));
    renderCompose();
    await typeAndSend();

    await screen.findByText("network error");
    await waitFor(() => expect(textarea().value).toBe(PROMPT));
    expect(indicator()).toBeNull();
  });

  it("a stream that breaks after the route answered does not put the prompt back — the chat exists", async () => {
    // Without this distinction the next new chat would open with this one's text.
    answerSend = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: new ReadableStream({ start: (controller) => controller.error(new TypeError("network")) }),
        json: async () => ({}),
      } as unknown as Response);
    renderCompose();
    await typeAndSend();

    await waitFor(() => expect(textarea().disabled).toBe(false));
    expect(textarea().value).toBe("");
    expect(getComposerDraft(NEW_CHAT_DRAFT_KEY)).toBe("");
  });

  it("a prompt led by a slash command comes back whole", async () => {
    answerSend = () => Promise.resolve(jsonResponse({ error: "boom" }, 500));
    saveComposerDraft(NEW_CHAT_DRAFT_KEY, "");
    renderCompose();
    await typeAndSend("/review the parser");
    await screen.findByText("boom");
    await waitFor(() => expect(textarea().value).toBe("/review the parser"));
  });
});
