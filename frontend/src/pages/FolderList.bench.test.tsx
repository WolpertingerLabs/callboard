// @vitest-environment jsdom
/**
 * The measurement behind the folder-sidebar refresh work, kept runnable.
 *
 * This is the harness that produced the table in the PR that introduced it. It
 * mounts the real sidebar under a scripted 60s of triggers with `listFolders`
 * mocked at the measured latency, and reports two numbers per scenario: how
 * many requests were fired, and how much React render work the window cost.
 *
 * ## Reproducing the "before" column
 *
 * The harness deliberately does not vendor a copy of the old component — that
 * would be committed dead code that rots. It runs against whatever is in the
 * tree, so the previous implementation is a checkout away:
 *
 *     git log --oneline -- frontend/src/pages/FolderList.tsx    # find the commit
 *     git checkout <before>^ -- frontend/src/pages/FolderList.tsx \
 *                               frontend/src/components/FolderListItem.tsx \
 *                               frontend/src/api.ts
 *     npx vitest run frontend/src/pages/FolderList.bench.test.tsx --reporter=verbose
 *     git checkout HEAD -- frontend/src/pages/FolderList.tsx \
 *                          frontend/src/components/FolderListItem.tsx frontend/src/api.ts
 *
 * That works in both directions because the mock tolerates a caller that
 * passes no `AbortSignal`: the pre-change `listFolders` took two arguments and
 * the pre-change sidebar never aborted anything.
 *
 * ## Reading the numbers
 *
 * `render-ms` is jsdom wall time through `<Profiler>`, so its absolute value
 * means nothing — only the ratio does, and only against a run on the same
 * machine. The request counts are exact and are asserted below, which makes
 * this a regression guard as well as a measurement: the assertions are the
 * cadence contract (a heartbeat every 15s, one request per correlated trigger
 * pair rather than two).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Profiler } from "react";
import { MemoryRouter } from "react-router-dom";
import type { FolderListResponse, FolderSummary } from "../api";
import { listFolders } from "../api";
import FolderList from "./FolderList";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listFolders: vi.fn(),
}));

const sessionState = { activeSessions: new Map<string, { chatId: string }>(), metadataVersion: 0 };
vi.mock("../contexts/SessionContext", () => ({
  useSessionContext: () => ({
    activeSessions: sessionState.activeSessions,
    connected: true,
    metadataVersion: sessionState.metadataVersion,
    summonedChatIds: new Set<string>(),
  }),
  useMetadataVersion: () => sessionState.metadataVersion,
}));
vi.mock("../components/WorkspaceManagerModal", () => ({ default: () => <div /> }));
vi.mock("../components/SidebarHeader", () => ({ default: () => <div /> }));
vi.mock("../components/NewChatPanel", () => ({ default: () => <div /> }));

const mockListFolders = vi.mocked(listFolders);

/** 44 directories — the sidebar size on the machine this was measured on. */
const ROW_COUNT = 44;

/** Measured: ~120ms of blocked event loop per uncached folders sweep. */
const LATENCY_MS = 120;

function folders(n: number): FolderSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    folder: `/home/cybil/dir-${i}`,
    displayName: `dir-${i}`,
    mostRecentChatId: `chat-${i}`,
    mostRecentChatCreatedAt: "2026-08-20T10:00:00.000Z",
    lastUpdatedAt: "2026-08-20T11:00:00.000Z",
    status: "stopped" as const,
    isGitRepo: true,
    isWorktree: true,
    isTriggered: false,
    chatCount: 3,
  }));
}

