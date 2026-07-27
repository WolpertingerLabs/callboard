/**
 * Handshake parsing and `supports()` — the capability negotiation from
 * `plans/wire-capability-negotiation.md`, Phase 1.
 *
 * The load-bearing case is the legacy client: a request with no handshake
 * headers at all (every browser bundle shipped before this existed) must parse
 * to protocol 1 with an empty capability set and must never throw. Nothing is
 * gated on capabilities yet, so "supports() is false for everything" is by
 * construction a no-op — but it is the property the later phases lean on.
 */
import { describe, expect, it } from "vitest";
import type { IncomingHttpHeaders } from "http";
import { CLIENT_CAPS, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, SERVER_FEATURES, CLIENT_CAP_VALUES, handshakeHeaders } from "shared/types/index.js";
import { StreamSession, buildServerInfo, createStreamSession } from "./stream-session.js";

/** Build a fake request carrying the given (already lowercased) headers. */
function req(headers: IncomingHttpHeaders) {
  return { headers };
}

/** The headers a current client actually sends, lowercased as Node delivers them. */
function currentClientHeaders(): IncomingHttpHeaders {
  const sent = handshakeHeaders();
  return Object.fromEntries(Object.entries(sent).map(([k, v]) => [k.toLowerCase(), v]));
}

describe("createStreamSession — legacy client (no handshake headers)", () => {
  it("treats a request with no headers as protocol 1 with an empty cap set", () => {
    const session = createStreamSession(req({}));

    expect(session.protocolVersion).toBe(1);
    expect(session.capabilities).toEqual([]);
  });

  it("answers false for every known capability", () => {
    const session = createStreamSession(req({}));

    for (const cap of CLIENT_CAP_VALUES) {
      expect(session.supports(cap)).toBe(false);
    }
  });

  it("is unaffected by unrelated headers a browser sends", () => {
    const session = createStreamSession(
      req({ accept: "text/event-stream", cookie: "callboard_session=abc", "user-agent": "Mozilla/5.0", "cache-control": "no-cache" }),
    );

    expect(session.protocolVersion).toBe(1);
    expect(session.capabilities).toEqual([]);
    expect(session.supports(CLIENT_CAPS.budgetEvents)).toBe(false);
  });
});

