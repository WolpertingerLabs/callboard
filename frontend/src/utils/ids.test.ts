/**
 * The regression these guard: `crypto.randomUUID` is exposed only in secure
 * contexts, so on a plain-HTTP LAN IP or tunnel hostname it is `undefined`.
 * Calling it unguarded threw inside the send path and surfaced as a bare
 * "network error" on every new chat, with nothing created server-side.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { newChatTrackingId } from "./ids";

/** The server's clientTrackingId allowlist (routes/stream.ts). */
const SERVER_ACCEPTS = /^new-[A-Za-z0-9_-]+$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newChatTrackingId", () => {
  it("works when crypto.randomUUID is missing (insecure context)", () => {
    vi.stubGlobal("crypto", {});
    const id = newChatTrackingId();
    expect(id).toMatch(SERVER_ACCEPTS);
  });

  it("works when there is no crypto object at all", () => {
    vi.stubGlobal("crypto", undefined);
    expect(newChatTrackingId()).toMatch(SERVER_ACCEPTS);
  });

  it("uses crypto.randomUUID when the context does expose it", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-2222-3333-4444-555555555555" });
    expect(newChatTrackingId()).toBe("new-11111111-2222-3333-4444-555555555555");
  });

  it("produces ids the server will accept, in either context", () => {
    for (const crypto of [{}, { randomUUID: () => "11111111-2222-3333-4444-555555555555" }]) {
      vi.stubGlobal("crypto", crypto);
      const id = newChatTrackingId();
      expect(id).toMatch(SERVER_ACCEPTS);
      // The route also caps the length.
      expect(id.length).toBeLessThanOrEqual(80);
    }
  });

  it("does not collide across rapid successive calls without randomUUID", () => {
    vi.stubGlobal("crypto", {});
    const ids = new Set(Array.from({ length: 1000 }, () => newChatTrackingId()));
    expect(ids.size).toBe(1000);
  });
});
