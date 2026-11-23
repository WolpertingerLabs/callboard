/**
 * Driver host: serve ONE local `Driver` over authenticated HTTP so a
 * `ComputerUseService` elsewhere can drive it through `createRemoteDriver`.
 *
 * This is deliberately not an MCP server and holds no authority of its own.
 * It knows nothing about owners, leases, approvals, frames or TTLs: the service
 * on the other end decides whether an operation may happen, and this host only
 * performs it. What it does enforce is transport hygiene: proof that it holds
 * the token before a client sends anything that matters (see the handshake in
 * protocol.ts), an instance-bound credential on every other request (compared
 * in constant time), the action grammar, bounded request sizes and read times,
 * a bounded operation time, and — the property that matters for input safety —
 * a session lives exactly as long as the client's attach connection. Lose that
 * connection and the host aborts whatever is running, releases input and
 * closes the session.
 *
 * Endpoints. `POST /hello` takes no credentials; every other one requires
 * `Authorization: Bearer <credential>` and `X-Computer-Use-Protocol` with this
 * host's major:
 *
 *   POST   /hello                           {nonce, protocol} → HostIdentity + proof
 *   POST   /v2/probe                        Probe
 *   POST   /v2/sessions                     NDJSON stream: {"type":"opened","sessionId","instanceId"} then pings
 *   POST   /v2/sessions/:id/observe         Frame (PNG, width/height from the image)
 *   POST   /v2/sessions/:id/act             {"action": Action} → 204
 *   POST   /v2/sessions/:id/release-input   204
 *   DELETE /v2/sessions/:id                 204
 *   GET    /v2/outbox                       {"entries": OutboxEntry[]}        (capability outbox.list)
 *   GET    /v2/outbox/:name                 file bytes, X-Content-SHA256      (capability outbox.get)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, readFile, readlink, realpath, stat as statPath, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { ComputerUseError, type Driver, type DriverSession } from "../contracts.js";
import { actionSchema } from "../validation.js";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MAX_OUTBOX_FILE_BYTES,
  DEFAULT_OPERATION_TIMEOUT_MS,
  HELLO_PATH,
  MAX_HELLO_BYTES,
  MAX_OUTBOX_ENTRIES,
  MAX_REQUEST_BYTES,
  MIN_TOKEN_LENGTH,
  NONCE,
  OUTBOX_NAME,
  PROTOCOL,
  PROTOCOL_HEADER,
  STATUS_FOR,
  asComputerUseError,
  credentialMatches,
  hostProof,
  pngSize,
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
  /** Simultaneous connections (default 32). More are dropped by the server. */
  maxConnections?: number;
  /** Time to receive a request's headers (default 10s). */
  headersTimeoutMs?: number;
  /** Time to receive a whole request, headers and body (default 15s). Responses, the attach stream included, are not bounded by it. */
  requestTimeoutMs?: number;
  /** Time to read a request body once headers are in (default 10s). */
  bodyTimeoutMs?: number;
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

/** Read a small JSON body, within `max` bytes and `deadlineMs`. The socket is closed by the caller if this throws. */
async function readJson(req: IncomingMessage, deadlineMs: number, max = MAX_REQUEST_BYTES): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (!Number.isFinite(declared) || declared > max) throw new HttpError("invalid_request");
  const chunks: Buffer[] = [];
  let size = 0;
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    req.destroy();
  }, deadlineMs);
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > max) throw new HttpError("invalid_request");
      chunks.push(chunk);
    }
  } catch (error) {
    throw error instanceof HttpError ? error : new HttpError(late ? "timeout" : "cancelled");
  } finally {
    clearTimeout(timer);
  }
  if (late) throw new HttpError("timeout");
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError("invalid_request");
  }
}

/**
 * The outbox directory, opened once per request and held, so every name is
 * resolved inside that exact directory however its path changes meanwhile.
 *
 * The desktop user owns the outbox and its parent, so it can swap `outbox` for
 * a symlink at any moment. `O_NOFOLLOW` on a file path guards only the last
 * component, which is how a race between checking and opening once served the
 * token file. Instead: open the directory itself with `O_NOFOLLOW` (a symlink
 * there fails), confirm via `/proc/self/fd` that it is the configured path,
 * then resolve names through `/proc/self/fd/<dirfd>/<name>` — the kernel's
 * openat — with `O_NOFOLLOW` on the name. Linux-only, like the driver host.
 */
