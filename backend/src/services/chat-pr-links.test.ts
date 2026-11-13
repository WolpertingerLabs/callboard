/**
 * PR links read from a chat's transcripts: what counts as a link, that a scan
 * resumes where the last one stopped, and that the chat record ends up with
 * every PR its sessions name. Real fixture transcripts and a throwaway chat
 * store; the transcript paths are injected.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-pr-links-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const tmp = mkdtempSync(join(tmpdir(), "callboard-pr-links-"));

/** Where the (stubbed) Claude Code provider finds each session's transcript. */
const sessionLogs: Record<string, string> = {};
const resolveSession = vi.fn((sessionId: string) => (sessionLogs[sessionId] ? { logPath: sessionLogs[sessionId] } : null));
vi.mock("../agents/factory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/factory.js")>()),
  getSessionProvider: () => ({ resolveSession }),
}));

const { chatFileService } = await import("./chat-file-service.js");
const { sessionRegistry } = await import("./session-registry.js");
const {
  DEFAULT_PR_LINK_DEPS,
  initPrLinkRecorder,
  MISSING_LOG_TTL_MS,
  mergePrLinks,
  parsePrLinks,
  prLinkBacklogIdle,
  resetPrLinkSync,
  scanPrLinks,
  syncChatPrLinks,
  syncPrLinksInBackground,
} = await import("./chat-pr-links.js");
type PrLinkDeps = import("./chat-pr-links.js").PrLinkDeps;

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  resetPrLinkSync();
  resolveSession.mockClear();
});

const prLink = (prNumber: number, timestamp = "2026-06-01T00:00:00Z", prRepository = "acme/app") =>
  JSON.stringify({ type: "pr-link", sessionId: "s", prNumber, prUrl: `https://github.com/${prRepository}/pull/${prNumber}`, prRepository, timestamp });
const lines = (...entries: string[]) => entries.map((entry) => entry + "\n").join("");

let files = 0;
function transcript(content: string): string {
  const path = join(tmp, `t${++files}.jsonl`);
  writeFileSync(path, content);
  return path;
}

let chats = 0;
function makeChat(metadata: Record<string, unknown> = {}) {
  const id = `links-chat-${++chats}`;
  return chatFileService.upsertChat(id, "/src/app", id, { metadata: JSON.stringify(metadata) });
}
const metaOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata || "{}");

/** Transcripts by session id, sized from the real files. */
function deps(paths: Record<string, string>): PrLinkDeps & { logPath: ReturnType<typeof vi.fn> } {
  return { logPath: vi.fn((sessionId: string) => paths[sessionId] ?? null), size: (path) => statSync(path).size };
}

