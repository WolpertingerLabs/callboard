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

const { chatFileService } = await import("./chat-file-service.js");
const { mergePrLinks, parsePrLinks, prLinkBacklogIdle, resetPrLinkSync, scanPrLinks, syncChatPrLinks, syncPrLinksInBackground } = await import(
  "./chat-pr-links.js"
);
type PrLinkDeps = import("./chat-pr-links.js").PrLinkDeps;

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => resetPrLinkSync());

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