interface OutboxDir {
  handle: FileHandle;
  /** `/proc/self/fd/<fd>`: a path that always means this directory. */
  via: string;
  /** Its real path, for checking what a file fd resolves to. */
  real: string;
  stat: Stats;
}
async function openOutboxDir(configured: string): Promise<OutboxDir | undefined> {
  // The parent is not the desktop user's to rename; the outbox itself is.
  const expected = join(await realpath(dirname(configured)).catch(() => dirname(configured)), basename(configured));
  let handle: FileHandle;
  try {
    handle = await open(configured, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const via = `/proc/self/fd/${handle.fd}`;
    const [stat, real] = await Promise.all([handle.stat(), readlink(via)]);
    if (!stat.isDirectory() || real !== expected) throw new Error("outbox moved");
    return { handle, via, real, stat };
  } catch {
    await handle.close();
    return undefined;
  }
}
/**
 * Open `name` inside a held outbox directory. Refused unless it is a regular
 * file on the outbox's own device, owned by the outbox's owner, and the open
 * fd still resolves to `<outbox>/<name>`. Any of those failing means a link or
 * a swap, and reads as not found.
 */
async function openOutboxFile(dir: OutboxDir, name: string): Promise<{ handle: FileHandle; stat: Stats }> {
  if (!OUTBOX_NAME.test(name)) throw new HttpError("invalid_request");
  let handle: FileHandle;
  try {
    handle = await open(`${dir.via}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new HttpError("not_found");
  }
  try {
    const [stat, real] = await Promise.all([handle.stat(), readlink(`/proc/self/fd/${handle.fd}`)]);
    if (!stat.isFile() || stat.dev !== dir.stat.dev || stat.uid !== dir.stat.uid || real !== `${dir.real}/${name}`) throw new Error("not a plain outbox file");
    return { handle, stat };
  } catch {
    await handle.close();
    throw new HttpError("not_found");
  }
}
/** SHA-256 of an open file, streamed. Undefined when the bytes read do not match the size it had (it is being written). */
async function hashFile(handle: FileHandle, size: number): Promise<string | undefined> {
  const hash = createHash("sha256");
  let read = 0;
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false }) as AsyncIterable<Buffer>) {
    read += chunk.length;
    if (read > size) return undefined;
    hash.update(chunk);
  }
  return read === size ? hash.digest("hex") : undefined;
}

/** `"1"` or `"1.4"` → 1; anything else → undefined. */
export function protocolMajor(value: unknown): number | undefined {
  const match = typeof value === "string" ? /^(\d{1,4})(?:\.\d{1,4})?$/.exec(value.trim()) : null;
  return match ? Number(match[1]) : undefined;
}

/**
 * Read a bearer token from a file, the way the driver host is meant to get it:
 * a read-only bind mount, never an environment variable (which `docker
 * inspect` and every `docker exec` shell can read). Refuses a symlink (unless
 * `allowSymlink`), a non-regular file, a file group or others could write,
 * and anything but one line of 32–4096 non-space characters.
 */
export async function readTokenFile(path: string, options: { allowSymlink?: boolean } = {}): Promise<string> {
  const link = await lstat(path).catch(() => undefined);
  if (!link) throw new ComputerUseError("invalid_request", "Token file not found");
  // Followed only when the caller opts in (Kubernetes secrets and some credential
  // stores are symlinks). The checks below then apply to the file it names.
  if (link.isSymbolicLink() && !options.allowSymlink) throw new ComputerUseError("invalid_request", "Token file must be a regular file, not a symlink");
  const stat = link.isSymbolicLink() ? await statPath(path).catch(() => undefined) : link;
  if (!stat?.isFile()) throw new ComputerUseError("invalid_request", "Token file must be a regular file, not a directory or a broken link");
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
  const bodyTimeout = options.bodyTimeoutMs ?? 10_000;
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 100 || heartbeatMs > 60_000)
    throw new ComputerUseError("invalid_request", "heartbeatMs must be 100–60000");
  const identity: HostIdentity = Object.freeze({
    protocol: { ...PROTOCOL },
    // Only what this host actually serves: no outbox directory, no outbox capabilities.
    capabilities: ["session.attach", "observe.png", "act", "release-input", ...(options.outboxDir ? ["outbox.list", "outbox.get"] : [])],
    instanceId: randomUUID(),
    hostname: hostname(),
    kind: "native-desktop",
    heartbeatMs,
  });
  /** Digests by file identity and state, so a listing does not rehash unchanged files. */
  const digests = new Map<string, string>();
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
    if (!options.outboxDir) throw new HttpError("unsupported");
    const dir = await openOutboxDir(options.outboxDir);
    if (!dir) return [];
    try {
      const entries: OutboxEntry[] = [];
      const names = (await readdir(dir.via, { withFileTypes: true }))
        // Dirent reports a symlink as a symlink, never as a file; openOutboxFile checks again.
        .filter((e) => e.isFile() && OUTBOX_NAME.test(e.name))
        .map((e) => e.name)
        .sort();
      for (const name of names) {
        if (entries.length >= MAX_OUTBOX_ENTRIES) break;
        let file;
        try {
          file = await openOutboxFile(dir, name);
        } catch {
          continue;
        }
        try {
          const { stat } = file;
          let sha256: string | null = null;
          if (stat.size <= maxFile) {
            // ctime is in the key because mtime can be set back by the writer; ctime cannot.
            const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
            sha256 = digests.get(key) ?? null;
            if (!sha256) {
              sha256 = (await hashFile(file.handle, stat.size)) ?? null;
              if (sha256) {
                if (digests.size >= 4 * MAX_OUTBOX_ENTRIES) digests.clear();
                digests.set(key, sha256);
              }
            }
          }
          entries.push({ name, size: stat.size, sha256, mtimeMs: Math.floor(stat.mtimeMs) });
        } finally {
          await file.handle.close();
        }
      }
      return entries;
    } finally {
      await dir.handle.close();
    }
  }

  async function serveOutboxFile(res: ServerResponse, rawName: string): Promise<void> {
    if (!options.outboxDir) throw new HttpError("unsupported");
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      throw new HttpError("invalid_request");
    }
    if (!OUTBOX_NAME.test(name)) throw new HttpError("invalid_request");
    const dir = await openOutboxDir(options.outboxDir);
    if (!dir) throw new HttpError("not_found");
    let data: Buffer;
    try {
      const file = await openOutboxFile(dir, name);
      try {
        if (file.stat.size > maxFile) throw new HttpError("invalid_request");
        // Read once and hash what is sent, so the digest always describes these bytes.
        data = await file.handle.readFile();
      } finally {
        await file.handle.close();
      }
    } finally {
      await dir.handle.close();
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

  async function hello(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req, bodyTimeout, MAX_HELLO_BYTES)) as { nonce?: unknown; protocol?: unknown } | null;
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).some((k) => k !== "nonce" && k !== "protocol") ||
      typeof body.nonce !== "string" ||
      !NONCE.test(body.nonce)
    )
      throw new HttpError("invalid_request");
    // Answered whatever protocol the client speaks: this is where it learns whether it can talk to us.
    send(res, 200, { ...identity, proof: hostProof(token, body.nonce, identity.instanceId, PROTOCOL) });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closed) throw new HttpError("stopped");
    const method = req.method ?? "GET";
    if (req.url === HELLO_PATH && method === "POST") return hello(req, res);
    // Authentication first, before the body is read or the path is looked at.
    const header = req.headers.authorization;
    const presented = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!credentialMatches(token, identity.instanceId, presented)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="computer-use", error="invalid_token"');
      // An unauthenticated client gets its answer and loses the connection, body read or not.
      res.setHeader("Connection", "close");
      res.on("finish", () => req.socket.destroy());
      throw new HttpError("denied");
    }
    const url = new URL(req.url ?? "/", "http://driver-host");
    const parts = url.pathname.split("/").filter(Boolean);
    // Versioned paths, and the header, must both name this host's major.
    if (!/^v\d+$/.test(parts[0] ?? "")) throw new HttpError("not_found");
    if (parts[0] !== `v${PROTOCOL.major}` || protocolMajor(req.headers[PROTOCOL_HEADER.toLowerCase()]) !== PROTOCOL.major) throw new HttpError("unsupported");
    const [, resource, id, verb] = parts;
    if (resource === "probe" && method === "POST" && parts.length === 2) {
      await readJson(req, bodyTimeout);
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
        await readJson(req, bodyTimeout);
        return attach(res);
      }
      if (method === "DELETE" && parts.length === 3) {
        const s = sessions.get(id!);
        if (!s) throw new HttpError("not_found");
        await endSession(s);
        return send(res, 204);
      }
      if (method === "POST" && parts.length === 4) {
        const body = await readJson(req, bodyTimeout);
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

  const requestTimeout = options.requestTimeoutMs ?? 15_000;
  const headersTimeout = Math.min(options.headersTimeoutMs ?? 10_000, requestTimeout);
  const server = createServer(
    // Node checks these deadlines on an interval; keep it short enough to matter.
    { requestTimeout, headersTimeout, connectionsCheckingInterval: Math.max(100, Math.min(1_000, Math.floor(headersTimeout / 2))) },
    (req, res) => {
      // A request whose body was not read in full — refused before reading it,
      // too large, too slow — gets no keep-alive: the socket closes with the
      // answer, so nobody can hold it open by trickling a body nobody reads.
      res.on("finish", () => {
        if (!req.complete) req.socket.destroy();
      });
      route(req, res).catch((error) => {
        // A failed write means the client is already gone; nothing more to say.
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (!req.complete) res.setHeader("Connection", "close");
        sendError(res, error);
      });
    },
  );
  // Requests are bounded above; the attach stream's response is long-lived by design.
  server.keepAliveTimeout = 5_000;
  server.maxConnections = options.maxConnections ?? 32;

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
