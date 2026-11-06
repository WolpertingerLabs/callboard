/**
 * The chat PRs route never waits for a backfill: the first request answers
 * from the trail as it is and queues the backfill; a later one shows what the
 * history added.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-prs-backfill-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "callboard-prs-backfill-")));

const { chatFileService } = await import("./chat-file-service.js");
const { buildChatPrs, trailOfChat } = await import("./chat-prs.js");
const { DEFAULT_PLACEMENT_DEPS } = await import("./git-overview.js");
const { DEFAULT_BACKFILL_DEPS, backfillIdle, requestBackfill } = await import("./git-trail-backfill.js");
type PullSummary = import("./github-prs.js").PullSummary;

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });

const pull = (number: number, headRef: string): PullSummary => ({
  number,
  url: `https://github.com/acme/app/pull/${number}`,
  title: `PR ${number}`,
  state: "merged",
  headRef,
  headSha: "zzz",
  headOwner: "acme",
  updatedAt: "2026-03-01T00:00:00Z",
  baseRef: "main",
  author: "dev",
  createdAt: "2026-02-01T00:00:00Z",
});

describe("buildChatPrs with an unbackfilled chat", () => {
  it("answers from the current trail, then shows the backfilled PRs on a later request", async () => {
    const repo = join(tmp, "app");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    git(repo, "checkout", "-q", "-b", "feat/now");
    const transcript = join(tmp, "history.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", cwd: repo, gitBranch: "feat/old", timestamp: "2026-01-01T00:00:00Z" }) + "\n");
    const chat = chatFileService.upsertChat("old-chat", repo, "old-chat", { metadata: "{}" });

    const deps = {
      ...DEFAULT_PLACEMENT_DEPS,
      notRepos: new Map(),
      pullsFor: async () => ({ github: { owner: "acme", repo: "app" }, defaultBranch: "main", byBranch: new Map([["feat/old", [pull(5, "feat/old")]]]) }),
      cardOf: () => null,
      trailOf: (id: string) => trailOfChat(id, () => []),
      requestBackfill: vi.fn((request) => requestBackfill(request, { ...DEFAULT_BACKFILL_DEPS, logPaths: () => [transcript], getWorkspace: () => null })),
    };

    const first = await buildChatPrs({ folder: repo, chatId: chat.id }, deps);
    expect(first.current).toMatchObject({ status: "no_pr", branch: "feat/now" });
    expect(first.prs).toEqual([]);
    expect(deps.requestBackfill).toHaveBeenCalledWith(expect.objectContaining({ chatId: chat.id }));

    await backfillIdle();
    const later = await buildChatPrs({ folder: repo, chatId: chat.id }, deps);
    expect(later.prs.map((p) => p.number)).toEqual([5]);
  });

  it("does not wait on a backfill that never finishes", async () => {
    const repo = join(tmp, "app");
    const deps = {
      ...DEFAULT_PLACEMENT_DEPS,
      notRepos: new Map(),
      pullsFor: async () => ({ byBranch: new Map() }),
      cardOf: () => null,
      trailOf: () => [],
      requestBackfill: () => void new Promise(() => {}),
    };
    const answered = await Promise.race([
      buildChatPrs({ folder: repo, chatId: "x" }, deps).then(() => "answered"),
      new Promise((r) => setTimeout(() => r("timed out"), 2000)),
    ]);
    expect(answered).toBe("answered");
  });
});
