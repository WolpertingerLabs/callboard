/**
 * Quarantine and the retention sweep.
 *
 * Two claims, and everything here is one of them:
 *
 *  - moving a directory into the trash is an atomic `rename(2)` that preserves
 *    every byte, including the ignored files git would have deleted;
 *  - nothing is deleted before its time, and anything the sweep does not fully
 *    understand is kept forever.
 *
 * The cross-filesystem test needs two filesystems. It looks for a writable
 * directory on a different device (`/dev/shm`, `/run/user/<uid>`) and skips
 * when the machine has none — the refusal it proves is real either way, but
 * asserting it needs an EXDEV to be reachable.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "callboard-trash-"));
process.env.CALLBOARD_DATA_DIR = join(root, "data");

const { TRASH_MANIFEST_FILE, TRASH_RETENTION_MS, quarantineDirectory, sweepTrash, trashRoot } = await import("./worktree-trash.js");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A directory on a filesystem other than `root`'s, or null if there is none. */
function foreignFilesystemDir(): string | null {
  const here = statSync(root).dev;
  for (const candidate of ["/dev/shm", `/run/user/${process.getuid?.() ?? 0}`]) {
    try {
      if (statSync(candidate).dev === here) continue;
      const dir = mkdtempSync(join(candidate, "callboard-trash-xdev-"));
      return dir;
    } catch {
      // Not present, not writable, or not a directory — try the next.
    }
  }
  return null;
}

function makeSource(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, ".env"), "SECRET=hunter2\n");
  writeFileSync(join(dir, "nested", "local.sqlite"), "not really sqlite\n");
  return dir;
}

const manifestFor = (id: string, source: string) => ({ workspaceId: id, originalPath: source, repoPath: join(root, "repo"), branch: "feat/x" });

describe("quarantineDirectory", () => {
  it("moves the directory whole, ignored files and all, and writes a manifest", () => {
    const source = makeSource("src-move");

    const result = quarantineDirectory(source, { entryPrefix: "ws-move", manifest: manifestFor("ws-move", source) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(source)).toBe(false);
    // The files git could not see are the whole point: they came along.
    expect(readFileSync(join(result.trashPath, ".env"), "utf8")).toBe("SECRET=hunter2\n");
    expect(readFileSync(join(result.trashPath, "nested", "local.sqlite"), "utf8")).toBe("not really sqlite\n");

    const manifest = JSON.parse(readFileSync(join(result.trashPath, TRASH_MANIFEST_FILE), "utf8"));
    expect(manifest.workspaceId).toBe("ws-move");
    expect(manifest.originalPath).toBe(source);
    expect(manifest.branch).toBe("feat/x");
    expect(Date.parse(manifest.quarantinedAt)).toBeGreaterThan(0);
    // The restore recipe travels with the entry so it does not need Callboard.
    expect(manifest.restore.join("\n")).toContain(`worktree add ${source} feat/x`);
    // It landed under the trash root, named for the workspace.
    expect(result.trashPath.startsWith(join(trashRoot(), "ws-move-"))).toBe(true);
  });

  it("never overwrites an existing entry", () => {
    const first = quarantineDirectory(makeSource("src-a"), { entryPrefix: "ws-same", manifest: manifestFor("ws-same", "a") });
    const second = quarantineDirectory(makeSource("src-b"), { entryPrefix: "ws-same", manifest: manifestFor("ws-same", "b") });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.trashPath).not.toBe(second.trashPath);
    expect(existsSync(join(first.trashPath, ".env"))).toBe(true);
    expect(existsSync(join(second.trashPath, ".env"))).toBe(true);
  });

  it("refuses a source that is not there", () => {
    const result = quarantineDirectory(join(root, "no-such-dir"), { entryPrefix: "ws-x", manifest: manifestFor("ws-x", "n") });
    expect(result).toMatchObject({ ok: false, code: "source-missing" });
  });

  const foreign = foreignFilesystemDir();
  it.skipIf(!foreign)("refuses a cross-filesystem trash rather than falling back to a copy", () => {
    const source = makeSource("src-xdev");
    const before = readFileSync(join(source, ".env"), "utf8");

    const result = quarantineDirectory(source, {
      root: join(foreign!, "trash"),
      entryPrefix: "ws-xdev",
      manifest: manifestFor("ws-xdev", source),
    });

    expect(result).toMatchObject({ ok: false, code: "cross-device" });
    if (result.ok) return;
    expect(result.error).toContain("different filesystems");
    // The source is untouched — no half-copy, no delete.
    expect(readFileSync(join(source, ".env"), "utf8")).toBe(before);
    expect(existsSync(join(source, "nested", "local.sqlite"))).toBe(true);
    rmSync(foreign!, { recursive: true, force: true });
  });
});

describe("sweepTrash", () => {
  const sweepRoot = join(root, "sweep-trash");

  function entry(name: string, manifest: unknown | null): string {
    const dir = join(sweepRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "payload.txt"), "user data\n");
    if (manifest !== null) writeFileSync(join(dir, TRASH_MANIFEST_FILE), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    return dir;
  }

  it("removes only entries past the retention window, and keeps everything it cannot vouch for", () => {
    const now = Date.parse("2026-07-27T00:00:00.000Z");
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();

    const expired = entry("expired", { workspaceId: "ws-1", quarantinedAt: at(TRASH_RETENTION_MS + 1000) });
    const justInside = entry("just-inside", { workspaceId: "ws-2", quarantinedAt: at(TRASH_RETENTION_MS - 1000) });
    const fresh = entry("fresh", { workspaceId: "ws-3", quarantinedAt: at(0) });
    const future = entry("future", { workspaceId: "ws-4", quarantinedAt: new Date(now + 60_000).toISOString() });
    const noManifest = entry("no-manifest", null);
    const brokenManifest = entry("broken-manifest", "{ this is not json");
    const noTimestamp = entry("no-timestamp", { workspaceId: "ws-5" });
    const strayFile = join(sweepRoot, "stray.txt");
    writeFileSync(strayFile, "not a quarantine entry\n");

    const result = sweepTrash({ root: sweepRoot, now });

    expect(result.removed).toEqual(["expired"]);
    expect(result.errors).toEqual([]);
    expect(existsSync(expired)).toBe(false);
    // Everything else survives, including every entry the sweep could not read.
    for (const kept of [justInside, fresh, future, noManifest, brokenManifest, noTimestamp]) {
      expect(existsSync(join(kept, "payload.txt"))).toBe(true);
    }
    expect(existsSync(strayFile)).toBe(true);
    expect(result.kept.map((k) => k.entry).sort()).toEqual(
      ["broken-manifest", "fresh", "future", "just-inside", "no-manifest", "no-timestamp", "stray.txt"].sort(),
    );
  });

  it("is a no-op when there is no trash directory", () => {
    expect(sweepTrash({ root: join(root, "never-created") })).toEqual({ removed: [], kept: [], errors: [] });
  });
});
