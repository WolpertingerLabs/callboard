import { afterEach, expect, it, vi } from "vitest";
import { HeldRequestError, HeldUnsupportedError, deleteHeldMessage, holdMessage, resumeHeldMessages, takeHeldMessage } from "./api";

afterEach(() => vi.unstubAllGlobals());

const answering = (status: number, body: unknown) => {
  const fetcher = vi.fn(async (_url: unknown, _init: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("not JSON");
      return body;
    },
  }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

const item = { id: "h1", chatId: "c", text: "later", createdAt: "2026-01-01T00:00:00.000Z", state: "queued" };

it("holds a message with the given body", async () => {
  const fetcher = answering(201, { heldMessage: item, heldMessages: [item] });
  const res = await holdMessage("c", { text: "later", model: "opus" });
  expect(res).toEqual({ held: true, heldMessage: item, heldMessages: [item] });
  expect(String(fetcher.mock.calls[0][0])).toMatch(/\/chats\/c\/held$/);
  expect(fetcher.mock.calls[0][1].method).toBe("POST");
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({ text: "later", model: "opus" });
});

it("reports not_running so the caller can send normally", async () => {
  answering(409, { error: "The chat is not running", code: "not_running" });
  expect(await holdMessage("c", { text: "x" })).toEqual({ held: false, reason: "not_running" });
});

it("throws HeldUnsupportedError on an old daemon's bare 404", async () => {
  answering(404, undefined);
  await expect(holdMessage("c", { text: "x" })).rejects.toBeInstanceOf(HeldUnsupportedError);
});

it("throws HeldRequestError, not unsupported, for a real chat-not-found", async () => {
  answering(404, { error: "Chat not found" });
  const err = await holdMessage("c", { text: "x" }).catch((e) => e);
  expect(err).toBeInstanceOf(HeldRequestError);
  expect(err.status).toBe(404);
});

it("take surfaces delivering / not_found as codes", async () => {
  answering(409, { error: "This message is being sent right now.", code: "delivering" });
  const err = await takeHeldMessage("c", "h1").catch((e) => e);
  expect(err).toBeInstanceOf(HeldRequestError);
  expect(err.code).toBe("delivering");

  const fetcher = answering(200, { heldMessage: item });
  expect(await takeHeldMessage("c", "h1")).toEqual(item);
  expect(String(fetcher.mock.calls[0][0])).toMatch(/\/chats\/c\/held\/h1\/take$/);
});

it("delete and resume hit their routes", async () => {
  let fetcher = answering(200, { heldMessages: [] });
  expect(await deleteHeldMessage("c", "h1")).toEqual([]);
  expect(fetcher.mock.calls[0][1].method).toBe("DELETE");
  fetcher = answering(200, { resumed: 1, started: true, heldMessages: [] });
  expect(await resumeHeldMessages("c")).toMatchObject({ resumed: 1, started: true });
  expect(String(fetcher.mock.calls[0][0])).toMatch(/\/chats\/c\/held\/resume$/);
});
