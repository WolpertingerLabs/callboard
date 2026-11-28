import { describe, expect, it, vi } from "vitest";
vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));
vi.mock("./sessions.js", () => ({ getSession: (owner: string) => (owner === "browser-secret" ? { expires_at: Date.now() + 100_000 } : undefined) }));
const { buildChatQueryTools } = await import("./chat-query-tools.js");
const { chatViews } = await import("./chat-view.js");
import { DEFAULT_CHAT_FILTERS, DEFAULT_CHAT_VIEW_OPTIONS } from "shared/types/chat-filters.js";
describe("read-only query tool binding", () => {
  it("reads live state through a fixed execution binding, not through the latest tab", async () => {
    const snapshot = {
      viewId: "00000000-0000-4000-8000-000000000099",
      revision: 1,
      filters: DEFAULT_CHAT_FILTERS,
      options: DEFAULT_CHAT_VIEW_OPTIONS,
      submittedSearch: "",
    };
    const binding = chatViews.publish("browser-secret", snapshot);
    const tools = buildChatQueryTools(binding);
    const get = tools.find((tool) => tool.name === "get_chat_view")!;
    chatViews.publish("browser-secret", { ...snapshot, revision: 2, submittedSearch: "new" });
    chatViews.publish("browser-secret", { ...snapshot, viewId: "00000000-0000-4000-8000-000000000098", submittedSearch: "other tab" });
    const response = await get.handler({});
    const text = response.content[0] as { text: string };
    expect(JSON.parse(text.text)).toMatchObject({ revision: 2, submittedSearch: "new" });
    expect(text.text).not.toContain("browser-secret");
    const oldClient = buildChatQueryTools().find((tool) => tool.name === "get_chat_view")!;
    expect(JSON.parse(((await oldClient.handler({})).content[0] as { text: string }).text)).toMatchObject({ available: false });
  });
  it("rejects visible without context rather than returning unrestricted rows", async () => {
    const search = buildChatQueryTools().find((tool) => tool.name === "search_chats")!;
    const result = await search.handler({ scope: "visible" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("CHAT_VIEW_UNAVAILABLE") });
  });
});

describe("query tool permission categories", () => {
  it.each(["search_chats", "get_chat_view"])("gates %s at fileRead on every engine (the shared Callboard table)", async (name) => {
    const { getCallboardGateResolver } = await import("../agents/permissions/categorizers.js");
    expect(getCallboardGateResolver("claude-code")(`mcp__callboard-tools__${name}`, {})).toEqual(["fileRead"]);
    expect(getCallboardGateResolver("pi")(name, {})).toEqual(["fileRead"]);
    // A tokens-only categorizer (no exact table) as generic coverage.
    const { makeNameCategorizer } = await import("../agents/permissions/nameCategorizer.js");
    expect(makeNameCategorizer()(name)).toBe("fileRead");
  });
});
