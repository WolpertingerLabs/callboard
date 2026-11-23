/**
 * Driver host: serve ONE local `Driver` over authenticated HTTP so a
 * `ComputerUseService` elsewhere can drive it through `createRemoteDriver`.
 *
 * This is deliberately not an MCP server and holds no authority of its own.
 * It knows nothing about owners, leases, approvals, frames or TTLs: the service
 * on the other end decides whether an operation may happen, and this host only
 * performs it. What it does enforce is transport hygiene: a bearer token on
 * every request (compared in constant time), the action grammar, bounded
 * request sizes, a bounded operation time, and — the property that matters for
 * input safety — a session lives exactly as long as the client's attach
 * connection. Lose that connection and the host aborts whatever is running,
 * releases input and closes the session.
 *
 * Endpoints (all require `Authorization: Bearer <token>`; all but
 * `/v1/identity` also require `X-Computer-Use-Protocol: <major>.<minor>` with
 * this host's major — see `PROTOCOL` in protocol.ts):
 *
 *   GET    /v1/identity                     HostIdentity: protocol, capabilities, instance
 *   POST   /v1/probe                        Probe
 *   POST   /v1/sessions                     NDJSON stream: {"type":"opened","sessionId"} then pings
 *   POST   /v1/sessions/:id/observe         Frame (PNG, width/height from the image)
 *   POST   /v1/sessions/:id/act             {"action": Action} → 204
 *   POST   /v1/sessions/:id/release-input   204
 *   DELETE /v1/sessions/:id                 204
 *   GET    /v1/outbox                       {"entries": OutboxEntry[]}
 *   GET    /v1/outbox/:name                 file bytes, X-Content-SHA256
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { ComputerUseError, type Driver, type DriverSession } from "../contracts.js";
import { actionSchema } from "../validation.js";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MAX_OUTBOX_FILE_BYTES,
  DEFAULT_OPERATION_TIMEOUT_MS,
  MAX_OUTBOX_ENTRIES,
  MAX_REQUEST_BYTES,
  MIN_TOKEN_LENGTH,
  OUTBOX_NAME,
  HOST_CAPABILITIES,
  PROTOCOL,
  PROTOCOL_HEADER,
  STATUS_FOR,
  asComputerUseError,
  pngSize,
  tokenMatches,
  type HostIdentity,
  type OutboxEntry,
} from "./protocol.js";

export interface DriverHostOptions {
  /** The one local driver this host exposes. Native desktop only. */
  driver: Driver;
  /** Required. The host refuses to start without one of at least 32 characters. */
  token: string;
  /** Directory listed and served by `/v1/outbox`. Omit to disable the outbox. */
  outboxDir?: string;
  /** Per-operation bound (default 30s, the service's own default). */
  operationTimeoutMs?: number;
  /** Attach-stream ping interval (default 5s). */
  heartbeatMs?: number;
  /** Largest outbox file served (default 64 MiB). */
  maxOutboxFileBytes?: number;
}

export interface DriverHost {
  readonly server: Server;
  readonly identity: HostIdentity;
  /** Resolves with the bound port. */
  listen(port: number, host: string): Promise<number>;
  /** Close every session (releasing input) and stop listening. */
  close(): Promise<void>;
}

interface HostSession {
  id: string;
  driver: DriverSession;
  /** Aborted when the attach connection drops or the session is closed. */
  abort: AbortController;
  /** Serialises driver calls; the service sends one at a time, but a host must not trust that. */
  tail: Promise<unknown>;
  closing?: Promise<void>;
  heartbeat?: NodeJS.Timeout;
  /** The attach response; ended when the session ends for any other reason. */
  stream?: ServerResponse;
}

class HttpError extends Error {
  constructor(readonly code: ComputerUseError["code"]) {
    super(code);
  }
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (res.headersSent || res.destroyed) return;
  if (body === undefined) {
    res.writeHead(status, { "Cache-Control": "no-store" }).end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json), "Cache-Control": "no-store" }).end(json);
}
function sendError(res: ServerResponse, error: unknown): void {
  const code = error instanceof HttpError ? error.code : asComputerUseError(error).code;
  send(res, STATUS_FOR[code] ?? 500, { error: code });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError("invalid_request");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError("invalid_request");
  }
}

