import { afterEach, describe, expect, it, vi } from "vitest";
import { computerUseClient, validateObservation, validateStatus } from "./computerUse";

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
  it("rejects malformed readiness instead of leaving controls enabled", () => {
    expect(() => validateStatus({ permission: "allow" } as never)).toThrow("Invalid computer-control status");
    expect(() => validateStatus({ permission: "allow", capabilities: [{ kind: "native", available: "true" }], sessions: [] } as never)).toThrow();
  });
  it("rejects non-raster, malformed and unbounded frames", () => {
    const good = { generation: 2, frame: { data: "AA==", mimeType: "image/png" as const, width: 10, height: 20 } };
    expect(validateObservation(good)).toBe(good);
    for (const patch of [{ mimeType: "image/svg+xml" }, { width: 0 }, { height: 20000 }, { data: "data:bad" }]) {
      expect(() => validateObservation({ ...good, frame: { ...good.frame, ...patch } } as typeof good)).toThrow("Invalid screenshot");
    }
  });
});
