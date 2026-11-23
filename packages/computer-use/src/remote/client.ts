/**
 * `createRemoteDriver`: a `Driver` whose operations run on a driver host
 * (`createDriverHost`) over authenticated HTTP. Everything that decides whether
 * an operation may happen stays in the `ComputerUseService` this driver is
 * registered with; the host only performs it.
 *
 * Before anything that matters, the client makes the host prove it holds the
 * token (`POST /hello`, see protocol.ts), and from then on authenticates with
 * a credential bound to that host instance. The token itself is never sent.
 *
 * Each session holds one long-lived attach response from the host. If it
 * ends, errors, or misses several of the host's pings, the session is lost:
 * in-flight calls fail with `driver_error`, later calls fail the same way, and
 * `onLost` tells the service to fence the session at once rather than on its
 * next call. The host, seeing the same connection go, aborts its own work and
 * releases input.
 */
import { createHash } from "node:crypto";
import { ComputerUseError, type Action, type Driver, type DriverSession, type Frame, type Probe } from "../contracts.js";
import { actionSchema } from "../validation.js";
import { readTokenFile } from "./host.js";
import {
  DEFAULT_MAX_OUTBOX_FILE_BYTES,
  DEFAULT_OPERATION_TIMEOUT_MS,
  HELLO_PATH,
  MAX_FRAME_RESPONSE_BYTES,
  MIN_TOKEN_LENGTH,
  OUTBOX_NAME,
  PROTOCOL,
  PROTOCOL_HEADER,
  hostProof,
  newNonce,
  pngSize,
  secretsEqual,
  sessionCredential,
  wireCode,
  type HostIdentity,
  type OutboxEntry,
  type OutboxFile,
} from "./protocol.js";

export interface RemoteDriverOptions {
  /** Base URL of the driver host, e.g. `http://127.0.0.1:7801`. Plain http is accepted for loopback hosts only. */
  url: string;
  /** The shared secret, at least 32 characters. Give this or `tokenFile`, not both. */
  token?: string;
  /**
   * A file holding the secret, read (with `readTokenFile`'s checks, symlinks
   * allowed) at every handshake, so a rotated token is picked up. A missing or
   * bad file makes the target unavailable rather than throwing here.
   */
  tokenFile?: string;
  /** Ceiling for any one request (default 30s, the service's operation bound). */
  requestTimeoutMs?: number;
  /** Session is lost after this long without a ping (default 3 × the interval the host advertises, at least 3s). */
  heartbeatTimeoutMs?: number;
  /** Largest outbox download accepted (default 64 MiB). */
  maxOutboxFileBytes?: number;
}

/** A session opened on a driver host, with the host instance it opened on. */
export interface RemoteDriverSession extends DriverSession {
  /** The `instanceId` the host reported when it opened this session; it equals the one whose proof was checked. */
  readonly instanceId: string;
}

export interface RemoteDriver extends Driver {
  readonly kind: "native-desktop";
  readonly lockDomain: string;
  /** `host:port` of the driver host, for labels. Never contains the token. */
  readonly endpoint: string;
  /** What the host is, after it has proved it holds the token. A restarted host reports a new `instanceId`. */
  identity(signal?: AbortSignal): Promise<HostIdentity>;
  open(context: Parameters<Driver["open"]>[0]): Promise<RemoteDriverSession>;
  /**
   * The host instance a session opened on, by the `sessionId` the service
   * passed to `open`, while that session is open. Lets a host bind a consent to
   * the session that actually opened, not to an identity checked beforehand.
   */
  openedInstance(sessionId: string): string | undefined;
  listOutbox(signal?: AbortSignal): Promise<OutboxEntry[]>;
  /** Download one outbox file by plain name; the digest is checked against the bytes received. */
  downloadOutboxFile(name: string, signal?: AbortSignal): Promise<OutboxFile>;
}

const LOOPBACK = (host: string) => host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
const READINESS = new Set(["setup-required", "unsupported", "permission-blocked", "unknown"]);

/** Read a response body within `max` bytes. Any failure part-way — an abort, a reset — is a ComputerUseError. */
async function readCapped(res: Response, max: number, signal?: AbortSignal): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new ComputerUseError("driver_error", "Driver host response too large");
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  try {
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
  } catch (error) {
    if (error instanceof ComputerUseError) throw error;
    throw new ComputerUseError(signal?.aborted ? "cancelled" : "driver_error", "Driver host response interrupted");
  }
  return Buffer.concat(chunks);
}

