import { describe, it, expect } from "vitest";
import { isIpAllowed, isPrivateOrLoopback, validateAllowlistEntry, parseAllowlist } from "./ip-allowlist.js";

describe("isPrivateOrLoopback", () => {
  it("treats loopback as local", () => {
    expect(isPrivateOrLoopback("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopback("::1")).toBe(true);
    expect(isPrivateOrLoopback("::ffff:127.0.0.1")).toBe(true);
  });

  it("treats RFC1918 / LAN ranges as local", () => {
    expect(isPrivateOrLoopback("192.168.1.50")).toBe(true);
    expect(isPrivateOrLoopback("10.0.0.5")).toBe(true);
    expect(isPrivateOrLoopback("172.16.4.4")).toBe(true);
    expect(isPrivateOrLoopback("169.254.1.1")).toBe(true); // link-local
    expect(isPrivateOrLoopback("fd00::1")).toBe(true); // IPv6 unique-local
  });

  it("treats public addresses as NOT local (so they get gated)", () => {
    expect(isPrivateOrLoopback("203.0.113.7")).toBe(false);
    expect(isPrivateOrLoopback("2606:4700:4700::1111")).toBe(false);
  });

  it("treats Tailscale's ranges as NOT local, on IPv4 and IPv6 alike", () => {
    // 100.64.0.0/10 is CGNAT, which ipaddr.js does not call private.
    expect(isPrivateOrLoopback("100.64.0.1")).toBe(false);
    expect(isPrivateOrLoopback("100.101.102.103")).toBe(false);
    expect(isPrivateOrLoopback("::ffff:100.101.102.103")).toBe(false);
    // fd7a:115c:a1e0::/48 IS unique-local to ipaddr.js; it is carved out.
    expect(isPrivateOrLoopback("fd7a:115c:a1e0::1")).toBe(false);
    expect(isPrivateOrLoopback("fd7a:115c:a1e0:ab12:4843:cd96:6258:b240")).toBe(false);
    expect(isPrivateOrLoopback("[fd7a:115c:a1e0::1%tailscale0]")).toBe(false);
    // ...without taking the rest of fc00::/7 with it.
    expect(isPrivateOrLoopback("fd7a:115c:a1e1::1")).toBe(true);
    expect(isPrivateOrLoopback("fd00::1")).toBe(true);
  });

  it("treats unparseable input as NOT local", () => {
    expect(isPrivateOrLoopback("not-an-ip")).toBe(false);
    expect(isPrivateOrLoopback("")).toBe(false);
  });
});

describe("isIpAllowed", () => {
  it("allows everything when the list is empty (feature off)", () => {
    expect(isIpAllowed("203.0.113.7", [])).toBe(true);
    expect(isIpAllowed("203.0.113.7", ["   "])).toBe(true);
    expect(isIpAllowed("203.0.113.7", undefined)).toBe(true);
  });

  it("matches exact IPv4 and IPv6 addresses", () => {
    expect(isIpAllowed("203.0.113.7", ["203.0.113.7"])).toBe(true);
    expect(isIpAllowed("203.0.113.8", ["203.0.113.7"])).toBe(false);
    expect(isIpAllowed("2606:4700::1", ["2606:4700::1"])).toBe(true);
  });

  it("matches IPv4 CIDR ranges", () => {
    expect(isIpAllowed("203.0.113.42", ["203.0.113.0/24"])).toBe(true);
    expect(isIpAllowed("203.0.114.42", ["203.0.113.0/24"])).toBe(false);
  });

  it("matches IPv6 CIDR ranges", () => {
    expect(isIpAllowed("2606:4700:4700::1111", ["2606:4700:4700::/48"])).toBe(true);
    expect(isIpAllowed("2620:fe::fe", ["2606:4700:4700::/48"])).toBe(false);
  });

  it("matches IPv4-mapped IPv6 against an IPv4 rule", () => {
    expect(isIpAllowed("::ffff:203.0.113.7", ["203.0.113.0/24"])).toBe(true);
  });

  it("does not cross IPv4/IPv6 kinds", () => {
    expect(isIpAllowed("203.0.113.7", ["2606:4700::/32"])).toBe(false);
    expect(isIpAllowed("2606:4700::1", ["203.0.113.0/24"])).toBe(false);
  });

  it("skips malformed entries but honors valid ones", () => {
    expect(isIpAllowed("203.0.113.7", ["garbage", "203.0.113.7"])).toBe(true);
    expect(isIpAllowed("203.0.113.7", ["garbage"])).toBe(false);
  });

  it("returns false for an unparseable client address against a non-empty list", () => {
    expect(isIpAllowed("not-an-ip", ["203.0.113.0/24"])).toBe(false);
  });
});

describe("isIpAllowed — Tailscale ranges", () => {
  it("matches tailnet addresses against the suggested CIDRs", () => {
    const list = ["100.64.0.0/10", "fd7a:115c:a1e0::/48"];
    expect(isIpAllowed("100.101.102.103", list)).toBe(true);
    expect(isIpAllowed("fd7a:115c:a1e0::1", list)).toBe(true);
    expect(isIpAllowed("fd7a:115c:a1e1::1", list)).toBe(false);
    expect(isIpAllowed("203.0.113.7", list)).toBe(false);
  });
});

describe("validateAllowlistEntry", () => {
  it("accepts single IPs and CIDRs (v4 + v6)", () => {
    expect(validateAllowlistEntry("203.0.113.7")).toBe(true);
    expect(validateAllowlistEntry("203.0.113.0/24")).toBe(true);
    expect(validateAllowlistEntry("2606:4700::/32")).toBe(true);
    expect(validateAllowlistEntry("::1")).toBe(true);
  });

  it("rejects malformed entries", () => {
    expect(validateAllowlistEntry("garbage")).toBe(false);
    expect(validateAllowlistEntry("203.0.113.7/99")).toBe(false);
    expect(validateAllowlistEntry("")).toBe(false);
    expect(validateAllowlistEntry("999.0.0.1")).toBe(false);
  });
});

describe("parseAllowlist", () => {
  it("splits newline/comma strings and trims", () => {
    expect(parseAllowlist("203.0.113.7\n10.0.0.0/8 , 192.168.1.1")).toEqual(["203.0.113.7", "10.0.0.0/8", "192.168.1.1"]);
  });
  it("filters blanks from arrays", () => {
    expect(parseAllowlist(["203.0.113.7", "  ", ""])).toEqual(["203.0.113.7"]);
  });
  it("returns [] for empty input", () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist("")).toEqual([]);
  });
});
