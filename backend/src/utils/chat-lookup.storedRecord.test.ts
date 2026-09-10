/**
 * `findChat`'s third parameter, which exists for exactly one caller: a batch.
 *
 * `chatFileService.getChat` answers a miss with a readdir + parse of every
 * record in the directory — ~45 ms across the 9.2k records on a real data dir,
 * paid per lookup. `POST /api/chats/bulk-delete` therefore resolves its whole
 * batch from one `getAllChats()` snapshot and hands each record (or an explicit
 * `null`) down here.
 *
 * That only works if this function HONOURS the hint, and the failure mode is
 * silent: ignore it and every route test still passes while the daemon blocks
 * for nine seconds on a 200-id retry. So the three cases are pinned on the real
 * implementation rather than on the route's fake of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-find-chat-hint-"));

const RECORD = {
  id: "chat-1",
  folder: "/repo",
  session_id: "session-1",
  session_log_path: "/tmp/session-1.jsonl",
  metadata: "{}",
  created_at: "2026-08-20T10:00:00.000Z",
  updated_at: "2026-08-20T11:00:00.000Z",
};

/** The scan this parameter exists to skip. */
const getChat = vi.fn((id: string) => (id === RECORD.id ? RECORD : null));
/** findChat's second branch — the filesystem fallback for a chat with no record. */
const resolveSessionAcrossProviders = vi.fn(() => null);

vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: { getChat: (id: string) => getChat(id) },
}));
vi.mock("./session-provenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-provenance.js")>()),
  resolveSessionAcrossProviders: () => resolveSessionAcrossProviders(),
  resolveSessionContext: () => ({ provenance: { logPath: "/tmp/session-1.jsonl" }, metadata: "{}", current: { logPath: "/tmp/session-1.jsonl" } }),
}));
vi.mock("../agents/factory.js", () => ({ getSessionProviders: () => [] }));
vi.mock("../services/codex-native-agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/codex-native-agents.js")>()),
  refreshNativeMetadata: (_logPath: string, _sessionId: string, metadata: string) => metadata,
}));

const { findChat } = await import("./chat-lookup.js");

beforeEach(() => {
  getChat.mockClear();
  resolveSessionAcrossProviders.mockClear();
});

describe("findChat's storedRecord hint", () => {
  it("looks the record up itself when the hint is omitted", () => {
    // Every existing caller, unchanged.
    expect(findChat(RECORD.id, false)?.id).toBe(RECORD.id);
    expect(getChat).toHaveBeenCalledTimes(1);
  });

  it("uses a supplied record without going to the store", () => {
    const chat = findChat(RECORD.id, false, RECORD);

    expect(chat?.id).toBe(RECORD.id);
    expect(chat?.session_id).toBe(RECORD.session_id);
    // The whole point: the batch already knows, so nothing re-derives it.
    expect(getChat).not.toHaveBeenCalled();
  });

  it("treats an explicit null as 'there is no record' and skips straight to the filesystem", () => {
    expect(findChat("ghost", false, null)).toBeNull();

    // `null` must not be re-interpreted as "unknown" — that would put the
    // ~45 ms scan back on exactly the ids most likely to miss.
    expect(getChat).not.toHaveBeenCalled();
    // And it is a real answer, not a short-circuit: the second branch still
    // ran, so a chat that exists only as a session log is still found.
    expect(resolveSessionAcrossProviders).toHaveBeenCalledTimes(1);
  });
});