beforeEach(() => {
  // No `shouldAdvanceTime` here, unlike the unit tests. The window is scripted
  // in exact 250ms steps and the heartbeat falls due at exactly 60_000ms, so
  // letting real elapsed time bleed into the clock decides whether the last
  // heartbeat lands inside the window or just past it — the request counts
  // asserted below would drift by one depending on how loaded the machine is.
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-08-20T12:00:00.000Z"));
  localStorage.clear();
  mockListFolders.mockReset();
  mockListFolders.mockImplementation(
    (_days, _sizes, signal) =>
      new Promise<FolderListResponse>((resolve, reject) => {
        // Re-serialised every call, the way a real response arrives: fresh
        // objects, so any structural sharing has to be earned.
        const timer = setTimeout(() => resolve({ folders: JSON.parse(JSON.stringify(folders(ROW_COUNT))) } as FolderListResponse), LATENCY_MS);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      }),
  );
  sessionState.activeSessions = new Map([["chat-0", { chatId: "chat-0" }]]);
  sessionState.metadataVersion = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Scenario = {
  /** Metadata bump cadence in ms, or null for none. */
  bumpEveryMs: number | null;
  /**
   * Session start/stop cadence in ms, or null for none. Each one also bumps
   * the metadata counter, because that is what the server does: a session
   * starting or stopping *is* a chat status change, so it lands in the same
   * poll response that changes the session map. That correlation is the whole
   * reason the old four-trigger arrangement double-fired.
   */
  churnEveryMs: number | null;
};

async function run(scenario: Scenario) {
  const commits = { count: 0, ms: 0 };
  const view = () => (
    <MemoryRouter>
      <Profiler
        id="sidebar"
        onRender={(_id, _phase, actualDuration) => {
          commits.count += 1;
          commits.ms += actualDuration;
        }}
      >
        <FolderList onRefresh={() => {}} onViewModeChange={() => {}} />
      </Profiler>
    </MemoryRouter>
  );

  const { rerender } = render(view());
  const STEP_MS = 250;
  let live = true;
  for (let elapsed = 0; elapsed < 60_000; elapsed += STEP_MS) {
    if (scenario.bumpEveryMs && elapsed > 0 && elapsed % scenario.bumpEveryMs === 0) sessionState.metadataVersion += 1;
    if (scenario.churnEveryMs && elapsed > 0 && elapsed % scenario.churnEveryMs === 0) {
      live = !live;
      sessionState.activeSessions = live ? new Map([["chat-0", { chatId: "chat-0" }]]) : new Map();
      sessionState.metadataVersion += 1;
    }
    // The re-render is what carries the new context value in, the way the real
    // provider's setState does.
    await act(async () => {
      rerender(view());
      await vi.advanceTimersByTimeAsync(STEP_MS);
    });
  }

  return { requests: mockListFolders.mock.calls.length, ...commits };
}

async function report(label: string, scenario: Scenario) {
  const result = await run(scenario);
  const perCommit = result.count === 0 ? 0 : result.ms / result.count;
  // eslint-disable-next-line no-console
  console.log(
    `${label.padEnd(26)} requests ${String(result.requests).padStart(2)}   ` +
      `render-ms ${result.ms.toFixed(1).padStart(7)} over ${String(result.count).padStart(4)} commits ` +
      `(${perCommit.toFixed(2)}ms each, ${ROW_COUNT} rows)`,
  );
  return result;
}

describe("folder sidebar: requests and render work in a 60s window", { timeout: 120_000 }, () => {
  it("quiet — one live session, nothing else happening", async () => {
    const { requests } = await report("quiet", { bumpEveryMs: null, churnEveryMs: null });
    // Mount, plus the 15s heartbeat at 15s, 30s and 45s. The window is a
    // half-open interval: an event due at exactly 60_000ms falls outside it.
    expect(requests).toBe(4);
  });

  it("typical — a status or title change every 10s", async () => {
    const { requests } = await report("typical (bump/10s)", { bumpEveryMs: 10_000, churnEveryMs: null });
    expect(requests).toBe(8);
  });

  /**
   * The scenario the change is really about: one event, two triggers. Each
   * start/stop moves `activeSessions.size` AND bumps the metadata counter, and
   * the old arrangement answered that with two sweeps 200ms apart.
   */
  it("churn — sessions starting and stopping every 5s", async () => {
    const { requests } = await report("churn (start/stop 5s)", { bumpEveryMs: null, churnEveryMs: 5_000 });
    expect(requests).toBe(12);
  });

  /**
   * The ceiling, and the honest one: the metadata counter cannot move faster
   * than the 1s session poll, and a status change must still show up within
   * 300ms. So a workload that genuinely changes something every second costs a
   * request every second, before and after. What the change removes here is
   * the duplication, not the work.
   */
  it("worst — a metadata bump every second", async () => {
    const { requests } = await report("worst (bump/1s)", { bumpEveryMs: 1_000, churnEveryMs: null });
    expect(requests).toBe(60);
  });
});
