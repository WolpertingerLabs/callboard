// @vitest-environment jsdom
/**
 * How often the folder sidebar asks the server, and what it does when the
 * answer is about to be superseded.
 *
 * `GET /api/chats/folders` is the one listing endpoint with no server-side
 * cache — measured at ~120ms of blocked event loop per call, against ~1ms for
 * the cached chat list. Four independent effects used to call it with no
 * coordination whatsoever: mount, a 15s heartbeat, a 500ms timer on the
 * session count, and a 300ms timer on every metadata bump — and the metadata
 * counter is bumped by a 1s poll on any status, title or summon change. During
 * an active session those overlapped constantly, and every overlap was a
 * duplicate disk sweep whose answer was thrown away.
 *
 * These tests are about the fan-in, so they count requests. The two properties
 * that are easy to get wrong in opposite directions both have a test here: an
 * ambient trigger must NOT produce a second request while one is in flight,
 * and a post-write invalidation MUST, because its answer is already stale.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { FolderListResponse, FolderSummary } from "../api";
import { listFolders } from "../api";
import FolderList from "./FolderList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listFolders: vi.fn(),
}));

// Driven by the tests: this is the thing whose changes used to each cost their
// own request.
const sessionState = {
  activeSessions: new Map<string, { chatId: string }>(),
  metadataVersion: 0,
};
vi.mock("../contexts/SessionContext", () => ({
  useSessionContext: () => ({
    activeSessions: sessionState.activeSessions,
    connected: true,
    metadataVersion: sessionState.metadataVersion,
    summonedChatIds: new Set<string>(),
  }),
  useMetadataVersion: () => sessionState.metadataVersion,
}));

// Stubbed down to the one thing these tests use it for: the post-write
// invalidation callback. The real modal fetches on mount, which would put
// unrelated requests in the middle of a request count.
vi.mock("../components/WorkspaceManagerModal", () => ({
  default: ({ onChanged, onClose }: { onChanged?: () => void; onClose: () => void }) => (
    <div>
      <button onClick={() => onChanged?.()}>simulate-write</button>
      <button onClick={onClose}>close-manager</button>
    </div>
  ),
}));

vi.mock("../components/SidebarHeader", () => ({ default: () => <div /> }));
vi.mock("../components/NewChatPanel", () => ({ default: () => <div /> }));

const mockListFolders = vi.mocked(listFolders);

function makeFolder(overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    folder: "/home/cybil/callboard.feat-x",
    displayName: "callboard.feat-x",
    mostRecentChatId: "chat-1",
    mostRecentChatCreatedAt: "2026-08-20T10:00:00.000Z",
    lastUpdatedAt: "2026-08-20T11:00:00.000Z",
    status: "stopped",
    isGitRepo: true,
    isWorktree: false,
    isTriggered: false,
    chatCount: 3,
    ...overrides,
  };
}

function response(folders: FolderSummary[]): FolderListResponse {
  return { folders } as FolderListResponse;
}

/**
 * A request whose resolution the test controls, so "while one is in flight" is
 * an actual state and not a race against the event loop.
 */
