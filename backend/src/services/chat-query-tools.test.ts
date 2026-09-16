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
  it.each(["search_chats", "get_chat_view"])("classifies %s as read-only across name-based permission adapters", async (name) => {
    const { categorizeClaudeTool } = await import("../agents/adapters/claude-code/permissionAdapter.js");
    const { categorizePiToolName } = await import("../agents/adapters/pi/permissionAdapter.js");
    const { categorizeClineToolName } = await import("../agents/adapters/cline/permissionAdapter.js");
    const { categorizeAcpToolName } = await import("../agents/adapters/acp/permissionAdapter.js");
    const qualified = `mcp__callboard-tools__${name}`;
    expect(categorizeClaudeTool(qualified)).toBe("fileRead");
    for (const categorize of [categorizePiToolName, categorizeClineToolName, categorizeAcpToolName]) {
      expect(categorize(name)).toBe("fileRead");
      expect(categorize(qualified)).toBe("fileRead");
    }
  });
});
