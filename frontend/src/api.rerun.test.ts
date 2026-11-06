import { afterEach, expect, it, vi } from "vitest";
import { rerunChatFrom, RerunError } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("posts the pick and the precondition, and drops a system role", async () => {
  const fetcher = vi.fn(async (_url: unknown, _init: RequestInit) => ({ ok: true, json: async () => ({ chat: { id: "n" }, original: null }) }));
  vi.stubGlobal("fetch", fetcher);
  await rerunChatFrom("c", "2026-01-01T00:00:00.000Z", "assistant", { expectedParentChatId: null });
  expect(String(fetcher.mock.calls[0][0])).toMatch(/\/chats\/c\/rerun$/);
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ timestamp: "2026-01-01T00:00:00.000Z", role: "assistant", expectedParentChatId: null });
  await rerunChatFrom("c", "2026-01-01T00:00:00.000Z", "system");
  expect(JSON.parse(fetcher.mock.calls[1][1].body as string)).toEqual({ timestamp: "2026-01-01T00:00:00.000Z" });
});

it("throws a RerunError carrying the status and a chat started anyway", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: "moved. The rerun is running as a separate chat.", chatId: "stray" }) })),
  );
  const err = await rerunChatFrom("c", "2026-01-01T00:00:00.000Z", "user").catch((e) => e);
  expect(err).toBeInstanceOf(RerunError);
  expect(err).toMatchObject({ status: 409, chatId: "stray", message: expect.stringContaining("separate chat") });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "That message cannot be rerun" }) })),
  );
  expect(await rerunChatFrom("c", "2026-01-01T00:00:00.000Z", "user").catch((e) => e)).toMatchObject({ status: 400, chatId: undefined });
});
