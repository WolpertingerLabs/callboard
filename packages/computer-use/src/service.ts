import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ComputerUseError,
  type ActionRequest,
  type Authorizer,
  type DriverSession,
  type Lease,
  type LeaseRef,
  type Observation,
  type Operation,
  type Principal,
  type Probe,
  type ServiceEvent,
  type ServiceOptions,
  type SessionRef,
  type SessionStatus,
  type Target,
} from "./contracts.js";
import { actionSchema, leaseShape, refShape, frameShape } from "./validation.js";

const domains = new Map<string, string>();
const principalSchema = z.object({ ownerId: z.string().min(1).max(256), actorId: z.string().min(1).max(256), role: z.enum(["agent", "human"]) }).strict();
function identity(p: Principal): Readonly<Principal> {
  return Object.freeze(principalSchema.parse(p));
}
function fail(code: ConstructorParameters<typeof ComputerUseError>[0]): never {
  throw new ComputerUseError(code);
}
/**
 * Errors inside a bounded driver call that leave the driver's physical state
 * uncertain: the session is fenced `failed` and cleaned up. Every other code is
 * a request rejected by policy or validation, before or instead of dispatch,
 * and must leave the session usable — an out-of-bounds click is not a reason
 * to close the browser. Unknown throwables become `driver_error`, so they fence.
 */
