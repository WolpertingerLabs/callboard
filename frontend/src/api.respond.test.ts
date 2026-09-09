import { afterEach, expect, it, vi } from "vitest";
import { respondToChat } from "./api";
afterEach(() => vi.unstubAllGlobals());
it("sends the displayed request identity and preserves actionable HTTP errors", async () => {
  const fetcher = vi.fn(async (_url: unknown, _init: RequestInit) => ({ ok: false, json: async () => ({ error: "This prompt changed or expired" }) }));
  vi.stubGlobal("fetch", fetcher);
  expect(await respondToChat("chat", true, undefined, undefined, "issued-id")).toEqual({ ok: false, error: "This prompt changed or expired" });
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ allow: true, requestId: "issued-id" });
});
it("ordinary prompts omit identity and retain input compatibility", async () => {
  const fetcher = vi.fn(async (_url: unknown, _init: RequestInit) => ({ ok: true, json: async () => ({ ok: true, toolName: "Bash" }) }));
  vi.stubGlobal("fetch", fetcher);
  expect(await respondToChat("chat", true, { command: "ls" })).toEqual({ ok: true, toolName: "Bash" });
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ allow: true, updatedInput: { command: "ls" } });
});
it("pending replay advertises identity support and returns the same server prompt", async () => {
  const { getPending } = await import("./api");
  const { CAPS_HEADER, CLIENT_CAPS } = await import("shared/types/index.js");
  const pending = { type: "permission_request", humanOnly: true, requestId: "current", toolName: "mcp__computer_use__cu_action" };
  const fetcher = vi.fn(async (_url: unknown, _init: RequestInit) => ({ ok: true, json: async () => ({ pending }) }));
  vi.stubGlobal("fetch", fetcher);
  expect(await getPending("chat")).toEqual(pending);
  expect(new Headers(fetcher.mock.calls[0][1].headers).get(CAPS_HEADER)?.split(",")).toContain(CLIENT_CAPS.humanPromptIdentity);
});
