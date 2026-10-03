/**
 * `folderService.getRecentFolders` — the recent-folders aggregate behind
 * `/api/folders/recent` and the folder browser's suggestions.
 *
 *  - `chatCount` is an all-time count, so discovery must not be capped: it used
 *    to ask each provider for 9999 sessions and undercount past that.
 *  - Folder existence is checked once per distinct folder, not per session.
 *  - The recent cache is keyed per limit and dropped by `clearCache`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = vi.hoisted(() => ({ exists: [] as string[] }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: (path: string) => {
      probe.exists.push(String(path));
      return actual.existsSync(path);
    },
  };
});

const root = mkdtempSync(join(tmpdir(), "callboard-recent-folders-"));
const alpha = mkdtempSync(join(root, "alpha-"));
const beta = mkdtempSync(join(root, "beta-"));
const gone = join(root, "gone");

let sessions: Array<{ displayFolder: string; updatedAt: Date }> = [];
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      discoverSessions: ({ limit, offset }: { limit: number; offset: number }) => ({ sessions: sessions.slice(offset, offset + limit), total: sessions.length }),
    },
  ],
}));

const { folderService } = await import("./folder-service.js");

beforeEach(() => {
  folderService.clearCache();
  probe.exists = [];
});

describe("getRecentFolders", () => {
  it("counts every session, past the old 9999 cap, and stats each folder once", () => {
    const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min));
    sessions = [
      ...Array.from({ length: 10_000 }, () => ({ displayFolder: alpha, updatedAt: at(100) })),
      { displayFolder: gone, updatedAt: at(99) },
      { displayFolder: beta, updatedAt: at(50) },
      { displayFolder: beta, updatedAt: at(60) },
    ];

    const recent = folderService.getRecentFolders(10);

    expect(recent.map((r) => [r.path, r.chatCount, r.lastUsed])).toEqual([
      [alpha, 10_000, at(100).toISOString()],
      [beta, 2, at(60).toISOString()],
    ]);
    const stats = probe.exists.filter((p) => p.startsWith(root));
    expect(stats.sort()).toEqual([alpha, beta, gone].sort());
  });

  it("caches per limit until clearCache", () => {
    sessions = [{ displayFolder: alpha, updatedAt: new Date() }];
    expect(folderService.getRecentFolders(3)).toHaveLength(1);

    sessions = [...sessions, { displayFolder: beta, updatedAt: new Date() }];
    expect(folderService.getRecentFolders(3)).toHaveLength(1);
    expect(folderService.getRecentFolders(4)).toHaveLength(2);

    folderService.clearCache();
    expect(folderService.getRecentFolders(3)).toHaveLength(2);
  });
});