const FENCING_CODES = new Set<ComputerUseError["code"]>(["timeout", "cancelled", "driver_error", "stopped"]);
interface Session {
  id: string;
  target: Target;
  owner: string;
  original: Readonly<Principal>;
  controller: Readonly<Principal>;
  generation: number;
  leaseId: string;
  state: SessionStatus["state"];
  expiresAt: number;
  abort: AbortController;
  driver?: DriverSession;
  tail: Promise<void>;
  pending: number;
  seen: Set<string>;
  revision: number;
  frame?: { id: string; revision: number; generation: number; actorId: string; role: Principal["role"]; width: number; height: number };
  timer?: NodeJS.Timeout;
  reaper?: NodeJS.Timeout;
  cleanup?: Promise<void>;
  inflight?: Promise<unknown>;
}
/** Single authoritative service; transports bind identities, never accept them in input schemas. */
export class ComputerUseService {
  private targets = new Map<string, Target>();
  private sessions = new Map<string, Session>();
  private listeners = new Set<{ owner: string; fn: (event: Readonly<ServiceEvent>) => void }>();
  private authorize: Authorizer;
  private timeout: number;
  private maxQueue: number;
  private ttl: number;
  private maxSessions: number;
  private retention: number;
  private disposed = false;
  constructor(options: ServiceOptions = {}) {
    this.authorize = options.authorize ?? (() => "deny");
    this.timeout = z
      .number()
      .int()
      .min(100)
      .max(120000)
      .parse(options.actionTimeoutMs ?? 30000);
    this.maxQueue = z
      .number()
      .int()
      .min(1)
      .max(64)
      .parse(options.maxQueue ?? 16);
    this.ttl = z
      .number()
      .int()
      .min(100)
      .max(7200000)
      .parse(options.sessionTtlMs ?? 900000);
    this.maxSessions = z
      .number()
      .int()
      .min(1)
      .max(1024)
      .parse(options.maxSessions ?? 16);
    this.retention = z
      .number()
      .int()
      .min(0)
      .max(3600000)
      .parse(options.terminalRetentionMs ?? 60000);
    for (const t of options.targets ?? []) {
      if (
        !t.id ||
        this.targets.has(t.id) ||
        !["browser", "native-desktop"].includes(t.driver.kind) ||
        (t.driver.kind === "native-desktop" && !t.driver.lockDomain)
      )
        fail("invalid_request");
      this.targets.set(
        t.id,
        Object.freeze({
          id: t.id,
          enabled: t.enabled,
          driver: Object.freeze({
            kind: t.driver.kind,
            lockDomain: t.driver.lockDomain,
            probe: t.driver.probe.bind(t.driver),
            open: t.driver.open.bind(t.driver),
          }),
        }),
      );
    }
  }
  private target(id: string): Target {
    if (this.disposed) fail("disposed");
    const t = this.targets.get(id);
    if (!t) fail("not_found");
    return t;
  }
  private async allowed(p: Readonly<Principal>, operation: Operation, t: Target, s?: Session): Promise<void> {
    if (!t.enabled) fail("denied");
    let decision;
    let timer: NodeJS.Timeout | undefined;
    try {
      decision = await Promise.race([
        Promise.resolve().then(() =>
          this.authorize(
            Object.freeze({ principal: p, operation, targetId: t.id, kind: t.driver.kind, ...(s ? { sessionId: s.id, generation: s.generation } : {}) }),
          ),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ComputerUseError("denied")), this.timeout);
        }),
      ]);
    } catch {
      fail("denied");
    } finally {
      clearTimeout(timer);
    }
    if (decision === "ask") fail("approval_required");
    if (decision !== "allow") fail("denied");
  }
  private own(p: Readonly<Principal>, id: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.owner !== p.ownerId) fail("not_found");
    return s;
  }
  private check(s: Session, ref: SessionRef): void {
    if (this.disposed) fail("disposed");
    if (s.state === "revoked") fail("revoked");
    if (s.state !== "ready" && s.state !== "starting") fail("stopped");
    if (Date.now() >= s.expiresAt) {
      this.fence(s, "stopped");
      void this.cleanup(s);
      fail("stopped");
    }
    if (ref.generation !== s.generation) fail("stale_generation");
  }
  private lease(s: Session, p: Readonly<Principal>, ref: LeaseRef): void {
    this.check(s, ref);
    if (s.state !== "ready" || s.leaseId !== ref.leaseId || s.controller.actorId !== p.actorId || s.controller.role !== p.role) fail("lease_conflict");
  }
  private observer(s: Session, p: Readonly<Principal>): void {
    // Generation is public status, not permission to see a human's private screen.
    // Also deny during handoff, before the new controller is installed.
    if (s.state !== "ready" || (p.role === "agent" && s.controller.role === "human")) fail("lease_conflict");
  }
  private snapshot(s: Session): SessionStatus {
    return {
      sessionId: s.id,
      generation: s.generation,
      targetId: s.target.id,
      kind: s.target.driver.kind,
      state: s.state,
      controller: s.state === "ready" ? s.controller.role : "none",
      expiresAt: s.expiresAt,
    };
  }
  private grant(s: Session): Lease {
    return { ...this.snapshot(s), leaseId: s.leaseId };
  }
  private emit(s: Session, type: ServiceEvent["type"]): void {
    const e = Object.freeze({ sessionId: s.id, generation: s.generation, type, at: Date.now() });
    for (const l of this.listeners)
      if (l.owner === s.owner) {
        try {
          l.fn(e);
        } catch {
          /* Host listener cannot break fencing. */
        }
      }
  }
  private fence(s: Session, state: SessionStatus["state"]): void {
    s.generation++;
    s.state = state;
    this.invalidateFrame(s);
    s.abort.abort();
    clearTimeout(s.timer);
    this.emit(s, state === "revoked" ? "revoked" : state === "failed" ? "failed" : "stopped");
  }
  private invalidateFrame(s: Session): void {
    s.revision++;
    s.frame = undefined;
  }
  /** Synchronous preflight for host approvals; act repeats this after async policy at dequeue. */
  assertFrame(principal: Principal, ref: SessionRef & { frameId: string }): void {
    const p = identity(principal);
    const parsed = z
      .object({ ...refShape, ...frameShape })
      .strict()
      .parse(ref);
    const s = this.own(p, parsed.sessionId);
    this.check(s, parsed);
    const f = s.frame;
    if (
      !f ||
      f.id !== parsed.frameId ||
      f.revision !== s.revision ||
      f.generation !== s.generation ||
      f.actorId !== p.actorId ||
      f.role !== p.role ||
      s.controller.actorId !== p.actorId ||
      s.controller.role !== p.role
    )
      fail("stale_frame");
  }
  private cleanup(s: Session): Promise<void> {
    return (s.cleanup ??= (async () => {
      await s.inflight?.catch(() => {});
      if (s.driver) {
        // Always reach close(): it is the driver's only chance to settle its
        // own state after a failed release. The native driver retries the
        // release there and, if that fails again, keeps its input lock and
        // marks it quarantined — which is what makes a later reclaim refuse.
        // Skipping close() on a release failure left a lock holding a live
        // PID with no marker, i.e. exactly the lock that gets reclaimed.
        try {
          await s.driver.releaseInput();
        } finally {
          await s.driver.close();
        }
      }
      const domain = s.target.driver.lockDomain;
      if (domain && domains.get(domain) === s.id) domains.delete(domain);
    })()
      .catch(() => {
        /* Fenced and quarantined; no potentially sensitive driver diagnostics. */
      })
      .then(() => {
        // A terminal row stays listed for a grace period so a host can still see
        // the stop/failure it just observed, then it is dropped: sessions are
        // opened and stopped per turn, and an unbounded ledger of dead rows is
        // neither audit (events carry that) nor status.
        s.reaper = setTimeout(() => {
          if (this.sessions.get(s.id) === s && s.state !== "ready" && s.state !== "starting") this.sessions.delete(s.id);
        }, this.retention);
        s.reaper.unref();
      }));
  }
  private async bounded<T>(s: Session, work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    const generation = s.generation;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const epochSignal = s.abort.signal;
    epochSignal.addEventListener("abort", abort, { once: true });
    external?.addEventListener("abort", abort, { once: true });
    if (epochSignal.aborted || external?.aborted) controller.abort();
    let timeout = false;
    const timer = setTimeout(() => {
      timeout = true;
      controller.abort();
    }, this.timeout);
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ComputerUseError(timeout ? "timeout" : "cancelled"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const pending = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    });
    s.inflight = pending;
    try {
      return await Promise.race([pending, cancelled]);
    } catch (error) {
      // Translate before fencing: fencing aborts the epoch, which would turn every driver fault into "cancelled".
      const typed = error instanceof ComputerUseError ? error : new ComputerUseError(controller.signal.aborted ? "cancelled" : "driver_error");
      if (FENCING_CODES.has(typed.code) && s.generation === generation && (s.state === "ready" || s.state === "starting")) {
        this.fence(s, "failed");
        void this.cleanup(s);
      }
      throw typed;
    } finally {
      clearTimeout(timer);
      epochSignal.removeEventListener("abort", abort);
      external?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }
  private async queue<T>(
    p: Readonly<Principal>,
    s: Session,
    ref: SessionRef,
    op: "observe" | "act",
    work: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    /** Request validation at dequeue, outside the fenced driver call: a rejection here is not a driver failure. */
    prepare?: () => void,
  ): Promise<T> {
    const check = () => {
      this.check(s, ref);
      if (op === "observe") this.observer(s, p);
    };
    check();
    await this.allowed(p, op, s.target, s);
    check();
    if (s.pending >= this.maxQueue) fail("queue_full");
    s.pending++;
    const result = s.tail.then(async () => {
      check();
      await this.allowed(p, op, s.target, s);
      check();
      prepare?.();
      const value = await this.bounded(s, work, signal);
      check();
      await this.allowed(p, op, s.target, s);
      check();
      if (signal?.aborted) fail("cancelled");
      return value;
    });
    s.tail = result
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        s.pending--;
      });
    return result;
  }
  status(principal: Principal, sessionId?: string): SessionStatus[] {
    const p = identity(principal);
    return sessionId ? [this.snapshot(this.own(p, sessionId))] : [...this.sessions.values()].filter((s) => s.owner === p.ownerId).map((s) => this.snapshot(s));
  }
  async probe(principal: Principal, targetId: string): Promise<Probe> {
    const p = identity(principal),
      t = this.target(targetId);
    await this.allowed(p, "probe", t);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        t.driver.probe(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ComputerUseError("timeout")), this.timeout);
        }),
      ]);
      if (result.kind !== t.driver.kind || typeof result.available !== "boolean" || !Array.isArray(result.capabilities))
        throw new ComputerUseError("driver_error");
      return { ...result, kind: t.driver.kind, capabilities: [...result.capabilities] };
    } catch {
      return { available: false, kind: t.driver.kind, reason: "Driver probe failed or timed out", capabilities: [] };
    } finally {
      clearTimeout(timer);
    }
  }
  async open(principal: Principal, targetId: string, signal?: AbortSignal): Promise<Lease> {
    const p = identity(principal),
      t = this.target(targetId);
    await this.allowed(p, "open", t);
    if (this.disposed) fail("disposed");
    if (signal?.aborted) fail("cancelled");
    if ([...this.sessions.values()].filter((s) => s.state === "ready" || s.state === "starting").length >= this.maxSessions) fail("queue_full");
    if (this.sessions.size >= 1024) {
      for (const [id, s] of this.sessions) {
        if (s.state !== "ready" && s.state !== "starting") {
          this.sessions.delete(id);
          break;
        }
      }
    }
    const id = randomUUID(),
      domain = t.driver.lockDomain;
    if (domain && domains.has(domain)) fail("lease_conflict");
    if (domain) domains.set(domain, id);
    const s: Session = {
      id,
      target: t,
      owner: p.ownerId,
      original: p,
      controller: p,
      generation: 1,
      leaseId: randomUUID(),
      state: "starting",
      expiresAt: Date.now() + this.ttl,
      abort: new AbortController(),
      tail: Promise.resolve(),
      pending: 0,
      seen: new Set(),
      revision: 0,
    };
    this.sessions.set(id, s);
    const ref = { sessionId: id, generation: 1 };
    try {
      await this.bounded(
        s,
        async (sig) => {
          const probe = await t.driver.probe();
          sig.throwIfAborted();
          if (!probe.available) throw new ComputerUseError("unsupported", probe.reason ?? "Target unavailable");
          const driver = await t.driver.open({ sessionId: id, signal: sig, onTargetChanged: () => this.invalidateFrame(s) });
          if (sig.aborted || s.generation !== ref.generation) {
            await driver.releaseInput();
            await driver.close();
            throw new ComputerUseError("cancelled");
          }
          s.driver = driver;
        },
        signal,
      );
      await this.allowed(p, "open", t, s);
      this.check(s, ref);
      s.state = "ready";
      s.timer = setTimeout(
        () => {
          this.fence(s, "stopped");
          void this.cleanup(s);
        },
        Math.max(0, s.expiresAt - Date.now()),
      );
      s.timer.unref();
      this.emit(s, "opened");
      return this.grant(s);
    } catch (e) {
      if (s.state === "starting" || s.state === "ready") this.fence(s, "failed");
      void this.cleanup(s);
      throw e;
    }
  }
  async observe(principal: Principal, ref: SessionRef, signal?: AbortSignal): Promise<Observation> {
    const p = identity(principal);
    ref = z.object(refShape).strict().parse(ref);
    const s = this.own(p, ref.sessionId);
    const observation = await this.queue(
      p,
      s,
      ref,
      "observe",
      async (sig) => {
        this.check(s, ref);
        this.observer(s, p);
        const revision = s.revision;
        const f = await s.driver!.observe(sig);
        if (
          !Number.isInteger(f.width) ||
          !Number.isInteger(f.height) ||
          f.width < 1 ||
          f.height < 1 ||
          f.width > 16384 ||
          f.height > 16384 ||
          typeof f.data !== "string" ||
          f.data.length > 12 * 1024 * 1024 ||
          f.data.length === 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data) ||
          !Number.isFinite(f.capturedAt) ||
          !["image/png", "image/jpeg"].includes(f.mimeType)
        )
          fail("driver_error");
        await this.allowed(p, "observe", s.target, s);
        this.check(s, ref);
        this.observer(s, p);
        if (sig.aborted) fail("cancelled");
        if (revision !== s.revision) fail("stale_frame");
        const frameId = randomUUID();
        // Passive human previews cannot replace an agent's actionable capture.
        if (s.controller.actorId === p.actorId && s.controller.role === p.role)
          s.frame = { id: frameId, revision, generation: s.generation, actorId: p.actorId, role: p.role, width: f.width, height: f.height };
        return {
          frameId,
          frame: {
            data: f.data,
            mimeType: f.mimeType,
            width: f.width,
            height: f.height,
            capturedAt: f.capturedAt,
            ...(typeof f.url === "string" ? { url: f.url.slice(0, 4096) } : {}),
          },
        };
      },
      signal,
    );
    this.check(s, ref);
    this.observer(s, p);
    this.emit(s, "observed");
    await this.allowed(p, "observe", s.target, s);
    this.check(s, ref);
    this.observer(s, p);
    if (signal?.aborted) fail("cancelled");
    return { ...ref, ...observation };
  }
  async act(principal: Principal, request: ActionRequest, signal?: AbortSignal): Promise<SessionStatus> {
    const p = identity(principal);
    request = z
      .object({ ...leaseShape, ...frameShape, actionId: z.string().min(1).max(128), action: actionSchema })
      .strict()
      .parse(request);
    const s = this.own(p, request.sessionId);
    const a = request.action;
    // Runs at enqueue and again at dequeue (the frame may have been consumed
    // meanwhile). Everything here is a request rejection, never a driver fault.
    const preflight = () => {
      this.lease(s, p, request);
      this.assertFrame(p, { sessionId: request.sessionId, generation: request.generation, frameId: request.frameId });
      const frame = s.frame!;
      if (a.type === "navigate" && s.target.driver.kind !== "browser") fail("unsupported");
      if ("x" in a && (a.x >= frame.width || a.y >= frame.height)) fail("invalid_request");
      if (a.type === "drag" && (a.toX >= frame.width || a.toY >= frame.height)) fail("invalid_request");
    };
    this.lease(s, p, request);
    if (s.seen.has(request.actionId)) fail("invalid_request");
    if (s.seen.size >= 10000) fail("queue_full");
    s.seen.add(request.actionId);
    preflight();
    await this.queue(
      p,
      s,
      request,
      "act",
      async (sig) => {
        // Consume before dispatch, including actions that partially mutate and then fail.
        this.invalidateFrame(s);
        try {
          await s.driver!.act(a, sig);
        } finally {
          await s.driver!.releaseInput();
        }
      },
      signal,
      preflight,
    );
    this.emit(s, "acted");
    return this.snapshot(s);
  }
  async takeover(principal: Principal, ref: SessionRef): Promise<Lease> {
    const p = identity(principal);
    if (p.role !== "human") fail("denied");
    ref = z.object(refShape).strict().parse(ref);
    const s = this.own(p, ref.sessionId);
    this.check(s, ref);
    await this.allowed(p, "takeover", s.target, s);
    this.check(s, ref);
    return this.handoff(s, p, "takeover");
  }
  private async handoff(s: Session, p: Readonly<Principal>, event: "takeover" | "resumed"): Promise<Lease> {
    s.generation++;
    s.abort.abort();
    s.abort = new AbortController();
    s.state = "starting";
    this.invalidateFrame(s);
    s.leaseId = randomUUID();
    const generation = s.generation;
    const prior = s.inflight;
    await s.tail;
    await this.bounded(s, async () => {
      await prior?.catch(() => {});
      await s.driver!.releaseInput();
    });
    this.check(s, { sessionId: s.id, generation });
    s.controller = p;
    s.state = "ready";
    this.emit(s, event);
    return this.grant(s);
  }
  async resume(principal: Principal, ref: LeaseRef): Promise<Lease & { observation: Observation }> {
    const p = identity(principal);
    if (p.role !== "human") fail("denied");
    ref = z.object(leaseShape).strict().parse(ref);
    const s = this.own(p, ref.sessionId);
    this.lease(s, p, ref);
    await this.allowed(p, "resume", s.target, s);
    this.lease(s, p, ref);
    await this.allowed(s.original, "resume", s.target, s);
    this.lease(s, p, ref);
    const lease = await this.handoff(s, s.original, "resumed");
    const observation = await this.observe(s.original, { sessionId: s.id, generation: s.generation });
    return { ...lease, observation };
  }
  async stop(principal: Principal, sessionId: string): Promise<SessionStatus> {
    const s = this.own(identity(principal), sessionId);
    if (s.state !== "stopped" && s.state !== "revoked") {
      this.fence(s, "stopped");
    }
    void this.cleanup(s);
    return this.snapshot(s);
  }
  async revoke(principal: Principal, sessionId: string): Promise<SessionStatus> {
    const s = this.own(identity(principal), sessionId);
    if (s.state !== "revoked") this.fence(s, "revoked");
    void this.cleanup(s);
    return this.snapshot(s);
  }
  subscribe(principal: Principal, listener: (event: Readonly<ServiceEvent>) => void): () => void {
    const entry = { owner: identity(principal).ownerId, fn: listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.sessions.values()) {
      if (s.state !== "revoked" && s.state !== "stopped") this.fence(s, "stopped");
    }
    await Promise.all([...this.sessions.values()].map((s) => this.cleanup(s)));
    this.listeners.clear();
  }
}
export function createComputerUseService(options: ServiceOptions = {}): ComputerUseService {
  return new ComputerUseService(options);
}
