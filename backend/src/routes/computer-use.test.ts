import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
vi.mock("../auth.js", () => ({ requireSessionAuth: (_req: Request, _res: Response, next: () => void) => next() }));
vi.mock("../services/computer-use.js", async (original) => ({
  ...(await original<typeof import("../services/computer-use.js")>()),
  getComputerUseHost: vi.fn(),
}));
import express from "express";
import { getComputerUseHost } from "../services/computer-use.js";
import { requireControlOrigin, computerUseRouter } from "./computer-use.js";

describe("computer control origin boundary", () => {
  function run(method: string, headers: Record<string, string | undefined>) {
    const req = { method, get: (name: string) => headers[name] } as Request;
    const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn();
    requireControlOrigin(req, res, next);
    return { res, next };
  }
  it("requires same-origin browser mutations, including an Origin header", () => {
    for (const headers of [
      { host: "callboard.local" },
      { host: "callboard.local", origin: "null" },
      { host: "callboard.local", origin: "https://evil.example" },
      { host: "callboard.local", origin: "https://callboard.local", "sec-fetch-site": "cross-site" },
    ]) {
      const { res, next } = run("POST", headers);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });
  it("allows same-host HTTPS origins behind a local reverse proxy", () => {
    expect(run("POST", { host: "callboard.local", origin: "https://callboard.local" }).next).toHaveBeenCalledOnce();
  });
  it("never caches status or frame responses", () => {
    const { res, next } = run("GET", {});
    expect(next).toHaveBeenCalledOnce();
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store, private");
  });
});

it("HTTP requires and forwards the exact frame token and preserves stale-frame conflict errors", async () => {
  const action = vi.fn(async () => ({}));
  vi.mocked(getComputerUseHost).mockResolvedValue({ action } as never);
  const app = express();
  app.use(express.json());
  app.use("/api/computer-use", computerUseRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown) =>
    fetch(`${origin}/api/computer-use/chat/session/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
  try {
    for (const frameId of [undefined, "legacy", "x".repeat(4096)]) {
      expect((await post({ frameId, expectedGeneration: 2, action: { type: "click", x: 1, y: 2 } })).status).toBe(400);
    }
    expect(action).not.toHaveBeenCalled();
    const frameId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const mutation = { type: "click", x: 1, y: 2 };
    expect((await post({ frameId, expectedGeneration: 2, action: mutation })).status).toBe(200);
    expect(action).toHaveBeenCalledWith("chat", "session", mutation, 2, frameId);
    action.mockRejectedValueOnce(Object.assign(new Error("Capture again"), { code: "stale_frame" }));
    const stale = await post({ frameId, expectedGeneration: 2, action: mutation });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale_frame" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
