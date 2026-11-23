/**
 * `createRemoteDriver`: a `Driver` whose operations run on a driver host
 * (`createDriverHost`) over authenticated HTTP. Everything that decides whether
 * an operation may happen stays in the `ComputerUseService` this driver is
 * registered with; the host only performs it.
 *
 * Each session holds one long-lived attach response from the host. If it
 * ends, errors, or goes quiet for longer than `heartbeatTimeoutMs`, the
 * session is lost: in-flight calls fail with `driver_error`, later calls fail
 * the same way, and `onLost` tells the service to fence the session at once
 * rather than on its next call. The host, seeing the same connection go,
 * aborts its own work and releases input.
 */
import { createHash } from "node:crypto";
import { ComputerUseError, type Action, type Driver, type DriverSession, type Frame, type Probe } from "../contracts.js";
import { actionSchema } from "../validation.js";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MAX_OUTBOX_FILE_BYTES,
  DEFAULT_OPERATION_TIMEOUT_MS,
  MAX_FRAME_RESPONSE_BYTES,
  MIN_TOKEN_LENGTH,
  OUTBOX_NAME,
  PROTOCOL,
  PROTOCOL_HEADER,
  pngSize,
  wireCode,
  type HostIdentity,
  type OutboxEntry,
  type OutboxFile,
} from "./protocol.js";

export interface RemoteDriverOptions {
  /** Base URL of the driver host, e.g. `http://127.0.0.1:7801`. Plain http is accepted for loopback hosts only. */
  url: string;
  /** Bearer token; at least 32 characters. */
  token: string;
  /** Ceiling for any one request (default 30s, the service's operation bound). */
  requestTimeoutMs?: number;
  /** Session is lost after this long without a ping (default 3 × the host's 5s interval). */
  heartbeatTimeoutMs?: number;
  /** Largest outbox download accepted (default 64 MiB). */
  maxOutboxFileBytes?: number;
}

export interface RemoteDriver extends Driver {
  readonly kind: "native-desktop";
  readonly lockDomain: string;
  /** `host:port` of the driver host, for labels. Never contains the token. */
  readonly endpoint: string;
  /** What the host says it is. A restarted host reports a new `instanceId`. */
  identity(signal?: AbortSignal): Promise<HostIdentity>;
  listOutbox(signal?: AbortSignal): Promise<OutboxEntry[]>;
  /** Download one outbox file by plain name; the digest is checked against the bytes received. */
  downloadOutboxFile(name: string, signal?: AbortSignal): Promise<OutboxFile>;
}

