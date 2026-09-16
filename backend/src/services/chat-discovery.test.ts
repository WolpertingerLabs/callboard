import { describe, expect, it, vi } from "vitest";
vi.mock("../agents/factory.js", () => ({ getSessionProviders: () => [] }));
import { discoverChatCorpus } from "./chat-discovery.js";
import type { SessionProvider } from "../agents/ports/SessionProvider.js";
const entries = Array.from({ length: 10050 }, (_, i) => ({
  sessionId: String(i),
  folder: "/work/repo",
  displayFolder: "/work/repo",
  filePath: "/log/" + i,
  createdAt: new Date(0),
  updatedAt: new Date(i),
}));
describe("complete provider traversal", () => {
  it("enumerates beyond the former 9999 cap and merges providers globally", () => {
    const p = {
      kind: "codex",
      discoverSessions: ({ limit, offset }: { limit: number; offset: number }) => ({ sessions: entries.slice(offset, offset + limit), total: entries.length }),
    } as SessionProvider;
    const result = discoverChatCorpus([p]);
    expect(result.sessions).toHaveLength(10050);
    expect(result.sessions[0].sessionId).toBe("10049");
    expect(result.warnings).toEqual([]);
  });
  it("reports a stalled adapter or provider error rather than silently claiming completion", () => {
    const p = { kind: "codex", discoverSessions: () => ({ sessions: entries.slice(0, 10), total: 50 }) } as unknown as SessionProvider;
    expect(discoverChatCorpus([p]).warnings).toHaveLength(1);
    p.discoverSessions = () => {
      throw Error("offline");
    };
    expect(discoverChatCorpus([p]).warnings[0]).toContain("offline");
  });
});

it("requests a complete provider corpus in one scan, not one sweep per thousand rows", () => {
  const discoverSessions = vi.fn(({ limit, offset }) => ({ sessions: entries.slice(offset, offset + limit), total: entries.length }));
  expect(discoverChatCorpus([{ kind: "claude-code", discoverSessions } as unknown as SessionProvider]).sessions).toHaveLength(10050);
  expect(discoverSessions).toHaveBeenCalledTimes(1);
});
