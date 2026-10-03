import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parseChatMeta, providerKindOf, useChatMeta } from "./useChatMeta";

const NATIVE = {
  parentThreadId: "thread-1",
  inferredParentChatId: "chat-parent",
  lifecycle: "active",
  management: "read-only",
  controlNote: "note",
};

describe("parseChatMeta", () => {
  it("reads every field the chat page uses", () => {
    const meta = parseChatMeta(
      JSON.stringify({
        provider: "codex",
        jobRunId: "run-1",
        nativeAgent: NATIVE,
        parentChatId: "chat-explicit",
        acpProviderId: "opencode",
        model: "gpt-5",
        effort: "high",
        defaultPermissions: { fileRead: "allow" },
        agentAlias: "forge",
      }),
    );
    expect(meta).toEqual({
      provider: "codex",
      jobRunId: "run-1",
      nativeAgent: NATIVE,
      parentChatId: "chat-explicit",
      acpProviderId: "opencode",
      model: "gpt-5",
      effort: "high",
      defaultPermissions: { fileRead: "allow" },
      agentAlias: "forge",
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["malformed JSON", "{not json"],
    ["truncated JSON", '{"provider":"codex"'],
    ["JSON null", "null"],
    ["a JSON number", "42"],
    ["a JSON string", '"codex"'],
    ["a JSON array", '["codex"]'],
  ])("reads %s as carrying nothing", (_label, metadata) => {
    const meta = parseChatMeta(metadata);
    expect(meta.provider).toBeNull();
    expect(meta.jobRunId).toBeUndefined();
    expect(meta.nativeAgent).toBeUndefined();
    expect(meta.parentChatId).toBeUndefined();
    expect(meta.acpProviderId).toBeUndefined();
    expect(meta.model).toBeUndefined();
    expect(meta.effort).toBeUndefined();
    expect(meta.defaultPermissions).toBeUndefined();
    expect(meta.agentAlias).toBeUndefined();
  });

  it("drops fields of the wrong type rather than passing them on", () => {
    const meta = parseChatMeta(JSON.stringify({ provider: 7, jobRunId: 1, parentChatId: {}, acpProviderId: false, model: null, effort: 3, agentAlias: [] }));
    expect(meta).toEqual(parseChatMeta("{}"));
  });

  it("keeps an empty model and ACP id (an explicit 'no override'), but not an empty provider, parent or alias", () => {
    const meta = parseChatMeta(JSON.stringify({ provider: "", model: "", acpProviderId: "", parentChatId: "", agentAlias: "" }));
    expect(meta.provider).toBeNull();
    expect(meta.model).toBe("");
    expect(meta.acpProviderId).toBe("");
    expect(meta.parentChatId).toBeUndefined();
    expect(meta.agentAlias).toBeUndefined();
  });

  it("treats falsy nativeAgent and defaultPermissions as absent", () => {
    const meta = parseChatMeta(JSON.stringify({ nativeAgent: null, defaultPermissions: 0 }));
    expect(meta.nativeAgent).toBeUndefined();
    expect(meta.defaultPermissions).toBeUndefined();
  });

  it("passes an unrecognized provider through raw — the badge names retired harnesses", () => {
    expect(parseChatMeta(JSON.stringify({ provider: "openrouter" })).provider).toBe("openrouter");
  });
});

describe("providerKindOf", () => {
  it.each(["codex", "acp", "cline", "pi"])("keeps %s", (kind) => {
    expect(providerKindOf(kind)).toBe(kind);
  });

  it.each([null, "claude-code", "openrouter", "something-new"])("collapses %s to claude-code", (raw) => {
    expect(providerKindOf(raw)).toBe("claude-code");
  });
});

describe("useChatMeta", () => {
  it("parses once per metadata string, so derived objects keep their identity across renders", () => {
    const metadata = JSON.stringify({ nativeAgent: NATIVE });
    const { result, rerender } = renderHook(({ m }) => useChatMeta(m), { initialProps: { m: metadata } });
    const first = result.current;
    rerender({ m: metadata });
    expect(result.current).toBe(first);
    expect(result.current.nativeAgent).toBe(first.nativeAgent);

    rerender({ m: JSON.stringify({ nativeAgent: NATIVE }) }); // equal text, new string: same value
    expect(result.current).toBe(first);

    rerender({ m: JSON.stringify({ provider: "pi" }) });
    expect(result.current).not.toBe(first);
    expect(result.current.provider).toBe("pi");
  });

  it("survives malformed metadata", () => {
    const { result } = renderHook(() => useChatMeta("{oops"));
    expect(result.current.provider).toBeNull();
  });
});
