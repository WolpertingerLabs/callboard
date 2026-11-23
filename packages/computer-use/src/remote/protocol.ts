/**
 * Wire details shared by the driver host and the remote driver. The host is a
 * dumb transport for one local `Driver`: authorization, leases, approvals and
 * TTLs stay with whoever runs `ComputerUseService` on the other end.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { ComputerUseError, type ErrorCode } from "../contracts.js";

export const PROTOCOL_VERSION = 1;
/** Shortest bearer token either side accepts. 32 characters is 128+ bits for hex or base64url tokens. */
export const MIN_TOKEN_LENGTH = 32;
export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
export const DEFAULT_HEARTBEAT_MS = 5_000;
export const MAX_REQUEST_BYTES = 64 * 1024;
/** A base64 frame the service accepts is at most 12 MiB; leave room for the JSON around it. */
export const MAX_FRAME_RESPONSE_BYTES = 13 * 1024 * 1024;
export const DEFAULT_MAX_OUTBOX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_OUTBOX_ENTRIES = 200;
/**
 * One flat directory of plain names. No leading dot, so `.`, `..` and hidden
 * files are out, and no separator of any kind, so a name can never leave the
 * directory. Symlinks are refused separately, by the host, at open time.
 */
export const OUTBOX_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export interface HostIdentity {
  protocol: number;
  /** Random per host process; a restarted host is a different instance. */
  instanceId: string;
  hostname: string;
  kind: "native-desktop";
}
export interface OutboxEntry {
  name: string;
  size: number;
  /** Hex digest, or null when the file is larger than the host will serve. */
  sha256: string | null;
}
export interface OutboxFile {
  name: string;
  size: number;
  sha256: string;
  data: Buffer;
}

/** Constant-time comparison of two secrets of any length. */
export function tokenMatches(expected: string, presented: string): boolean {
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