describe("createStreamSession — protocol version parsing", () => {
  it("reads the version a current client sends", () => {
    expect(createStreamSession(req(currentClientHeaders())).protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("tolerates surrounding whitespace", () => {
    expect(createStreamSession(req({ "x-callboard-protocol": " 2 " })).protocolVersion).toBe(2);
  });

  it("accepts a version newer than this server's", () => {
    expect(createStreamSession(req({ "x-callboard-protocol": "99" })).protocolVersion).toBe(99);
  });

  it.each([
    ["empty", ""],
    ["non-numeric", "abc"],
    ["fractional", "2.5"],
    ["negative", "-1"],
    ["zero", "0"],
    ["numeric with junk", "2; q=1"],
  ])("falls back to protocol 1 on a %s value", (_label, value) => {
    expect(createStreamSession(req({ "x-callboard-protocol": value })).protocolVersion).toBe(1);
  });

  it("falls back to protocol 1 on an unsafe integer", () => {
    expect(createStreamSession(req({ "x-callboard-protocol": "9".repeat(30) })).protocolVersion).toBe(1);
  });

  it("does not downgrade a modern client whose version header a proxy duplicated", () => {
    // Node joins repeated headers into one comma-separated string, so a
    // header-appending proxy or CDN turns "2" into "2, 2". Rejecting that
    // whole value would record a current client as legacy — silently today,
    // and as a refused connection once minProtocolVersion is enforced.
    expect(createStreamSession(req({ "x-callboard-protocol": "2, 2" })).protocolVersion).toBe(2);
    expect(createStreamSession(req({ "x-callboard-protocol": ["2", "2"] })).protocolVersion).toBe(2);
  });

  it("takes the client's own segment, not a value appended after it", () => {
    // The client originates this header, so the leftmost segment is the one
    // describing the browser; anything appended downstream describes a proxy.
    expect(createStreamSession(req({ "x-callboard-protocol": "3,99" })).protocolVersion).toBe(3);
  });

  it("still falls back to protocol 1 when the client's own segment is junk", () => {
    expect(createStreamSession(req({ "x-callboard-protocol": "abc,2" })).protocolVersion).toBe(1);
  });
});

describe("createStreamSession — handshook", () => {
  it("is false for a client that sent no handshake headers", () => {
    expect(createStreamSession(req({})).handshook).toBe(false);
    expect(createStreamSession(req({ accept: "text/event-stream" })).handshook).toBe(false);
  });

  it("is true for a current client", () => {
    expect(createStreamSession(req(currentClientHeaders())).handshook).toBe(true);
  });

  it("is true for caps without a version — the case a version check gets wrong", () => {
    // Caps are parsed independently of the version, so this client is recorded
    // at protocol 1 with a non-empty cap set. `protocolVersion >= 2` — the
    // natural way to write "did this client handshake?" — would call it legacy.
    const session = createStreamSession(req({ "x-callboard-caps": "budget_events" }));

    expect(session.protocolVersion).toBe(1);
    expect(session.handshook).toBe(true);
  });

  it("is true for a version without caps", () => {
    expect(createStreamSession(req({ "x-callboard-protocol": "2" })).handshook).toBe(true);
  });

  it("is true for a garbled version — the client knows the mechanism either way", () => {
    // Degrading an unparseable version to 1 is a parse decision. It is not
    // evidence that the client predates the handshake.
    const session = createStreamSession(req({ "x-callboard-protocol": "abc" }));

    expect(session.protocolVersion).toBe(1);
    expect(session.handshook).toBe(true);
  });

  it("is false for headers present but blank", () => {
    expect(createStreamSession(req({ "x-callboard-protocol": "", "x-callboard-caps": "  " })).handshook).toBe(false);
  });
});

describe("createStreamSession — capability parsing", () => {
  it("records the caps a current client advertises", () => {
    const session = createStreamSession(req(currentClientHeaders()));

    expect(session.supports(CLIENT_CAPS.toolSource)).toBe(true);
    expect(session.supports(CLIENT_CAPS.budgetEvents)).toBe(true);
    expect(session.supports(CLIENT_CAPS.planReview)).toBe(true);
  });

  it("trims entries and drops blanks", () => {
    const session = createStreamSession(req({ "x-callboard-caps": " tool_source , ,budget_events, " }));

    expect(session.capabilities).toEqual(["budget_events", "tool_source"]);
  });

  it("de-duplicates repeated entries", () => {
    const session = createStreamSession(req({ "x-callboard-caps": "tool_source,tool_source" }));

    expect(session.capabilities).toEqual(["tool_source"]);
  });

  it("joins a repeated header rather than dropping one of them", () => {
    const session = createStreamSession(req({ "x-callboard-caps": ["tool_source", "plan_review"] }));

    expect(session.capabilities).toEqual(["plan_review", "tool_source"]);
  });

  it("records capabilities this server has never heard of", () => {
    // A newer client advertising something we don't know about is not an
    // error — no emit site asks about it.
    const session = createStreamSession(req({ "x-callboard-caps": "tool_source,from_the_future" }));

    expect(session.supports("from_the_future")).toBe(true);
    expect(session.supports(CLIENT_CAPS.toolSource)).toBe(true);
  });

  it("bounds how many capabilities one client can make us hold", () => {
    const many = Array.from({ length: 500 }, (_, i) => `cap_${i}`).join(",");

    expect(createStreamSession(req({ "x-callboard-caps": many })).capabilities.length).toBe(64);
  });

  it("is case-sensitive on cap values (they are wire constants, not prose)", () => {
    expect(createStreamSession(req({ "x-callboard-caps": "TOOL_SOURCE" })).supports(CLIENT_CAPS.toolSource)).toBe(false);
  });

  it("honors caps sent without a protocol header, as protocol 1", () => {
    // Independent parsing: the capability claim is the part an emit site acts
    // on, and a version number with no caps gates nothing.
    const session = createStreamSession(req({ "x-callboard-caps": "budget_events" }));

    expect(session.protocolVersion).toBe(1);
    expect(session.supports(CLIENT_CAPS.budgetEvents)).toBe(true);
  });

  it("leaves caps empty when only a protocol header is sent", () => {
    const session = createStreamSession(req({ "x-callboard-protocol": "2" }));

    expect(session.protocolVersion).toBe(2);
    expect(session.capabilities).toEqual([]);
  });
});

describe("StreamSession.supports", () => {
  it("answers only for what it was constructed with", () => {
    const session = new StreamSession(2, [CLIENT_CAPS.toolSource]);

    expect(session.supports(CLIENT_CAPS.toolSource)).toBe(true);
    expect(session.supports(CLIENT_CAPS.budgetEvents)).toBe(false);
  });

  it("answers false for an unknown string rather than throwing", () => {
    const session = new StreamSession(2, [CLIENT_CAPS.toolSource]);

    expect(session.supports("")).toBe(false);
    expect(session.supports("typo_at_an_emit_site")).toBe(false);
  });

  it("defaults to an empty cap set and to not-handshook", () => {
    expect(new StreamSession(1).capabilities).toEqual([]);
    expect(new StreamSession(1).handshook).toBe(false);
  });

  it("does not expose its internal set for mutation", () => {
    const session = new StreamSession(2, [CLIENT_CAPS.toolSource]);
    session.capabilities.push(CLIENT_CAPS.budgetEvents);

    expect(session.supports(CLIENT_CAPS.budgetEvents)).toBe(false);
  });
});

describe("buildServerInfo", () => {
  it("describes this server, independent of what the client advertised", () => {
    const info = buildServerInfo();

    expect(info.type).toBe("server_info");
    expect(info.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(info.minProtocolVersion).toBe(MIN_PROTOCOL_VERSION);
    expect(info.features).toEqual([...SERVER_FEATURES]);
    expect(typeof info.serverVersion).toBe("string");
    expect(info.serverVersion.length).toBeGreaterThan(0);
  });

  it("still admits every client we have shipped (floor is 'sent no handshake')", () => {
    expect(buildServerInfo().minProtocolVersion).toBe(1);
  });

  it("returns a fresh features array each call", () => {
    buildServerInfo().features.push("mutated");

    expect(buildServerInfo().features).toEqual([...SERVER_FEATURES]);
  });

  it("is JSON round-trippable (it goes on the wire as one line)", () => {
    const info = buildServerInfo();
    const line = JSON.stringify(info);

    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual(info);
  });
});