interface Verified {
  identity: HostIdentity;
  /** `Authorization` credential for this host instance. */
  credential: string;
  heartbeatTimeout: number;
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
  // Nothing secret crosses the wire, but screenshots and typed text do.
  if (base.protocol === "http:" && !LOOPBACK(base.hostname))
    throw new ComputerUseError("invalid_request", "Plain http is allowed only for a loopback driver host; put anything else behind TLS");
  if ((options.token === undefined) === (options.tokenFile === undefined))
    throw new ComputerUseError("invalid_request", "Give the remote driver a token or a tokenFile, not both or neither");
  if (options.token !== undefined && (typeof options.token !== "string" || options.token.length < MIN_TOKEN_LENGTH))
    throw new ComputerUseError("invalid_request", `Remote driver token must be at least ${MIN_TOKEN_LENGTH} characters`);
  if (options.tokenFile !== undefined && (typeof options.tokenFile !== "string" || !options.tokenFile))
    throw new ComputerUseError("invalid_request", "Remote driver tokenFile must be a path");
  const origin = base.origin;
  const prefix = base.pathname.replace(/\/+$/, "");
  const secret = (): Promise<string> =>
    options.token !== undefined ? Promise.resolve(options.token) : readTokenFile(options.tokenFile!, { allowSymlink: true });
  const requestTimeout = options.requestTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const maxFile = options.maxOutboxFileBytes ?? DEFAULT_MAX_OUTBOX_FILE_BYTES;
  const openedInstances = new Map<string, string>();

