import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-superseded-parent-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const { chatFileService } = await import("./chat-file-service.js");
const { answeringParentFor } = await import("./superseded-parent.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
const created: string[] = [];
afterEach(() => {
  for (const sessionId of created.splice(0)) chatFileService.deleteChat(sessionId);
});
function makeChat(meta: Record<string, unknown> = {}) {
  const chat = chatFileService.createChat("/repos/sp", `s-${Math.random().toString(36).slice(2)}`, JSON.stringify(meta));
  created.push(chat.session_id);
  return chat;
}
const CUT = "2026-01-01T10:00:10.000Z";
const BEFORE = "2026-01-01T10:00:05.000Z";
const AFTER = "2026-01-01T10:00:20.000Z";

describe("answeringParentFor", () => {
  it("is the parent itself when it was never superseded, or its successor is gone", () => {
    const p = makeChat({});
    expect(answeringParentFor(p.id, BEFORE)).toBe(p.id);
    const orphaned = makeChat({ supersededBy: { chatId: "deleted-chat", kind: "compress-after" } });
    expect(answeringParentFor(orphaned.id, BEFORE)).toBe(orphaned.id);
    expect(answeringParentFor("no-such-chat", BEFORE)).toBe("no-such-chat");
  });

  it("follows a compression for any child", () => {
    const n = makeChat({});
    const c = makeChat({ supersededBy: { chatId: n.id, kind: "compress-before" }, forkedAt: CUT });
    expect(answeringParentFor(c.id, AFTER)).toBe(n.id);
  });

  it.each(["continue", "rerun"])("follows a %s only for children that existed at the cutoff", (kind) => {
    const n = makeChat({});
    const c = makeChat({ supersededBy: { chatId: n.id, kind }, forkedAt: CUT });
    expect(answeringParentFor(c.id, BEFORE)).toBe(n.id);
    expect(answeringParentFor(c.id, AFTER)).toBe(c.id);
    expect(answeringParentFor(c.id, undefined)).toBe(n.id);
  });

  it("follows a chain of supersedes and survives a cycle", () => {
    const n2 = makeChat({});
    const n1 = makeChat({ supersededBy: { chatId: n2.id, kind: "compress-after" } });
    const c = makeChat({ supersededBy: { chatId: n1.id, kind: "compress-after" } });
    expect(answeringParentFor(c.id, BEFORE)).toBe(n2.id);
    chatFileService.updateChatMetadata(n2.id, { supersededBy: { chatId: c.id, kind: "compress-after" } });
    expect([c.id, n1.id, n2.id]).toContain(answeringParentFor(c.id, BEFORE));
  });
});
