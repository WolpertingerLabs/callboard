/**
 * Per-connection record of what the client on the other end understands.
 *
 * One {@link StreamSession} is built from the handshake headers when an SSE
 * connection opens, and the wire boundary asks it one question at each
 * serialization site: `session.supports(CLIENT_CAPS.someCapability)`.
 *
 * Phase 1 (`plans/wire-capability-negotiation.md`) installs the mechanism
 * without using it — every emit site still emits unconditionally. The point of
 * shipping it inert is that a capability can only gate against clients that
 * were already advertising when they connected, so every release that goes out
 * without the handshake is one more client we can never gate against.
 *
 * Backwards compatibility is the property that matters most here: a client
 * that sends no headers is protocol 1 with an empty capability set, and
 * `supports()` answers false for everything. Since nothing is gated yet, false
 * everywhere changes nothing at all.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { IncomingHttpHeaders } from "http";
import {
  CLIENT_CAPS,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SERVER_FEATURES,
  PROTOCOL_HEADER,
  CAPS_HEADER,
  type ServerInfoEvent,
} from "shared/types/index.js";

// Re-exported so emit sites import the capability names from the same module
// as the session they ask — `import { CLIENT_CAPS } from "./stream-session.js"`.
// The strings themselves live in shared/ because the client advertises them.
export { CLIENT_CAPS };

/**
 * Protocol version assumed for a client that sends no handshake header — i.e.
 * every client built before this mechanism existed.
 */
const LEGACY_PROTOCOL_VERSION = 1;

/**
 * Ceiling on how many capabilities we record from one header. Headers are
 * already bounded by Node's 16KB limit; this bounds the per-connection Set so a
 * client can't make us hold thousands of junk strings for the life of a stream.
 * Extras are dropped, matching the silent-drop style of the other route-boundary
 * allowlists in this codebase.
 */
const MAX_CAPS = 64;

/**
 * Capabilities the client advertised, and the questions the wire asks about
 * them. Immutable for the life of the connection: the handshake happens once,
 * at connect, and a reconnect builds a new session from the new headers.
 */
export class StreamSession {
  /** Protocol version the client declared; {@link LEGACY_PROTOCOL_VERSION} when absent or unparseable. */
  readonly protocolVersion: number;

  /**
   * Whether the client sent a handshake at all — i.e. either handshake header
   * was present with a non-blank value.
   *
   * Distinct from `protocolVersion >= 2`, and the reason this field exists.
   * Caps are parsed independently of the version, so a client that sends only
   * `X-Callboard-Caps` is recorded at protocol 1 with a non-empty cap set: it
   * *did* handshake, but a version check would call it legacy. Ask this, not
   * the version, when the question is "does this client know the mechanism?".
   *
   * Nothing branches on it in Phase 1. It is recorded now so that the first
   * code to ask has a correct answer available rather than reaching for the
   * version number that looks like it means this.
   */
  readonly handshook: boolean;

  private readonly caps: ReadonlySet<string>;

  constructor(protocolVersion: number, caps: Iterable<string> = [], handshook = false) {
    this.protocolVersion = protocolVersion;
    this.caps = new Set(caps);
    this.handshook = handshook;
  }

  /**
   * Whether the client understands `cap`. The one question the serialization
   * boundary asks. Unknown capability strings answer false, so a typo at an
   * emit site degrades to "suppress for everyone" rather than to a crash.
   */
  supports(cap: string): boolean {
    return this.caps.has(cap);
  }

  /** The advertised capabilities, sorted — for logging and tests. */
  get capabilities(): string[] {
    return [...this.caps].sort();
  }
}

/** Collapse a possibly-repeated header into a single string. */
function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw.join(",");
  return raw;
}

