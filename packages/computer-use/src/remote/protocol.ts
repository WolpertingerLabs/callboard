/**
 * Wire details shared by the driver host and the remote driver. The host is a
 * dumb transport for one local `Driver`: authorization, leases, approvals and
 * TTLs stay with whoever runs `ComputerUseService` on the other end.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ComputerUseError, type ErrorCode } from "../contracts.js";

/**
 * Wire protocol version, negotiated so a daemon and a container from different
 * releases can tell whether they understand each other.
 *
 * - **major** changes break compatibility. It is the URL prefix (`/v2`) of
 *   every endpoint except `POST /hello`, which is unversioned on purpose: it
 *   is where two releases find out whether they can talk. Both sides fail
 *   closed on a major they do not know. The host refuses any versioned request
 *   without a matching `X-Computer-Use-Protocol` header, and the client refuses
 *   a host whose hello reports another major.
 * - **minor** only adds. New endpoints and behaviours are announced in
 *   `capabilities`; a client checks for a capability before relying on it,
 *   never for a minor number.
 *
 * Rules, as for Callboard's own stream types: fields are added, never removed
 * or renamed; an existing field's meaning never changes; new meaning gets a
 * new field or a new capability.
 *
 * **Request bodies are strict.** The host rejects unknown fields in request
 * bodies (an `act` body is exactly `{ action }`, and the action grammar is
 * strict too). So a client may only send a new request field once the host
 * advertises a capability for it; an old host would refuse it otherwise.
 * Responses are the opposite: clients ignore fields they do not know.
 *
 * History: 1.0 sent the raw bearer token on every request and had no host
 * proof. 2.0 adds the `/hello` handshake below; the token never travels.
 */
export const PROTOCOL = Object.freeze({ major: 2, minor: 0 });
export const PROTOCOL_HEADER = "X-Computer-Use-Protocol";
/** Every capability this release of the host can serve. A host advertises the subset it actually serves (no outbox, no `outbox.*`). */
export const HOST_CAPABILITIES = Object.freeze(["session.attach", "observe.png", "act", "release-input", "outbox.list", "outbox.get"] as const);
export type HostCapability = (typeof HOST_CAPABILITIES)[number];
/** Shortest bearer token either side accepts. 32 characters is 128+ bits for hex or base64url tokens. */
export const MIN_TOKEN_LENGTH = 32;
export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
export const DEFAULT_HEARTBEAT_MS = 5_000;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_HELLO_BYTES = 1024;
/** A base64 frame the service accepts is at most 12 MiB; leave room for the JSON around it. */
export const MAX_FRAME_RESPONSE_BYTES = 13 * 1024 * 1024;
export const DEFAULT_MAX_OUTBOX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_OUTBOX_ENTRIES = 200;
/**
 * One flat directory of plain names. No leading dot, so `.`, `..` and hidden
 * files are out, and no separator of any kind, so a name can never leave the
 * directory. Symlinks are refused separately, by the host, at open time.
 *
 * Writers should create `.name.part` and rename it to `name` when complete:
 * dot-names are never listed, and a rename is atomic, so a listing never sees
 * a half-written file.
 */
export const OUTBOX_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/**
 * The handshake (`POST /hello`, no credentials):
 *
 * 1. The client sends `{ nonce, protocol }`, with a fresh 32-byte nonce.
 * 2. The host answers with its {@link HostIdentity} and
 *    `proof = HMAC-SHA256(token, ["computer-use/host-proof", nonce, instanceId, major, minor])`.
 * 3. The client recomputes the proof with its own copy of the token. Only a
 *    host holding the token can produce it, so a process that bound the port
 *    after the real host went away fails here and is told nothing.
 * 4. Every later request carries `Authorization: Bearer <credential>`, where
 *    `credential = nonce "." HMAC-SHA256(token, ["computer-use/credential", instanceId, nonce])`.
 *
 * The token itself never crosses the wire. A credential is bound to one host
 * instance, so one captured from a host that later went away (or restarted)
 * is worthless. What this does not stop is an active relay that can already
 * reach a live host: that needs channel binding (TLS), and is why the port
 * must stay on loopback.
 */
export const HELLO_PATH = "/hello";
export const NONCE = /^[A-Za-z0-9_-]{43}$/;

export interface HostIdentity {
  protocol: { major: number; minor: number };
  /** Optional features this host serves; see {@link PROTOCOL}. Unknown entries are ignored. */
  capabilities: readonly string[];
  /** Random per host process; a restarted host is a different instance. */
  instanceId: string;
  hostname: string;
  kind: "native-desktop";
  /** Interval of the attach stream's pings. Clients time a session out after a few missed ones. */
  heartbeatMs: number;
}
export interface OutboxEntry {
  name: string;
  size: number;
  /** Hex digest, or null when the file is larger than the host will serve, or changed while being hashed. */
  sha256: string | null;
  /** Last modification time, in milliseconds since the epoch. */
  mtimeMs: number;
}
export interface OutboxFile {
  name: string;
  size: number;
  sha256: string;
  data: Buffer;
}

export const newNonce = (): string => randomBytes(32).toString("base64url");
const mac = (token: string, fields: readonly (string | number)[]): string => createHmac("sha256", token).update(JSON.stringify(fields)).digest("base64url");
export function hostProof(token: string, nonce: string, instanceId: string, protocol: { major: number; minor: number }): string {
  return mac(token, ["computer-use/host-proof", nonce, instanceId, protocol.major, protocol.minor]);
}
export function sessionCredential(token: string, instanceId: string, nonce: string): string {
  return `${nonce}.${mac(token, ["computer-use/credential", instanceId, nonce])}`;
}
/** Constant-time check of a presented credential against this host instance. */
export function credentialMatches(token: string, instanceId: string, presented: string): boolean {
  const dot = presented.indexOf(".");
  const nonce = dot > 0 ? presented.slice(0, dot) : "";
  if (!NONCE.test(nonce)) return false;
  return secretsEqual(sessionCredential(token, instanceId, nonce), presented);
}
/** Constant-time comparison of two secrets of any length. */
export function secretsEqual(expected: string, presented: string): boolean {
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(a, b) && expected.length === presented.length;
}

/** Codes a host may return. Anything else is read as `driver_error`. */
const WIRE_CODES = new Set<ErrorCode>([
  "denied",
  "unsupported",
  "not_found",
  "lease_conflict",
  "cancelled",
  "timeout",
  "invalid_request",
  "driver_error",
  "stopped",
  "queue_full",
]);
export const STATUS_FOR: Partial<Record<ErrorCode, number>> = {
  denied: 401,
  invalid_request: 400,
  not_found: 404,
  lease_conflict: 409,
  queue_full: 429,
  unsupported: 501,
  timeout: 504,
  cancelled: 499,
  stopped: 410,
  driver_error: 500,
};
export function wireCode(value: unknown): ErrorCode {
  return typeof value === "string" && WIRE_CODES.has(value as ErrorCode) ? (value as ErrorCode) : "driver_error";
}
export function asComputerUseError(error: unknown): ComputerUseError {
  if (error instanceof ComputerUseError) return error;
  return new ComputerUseError("driver_error");
}

/** Width and height from a PNG's IHDR, or undefined if it is not a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || png.subarray(12, 16).toString("latin1") !== "IHDR") return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
