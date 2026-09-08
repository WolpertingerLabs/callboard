import { afterEach, describe, expect, it, vi } from "vitest";
import { computerUseClient, controlErrorCode, validateObservation, validateStatus } from "./computerUse";

afterEach(() => vi.unstubAllGlobals());
describe("computer-use HTTP adapter", () => {
  it("uses authenticated same-origin, encoded URLs and explicit JSON mutations", async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ permission: "deny", capabilities: [], sessions: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await computerUseClient.open("chat/1", "native");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/computer-use/chat%2F1/open",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: '{"kind":"native"}',
      }),
    );
    await computerUseClient.status("chat/1");
    expect(fetcher).toHaveBeenLastCalledWith("/api/computer-use/chat%2F1/status", expect.objectContaining({ method: "GET", credentials: "include" }));
  });
  it("surfaces actionable backend capability errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":{"message":"Native display missing: configure OS consent"}}', { status: 503 })));
    await expect(computerUseClient.open("c", "native")).rejects.toThrow("configure OS consent");
  });
  it("surfaces the server's error code alongside its message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: "not_found", error: "Control session not found" }), { status: 404 })),
    );
    const failure = await computerUseClient.control("c1", "s1", "stop", 1).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Control session not found");
    expect(controlErrorCode(failure)).toBe("not_found");
  });
  it.each([
    ["a non-JSON body", () => new Response("gateway timeout", { status: 504 })],
    ["a JSON body without a code", () => new Response(JSON.stringify({ error: "nope" }), { status: 500 })],
  ])("reports no code for %s", async (_label, response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    const failure = await computerUseClient.control("c1", "s1", "stop", 1).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(controlErrorCode(failure)).toBeUndefined();
    expect(controlErrorCode(new Error("plain"))).toBeUndefined();
    expect(controlErrorCode(undefined)).toBeUndefined();
  });
  it("rejects malformed readiness instead of leaving controls enabled", () => {
    expect(() => validateStatus({ permission: "allow" } as never)).toThrow("Invalid computer-control status");
    expect(() => validateStatus({ permission: "allow", capabilities: [{ kind: "native", available: "true" }], sessions: [] } as never)).toThrow();
  });
  it("rejects non-raster, malformed and unbounded frames", () => {
    const good = {
      generation: 2,
      frameId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      frame: { data: "AA==", mimeType: "image/png" as const, width: 10, height: 20 },
    };
    expect(validateObservation(good)).toBe(good);
    for (const frameId of [undefined, "", "legacy", "x".repeat(4096)]) {
      expect(() => validateObservation({ ...good, frameId } as typeof good)).toThrow("Invalid screenshot");
    }
    for (const patch of [{ mimeType: "image/svg+xml" }, { width: 0 }, { height: 20000 }, { data: "data:bad" }]) {
      expect(() =>
        validateObservation({ ...good, frameId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", frame: { ...good.frame, ...patch } } as typeof good),
      ).toThrow("Invalid screenshot");
    }
  });
});

it.each(["setup-required", "unsupported", "permission-blocked", "unknown", "future-value", undefined])(
  "preserves additive readiness %s across the HTTP adapter without rejecting old payloads",
  async (readiness) => {
    const payload = {
      permission: "allow",
      capabilities: [{ kind: "native", available: false, reason: "Diagnostic", ...(readiness ? { readiness } : {}) }],
      sessions: [],
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await computerUseClient.status("c1")).toEqual(payload);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/computer-use/c1/status", expect.objectContaining({ method: "GET" }));
  },
);
