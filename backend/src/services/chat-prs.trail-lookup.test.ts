/** The chat PRs route reads a chat's own trail without `getChat`'s scan of every record. */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-chat-prs-trail-"));
process.env.CALLBOARD_DATA_DIR = dataDir;

const { chatFileService } = await import("./chat-file-service.js");
const { trailOfChat } = await import("./chat-prs.js");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const TRAIL = [{ cwd: "/r.wt", repoPath: "/r", branch: "feat/a", firstSeen: "t0", lastSeen: "t1" }];

describe("trailOfChat", () => {
  it("reads a chat filed under its own id with one file read", () => {
    chatFileService.upsertChat("same-id", "/r", "same-id", { metadata: JSON.stringify({ gitTrail: TRAIL }) });
    const scan = vi.spyOn(chatFileService, "getChat");
    const snapshot = vi.fn(() => []);
    expect(trailOfChat("same-id", snapshot)).toEqual(TRAIL);
    expect(scan).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("finds a chat filed under another session id in the snapshot, not by scanning", () => {
    const chat = chatFileService.upsertChat("chat-id", "/r", "other-session", { metadata: JSON.stringify({ gitTrail: TRAIL }) });
    const scan = vi.spyOn(chatFileService, "getChat");
    expect(trailOfChat("chat-id", () => [chat])).toEqual(TRAIL);
    expect(scan).not.toHaveBeenCalled();
  });

  it("answers an empty trail for an unknown chat", () => {
    expect(trailOfChat("nobody", () => [])).toEqual([]);
  });
});
