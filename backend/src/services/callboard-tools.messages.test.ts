import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ToolDefinition } from "../agents/ports/tools.js";

vi.mock("./claude.js", () => ({ getActiveSession: () => undefined }));
vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  findChat: () => ({ id: "example", session_id: "session", metadata: "{}" }),
}));
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      resolveSession: () => true,
      parseSessionMessages: () => [
        { role: "assistant", type: "text", content: "Root answer" },
        {
          role: "system",
          type: "system",
          subtype: "agent_message",
          content: "[Encrypted collaboration content unavailable]",
          collaboration: { author: "/root/example", recipient: "/root", id: "reply-1", kind: "FINAL_ANSWER" },
        },
        { role: "system", type: "system", content: "ordinary marker" },
      ],
    },
  ],
}));

const { buildCallboardToolsSpec } = await import("./callboard-tools.js");
describe("read_session_messages collaboration context", () => {
  it("exports attributed context without pretending it is a root answer", async () => {
    const spec = buildCallboardToolsSpec(() => "caller", undefined, { includeJobTools: false });
    const tool = spec.tools.find((t) => t.name === "read_session_messages") as ToolDefinition<{ chatId: z.ZodString; limit: z.ZodOptional<z.ZodNumber> }>;
    const result = await tool.handler({ chatId: "example" });
    expect(result.content[0]).toMatchObject({
      text: "[assistant] Root answer\n\n[inter-agent FINAL_ANSWER; from /root/example to /root; id reply-1] [Encrypted collaboration content unavailable]",
    });
    const limited = await tool.handler({ chatId: "example", limit: 1 });
    expect(JSON.stringify(limited)).not.toContain("Root answer");
  });
});
