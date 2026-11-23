import { afterEach, expect, it, vi } from "vitest";
import type { DefaultPermissions } from "shared/types/permissions.js";
import { updateChatPermissions } from "./api";

afterEach(() => vi.unstubAllGlobals());

const answering = (status: number, body: unknown) => {
  const fetcher = vi.fn(async (_url: unknown, _init: RequestInit) => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

it("always sends browserControl, so this bundle never takes the daemon's stale-tab path", async () => {
  const fetcher = answering(200, {});
  // Even a caller holding a record from before the split (no browserControl key).
  const legacy = { fileRead: "allow", fileWrite: "ask", codeExecution: "ask", webAccess: "ask", computerControl: "allow" } as unknown as DefaultPermissions;
  await updateChatPermissions("c", legacy);
  const sent = JSON.parse(fetcher.mock.calls[0][1].body as string).defaultPermissions;
  expect(sent).toMatchObject({ browserControl: "deny", computerControl: "allow" });
});

it("surfaces the daemon's stale-tab refusal text to the caller", async () => {
  answering(409, { error: "This tab is running an older Callboard version. Reload the tab.", code: "stale_client" });
  const all = { fileRead: "ask", fileWrite: "ask", codeExecution: "ask", webAccess: "ask", browserControl: "deny", computerControl: "deny" } as const;
  await expect(updateChatPermissions("c", all)).rejects.toThrow(/Reload the tab/);
});