const LOOPBACK = (host: string) => host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new ComputerUseError("driver_error", "Driver host response too large");
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new ComputerUseError("driver_error", "Driver host response too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function createRemoteDriver(options: RemoteDriverOptions): RemoteDriver {
  let base: URL;
  try {
    base = new URL(options.url);
  } catch {
    throw new ComputerUseError("invalid_request", "Remote driver URL is not a URL");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new ComputerUseError("invalid_request", "Remote driver URL must be a plain http(s) origin");
  // The bearer token would cross the network in the clear otherwise.
  if (base.protocol === "http:" && !LOOPBACK(base.hostname))
    throw new ComputerUseError("invalid_request", "Plain http is allowed only for a loopback driver host; put anything else behind TLS");
  if (typeof options.token !== "string" || options.token.length < MIN_TOKEN_LENGTH)
    throw new ComputerUseError("invalid_request", `Remote driver token must be at least ${MIN_TOKEN_LENGTH} characters`);
  const origin = base.origin;
  const prefix = base.pathname.replace(/\/+$/, "");
  const auth = `Bearer ${options.token}`;
  const requestTimeout = options.requestTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const heartbeatTimeout = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_MS * 3;
  const maxFile = options.maxOutboxFileBytes ?? DEFAULT_MAX_OUTBOX_FILE_BYTES;

  /**
   * One request. Abort by the caller is `cancelled`, by the bound is
   * `timeout`, a network failure is `driver_error`, and a host error body is
   * mapped through a fixed list of codes. The host's messages are never kept.
   */
  async function request(method: string, path: string, init: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Response> {
    init.signal?.throwIfAborted();
    // timeoutMs 0: no bound here, because the caller owns it (the attach stream lives for the session).
    const timeout = init.timeoutMs === 0 ? undefined : AbortSignal.timeout(init.timeoutMs ?? requestTimeout);
    const signal = init.signal && timeout ? AbortSignal.any([init.signal, timeout]) : (init.signal ?? timeout);
    let res: Response;
    try {
      res = await fetch(`${origin}${prefix}${path}`, {
        method,
        headers: {
          Authorization: auth,
          [PROTOCOL_HEADER]: `${PROTOCOL.major}.${PROTOCOL.minor}`,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal,
        redirect: "error",
      });
    } catch {
      if (init.signal?.aborted) throw new ComputerUseError("cancelled");
      if (timeout?.aborted) throw new ComputerUseError("timeout");
      throw new ComputerUseError("driver_error", "Driver host unreachable");
    }
    if (res.ok) return res;
    let code: unknown;
    try {
      code = (JSON.parse((await readCapped(res, 4096)).toString("utf8")) as { error?: unknown }).error;
    } catch {
      code = undefined;
    }
    throw new ComputerUseError(res.status === 401 ? "denied" : wireCode(code), `Driver host answered ${res.status}`);
  }
  async function json<T>(res: Response, max = 1024 * 1024): Promise<T> {
    try {
      return JSON.parse((await readCapped(res, max)).toString("utf8")) as T;
    } catch (error) {
      throw error instanceof ComputerUseError ? error : new ComputerUseError("driver_error", "Driver host sent malformed JSON");
    }
  }

  async function identity(signal?: AbortSignal): Promise<HostIdentity> {
    const value = await json<HostIdentity>(await request("GET", "/v1/identity", { signal, timeoutMs: Math.min(requestTimeout, 10_000) }));
    const protocol = value?.protocol as Partial<HostIdentity["protocol"]> | undefined;
    if (
      !value ||
      typeof value.instanceId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.instanceId) ||
      value.kind !== "native-desktop" ||
      !protocol ||
      !Number.isSafeInteger(protocol.major) ||
      !Number.isSafeInteger(protocol.minor)
    )
      // A host from before versioning, or not a driver host at all: no basis to proceed.
      throw new ComputerUseError("unsupported", "Driver host did not report a protocol version this client understands");
    return {
      protocol: { major: protocol.major!, minor: protocol.minor! },
      capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter((c) => typeof c === "string").slice(0, 64) : [],
      instanceId: value.instanceId,
      hostname: String(value.hostname).slice(0, 255),
      kind: "native-desktop",
    };
  }
  /**
   * Check the host speaks our protocol major, and that it serves `capability`
   * when given. Fails closed with `unsupported`. Runs before probe, open and
   * outbox calls, so a host upgraded or replaced in between is caught.
   */
  async function negotiate(signal?: AbortSignal, capability?: string): Promise<HostIdentity> {
    const host = await identity(signal);
    if (host.protocol.major !== PROTOCOL.major)
      throw new ComputerUseError(
        "unsupported",
        `Driver host speaks protocol ${host.protocol.major}.${host.protocol.minor}; this client speaks ${PROTOCOL.major}.x`,
      );
    if (capability && !host.capabilities.includes(capability)) throw new ComputerUseError("unsupported", `Driver host does not serve ${capability}`);
    return host;
  }

  async function probe(): Promise<Probe> {
    const no = (readiness: Probe["readiness"], reason: string, operatorDetail: string): Probe => ({
      available: false,
      kind: "native-desktop",
      readiness,
      reason,
      operatorDetail,
      capabilities: [],
    });
    let value: Probe;
    let host: HostIdentity;
    try {
      host = await negotiate();
      value = await json<Probe>(await request("POST", "/v1/probe", { body: {} }));
    } catch (error) {
      const code = error instanceof ComputerUseError ? error.code : "driver_error";
      if (code === "denied") return no("setup-required", "The remote desktop host refused the configured token", `Driver host ${origin} answered 401`);
      if (code === "unsupported")
        return no(
          "unsupported",
          "The remote desktop host runs an incompatible version; update the image or Callboard so they match",
          `Driver host ${origin}: ${error instanceof Error ? error.message : "incompatible"}`,
        );
      return no("setup-required", "The remote desktop host is not reachable", `Driver host ${origin}: ${code}`);
    }
    if (!value || typeof value.available !== "boolean" || value.kind !== "native-desktop" || !Array.isArray(value.capabilities))
      return no("unknown", "The remote desktop host answered with an unrecognised probe", `Driver host ${origin}`);
    return {
      available: value.available,
      kind: "native-desktop",
      ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 500) } : {}),
      ...(typeof value.readiness === "string" ? { readiness: value.readiness } : {}),
      operatorDetail: `Remote driver host ${origin}, protocol ${host.protocol.major}.${host.protocol.minor}, instance ${host.instanceId}`,
      capabilities: value.capabilities.filter((c) => typeof c === "string").slice(0, 16),
    };
  }

  async function open(context: Parameters<Driver["open"]>[0]): Promise<DriverSession> {
    context.signal.throwIfAborted();
    // Aborting this ends the attach response, which is what ends the session on the host.
    const connection = new AbortController();
    // Bounds the open handshake only: headers plus the "opened" line. The stream itself has no timeout.
    let openTimedOut = false;
    const openTimer = setTimeout(() => {
      openTimedOut = true;
      connection.abort();
    }, requestTimeout);
    const onOpenAbort = () => connection.abort();
    context.signal.addEventListener("abort", onOpenAbort, { once: true });
    const opening = (error: unknown) => {
      connection.abort();
      if (context.signal.aborted) return new ComputerUseError("cancelled");
      if (openTimedOut) return new ComputerUseError("timeout");
      return error instanceof ComputerUseError ? error : new ComputerUseError("driver_error", "Driver host session stream failed");
    };
    let sessionId: string;
    const decoder = new TextDecoder();
    let buffered = "";
    const nextLine = async (): Promise<string | undefined> => {
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          return line;
        }
        if (buffered.length > 4096) throw new ComputerUseError("driver_error", "Driver host stream line too long");
        const { done, value } = await reader.read();
        if (done) return undefined;
        buffered += decoder.decode(value, { stream: true });
      }
    };
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      await negotiate(connection.signal, "session.attach");
      const res = await request("POST", "/v1/sessions", { body: {}, signal: connection.signal, timeoutMs: 0 });
      if (!res.body) throw new ComputerUseError("driver_error", "Driver host sent no session stream");
      reader = res.body.getReader();
    } catch (error) {
      clearTimeout(openTimer);
      context.signal.removeEventListener("abort", onOpenAbort);
      throw opening(error);
    }
    try {
      const hello = JSON.parse((await nextLine()) ?? "null") as { type?: unknown; sessionId?: unknown } | null;
      if (hello?.type !== "opened" || typeof hello.sessionId !== "string" || !/^[0-9a-f-]{36}$/.test(hello.sessionId))
        throw new ComputerUseError("driver_error", "Driver host did not open a session");
      sessionId = hello.sessionId;
    } catch (error) {
      throw opening(error);
    } finally {
      clearTimeout(openTimer);
      context.signal.removeEventListener("abort", onOpenAbort);
    }

    // `lost` aborts every in-flight call; `closing` means the loss was ours.
    const lost = new AbortController();
    let closing = false;
    let watchdog: NodeJS.Timeout | undefined;
    const loseConnection = () => {
      if (lost.signal.aborted) return;
      lost.abort();
      clearTimeout(watchdog);
      connection.abort();
      if (!closing) context.onLost?.();
    };
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(loseConnection, heartbeatTimeout);
      watchdog.unref();
    };
    arm();
    void (async () => {
      try {
        while ((await nextLine()) !== undefined) arm();
      } catch {
        /* Stream error: same as the stream ending. */
      }
      loseConnection();
    })();

    const path = `/v1/sessions/${sessionId}`;
    /** A session call: aborted by the caller or by losing the connection, which reads as a driver fault. */
    const call = async (verb: string, signal: AbortSignal | undefined, body?: unknown, timeoutMs?: number) => {
      if (closing) throw new ComputerUseError("stopped");
      if (lost.signal.aborted) throw new ComputerUseError("driver_error", "Remote desktop connection lost");
      try {
        return await request("POST", `${path}/${verb}`, {
          body: body ?? {},
          signal: signal ? AbortSignal.any([signal, lost.signal]) : lost.signal,
          timeoutMs,
        });
      } catch (error) {
        if (lost.signal.aborted && !signal?.aborted) throw new ComputerUseError("driver_error", "Remote desktop connection lost");
        // The host no longer knows this session: whatever happened, its input state is not ours to vouch for.
        if (error instanceof ComputerUseError && error.code === "not_found") throw new ComputerUseError("driver_error", "Remote session gone");
        throw error;
      }
    };
    return {
      async observe(signal): Promise<Frame> {
        const res = await call("observe", signal);
        const frame = await json<Partial<Frame>>(res, MAX_FRAME_RESPONSE_BYTES);
        signal.throwIfAborted();
        if (frame.mimeType !== "image/png" || typeof frame.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data))
          throw new ComputerUseError("driver_error", "Driver host sent an invalid frame");
        // Trust the image, not the envelope: coordinates are 1:1 with these pixels.
        const size = pngSize(Buffer.from(frame.data, "base64"));
        if (!size || size.width !== frame.width || size.height !== frame.height) throw new ComputerUseError("driver_error", "Driver host frame size mismatch");
        return {
          data: frame.data,
          mimeType: "image/png",
          width: size.width,
          height: size.height,
          capturedAt: Number.isFinite(frame.capturedAt) ? Number(frame.capturedAt) : Date.now(),
        };
      },
      async act(action: Action, signal) {
        const parsed = actionSchema.safeParse(action);
        if (!parsed.success) throw new ComputerUseError("invalid_request");
        await call("act", signal, { action: parsed.data });
      },
      async releaseInput() {
        // After a lost connection the host has already released (or quarantined); we cannot confirm which.
        await call("release-input", undefined, undefined, 10_000);
      },
      async close() {
        if (closing) return;
        closing = true;
        try {
          if (!lost.signal.aborted) await request("DELETE", path, { timeoutMs: requestTimeout });
        } catch (error) {
          // Already gone on the host is closed. Anything else still ends the connection below,
          // and the host ends the session when it sees that.
          if (!(error instanceof ComputerUseError && error.code === "not_found")) throw error;
        } finally {
          lost.abort();
          clearTimeout(watchdog);
          connection.abort();
        }
      },
    };
  }

  return {
    kind: "native-desktop",
    // One host is one input device, whoever else points at it from this process.
    lockDomain: `remote-desktop:${origin}${prefix}`,
    endpoint: base.host,
    probe,
    open,
    identity,
    async listOutbox(signal) {
      await negotiate(signal, "outbox.list");
      const value = await json<{ entries?: unknown }>(await request("GET", "/v1/outbox", { signal }));
      if (!Array.isArray(value.entries)) throw new ComputerUseError("driver_error", "Driver host outbox listing malformed");
      return value.entries
        .filter(
          (e): e is OutboxEntry =>
            !!e &&
            typeof e.name === "string" &&
            OUTBOX_NAME.test(e.name) &&
            Number.isSafeInteger(e.size) &&
            e.size >= 0 &&
            (e.sha256 === null || (typeof e.sha256 === "string" && /^[0-9a-f]{64}$/.test(e.sha256))),
        )
        .map((e) => ({ name: e.name, size: e.size, sha256: e.sha256 }));
    },
    async downloadOutboxFile(name, signal) {
      if (typeof name !== "string" || !OUTBOX_NAME.test(name)) throw new ComputerUseError("invalid_request", "Outbox names are plain file names");
      await negotiate(signal, "outbox.get");
      const res = await request("GET", `/v1/outbox/${encodeURIComponent(name)}`, { signal });
      const declared = res.headers.get("x-content-sha256") ?? "";
      const data = await readCapped(res, maxFile);
      const sha256 = createHash("sha256").update(data).digest("hex");
      if (!/^[0-9a-f]{64}$/.test(declared) || declared !== sha256) throw new ComputerUseError("driver_error", "Outbox file digest mismatch");
      return { name, size: data.length, sha256, data };
    },
  };
}
