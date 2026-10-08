/**
 * The slash-command body cache keys on the space as well as the chat or
 * folder: a chat can move to a space whose agent scope hides a command, and a
 * body cached before the move must not keep showing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlashCommandContent } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("getSlashCommandContent cache", () => {
  it("fetches again when the same chat is asked about under a different space", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ name: "callboard:x", source: "custom-skill", description: null, content: "body" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await getSlashCommandContent("callboard:x", { chatId: "cache-chat-1", space: "default" });
    await getSlashCommandContent("callboard:x", { chatId: "cache-chat-1", space: "default" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getSlashCommandContent("callboard:x", { chatId: "cache-chat-1", space: "sp_work" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the space only on the new-chat (folder) door", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ name: "callboard:y", source: "builtin", description: null, content: null }) }));
    vi.stubGlobal("fetch", fetchMock);
    await getSlashCommandContent("callboard:y", { folder: "/repo", space: "sp_work" });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("space=sp_work");
    await getSlashCommandContent("callboard:y", { chatId: "cache-chat-2", space: "sp_work" });
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).not.toContain("space=");
  });
});
