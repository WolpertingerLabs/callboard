import { describe, expect, it, vi } from "vitest";
import type { Chat } from "../api";
import { chatMeta, withChatMeta } from "./chatMeta";

const chat = (metadata: string): Chat => ({ id: "c1", folder: "/x", metadata }) as Chat;

describe("chatMeta", () => {
  it("parses once per chat object", () => {
    const parse = vi.spyOn(JSON, "parse");
    try {
      const c = chat('{"title":"T","pinned":true}');
      const first = chatMeta(c);
      const second = chatMeta(c);
      expect(first).toEqual({ title: "T", pinned: true });
      expect(second).toBe(first);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it("re-parses a different chat object with the same id", () => {
    const a = chat('{"title":"old"}');
    const b = { ...a, metadata: '{"title":"new"}' };
    expect(chatMeta(a).title).toBe("old");
    expect(chatMeta(b).title).toBe("new");
  });

  it("re-parses when a chat's metadata string is mutated in place", () => {
    const c = chat('{"title":"old"}');
    expect(chatMeta(c).title).toBe("old");
    c.metadata = '{"title":"new"}';
    expect(chatMeta(c).title).toBe("new");
  });

  it.each(["", "not json", "null", "5", '"str"'])("reads %j as empty and never throws", (metadata) => {
    expect(chatMeta(chat(metadata))).toEqual({});
  });
});

describe("withChatMeta", () => {
  it("returns a new chat with the edit applied, leaving the cached read untouched", () => {
    const c = chat('{"pinned":false,"title":"T"}');
    const before = chatMeta(c);
    const next = withChatMeta(c, (meta) => {
      meta.pinned = true;
    });
    expect(next).not.toBe(c);
    expect(JSON.parse(next.metadata)).toEqual({ pinned: true, title: "T" });
    expect(before.pinned).toBe(false);
    expect(chatMeta(c)).toBe(before);
    expect(chatMeta(next).pinned).toBe(true);
  });

  it("returns the chat itself when its metadata does not parse", () => {
    const c = chat("not json");
    expect(withChatMeta(c, (meta) => (meta.pinned = true))).toBe(c);
  });

  it("treats empty metadata as {}", () => {
    const next = withChatMeta(chat(""), (meta) => {
      meta.bookmarked = true;
    });
    expect(JSON.parse(next.metadata)).toEqual({ bookmarked: true });
  });
});
