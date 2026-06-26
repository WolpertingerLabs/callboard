import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { getClientKey } from "./client-ip.js";

/** Build a minimal Express-like Request for the resolver. */
function mockReq(opts: { socketIp?: string; ip?: string; headers?: Record<string, string | string[]> }): Request {
  return {
    socket: opts.socketIp === undefined ? undefined : { remoteAddress: opts.socketIp },
    ip: opts.ip,
    headers: opts.headers ?? {},
  } as unknown as Request;
}

describe("getClientKey", () => {
  describe("direct local / LAN clients", () => {
    it("keys on the socket address for a direct LAN client", () => {
      expect(getClientKey(mockReq({ socketIp: "192.168.1.50" }))).toBe("192.168.1.50");
    });

    it("IGNORES spoofed forwarding headers from a non-loopback client", () => {
      // The whole point: a remote/LAN attacker cannot mint fresh buckets via headers.
      const req = mockReq({
        socketIp: "192.168.1.50",
        headers: { "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "8.8.8.8" },
      });
      expect(getClientKey(req)).toBe("192.168.1.50");
    });

    it("returns the loopback address for a same-machine browser with no headers", () => {
      expect(getClientKey(mockReq({ socketIp: "127.0.0.1" }))).toBe("127.0.0.1");
    });
  });

  describe("behind the local cloudflared tunnel (loopback socket)", () => {
    it("trusts CF-Connecting-IP", () => {
      const req = mockReq({ socketIp: "127.0.0.1", headers: { "cf-connecting-ip": "203.0.113.7" } });
      expect(getClientKey(req)).toBe("203.0.113.7");
    });

    it("falls back to the first X-Forwarded-For hop when CF header is absent", () => {
      const req = mockReq({ socketIp: "127.0.0.1", headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } });
      expect(getClientKey(req)).toBe("203.0.113.7");
    });

    it("prefers CF-Connecting-IP over X-Forwarded-For", () => {
      const req = mockReq({
        socketIp: "127.0.0.1",
        headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "8.8.8.8" },
      });
      expect(getClientKey(req)).toBe("203.0.113.7");
    });

    it("distinguishes two remote clients sharing the loopback socket", () => {
      const a = getClientKey(mockReq({ socketIp: "127.0.0.1", headers: { "cf-connecting-ip": "203.0.113.7" } }));
      const b = getClientKey(mockReq({ socketIp: "127.0.0.1", headers: { "cf-connecting-ip": "198.51.100.4" } }));
      expect(a).not.toBe(b);
    });

    it("handles IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
      const req = mockReq({ socketIp: "::ffff:127.0.0.1", headers: { "cf-connecting-ip": "203.0.113.7" } });
      expect(getClientKey(req)).toBe("203.0.113.7");
    });

    it("handles IPv6 loopback (::1)", () => {
      const req = mockReq({ socketIp: "::1", headers: { "cf-connecting-ip": "203.0.113.7" } });
      expect(getClientKey(req)).toBe("203.0.113.7");
    });

    it("array-valued X-Forwarded-For uses the first hop", () => {
      const req = mockReq({ socketIp: "127.0.0.1", headers: { "x-forwarded-for": ["203.0.113.7", "10.0.0.1"] } });
      expect(getClientKey(req)).toBe("203.0.113.7");
    });
  });

  describe("fallbacks", () => {
    it("uses req.ip when there is no socket", () => {
      expect(getClientKey(mockReq({ socketIp: undefined, ip: "192.168.1.9" }))).toBe("192.168.1.9");
    });

    it("returns 'unknown' when nothing is available", () => {
      expect(getClientKey(mockReq({ socketIp: undefined }))).toBe("unknown");
    });
  });
});