  /**
   * One request. Abort by the caller is `cancelled`, by the bound is
   * `timeout`, a network failure is `driver_error`, and a host error body is
   * mapped through a fixed list of codes. The host's messages are never kept.
   * Sends a credential only when given one: the handshake sends none.
   */
  async function request(
    method: string,
    path: string,
    init: { body?: unknown; signal?: AbortSignal; timeoutMs?: number; credential?: string } = {},
  ): Promise<Response> {
    init.signal?.throwIfAborted();
    // timeoutMs 0: no bound here, because the caller owns it (the attach stream lives for the session).
    const timeout = init.timeoutMs === 0 ? undefined : AbortSignal.timeout(init.timeoutMs ?? requestTimeout);
    const signal = init.signal && timeout ? AbortSignal.any([init.signal, timeout]) : (init.signal ?? timeout);
    let res: Response;
    try {
      res = await fetch(`${origin}${prefix}${path}`, {
        method,
        headers: {
          ...(init.credential ? { Authorization: `Bearer ${init.credential}` } : {}),
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
      code = (JSON.parse((await readCapped(res, 4096, signal)).toString("utf8")) as { error?: unknown }).error;
    } catch {
      code = undefined;
    }
    throw new ComputerUseError(res.status === 401 ? "denied" : wireCode(code), `Driver host answered ${res.status}`);
  }
  async function json<T>(res: Response, max = 1024 * 1024, signal?: AbortSignal): Promise<T> {
    const body = await readCapped(res, max, signal);
    try {
      return JSON.parse(body.toString("utf8")) as T;
    } catch {
      throw new ComputerUseError("driver_error", "Driver host sent malformed JSON");
    }
  }

  /**
   * The handshake: a fresh nonce out, identity and proof back. Nothing is
   * trusted — not even the protocol it reports — until the proof checks out
   * against our own copy of the token. A host that cannot prove it gets
   * `denied`, and was never sent anything secret.
   */
  async function hello(signal?: AbortSignal): Promise<Verified> {
    const token = await secret();
    const nonce = newNonce();
    const res = await request("POST", HELLO_PATH, { body: { nonce, protocol: { ...PROTOCOL } }, signal, timeoutMs: Math.min(requestTimeout, 10_000) });
    const value = await json<Partial<HostIdentity> & { proof?: unknown }>(res, 64 * 1024, signal);
    const protocol = value?.protocol as Partial<HostIdentity["protocol"]> | undefined;
    if (
      !value ||
      typeof value.instanceId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.instanceId) ||
      value.kind !== "native-desktop" ||
      !protocol ||
      !Number.isSafeInteger(protocol.major) ||
      !Number.isSafeInteger(protocol.minor) ||
      typeof value.proof !== "string"
    )
      // A host from before the handshake, or not a driver host at all.
      throw new ComputerUseError("unsupported", "Driver host did not complete a handshake this client understands");
    const reported = { major: protocol.major!, minor: protocol.minor! };
    if (!secretsEqual(hostProof(token, nonce, value.instanceId, reported), value.proof))
      throw new ComputerUseError("denied", "Driver host could not prove it holds the token (a wrong token, or not the driver host)");
    const heartbeat = Number.isInteger(value.heartbeatMs) && value.heartbeatMs! >= 100 && value.heartbeatMs! <= 60_000 ? value.heartbeatMs! : 5_000;
    return {
      identity: {
        protocol: reported,
        capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter((c) => typeof c === "string").slice(0, 64) : [],
        instanceId: value.instanceId,
        hostname: String(value.hostname).slice(0, 255),
        kind: "native-desktop",
        heartbeatMs: heartbeat,
      },
      credential: sessionCredential(token, value.instanceId, nonce),
      heartbeatTimeout: options.heartbeatTimeoutMs ?? Math.min(Math.max(3 * heartbeat, 3_000), 180_000),
    };
  }
  /**
   * Handshake, then check the host speaks our protocol major and serves
   * `capability` when given. Fails closed with `unsupported`. Runs before
   * probe, open and outbox calls, so a host upgraded or replaced in between is
   * caught, and each gets a credential for the instance it is talking to.
   */
  async function negotiate(signal?: AbortSignal, capability?: string): Promise<Verified> {
    const verified = await hello(signal);
    const { protocol, capabilities } = verified.identity;
    if (protocol.major !== PROTOCOL.major)
      throw new ComputerUseError("unsupported", `Driver host speaks protocol ${protocol.major}.${protocol.minor}; this client speaks ${PROTOCOL.major}.x`);
    if (capability && !capabilities.includes(capability)) throw new ComputerUseError("unsupported", `Driver host does not serve ${capability}`);
    return verified;
  }
  const v = (path: string) => `/v${PROTOCOL.major}${path}`;

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
    let verified: Verified;
    try {
      verified = await negotiate();
      value = await json<Probe>(await request("POST", v("/probe"), { body: {}, credential: verified.credential }));
    } catch (error) {
      const code = error instanceof ComputerUseError ? error.code : "driver_error";
      const detail = `Driver host ${origin}: ${code}${error instanceof Error && error.message !== code ? ` (${error.message})` : ""}`;
      if (code === "invalid_request" && options.tokenFile !== undefined)
        return no(
          "setup-required",
          "The remote desktop token file is missing or unusable",
          `${options.tokenFile}: ${error instanceof Error ? error.message : "unusable"}`,
        );
      if (code === "denied") return no("setup-required", "The remote desktop host could not prove it holds the configured token", detail);
      if (code === "unsupported")
        return no("unsupported", "The remote desktop host runs an incompatible version; update the image or Callboard so they match", detail);
      return no("setup-required", "The remote desktop host is not reachable", detail);
    }
    if (!value || typeof value.available !== "boolean" || value.kind !== "native-desktop" || !Array.isArray(value.capabilities))
      return no("unknown", "The remote desktop host answered with an unrecognised probe", `Driver host ${origin}`);
    const { identity } = verified;
    // The host's own words are for operators only: a model-visible reason is
    // ours and fixed, so nothing the container says reaches a prompt.
    const hostReason = typeof value.reason === "string" ? `: ${value.reason.replace(/[\p{Cc}\p{Cf}]+/gu, " ").slice(0, 300)}` : "";
    return {
      available: value.available,
      kind: "native-desktop",
      reason: value.available ? "The remote desktop host is ready" : "The remote desktop host reports it is not ready; an operator can see why in diagnostics",
      ...(typeof value.readiness === "string" && READINESS.has(value.readiness)
        ? { readiness: value.readiness }
        : value.available
          ? {}
          : { readiness: "unknown" as const }),
      operatorDetail: `Remote driver host ${origin}, protocol ${identity.protocol.major}.${identity.protocol.minor}, instance ${identity.instanceId}${hostReason}`,
      capabilities: value.capabilities.filter((c) => typeof c === "string").slice(0, 16),
    };
  }

  async function open(context: Parameters<Driver["open"]>[0]): Promise<RemoteDriverSession> {
    context.signal.throwIfAborted();
    // Aborting this ends the attach response, which is what ends the session on the host.
    const connection = new AbortController();
    // Bounds the open handshake only: hello, headers and the "opened" line. The stream itself has no timeout.
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
    const decoder = new TextDecoder();
    let buffered = "";
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const nextLine = async (): Promise<string | undefined> => {
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          return line;
        }
        if (buffered.length > 4096) throw new ComputerUseError("driver_error", "Driver host stream line too long");
        const { done, value } = await reader!.read();
        if (done) return undefined;
        buffered += decoder.decode(value, { stream: true });
      }
    };
    let verified: Verified;
    let sessionId: string;
    try {
      verified = await negotiate(connection.signal, "session.attach");
      const res = await request("POST", v("/sessions"), { body: {}, signal: connection.signal, timeoutMs: 0, credential: verified.credential });
      if (!res.body) throw new ComputerUseError("driver_error", "Driver host sent no session stream");
      reader = res.body.getReader();
      const opened = JSON.parse((await nextLine()) ?? "null") as { type?: unknown; sessionId?: unknown; instanceId?: unknown } | null;
      if (opened?.type !== "opened" || typeof opened.sessionId !== "string" || !/^[0-9a-f-]{36}$/.test(opened.sessionId))
        throw new ComputerUseError("driver_error", "Driver host did not open a session");
      // The credential only works on the instance that proved itself, so this
      // cannot differ in practice; checking it keeps the claim explicit.
      if (opened.instanceId !== verified.identity.instanceId) throw new ComputerUseError("driver_error", "Driver host opened the session on another instance");
      sessionId = opened.sessionId;
    } catch (error) {
      throw opening(error);
    } finally {
      clearTimeout(openTimer);
      context.signal.removeEventListener("abort", onOpenAbort);
    }
    const instanceId = verified.identity.instanceId;
    const credential = verified.credential;
    openedInstances.set(context.sessionId, instanceId);

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
      watchdog = setTimeout(loseConnection, verified.heartbeatTimeout);
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