describe("scanPrLinks", () => {
  it("reads the pr-link entries, once per PR with the earliest timestamp, and nothing that merely mentions one", async () => {
    const path = transcript(
      lines(
        JSON.stringify({ type: "user", message: { content: 'the entry looks like {"type":"pr-link","prNumber":999}' } }),
        prLink(12, "2026-06-02T00:00:00Z"),
        prLink(12, "2026-06-01T00:00:00Z"),
        JSON.stringify({ type: "assistant", message: { content: "x".repeat(3 << 20) } }), // a line longer than one read
        prLink(13, "2026-06-03T00:00:00Z", "acme/lib"),
        JSON.stringify({ type: "pr-link", prNumber: 14, prUrl: "https://ghe.example.com/acme/app/pull/14", prRepository: "acme/app" }),
        JSON.stringify({ type: "pr-link", prNumber: "15", prUrl: "https://github.com/acme/app/pull/15", prRepository: "acme/app" }),
        JSON.stringify({ type: "pr-link", prNumber: 16, prUrl: "https://github.com/acme/app/pull/16", prRepository: "../etc" }),
      ),
    );
    const { links, offset } = await scanPrLinks(path);
    expect(links).toEqual([
      { repo: "acme/app", number: 12, url: "https://github.com/acme/app/pull/12", firstSeen: "2026-06-01T00:00:00Z" },
      { repo: "acme/lib", number: 13, url: "https://github.com/acme/lib/pull/13", firstSeen: "2026-06-03T00:00:00Z" },
    ]);
    expect(offset).toBe(statSync(path).size);
  });

  it("skips an entry GitHub could not be asked about: a number past an Int, a repository named like a path, no timestamp", async () => {
    const entry = (fields: Record<string, unknown>) =>
      JSON.stringify({ type: "pr-link", prUrl: "https://github.com/acme/app/pull/1", prRepository: "acme/app", prNumber: 1, timestamp: "2026-06-01T00:00:00Z", ...fields });
    const path = transcript(
      lines(
        entry({ prNumber: 1e21 }), // spliced into the query as `1e+21`, failing every PR asked about with it
        entry({ prNumber: 2_147_483_648 }),
        entry({ prRepository: "acme/.." }),
        entry({ prRepository: "acme/." }),
        entry({ prNumber: 3, timestamp: undefined }), // "when scanned" is not when the chat named it
        entry({ prNumber: 4, timestamp: 1_700_000_000 }),
        entry({ prNumber: 2_147_483_647 }),
      ),
    );
    expect((await scanPrLinks(path)).links.map((l) => l.number)).toEqual([2_147_483_647]);

    const stored = (fields: Record<string, unknown>) => ({ repo: "acme/app", number: 1, url: "u", firstSeen: "t", ...fields });
    expect(parsePrLinks([stored({ number: 1e21 }), stored({ repo: "acme/.." }), stored({ number: 5 })]).map((l) => l.number)).toEqual([5]);
  });

  it("finds an entry in a line longer than one read, wherever a read boundary falls in it", async () => {
    const READ = 1 << 20;
    // `{"pad":"…","type":"pr-link",…}`: the marker starts 10 bytes plus the padding into the line.
    const padded = (prNumber: number, markerAt: number) =>
      JSON.stringify({ pad: "x".repeat(markerAt - 10), type: "pr-link", prNumber, prUrl: `https://github.com/acme/app/pull/${prNumber}`, prRepository: "acme/app", timestamp: "2026-06-01T00:00:00Z" });
    const first = padded(1, READ - 5); // the marker itself is split across the first two reads
    const second = padded(2, 3 * READ + 100); // the marker is whole, three reads into its line
    const path = transcript(lines(first, JSON.stringify({ type: "assistant", message: { content: "y".repeat(2 * READ) } }), second, prLink(3)));
    const { links, offset } = await scanPrLinks(path);
    expect(links.map((l) => l.number)).toEqual([1, 2, 3]);
    expect(offset).toBe(statSync(path).size);

    // And resumed mid-file, with the long line torn before its end.
    const whole = lines(prLink(4));
    const torn = transcript(whole + second.slice(0, 2 * READ));
    expect(await scanPrLinks(torn)).toEqual({ links: [expect.objectContaining({ number: 4 })], offset: Buffer.byteLength(whole) });
    appendFileSync(torn, second.slice(2 * READ) + "\n");
    expect((await scanPrLinks(torn, Buffer.byteLength(whole))).links.map((l) => l.number)).toEqual([2]);
  });

  it("stops at the last complete line, and picks the torn one up whole next time", async () => {
    const whole = lines(prLink(1));
    const torn = prLink(2);
    const path = transcript(whole + torn.slice(0, 40));
    const first = await scanPrLinks(path);
    expect(first.links.map((l) => l.number)).toEqual([1]);
    expect(first.offset).toBe(Buffer.byteLength(whole));

    appendFileSync(path, torn.slice(40) + "\n");
    const second = await scanPrLinks(path, first.offset);
    expect(second.links.map((l) => l.number)).toEqual([2]);
    expect(second.offset).toBe(statSync(path).size);
  });
});

