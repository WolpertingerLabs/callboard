import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { getClientKey, isDirectLocalClient } from "./client-ip.js";

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

  describe("behind a local reverse proxy such as tailscale serve (loopback socket)", () => {
    it("trusts the X-Forwarded-For entry the proxy appended", () => {
      const req = mockReq({ socketIp: "127.0.0.1", headers: { "x-forwarded-for": "100.101.102.103" } });
      expect(getClientKey(req)).toBe("100.101.102.103");
    });

    it("takes the LAST entry, not a client-supplied head", () => {
      // An appending proxy passes the client's own chain through and adds the
      // real peer at the end. Keying on the head let one client pick a fresh
      // bucket per request by varying one header.
      const req = mockReq({ socketIp: "127.0.0.1", headers: { "x-forwarded-for": "9.9.9.9, 100.101.102.103" } });
      expect(getClientKey(req)).toBe("100.101.102.103");
    });

    it("cannot be moved to a fresh bucket by varying the head", () => {
      const a = getClientKey(mockReq({ socketIp: "127.0.0.1", headers: { "x-forwarded-for": "1.1.1.1, 100.101.102.103" } }));
      const b = getClientKey(mockReq({ socketIp: "127.0.0.1", headers: { "x-forwarded-for": "2.2.2.2, 100.101.102.103" } }));
      expect(a).toBe(b);
    });

    it("IGNORES CF-Connecting-IP — nothing on this host sets it any more", () => {
      // It was trusted only while Callboard bundled a cloudflared tunnel that
      // overwrote it. Through any other proxy it is the client's own header.
      expect(getClientKey(mockReq({ socketIp: "127.0.0.1", headers: { "cf-connecting-ip": "203.0.113.7" } }))).toBe("127.0.0.1");
      const req = mockReq({ socketIp: "127.0.0.1", headers: { "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "100.101.102.103" } });
      expect(getClientKey(req)).toBe("100.101.102.103");
    });

    it("distinguishes two remote clients sharing the loopback socket", () => {
      const a = getClientKey(mockReq({ socketIp: "127.0.0.1", headers: { "x-forwarded-for": "100.101.102.103" } }));
      const b = getClientKey(mockReq({ socketIp: "127.0.0.1", headers: { "x-forwarded-for": "100.90.1.2" } }));
      expect(a).not.toBe(b);
    });

    it("handles IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
      const req = mockReq({ socketIp: "::ffff:127.0.0.1", headers: { "x-forwarded-for": "203.0.113.7" } });
      expect(getClientKey(req)).toBe("203.0.113.7");
    });

    it("handles IPv6 loopback (::1)", () => {
      const req = mockReq({ socketIp: "::1", headers: { "x-forwarded-for": "203.0.113.7" } });
      expect(getClientKey(req)).toBe("203.0.113.7");
    });

    it("array-valued X-Forwarded-For uses the last hop", () => {
      const req = mockReq({ socketIp: "127.0.0.1", headers: { "x-forwarded-for": ["9.9.9.9", "203.0.113.7"] } });
      expect(getClientKey(req)).toBe("203.0.113.7");
    });

    it("falls back to the socket on an empty X-Forwarded-For", () => {
      expect(getClientKey(mockReq({ socketIp: "127.0.0.1", headers: { "x-forwarded-for": " , " } }))).toBe("127.0.0.1");
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

/**
 * `isDirectLocalClient` — the one function between the public internet and
 * `npm install -g` on the operator's machine.
 *
 * It had no tests at all, which for a gate of this consequence is the same
 * defect this feature keeps producing: a security claim nothing checked. The
 * matrix below is deliberately hostile rather than illustrative — every row is a
 * header or address shape someone could actually send.
 *
 * The rule under test is **both** conditions: a local socket peer *and* no
 * forwarding header whatsoever. It is not `getClientKey`-based, and the first
 * case below is why.
 */
describe("isDirectLocalClient", () => {
  it("REJECTS a loopback socket whose XFF starts with a loopback address", () => {
    // The measured bypass. `getClientKey` trusted forwarding headers when the
    // socket was loopback and took XFF's *head* — and appending proxies pass a
    // client-supplied XFF through, so this is precisely the header an attacker
    // sends. Under the old derivation this keyed as "127.0.0.1" and passed.
    const req = mockReq({ socketIp: "127.0.0.1", headers: { "x-forwarded-for": "127.0.0.1, 203.0.113.7" } });
    expect(isDirectLocalClient(req)).toBe(false);
    // The loose function attributes it to the appended hop — a rate-limit
    // bucket — which is still not an answer to "is this local?".
    expect(getClientKey(req)).toBe("203.0.113.7");
  });

  it("accepts a same-machine browser: loopback socket, no headers", () => {
    expect(isDirectLocalClient(mockReq({ socketIp: "127.0.0.1" }))).toBe(true);
  });

  it("accepts an IPv4-mapped IPv6 loopback socket", () => {
    expect(isDirectLocalClient(mockReq({ socketIp: "::ffff:127.0.0.1" }))).toBe(true);
  });

  it("accepts an IPv6 loopback socket", () => {
    expect(isDirectLocalClient(mockReq({ socketIp: "::1" }))).toBe(true);
  });

  it("accepts private LAN ranges, which is the documented scope", () => {
    for (const ip of ["192.168.1.44", "10.0.0.5", "172.16.4.9", "fd00::1", "fe80::1"]) {
      expect(isDirectLocalClient(mockReq({ socketIp: ip }))).toBe(true);
    }
  });

  it("rejects a Tailscale socket address (100.64.0.0/10, fd7a:115c:a1e0::/48) — a tailnet is not the LAN", () => {
    for (const ip of ["100.64.0.1", "100.101.102.103", "100.127.255.254", "::ffff:100.101.102.103", "fd7a:115c:a1e0::1"]) {
      expect(isDirectLocalClient(mockReq({ socketIp: ip }))).toBe(false);
    }
  });

  it("rejects a public socket address", () => {
    for (const ip of ["203.0.113.7", "8.8.8.8", "2001:db8::1"]) {
      expect(isDirectLocalClient(mockReq({ socketIp: ip }))).toBe(false);
    }
  });

  it("rejects a loopback socket plus CF-Connecting-IP", () => {
    expect(isDirectLocalClient(mockReq({ socketIp: "127.0.0.1", headers: { "cf-connecting-ip": "203.0.113.7" } }))).toBe(false);
  });

  it("rejects a CF-Connecting-IP that claims to be loopback", () => {
    expect(isDirectLocalClient(mockReq({ socketIp: "127.0.0.1", headers: { "cf-connecting-ip": "127.0.0.1" } }))).toBe(false);
  });

  it("rejects every forwarding header on its own", () => {
    for (const header of [
      "cf-connecting-ip",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
      "x-client-ip",
      "true-client-ip",
      "fastly-client-ip",
      "fly-client-ip",
      "forwarded",
    ]) {
      expect(isDirectLocalClient(mockReq({ socketIp: "127.0.0.1", headers: { [header]: "anything" } }))).toBe(false);
    }
  });

  it("rejects an EMPTY forwarding header — a hop still announced itself", () => {
    expect(isDirectLocalClient(mockReq({ socketIp: "127.0.0.1", headers: { "x-forwarded-for": "" } }))).toBe(false);
  });

  it("rejects a duplicated header, which Node presents as an array", () => {
    expect(isDirectLocalClient(mockReq({ socketIp: "127.0.0.1", headers: { "x-forwarded-for": ["127.0.0.1", "203.0.113.7"] } }))).toBe(false);
  });

  it("rejects conflicting headers rather than picking a winner", () => {
    // No precedence rules here on purpose: the presence of *any* of them means
    // this is not a direct connection, and that is the whole question.
    const req = mockReq({ socketIp: "127.0.0.1", headers: { "cf-connecting-ip": "127.0.0.1", "x-forwarded-for": "203.0.113.7" } });
    expect(isDirectLocalClient(req)).toBe(false);
  });

  it("ignores headers that are not forwarding headers", () => {
    const req = mockReq({ socketIp: "127.0.0.1", headers: { "user-agent": "Mozilla", cookie: "callboard_session=x", "x-requested-with": "fetch" } });
    expect(isDirectLocalClient(req)).toBe(true);
  });

  it("fails closed on an absent socket", () => {
    expect(isDirectLocalClient(mockReq({}))).toBe(false);
  });

  it("fails closed on an unparseable address, and never falls back to req.ip", () => {
    // `getClientKey` has an `|| req.ip` fallback; this deliberately does not.
    // `req.ip` is derived by Express from headers when `trust proxy` is on, and
    // a capability gate must not read a value a header can move.
    expect(isDirectLocalClient(mockReq({ socketIp: "not-an-address", ip: "127.0.0.1" }))).toBe(false);
    expect(isDirectLocalClient(mockReq({ socketIp: "", ip: "127.0.0.1" }))).toBe(false);
  });

  it("survives a request with no headers object at all", () => {
    expect(isDirectLocalClient({ socket: { remoteAddress: "127.0.0.1" } } as any)).toBe(true);
  });
});