function deferred() {
  let resolve!: (value: FolderListResponse) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<FolderListResponse>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The abort a real `fetch` produces. `listFolders` now takes a signal, and the
 * mock has to honour it or "an aborted request does not blank the list" would
 * be untestable.
 */
function abortWhenSignalled(signal: AbortSignal | undefined, pending: ReturnType<typeof deferred>) {
  signal?.addEventListener("abort", () => {
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    pending.reject(err);
  });
}

// A fresh element each time: React bails out of re-rendering when handed the
// identical element object, which would make every `rerender` below a no-op.
const view = () => (
  <MemoryRouter>
    <FolderList onRefresh={() => {}} onViewModeChange={() => {}} />
  </MemoryRouter>
);

function renderSidebar() {
  const result = render(view());
  return {
    ...result,
    /**
     * What the 1s session poll does: bump the counter and re-render. The mock
     * context reads module state, so the re-render is what makes the new value
     * reach the component — the real provider does it with `setState`.
     */
    async bumpMetadata(steps = 1, gapMs = 0) {
      for (let i = 0; i < steps; i++) {
        sessionState.metadataVersion += 1;
        await act(async () => {
          result.rerender(view());
          if (gapMs) await vi.advanceTimersByTimeAsync(gapMs);
        });
      }
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockListFolders.mockReset();
  sessionState.activeSessions = new Map();
  sessionState.metadataVersion = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Push past the ambient debounce window and let the resulting promises settle. */
async function settle(ms = 400) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("one request per burst of triggers", () => {
  it("fetches once on mount, not once per effect", async () => {
    mockListFolders.mockResolvedValue(response([makeFolder()]));
    renderSidebar();
    await settle(1000);
    // Mount used to fire immediately AND again 500ms later from the
    // session-count effect, before anything had even changed.
    expect(mockListFolders).toHaveBeenCalledTimes(1);
  });

  /**
   * The load-bearing case. The 1s session poll bumps `metadataVersion` on any
   * status, title or summon change, and a session that is actually doing
   * something bumps it repeatedly — each bump used to be its own uncached
   * sweep, regardless of whether the previous one had come back.
   */
  it("collapses several metadata bumps that land together into one request", async () => {
    mockListFolders.mockResolvedValue(response([makeFolder()]));
    const { bumpMetadata } = renderSidebar();
    await settle();
    expect(mockListFolders).toHaveBeenCalledTimes(1);

    // Four bumps, 50ms apart — well inside the 300ms window.
    await bumpMetadata(4, 50);
    await settle();

    expect(mockListFolders).toHaveBeenCalledTimes(2);
  });

  /**
   * Dedupe, distinct from the debounce: the debounce merges triggers that
   * arrive close together, this drops one that arrives while a sweep is
   * already on the wire. Both are needed, because a sweep takes ~120ms and the
   * debounce window is 300ms.
   */
  it("rides the request already in flight instead of starting a second one", async () => {
    const pending = deferred();
    mockListFolders.mockImplementation((_days, _sizes, signal) => {
      abortWhenSignalled(signal, pending);
      return pending.promise;
    });
    const { bumpMetadata } = renderSidebar();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(mockListFolders).toHaveBeenCalledTimes(1);

    // A metadata bump arrives while the mount request is still open.
    await bumpMetadata();
    await settle();

    expect(mockListFolders).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(response([makeFolder()]));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(await screen.findByText("callboard.feat-x")).toBeTruthy();
  });

  it("does not poll at all while no session is active", async () => {
    mockListFolders.mockResolvedValue(response([makeFolder()]));
    renderSidebar();
    await settle();
    expect(mockListFolders).toHaveBeenCalledTimes(1);

    await settle(60_000);
    expect(mockListFolders).toHaveBeenCalledTimes(1);
  });

  /**
   * The number this change is actually about. One live session, one minute,
   * nothing else happening: the heartbeat is the only trigger, so four
   * requests. Before, the heartbeat alone was four and every metadata bump the
   * session produced added its own on top.
   */
  it("keeps the 15s heartbeat while a session is live", async () => {
    mockListFolders.mockResolvedValue(response([makeFolder()]));
    sessionState.activeSessions = new Map([["chat-1", { chatId: "chat-1" }]]);
    renderSidebar();
    await settle();
    expect(mockListFolders).toHaveBeenCalledTimes(1);

    await settle(60_000);
    // Four ticks in the minute, each one request.
    expect(mockListFolders).toHaveBeenCalledTimes(5);
  });
});

describe("a request that is about to be wrong", () => {
  /**
   * `onChanged` is a post-write invalidation — adopt, archive or rename has
   * already happened. The dedupe above must not swallow it: the request in
   * flight was issued before the write and will answer from before it.
   */
  it("forces a refresh from the workspace manager even with a request in flight", async () => {
    const first = deferred();
    mockListFolders.mockImplementationOnce((_days, _sizes, signal) => {
      abortWhenSignalled(signal, first);
      return first.promise;
    });
    mockListFolders.mockResolvedValue(response([makeFolder({ displayName: "after-the-write" })]));

    const { bumpMetadata } = renderSidebar();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    // Resolve the mount request so the list renders and the Manage button is reachable.
    await act(async () => {
      first.resolve(response([makeFolder({ displayName: "before-the-write" })]));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(mockListFolders).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle("Adopt, archive and restore worktrees"));

    const second = deferred();
    mockListFolders.mockImplementationOnce((_days, _sizes, signal) => {
      abortWhenSignalled(signal, second);
      return second.promise;
    });
    // A poll opens a request, and the write lands while it is still open.
    await bumpMetadata();
    await settle();
    expect(mockListFolders).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByText("simulate-write"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Third request, issued after the write, rather than the second one's
    // pre-write answer being reused.
    expect(mockListFolders).toHaveBeenCalledTimes(3);
    expect(await screen.findByText("after-the-write")).toBeTruthy();
  });

  /**
   * A filter change must supersede too, for a different reason: an in-flight
   * request for 30 days cannot answer a question about 1 day. Riding it would
   * show the wrong window and clear the spinner while doing it.
   */
  it("abandons the in-flight request when the age filter changes", async () => {
    const thirtyDays = deferred();
    mockListFolders.mockImplementationOnce((_days, _sizes, signal) => {
      abortWhenSignalled(signal, thirtyDays);
      return thirtyDays.promise;
    });
    mockListFolders.mockResolvedValue(response([makeFolder({ displayName: "one-day-window" })]));

    renderSidebar();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "1" } });
    await settle();

    expect(mockListFolders).toHaveBeenCalledTimes(2);
    expect(mockListFolders.mock.calls[1][0]).toBe(1);
    expect(await screen.findByText("one-day-window")).toBeTruthy();
  });

  /**
   * Abandoning a request is a decision, not a failure. It must not reach the
   * console — a sidebar that logs an error every time a poll is superseded
   * makes the console useless — and it must not blank the list, which is what
   * a naive `setFolders([])`-on-error would do.
   */
  it("logs nothing and keeps the rows when a request is abandoned", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockListFolders.mockResolvedValueOnce(response([makeFolder({ displayName: "still-here" })]));
    const { bumpMetadata } = renderSidebar();
    await settle();
    expect(screen.getByText("still-here")).toBeTruthy();

    const superseded = deferred();
    mockListFolders.mockImplementationOnce((_days, _sizes, signal) => {
      abortWhenSignalled(signal, superseded);
      return superseded.promise;
    });
    const replacement = deferred();
    mockListFolders.mockImplementationOnce((_days, _sizes, signal) => {
      abortWhenSignalled(signal, replacement);
      return replacement.promise;
    });

    // A poll opens a request, then a write supersedes it. Superseding through
    // the write path rather than the filter path on purpose: a filter change
    // legitimately puts the spinner up, which would hide the rows this test is
    // asserting about for a reason that has nothing to do with the abort.
    fireEvent.click(screen.getByTitle("Adopt, archive and restore worktrees"));
    await bumpMetadata();
    await settle();
    fireEvent.click(screen.getByText("simulate-write"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // The superseded request has rejected with AbortError by now.
    expect(consoleError).not.toHaveBeenCalled();
    expect(screen.getByText("still-here")).toBeTruthy();

    await act(async () => {
      replacement.resolve(response([makeFolder({ displayName: "replaced" })]));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(await screen.findByText("replaced")).toBeTruthy();
    consoleError.mockRestore();
  });

  it("still reports a real failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockListFolders.mockRejectedValue(new Error("Failed to list folders"));
    renderSidebar();
    await settle();
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(screen.getByText("No folders with recent activity")).toBeTruthy();
    consoleError.mockRestore();
  });
});

describe("a poll that changes nothing", () => {
  /**
   * The row is memoised, but the listing arrives as JSON — every row is a new
   * object every poll, so shallow comparison would never hit. The page carries
   * unchanged rows forward, which is what makes the memo real; this asserts
   * the identity, because that is the whole mechanism.
   */
  it("hands the rows back the objects they already had", async () => {
    const payload = () => response([makeFolder(), makeFolder({ folder: "/home/cybil/other", displayName: "other" })]);
    mockListFolders.mockImplementation(async () => JSON.parse(JSON.stringify(payload())) as FolderListResponse);

    const { bumpMetadata } = renderSidebar();
    await settle();
    const firstRow = screen.getByText("callboard.feat-x");

    await bumpMetadata();
    await settle();
    expect(mockListFolders).toHaveBeenCalledTimes(2);
    // Same DOM node: React never re-rendered the row, because the props it
    // was given compared equal.
    expect(screen.getByText("callboard.feat-x")).toBe(firstRow);
  });

  it("still re-renders the row when the listing actually changes", async () => {
    mockListFolders.mockResolvedValueOnce(response([makeFolder({ chatTitle: "before" })]));
    mockListFolders.mockResolvedValue(response([makeFolder({ chatTitle: "after" })]));

    const { bumpMetadata } = renderSidebar();
    await settle();
    expect(screen.getByText("before")).toBeTruthy();

    await bumpMetadata();
    await settle();
    expect(await screen.findByText("after")).toBeTruthy();
  });
});
