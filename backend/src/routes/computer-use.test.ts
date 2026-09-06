import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
vi.mock("../auth.js", () => ({ requireSessionAuth: vi.fn() }));
vi.mock("../services/computer-use.js", () => ({ getComputerUseHost: vi.fn() }));
import { requireControlOrigin } from "./computer-use.js";

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