describe("syncChatPrLinks", () => {
  it("stores every PR the chat's sessions name, and reads only what was appended afterwards", async () => {
    const old = transcript(lines(prLink(1)));
    const live = transcript(lines(prLink(2)));
    const chat = makeChat({ session_ids: ["old-session"], title: "kept" });
    const d = deps({ "old-session": old, [chat.session_id]: live });

    expect((await syncChatPrLinks(chat, d)).map((l) => l.number).sort()).toEqual([1, 2]);
    const stored = metaOf(chat.id);
    expect(parsePrLinks(stored.prLinks).map((l) => l.number).sort()).toEqual([1, 2]);
    expect(stored.prLinkScan).toEqual({ "old-session": statSync(old).size, [chat.session_id]: statSync(live).size });
    expect(stored.title).toBe("kept");

    // Nothing grew: no read, no write.
    const before = chatFileService.getChat(chat.id)!;
    expect((await syncChatPrLinks(before, d)).map((l) => l.number).sort()).toEqual([1, 2]);
    expect(chatFileService.getChat(chat.id)).toEqual(before);

    // The turn goes on and opens two more PRs.
    appendFileSync(live, lines(prLink(3), prLink(4)));
    expect((await syncChatPrLinks(chatFileService.getChat(chat.id)!, d)).map((l) => l.number).sort()).toEqual([1, 2, 3, 4]);
    expect(metaOf(chat.id).prLinkScan[chat.session_id]).toBe(statSync(live).size);
  });

  it("leaves `updated_at` alone, and marks a transcript with no links as read", async () => {
    const chat = makeChat();
    const path = transcript(lines(JSON.stringify({ type: "user" })));
    expect(await syncChatPrLinks(chat, deps({ [chat.session_id]: path }))).toEqual([]);
    const after = chatFileService.getChat(chat.id)!;
    expect(after.updated_at).toBe(chat.updated_at);
    expect(metaOf(chat.id).prLinks).toBeUndefined();
    expect(metaOf(chat.id).prLinkScan).toEqual({ [chat.session_id]: statSync(path).size });
  });

  it("starts over on a transcript shorter than what was read", async () => {
    const path = transcript(lines(prLink(5)));
    const chat = makeChat({ prLinkScan: {} });
    chatFileService.updateChatMetadata(chat.id, { prLinkScan: { [chat.session_id]: 10_000 } });
    expect((await syncChatPrLinks(chatFileService.getChat(chat.id)!, deps({ [chat.session_id]: path }))).map((l) => l.number)).toEqual([5]);
  });

  it("shares one run between callers that arrive together", async () => {
    const chat = makeChat();
    const d = deps({ [chat.session_id]: transcript(lines(prLink(1))) });
    const a = syncChatPrLinks(chat, d);
    const b = syncChatPrLinks(chat, d);
    expect(b).toBe(a);
    expect((await a).map((l) => l.number)).toEqual([1]);
    expect(d.logPath).toHaveBeenCalledTimes(1);
  });

  it("writes onto the freshest record: what was written to the chat while its transcript was read survives", async () => {
    const chat = makeChat({ title: "before" });
    const run = syncChatPrLinks(chat, deps({ [chat.session_id]: transcript(lines(prLink(1))) }));
    // Lands while the scan is awaited — after the snapshot `chat` was taken.
    chatFileService.updateChatMetadata(chat.id, { title: "after", model: "opus" });
    await run;
    expect(metaOf(chat.id)).toMatchObject({ title: "after", model: "opus", prLinks: [expect.objectContaining({ number: 1 })] });
  });

  it("writes only the offsets it moved, so a run on an older snapshot does not rewind another session's", async () => {
    const old = transcript(lines(prLink(1)));
    const live = transcript(lines(prLink(2)));
    const chat = makeChat({ session_ids: ["old-session"] });
    const d = deps({ "old-session": old, [chat.session_id]: live });
    await syncChatPrLinks(chat, d);
    // The backlog's copy of the chat, taken now…
    const snapshot = chatFileService.getChat(chat.id)!;
    // …then a turn's end reads further into the old session's transcript.
    appendFileSync(old, lines(prLink(3)));
    await syncChatPrLinks(chatFileService.getChat(chat.id)!, d);
    const advanced = statSync(old).size;
    // The backlog reaches the chat: only the live transcript has grown for it.
    appendFileSync(live, lines(prLink(4)));
    await syncChatPrLinks(snapshot, deps({ [chat.session_id]: live }));
    expect(metaOf(chat.id).prLinkScan).toEqual({ "old-session": advanced, [chat.session_id]: statSync(live).size });
    expect(parsePrLinks(metaOf(chat.id).prLinks).map((l) => l.number)).toEqual([1, 2, 3, 4]);
  });

  it("answers with the stored links for another engine, a missing transcript, or a failed read", async () => {
    const stored = [{ repo: "acme/app", number: 9, url: "https://github.com/acme/app/pull/9", firstSeen: "t" }];
    const codex = makeChat({ provider: "codex", prLinks: stored });
    const d = deps({});
    expect(await syncChatPrLinks(codex, d)).toEqual(stored);
    expect(d.logPath).not.toHaveBeenCalled();

    const gone = makeChat({ prLinks: stored });
    expect(await syncChatPrLinks(gone, deps({}))).toEqual(stored);

    const broken = makeChat({ prLinks: stored });
    expect(await syncChatPrLinks(broken, { logPath: () => tmp, size: () => 5 })).toEqual(stored); // a directory: the read fails
  });
});

