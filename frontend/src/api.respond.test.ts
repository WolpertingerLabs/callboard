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
