/**
 * Two lookups, two costs.
 *
 * Records are filed as `<session_id>.json`. `getChat` tries that filename, then
 * falls back to reading every record in the directory looking for
 * `chat.id === id`. That fallback has 26 callers, several of which pass an
 * ambiguous id and genuinely need it, so it stays.
 *
 * `getChatBySessionId` is the narrow one — the direct filename read and nothing
 * else — for the sites whose id is provably a session id (the folders
 * projection, chat search). `chat.id` and `session_id` are not separate
 * namespaces: the dominant creation path makes them equal, so for a session id
 * the scan can only re-derive what the direct read already answered, and when
 * there is no record it can only fail. Either way it is a full readdir + parse
 * of the chats directory bought for nothing.
 *
 * These tests cover the method. The call sites — proving the narrow method is
 * the one actually reached — are guarded in chat-file-service.call-sites.test.ts.
 *
 * DATA_DIR is read when utils/paths.js first loads, so the env var is set
 * before the service is imported.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The claim under test is "no directory scan", so count the scans. The fs
// namespace is not spyable in ESM, hence a module mock; everything but
// readdirSync is the real thing.
const probe = vi.hoisted(() => ({ readdirCalls: 0 }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      probe.readdirCalls++;
      return actual.readdirSync(...args);
    },
  };
});

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-chat-lookup-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { chatFileService } = await import("./chat-file-service.js");

const chatsDir = join(tmpRoot, "chats");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of readdirSync(chatsDir)) rmSync(join(chatsDir, file), { force: true, recursive: true });
  probe.readdirCalls = 0;
});

describe("getChatBySessionId", () => {
  it("returns the record filed under that session id", () => {
    const sessionId = randomUUID();
    const created = chatFileService.createChat("/repo", sessionId, '{"title":"hello"}');

    const found = chatFileService.getChatBySessionId(sessionId);
    expect(found?.id).toBe(created.id);
    expect(found?.session_id).toBe(sessionId);
    expect(JSON.parse(found!.metadata).title).toBe("hello");
  });

  it("returns null for an unknown id without scanning the directory", () => {
    // A populated directory, so a scan would have something to read.
    for (let i = 0; i < 5; i++) chatFileService.createChat("/repo", randomUUID());
    probe.readdirCalls = 0;

    expect(chatFileService.getChatBySessionId(randomUUID())).toBeNull();
    expect(probe.readdirCalls).toBe(0);
  });

  it("does not resolve a chat.id that is filed under a different session id", () => {
    // createChat is the minority path that makes the two ids diverge, and this
    // is the accepted divergence stated on the method: the record exists and
    // getChat would find it by scanning, this will not. The call sites never
    // pass an id of this shape.
    const sessionId = randomUUID();
    const chat = chatFileService.createChat("/repo", sessionId);
    expect(chat.id).not.toBe(sessionId);

    probe.readdirCalls = 0;
    expect(chatFileService.getChatBySessionId(chat.id)).toBeNull();
    expect(probe.readdirCalls).toBe(0);
  });

  it("returns null for an unreadable record rather than throwing", () => {
    const sessionId = randomUUID();
    writeFileSync(join(chatsDir, `${sessionId}.json`), "{ not json");
    expect(chatFileService.getChatBySessionId(sessionId)).toBeNull();
  });
});

describe("getChat keeps its fallback", () => {
  it("still finds a chat by its chat.id", () => {
    const sessionId = randomUUID();
    const created = chatFileService.createChat("/repo", sessionId, '{"title":"by-uuid"}');
    expect(created.id).not.toBe(sessionId);

    probe.readdirCalls = 0;
    const found = chatFileService.getChat(created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.session_id).toBe(sessionId);
    // The control for the two `readdirCalls === 0` assertions above: this is
    // the path that does scan, and the probe sees it.
    expect(probe.readdirCalls).toBe(1);
  });

  it("still finds a chat by its session id", () => {
    const sessionId = randomUUID();
    const created = chatFileService.createChat("/repo", sessionId);
    expect(chatFileService.getChat(sessionId)?.id).toBe(created.id);
  });

  it("picks the right record out of a populated directory", () => {
    for (let i = 0; i < 5; i++) chatFileService.createChat("/other", randomUUID());
    const target = chatFileService.createChat("/repo", randomUUID(), '{"title":"needle"}');
    for (let i = 0; i < 5; i++) chatFileService.createChat("/other", randomUUID());

    const found = chatFileService.getChat(target.id);
    expect(JSON.parse(found!.metadata).title).toBe("needle");
  });

  it("falls back to the scan when the session file exists but is corrupt", () => {
    // The record whose *filename* matches is unparseable; the one whose
    // chat.id matches is elsewhere. Pre-existing behaviour, preserved.
    const target = chatFileService.createChat("/repo", randomUUID(), '{"title":"intact"}');
    writeFileSync(join(chatsDir, `${target.id}.json`), "{ not json");

    const found = chatFileService.getChat(target.id);
    expect(JSON.parse(found!.metadata).title).toBe("intact");
  });

  it("returns null when nothing matches either namespace", () => {
    chatFileService.createChat("/repo", randomUUID());
    expect(chatFileService.getChat(randomUUID())).toBeNull();
  });
});