describe("syncPrLinksInBackground", () => {
  it("syncs each chat once per daemon lifetime, however often it is asked", async () => {
    const chat = makeChat();
    const d = deps({ [chat.session_id]: transcript(lines(prLink(7))) });
    syncPrLinksInBackground([chat], d);
    syncPrLinksInBackground([chat], d);
    await prLinkBacklogIdle();
    expect(d.logPath).toHaveBeenCalledTimes(1);
    expect(parsePrLinks(metaOf(chat.id).prLinks).map((l) => l.number)).toEqual([7]);
  });

  it("gives the event loop a turn between chats, so a long backlog of up-to-date chats does not hold every request", async () => {
    // No transcript to read: each sync finishes without ever awaiting I/O.
    const backlog = Array.from({ length: 50 }, () => makeChat());
    const d = deps({});
    let syncedWhenTheLoopTurned = -1;
    setImmediate(() => (syncedWhenTheLoopTurned = d.logPath.mock.calls.length));
    syncPrLinksInBackground(backlog, d);
    await prLinkBacklogIdle();
    expect(d.logPath).toHaveBeenCalledTimes(50);
    expect(syncedWhenTheLoopTurned).toBeGreaterThanOrEqual(0);
    expect(syncedWhenTheLoopTurned).toBeLessThan(5);
  });
});

describe("the production wiring", () => {
  const tick = () => new Promise((r) => setImmediate(r));
  initPrLinkRecorder();

  it("finds a transcript through the Claude Code provider once, and does not look again for one that is missing", () => {
    sessionLogs["wired-here"] = transcript(lines(prLink(1)));
    expect(DEFAULT_PR_LINK_DEPS.logPath("wired-here")).toBe(sessionLogs["wired-here"]);
    expect(DEFAULT_PR_LINK_DEPS.logPath("wired-here")).toBe(sessionLogs["wired-here"]);
    expect(DEFAULT_PR_LINK_DEPS.logPath("wired-gone")).toBeNull();
    expect(DEFAULT_PR_LINK_DEPS.logPath("wired-gone")).toBeNull();
    // A miss walks every project directory: paid once per session, not once per sync.
    expect(resolveSession.mock.calls.map(([id]) => id)).toEqual(["wired-here", "wired-gone"]);
    expect(DEFAULT_PR_LINK_DEPS.size(sessionLogs["wired-here"])).toBe(statSync(sessionLogs["wired-here"]).size);
    expect(DEFAULT_PR_LINK_DEPS.size(join(tmp, "no-such-file"))).toBeNull();

    resetPrLinkSync();
    expect(DEFAULT_PR_LINK_DEPS.logPath("wired-gone")).toBeNull();
    expect(resolveSession).toHaveBeenCalledTimes(3);
  });

  it("looks again for a missing transcript after a minute, so a chat asked about before its file exists is not blank for a long first turn", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      expect(DEFAULT_PR_LINK_DEPS.logPath("wired-late")).toBeNull();
      // Claude Code creates the file a moment later; the turn runs on.
      sessionLogs["wired-late"] = transcript(lines(prLink(1)));
      vi.setSystemTime(1_000_000 + MISSING_LOG_TTL_MS - 1);
      expect(DEFAULT_PR_LINK_DEPS.logPath("wired-late")).toBeNull();
      expect(resolveSession).toHaveBeenCalledTimes(1);
      vi.setSystemTime(1_000_000 + MISSING_LOG_TTL_MS);
      expect(DEFAULT_PR_LINK_DEPS.logPath("wired-late")).toBe(sessionLogs["wired-late"]);
      expect(MISSING_LOG_TTL_MS).toBeLessThanOrEqual(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("syncs a chat's links when its turn ends — looking again for a transcript that was missing before the turn", async () => {
    const chat = makeChat();
    // Asked about before the session has written anything: remembered as missing.
    expect(await syncChatPrLinks(chat)).toEqual([]);
    sessionLogs[chat.session_id] = transcript(lines(prLink(31)));
    expect(await syncChatPrLinks(chat)).toEqual([]);

    sessionRegistry.register(chat.id, { type: "web" });
    await tick();
    expect(metaOf(chat.id).prLinks).toBeUndefined();
    sessionRegistry.unregister(chat.id);
    await vi.waitFor(() => expect(parsePrLinks(metaOf(chat.id).prLinks).map((l) => l.number)).toEqual([31]));
  });

  it("ignores a new chat's temporary id", async () => {
    sessionRegistry.register("new-777", { type: "web" });
    sessionRegistry.unregister("new-777");
    await tick();
    expect(resolveSession).not.toHaveBeenCalled();
  });
});

describe("mergePrLinks", () => {
  it("keeps one entry per PR — repository names compared case-insensitively — with the earliest sighting", () => {
    const link = (repo: string, number: number, firstSeen: string) => ({ repo, number, url: `https://github.com/${repo}/pull/${number}`, firstSeen });
    expect(mergePrLinks([link("acme/app", 1, "b")], [link("Acme/App", 1, "a"), link("acme/app", 2, "c")])).toEqual([
      { ...link("acme/app", 1, "a") },
      link("acme/app", 2, "c"),
    ]);
  });
});