    const path = v(`/sessions/${sessionId}`);
    /** A session call: aborted by the caller or by losing the connection, which reads as a driver fault. */
    const call = async (verb: string, signal: AbortSignal | undefined, body?: unknown, timeoutMs?: number) => {
      if (closing) throw new ComputerUseError("stopped");
      if (lost.signal.aborted) throw new ComputerUseError("driver_error", "Remote desktop connection lost");
      try {
        return await request("POST", `${path}/${verb}`, {
          body: body ?? {},
          signal: signal ? AbortSignal.any([signal, lost.signal]) : lost.signal,
          timeoutMs,
          credential,
        });
      } catch (error) {
        if (lost.signal.aborted && !signal?.aborted) throw new ComputerUseError("driver_error", "Remote desktop connection lost");
        // The host no longer knows this session (or this instance): its input state is not ours to vouch for.
        if (error instanceof ComputerUseError && (error.code === "not_found" || error.code === "denied"))
          throw new ComputerUseError("driver_error", "Remote session gone");
        throw error;
      }
    };
    return {
      instanceId,
      async observe(signal): Promise<Frame> {
        const res = await call("observe", signal);
        const frame = await json<Partial<Frame>>(res, MAX_FRAME_RESPONSE_BYTES, signal);
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
          if (!lost.signal.aborted) await request("DELETE", path, { timeoutMs: requestTimeout, credential });
        } catch (error) {
          // Already gone on the host is closed. Anything else still ends the connection below,
          // and the host ends the session when it sees that.
          if (!(error instanceof ComputerUseError && error.code === "not_found")) throw error;
        } finally {
          lost.abort();
          clearTimeout(watchdog);
          connection.abort();
          if (openedInstances.get(context.sessionId) === instanceId) openedInstances.delete(context.sessionId);
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
    openedInstance: (sessionId) => openedInstances.get(sessionId),
    identity: async (signal) => (await hello(signal)).identity,
    async listOutbox(signal) {
      const { credential } = await negotiate(signal, "outbox.list");
      const value = await json<{ entries?: unknown }>(await request("GET", v("/outbox"), { signal, credential }), 1024 * 1024, signal);
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
        .map((e) => ({ name: e.name, size: e.size, sha256: e.sha256, mtimeMs: Number.isFinite(e.mtimeMs) ? Math.floor(e.mtimeMs) : 0 }));
    },
    async downloadOutboxFile(name, signal) {
      if (typeof name !== "string" || !OUTBOX_NAME.test(name)) throw new ComputerUseError("invalid_request", "Outbox names are plain file names");
      const { credential } = await negotiate(signal, "outbox.get");
      const res = await request("GET", v(`/outbox/${encodeURIComponent(name)}`), { signal, credential });
      const declared = res.headers.get("x-content-sha256") ?? "";
      const data = await readCapped(res, maxFile, signal);
      const sha256 = createHash("sha256").update(data).digest("hex");
      if (!/^[0-9a-f]{64}$/.test(declared) || declared !== sha256) throw new ComputerUseError("driver_error", "Outbox file digest mismatch");
      return { name, size: data.length, sha256, data };
    },
  };
}
