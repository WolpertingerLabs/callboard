/**
 * Guards the call site, not the method.
 *
 * chat-file-service.lookup.test.ts proves `getChatBySessionId` does no
 * directory scan. That is necessary and not sufficient: revert the call site to
 * `getChat` and those tests stay green, because nothing there asserts the
 * narrow method is the one actually reached. These tests close that gap by
 * driving the real code path — `searchChats` — over a populated chats
 * directory and asserting the chats directory is never enumerated.
 *
 * The probe counts `readdirSync` calls *scoped to the chats directory*. The
 * path legitimately readdirs elsewhere (session discovery, project dirs), so
 * an unscoped count would be meaningless. `readdirCalls` is therefore exactly
 * "times something scanned the chat records".
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = vi.hoisted(() => ({ chatsDir: "", readdirCalls: 0 }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (probe.chatsDir && String(args[0]) === probe.chatsDir) probe.readdirCalls++;
      return actual.readdirSync(...args);
    },
  };
});

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-call-sites-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
// CLAUDE_PROJECTS_DIR is derived from homedir() at paths.js load, and
// os.homedir() honours $HOME on POSIX — so chat search reads a fixture tree.
process.env.HOME = tmpRoot;

// The fixture lives under the system temp dir, and `-tmp` is a *default*
// ignored project-dir prefix — chat search honours the ignore list, so without
// an explicit empty list every session below would be correctly filtered out
// and these call-site guards would assert against zero rows. Declaring the list
// also decouples the fixture from whatever the defaults happen to be.
writeFileSync(join(tmpRoot, "ignored-project-dirs.json"), JSON.stringify({ prefixes: [] }));

const projectFolder = join(tmpRoot, "proj");
mkdirSync(projectFolder, { recursive: true });
const projectsDir = join(tmpRoot, ".claude", "projects");
// chat-search encodes a folder path by replacing every non-alphanumeric run.
const encodedDir = projectFolder.replace(/[^a-zA-Z0-9]/g, "-");
mkdirSync(join(projectsDir, encodedDir), { recursive: true });

const { chatFileService } = await import("./chat-file-service.js");
const { searchChats } = await import("../utils/chat-search.js");
const { clearProjectDirFolderCache } = await import("../utils/paths.js");

const chatsDir = join(tmpRoot, "chats");
probe.chatsDir = chatsDir;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * A folder whose sessions are a mix of tracked and untracked — the untracked
 * ones are the whole point, since those are the ids that used to buy a full
 * scan to learn nothing.
 */
beforeEach(() => {
  clearProjectDirFolderCache();
  for (const file of readdirSync(chatsDir)) rmSync(join(chatsDir, file), { force: true, recursive: true });
  for (const file of readdirSync(join(projectsDir, encodedDir))) rmSync(join(projectsDir, encodedDir, file), { force: true });

  for (let i = 0; i < 6; i++) {
    const sessionId = randomUUID();
    // Every session has a transcript; only the even ones have a record.
    writeFileSync(join(projectsDir, encodedDir, `${sessionId}.jsonl`), `{"type":"user","timestamp":"2026-01-0${i + 1}T00:00:00.000Z"}\n`);
    if (i % 2 === 0) chatFileService.createChat(projectFolder, sessionId, JSON.stringify({ agentAlias: "scout", triggered: true, title: `tracked ${i}` }));
  }
  probe.readdirCalls = 0;
});

describe("probe control", () => {
  it("counts a scan when one actually happens", () => {
    // Without this, every `toBe(0)` below could pass because the mock never
    // took, or because chatsDir was mis-set. getChat's fallback is the one
    // path that must still scan.
    expect(chatFileService.getChat(randomUUID())).toBeNull();
    expect(probe.readdirCalls).toBe(1);
  });
});

describe("searchChats", () => {
  it("never scans the chats directory, once per candidate or at all", () => {
    const { chats } = searchChats({ folder: projectFolder, limit: 50 });
    // Three tracked + three untracked sessions all surface as results.
    expect(chats).toHaveLength(6);
    expect(probe.readdirCalls).toBe(0);
  });

  it("still reads metadata off the records it does find", () => {
    const { chats } = searchChats({ folder: projectFolder, limit: 50, triggered: true });
    expect(chats).toHaveLength(3);
    expect(chats.every((c) => c.agentAlias === "scout")).toBe(true);
    expect(probe.readdirCalls).toBe(0);
  });
});