/**
 * Parse `X-Callboard-Protocol`. Anything that isn't a positive integer — absent,
 * empty, "abc", "2.5", "-1" — is treated as a legacy client rather than
 * rejected. A malformed handshake must never be worse for the user than no
 * handshake.
 *
 * Duplicates are the interesting case. A header-appending proxy or CDN in front
 * of the daemon makes Node deliver `X-Callboard-Protocol: 2` twice as the single
 * string `"2, 2"`, which is not an integer — so a strict parse would silently
 * record a *modern* client as legacy, and that misclassification becomes live
 * the moment `minProtocolVersion` is enforced. Unlike the caps list, a
 * comma-join is not a meaningful merge for a scalar, so take one segment: the
 * first, which is the value the client itself set (anything appended downstream
 * describes the proxy, not the browser).
 */
function parseProtocolVersion(raw: string | string[] | undefined): number {
  const value = headerValue(raw)?.split(",")[0].trim();
  if (!value || !/^\d+$/.test(value)) return LEGACY_PROTOCOL_VERSION;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= LEGACY_PROTOCOL_VERSION ? parsed : LEGACY_PROTOCOL_VERSION;
}

/**
 * Parse `X-Callboard-Caps` — a comma-separated list. Blank entries are dropped,
 * entries are trimmed, and the list is not filtered against the capabilities
 * this server knows: a newer client advertising something we've never heard of
 * is recorded verbatim, and no emit site asks about it.
 *
 * Parsed independently of the protocol version. A client that sends caps but no
 * version header still gets its caps honored — the capability claim is the part
 * an emit site acts on, and a version number with no caps gates nothing.
 */
function parseCapabilities(raw: string | string[] | undefined): string[] {
  const value = headerValue(raw);
  if (!value) return [];
  const caps: string[] = [];
  for (const part of value.split(",")) {
    const cap = part.trim();
    if (!cap) continue;
    if (!caps.includes(cap)) caps.push(cap);
    if (caps.length >= MAX_CAPS) break;
  }
  return caps;
}

/**
 * Build the session for an incoming request from its handshake headers.
 *
 * Accepts anything with `headers` (an Express `Request` satisfies it) so tests
 * don't need a live server.
 */
export function createStreamSession(req: { headers: IncomingHttpHeaders }): StreamSession {
  const headers = req.headers;
  // Node lowercases incoming header names; the exported constants carry the
  // canonical mixed case a client sends.
  const rawProtocol = headers[PROTOCOL_HEADER.toLowerCase()];
  const rawCaps = headers[CAPS_HEADER.toLowerCase()];
  // "Sent something" rather than "sent something we could parse": a client with
  // a garbled version header still knows the mechanism exists, and degrading it
  // to protocol 1 is a parse decision, not evidence about the client.
  const handshook = Boolean(headerValue(rawProtocol)?.trim()) || Boolean(headerValue(rawCaps)?.trim());
  return new StreamSession(parseProtocolVersion(rawProtocol), parseCapabilities(rawCaps), handshook);
}

// Package root — resolved from backend/dist/services/ (or backend/src/services/
// under tsx). Mirrors the "../.." computation in index.ts, one level deeper.
const __pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let cachedServerVersion: string | undefined;

/** The daemon's package version, read once. "unknown" when it can't be read. */
function serverVersion(): string {
  if (cachedServerVersion !== undefined) return cachedServerVersion;
  let version = "unknown";
  try {
    version = JSON.parse(readFileSync(path.join(__pkgRoot, "package.json"), "utf-8")).version || "unknown";
  } catch {
    // Unreadable package.json — report "unknown" rather than failing a stream.
  }
  cachedServerVersion = version;
  return version;
}

/**
 * The `server_info` payload — what this daemon speaks and can do, sent as the
 * first frame of every SSE stream. Independent of what the client advertised:
 * a legacy client gets the same frame and ignores it.
 */
export function buildServerInfo(): ServerInfoEvent {
  return {
    type: "server_info",
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: MIN_PROTOCOL_VERSION,
    features: [...SERVER_FEATURES],
    serverVersion: serverVersion(),
  };
}