/** Open a regular file inside `dir` by plain name, refusing symlinks and anything else. */
async function openOutboxFile(dir: string, name: string) {
  if (!OUTBOX_NAME.test(name)) throw new HttpError("invalid_request");
  const dirStat = await lstat(dir).catch(() => undefined);
  if (!dirStat?.isDirectory()) throw new HttpError("not_found");
  let handle;
  try {
    // O_NOFOLLOW: a symlink at the final component fails with ELOOP instead of being followed.
    handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new HttpError("not_found");
  }
  const stat = await handle.stat();
  if (!stat.isFile()) {
    await handle.close();
    throw new HttpError("not_found");
  }
  return { handle, size: stat.size };
}

/** `"1"` or `"1.4"` → 1; anything else → undefined. */
export function protocolMajor(value: unknown): number | undefined {
  const match = typeof value === "string" ? /^(\d{1,4})(?:\.\d{1,4})?$/.exec(value.trim()) : null;
  return match ? Number(match[1]) : undefined;
}

/**
 * Read a bearer token from a file, the way the driver host is meant to get it:
 * a read-only bind mount, never an environment variable (which `docker
 * inspect` and every `docker exec` shell can read). Refuses a symlink, a
 * non-regular file, a file anyone else could write, and anything outside
 * 32–4096 characters once trailing whitespace is trimmed.
 */
export async function readTokenFile(path: string): Promise<string> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) throw new ComputerUseError("invalid_request", "Token file not found");
  if (!stat.isFile()) throw new ComputerUseError("invalid_request", "Token file must be a regular file, not a symlink or directory");
  if ((stat.mode & 0o022) !== 0) throw new ComputerUseError("invalid_request", "Token file must not be writable by group or others");
  if (stat.size > 4096) throw new ComputerUseError("invalid_request", "Token file is too large");
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < MIN_TOKEN_LENGTH || /\s/.test(token))
    throw new ComputerUseError("invalid_request", `Token must be one line of at least ${MIN_TOKEN_LENGTH} non-space characters`);
  return token;
}

