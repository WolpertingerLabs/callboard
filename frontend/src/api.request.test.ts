/**
 * The shared `request` path every JSON wrapper in api.ts goes through: one
 * credentials policy, a JSON Content-Type only when there is a body, encoded
 * path segments, and one error-message order (`message`, `error`, `errors[]`,
 * then the fallback).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent, deleteChat, deleteDraft, getChat, getMessages, importJob, stopChat, toggleBookmark, uploadImagesOnly } from "./api";

type Call = [string, RequestInit];

function stubFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => response.body ?? {},
  }));
  vi.stubGlobal("fetch", fetcher);
  return () => fetcher.mock.calls as unknown as Call[];
}

afterEach(() => vi.unstubAllGlobals());

describe("request options", () => {
  it("sends cookies and no Content-Type on a bodyless GET", async () => {
    const calls = stubFetch({ ok: true, body: { id: "c1" } });
    await expect(getChat("c1")).resolves.toEqual({ id: "c1" });
    const [url, init] = calls()[0];
    expect(url).toBe("/api/chats/c1");
    expect(init.credentials).toBe("include");
    expect(init.method).toBeUndefined();
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("serialises a JSON body with a JSON Content-Type", async () => {
    const calls = stubFetch({ ok: true, body: {} });
    await toggleBookmark("c1", true);
    const [, init] = calls()[0];
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ bookmarked: true });
  });

  it("leaves multipart Content-Type to the browser", async () => {
    const calls = stubFetch({ ok: true, body: { images: [] } });
    await uploadImagesOnly([]);
    const [, init] = calls()[0];
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).toBeUndefined();
  });

  it("unwraps the field envelope", async () => {
    stubFetch({ ok: true, body: { agent: { alias: "a" } } });
    await expect(createAgent({ name: "A", alias: "a", description: "" })).resolves.toEqual({ alias: "a" });
  });

  it("does not parse a void call's body", async () => {
    const json = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json })),
    );
    await expect(deleteDraft("d1")).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });
});

describe("path segments", () => {
  it("encodes ids, and leaves ordinary ids byte-identical", async () => {
    const calls = stubFetch({ ok: true, body: [] });
    await getMessages("0b9e6a1c-4c1e-4b8a-9d51-2f3c5e7a9b10");
    await getMessages("a/b?c");
    expect(calls()[0][0]).toBe("/api/chats/0b9e6a1c-4c1e-4b8a-9d51-2f3c5e7a9b10/messages");
    expect(calls()[1][0]).toBe("/api/chats/a%2Fb%3Fc/messages");
  });
});

describe("error messages", () => {
  it("prefers message, then error, then errors[], then the fallback", async () => {
    stubFetch({ ok: false, body: { error: "native_child_read_only", message: "Read-only child chat" } });
    await expect(getChat("c1")).rejects.toThrow("Read-only child chat");
    stubFetch({ ok: false, body: { error: "Chat not found" } });
    await expect(getChat("c1")).rejects.toThrow("Chat not found");
    stubFetch({ ok: false, body: { errors: ["a", "b"] } });
    await expect(getChat("c1")).rejects.toThrow("a; b");
    stubFetch({ ok: false, body: {} });
    await expect(getChat("c1")).rejects.toThrow("Failed to get chat");
  });

  it("falls back when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, json: async () => Promise.reject(new SyntaxError("bad")) })),
    );
    await expect(getChat("c1")).rejects.toThrow("Failed to get chat");
  });

  it("deleteChat keeps showing the 409's prose over its code", async () => {
    stubFetch({ ok: false, status: 409, body: { error: "native_child_read_only", message: "Delete the parent instead" } });
    await expect(deleteChat("c1")).rejects.toThrow("Delete the parent instead");
  });

  it("stopChat surfaces the server's words, and the status when there are none", async () => {
    stubFetch({ ok: false, status: 409, body: { stopped: false, error: "native_child_read_only", message: "Stop it from the parent" } });
    await expect(stopChat("c1")).rejects.toThrow("Stop it from the parent");
    stubFetch({ ok: false, status: 503, body: {} });
    await expect(stopChat("c1")).rejects.toThrow("Stop failed (503)");
  });

  it("importJob keeps its own validation message shape", async () => {
    stubFetch({ ok: false, status: 400, body: { error: "Invalid job", errors: ["steps: required"] } });
    await expect(importJob({ name: "x" })).rejects.toThrow("Invalid job: steps: required");
    stubFetch({ ok: false, status: 409, body: { error: "exists", conflict: { id: "j1" } } });
    await expect(importJob({ name: "x" })).resolves.toEqual({ conflict: { id: "j1" } });
  });
});