export function createDriverHost(options: DriverHostOptions): DriverHost {
  const { driver } = options;
  if (typeof options.token !== "string" || options.token.length < MIN_TOKEN_LENGTH)
    throw new ComputerUseError("invalid_request", `Driver host needs a bearer token of at least ${MIN_TOKEN_LENGTH} characters; refusing to start`);
  if (driver.kind !== "native-desktop") throw new ComputerUseError("invalid_request", "Driver host serves native-desktop drivers only");
  const token = options.token;
  const opTimeout = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxFile = options.maxOutboxFileBytes ?? DEFAULT_MAX_OUTBOX_FILE_BYTES;
  const identity: HostIdentity = Object.freeze({
    protocol: { ...PROTOCOL },
    capabilities: [...HOST_CAPABILITIES],
    instanceId: randomUUID(),
    hostname: hostname(),
    kind: "native-desktop",
  });
  const sessions = new Map<string, HostSession>();
  let opening = false;
  let closed = false;

  /**
   * Run one driver call for a request. Aborted by the client going away, by
   * the session ending, or by the operation bound. The response is decided by
   * whichever comes first; the driver call is still awaited before the next
   * one starts (via `tail`), so a late settle cannot overlap new input.
   */
  async function operate<T>(res: ServerResponse, s: HostSession, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    // `res` close before finishing is the client aborting (fetch signal, timeout, crash).
    const onClose = () => {
      if (!res.writableFinished) abort();
    };
    res.on("close", onClose);
    s.abort.signal.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, opTimeout);
    const run = s.tail.then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    });
    s.tail = run.catch(() => {});
    try {
      return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new ComputerUseError(timedOut ? "timeout" : s.abort.signal.aborted ? "stopped" : "cancelled"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
        run.then(resolve, (error) => reject(controller.signal.aborted ? new ComputerUseError(timedOut ? "timeout" : "cancelled") : error));
      });
    } finally {
      clearTimeout(timer);
      res.off("close", onClose);
      s.abort.signal.removeEventListener("abort", abort);
    }
  }

  /** End a session: abort its work, wait (bounded) for it to settle, release input, close. Idempotent. */
  function endSession(s: HostSession): Promise<void> {
    return (s.closing ??= (async () => {
      s.abort.abort();
      clearInterval(s.heartbeat);
      s.stream?.end();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([s.tail, new Promise((resolve) => (timer = setTimeout(resolve, opTimeout)))]);
      clearTimeout(timer);
      try {
        try {
          await s.driver.releaseInput();
        } finally {
          // The native driver retries the release in close() and quarantines its lock if that fails too.
          await s.driver.close();
        }
      } finally {
        if (sessions.get(s.id) === s) sessions.delete(s.id);
      }
    })());
  }

  async function attach(res: ServerResponse): Promise<void> {
    if (opening || sessions.size > 0) throw new HttpError("lease_conflict");
    opening = true;
    const abort = new AbortController();
    const onEarlyClose = () => abort.abort();
    res.on("close", onEarlyClose);
    let driverSession: DriverSession;
    try {
      const timer = setTimeout(() => abort.abort(), opTimeout);
      try {
        driverSession = await driver.open({ sessionId: randomUUID(), signal: abort.signal });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      opening = false;
      res.off("close", onEarlyClose);
      throw error instanceof ComputerUseError ? error : new HttpError(abort.signal.aborted ? "cancelled" : "driver_error");
    }
    opening = false;
    res.off("close", onEarlyClose);
    const s: HostSession = { id: randomUUID(), driver: driverSession, abort: new AbortController(), tail: Promise.resolve() };
    if (abort.signal.aborted || res.destroyed || closed) {
      // The client gave up while the driver was opening; nobody holds this session.
      await endSession(s).catch(() => {});
      return;
    }
    sessions.set(s.id, s);
    s.stream = res;
    // The session is bound to this connection. Its loss — client close, crash,
    // network drop, or our own write failing — ends the session and releases input.
    res.on("close", () => void endSession(s).catch(() => {}));
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write(`${JSON.stringify({ type: "opened", sessionId: s.id, instanceId: identity.instanceId })}\n`);
    s.heartbeat = setInterval(() => {
      if (!res.write(`${JSON.stringify({ type: "ping", at: Date.now() })}\n`) && res.writableLength > 64 * 1024) res.destroy();
    }, heartbeatMs);
    s.heartbeat.unref();
  }

  async function listOutbox(): Promise<OutboxEntry[]> {
    const dir = options.outboxDir;
    if (!dir) throw new HttpError("unsupported");
    const dirStat = await lstat(dir).catch(() => undefined);
    if (!dirStat?.isDirectory()) return [];
    const entries: OutboxEntry[] = [];
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entries.length >= MAX_OUTBOX_ENTRIES) break;
      // Dirent reports a symlink as a symlink, never as a file, so links are skipped here too.
      if (!entry.isFile() || !OUTBOX_NAME.test(entry.name)) continue;
      let file;
      try {
        file = await openOutboxFile(dir, entry.name);
      } catch {
        continue;
      }
      try {
        if (file.size > maxFile) {
          entries.push({ name: entry.name, size: file.size, sha256: null });
          continue;
        }
        const data = await file.handle.readFile();
        entries.push({ name: entry.name, size: data.length, sha256: createHash("sha256").update(data).digest("hex") });
      } finally {
        await file.handle.close();
      }
    }
    return entries;
  }

  async function serveOutboxFile(res: ServerResponse, rawName: string): Promise<void> {
    if (!options.outboxDir) throw new HttpError("unsupported");
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      throw new HttpError("invalid_request");
    }
    const file = await openOutboxFile(options.outboxDir, name);
    let data: Buffer;
    try {
      if (file.size > maxFile) throw new HttpError("invalid_request");
      // Read once and hash what is sent, so the digest always describes these bytes.
      data = await file.handle.readFile();
    } finally {
      await file.handle.close();
    }
    if (data.length > maxFile) throw new HttpError("invalid_request");
    res
      .writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": data.length,
        "X-Content-SHA256": createHash("sha256").update(data).digest("hex"),
        "Cache-Control": "no-store",
      })
      .end(data);
  }

  function session(id: string | undefined): HostSession {
    const s = id ? sessions.get(id) : undefined;
    if (!s || s.closing) throw new HttpError("not_found");
    return s;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Authentication first, before the body is read or the path is looked at.
    const header = req.headers.authorization;
    const presented = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!tokenMatches(token, presented)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      req.resume();
      throw new HttpError("denied");
    }
    if (closed) throw new HttpError("stopped");
    const url = new URL(req.url ?? "/", "http://driver-host");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    if (parts[0] !== "v1") throw new HttpError("not_found");
    const [, resource, id, verb] = parts;
    // Identity is the one endpoint served to any protocol version: it is how a
    // client from another release learns that it cannot talk to this host.
    if (resource === "identity" && method === "GET" && parts.length === 2) return send(res, 200, identity);
    // Everything else fails closed on a protocol major this host does not speak, or none at all.
    if (protocolMajor(req.headers[PROTOCOL_HEADER.toLowerCase()]) !== PROTOCOL.major) {
      req.resume();
      throw new HttpError("unsupported");
    }
    if (resource === "probe" && method === "POST" && parts.length === 2) {
      await readJson(req);
      let timer: NodeJS.Timeout | undefined;
      try {
        const probe = await Promise.race([
          driver.probe(),
          new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new HttpError("timeout")), opTimeout))),
        ]);
        return send(res, 200, probe);
      } finally {
        clearTimeout(timer);
      }
    }
    if (resource === "outbox" && method === "GET") {
      if (parts.length === 2) return send(res, 200, { entries: await listOutbox() });
      if (parts.length === 3) return serveOutboxFile(res, id!);
    }
    if (resource === "sessions") {
      if (method === "POST" && parts.length === 2) {
        await readJson(req);
        return attach(res);
      }
      if (method === "DELETE" && parts.length === 3) {
        const s = sessions.get(id!);
        if (!s) throw new HttpError("not_found");
        await endSession(s);
        return send(res, 204);
      }
      if (method === "POST" && parts.length === 4) {
        const body = await readJson(req);
        const s = session(id);
        if (verb === "observe") {
          const frame = await operate(res, s, (signal) => s.driver.observe(signal));
          const png = frame.mimeType === "image/png" ? pngSize(Buffer.from(frame.data, "base64")) : undefined;
          if (!png) throw new ComputerUseError("driver_error", "Driver did not return a PNG");
          // Width and height come from the image itself: coordinates are 1:1 with these pixels.
          return send(res, 200, { data: frame.data, mimeType: "image/png", width: png.width, height: png.height, capturedAt: frame.capturedAt });
        }
        if (verb === "act") {
          const parsed = actionSchema.safeParse((body as { action?: unknown } | null)?.action);
          if (!parsed.success || Object.keys(body as object).length !== 1) throw new HttpError("invalid_request");
          await operate(res, s, (signal) => s.driver.act(parsed.data, signal));
          return send(res, 204);
        }
        if (verb === "release-input") {
          await operate(res, s, () => s.driver.releaseInput());
          return send(res, 204);
        }
      }
    }
    throw new HttpError("not_found");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      // A failed write means the client is already gone; nothing more to say.
      if (!res.headersSent) sendError(res, error);
      else res.destroy();
    });
  });
  // The attach stream is long-lived by design; per-request timeouts are ours, not Node's.
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    identity,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      });
    },
    async close() {
      closed = true;
      await Promise.all([...sessions.values()].map((s) => endSession(s).catch(() => {})));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
