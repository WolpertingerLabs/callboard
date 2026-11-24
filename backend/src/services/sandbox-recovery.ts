/**
 * Keep-for-recovery: the policy on top of the manager's keep contract
 * (`DrainResult`, `keptSandboxes()`, `release()` in sandbox-containers.ts).
 *
 * The managed drain hook copies the outbox out (sandbox-deliverables.ts). If
 * that copy is incomplete, and the chat still exists, and fewer than
 * `maxKept` sandboxes are kept, it pauses the container and returns
 * `{ keep: true }`; the manager records the keep in `session.json` and no
 * reaper touches it again. Otherwise it returns nothing and the manager
 * removes it as usual (the loss is recorded on the session's deliveries).
 *
 * **Why pause before returning, not after.** The pause is the one step that
 * protects what is left (the home and outbox are tmpfs, so `docker stop`
 * would erase them, and a running container nobody supervises must not keep
 * running). If the daemon dies after the pause but before the manager records
 * the keep, the next reaper pass finds a paused container with complete
 * metadata and, through {@link SandboxRecovery.adoptPaused}, records it kept.
 * The other order would leave a *running* container recorded as kept, which
 * no reaper would ever touch.
 *
 * **One source of truth.** Whether a sandbox is kept, and since when, is
 * `session.json` (`keptAt`), read through `keptSandboxes()`. Its retention is
 * `keptAt + keepHours` from the current settings; why it is kept is the
 * session's deliveries manifest (`problem`). Nothing here persists a second
 * record.
 *
 * A kept sandbox ends through `release()`: after a successful Retry export,
 * on Discard, when its retention ends or its container vanished
 * ({@link SandboxRecovery.sweep}, run after each reaper pass), and when its
 * chat is deleted.
 */
import { ComputerUseError } from "@wolpertingerlabs/computer-use";
import type { SandboxKeptContainer, SandboxKeptRetryResult } from "shared/types/index.js";
import {
  SandboxInstanceChangedError,
  type DrainBeforeDestroy,
  type DrainableSandbox,
  type KeptSandbox,
  type SandboxContainerManager,
} from "./sandbox-containers.js";
import { DeliveryIncompleteError, type DeliveryContext, type SandboxDeliveries } from "./sandbox-deliverables.js";
import type { ResolvedSandboxSettings } from "./sandbox-desktop-settings.js";
import { DockerError, type DockerRunner } from "./sandbox-image.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("sandbox-recovery");

export interface SandboxRecoveryOptions {
  manager: Pick<SandboxContainerManager, "keptSandboxes" | "release" | "connectKept" | "nameOf">;
  deliveries: Pick<SandboxDeliveries, "drain" | "markLost" | "forgetSession" | "forChat">;
  docker: DockerRunner;
  settings: () => Pick<ResolvedSandboxSettings, "keepHours" | "maxKept">;
  chatExists: (chatId: string) => boolean;
  /**
   * How long the copy may take inside the hook (default 25 s): less than the
   * manager's 30 s drain bound, so a copy that times out still leaves time to
   * pause and return `{ keep: true }` — a hook the manager times out never
   * keeps anything.
   */
  copyBudgetMs?: number;
}

const PAUSE_TIMEOUT_MS = 4_000;
const RESERVATION_MS = 120_000;

/** A managed sandbox, as the outbox sync sees it. */
export const managedDelivery = (sandbox: Pick<DrainableSandbox, "sessionId" | "chatId" | "workspaceId" | "folder" | "driver">): DeliveryContext => ({
  sessionId: sandbox.sessionId,
  chatId: sandbox.chatId,
  ...(sandbox.workspaceId ? { workspaceId: sandbox.workspaceId } : {}),
  ...(sandbox.folder ? { folder: sandbox.folder } : {}),
  mode: "managed",
  source: sandbox.driver,
});

const owner = (k: Pick<KeptSandbox, "sessionId" | "chatId" | "workspaceId" | "folder">) => ({
  sessionId: k.sessionId,
  chatId: k.chatId,
  ...(k.workspaceId ? { workspaceId: k.workspaceId } : {}),
  ...(k.folder ? { folder: k.folder } : {}),
});

export class SandboxRecovery {
  /** Sessions this process paused to keep, until `keptSandboxes()` shows them (the manager records the keep after the hook returns). */
  private readonly reserved = new Map<string, number>();
  /** Keep decisions one at a time, so two failing drains cannot both take the last slot. */
  private decisions: Promise<unknown> = Promise.resolve();
  /** Sessions with a retry or discard in flight. */
  private readonly busy = new Set<string>();

  constructor(private readonly options: SandboxRecoveryOptions) {}

  /**
   * The managed drain hook. The chat is checked first: a deleted chat's
   * outbox is discarded, not copied (an orphan found after a crash most of
   * all), and logged. Then the copy; if it is incomplete, keep (see the file
   * comment) or let the manager remove it.
   */
  readonly drainHook: DrainBeforeDestroy = async (sandbox, signal) => {
    if (!this.options.chatExists(sandbox.chatId)) {
      log.info(`Sandbox session ${sandbox.sessionId} (${sandbox.cause}): its chat no longer exists; discarding its outbox without copying it`);
      this.options.deliveries.forgetSession(sandbox.sessionId);
      return;
    }
    const budget = AbortSignal.any([signal, AbortSignal.timeout(this.options.copyBudgetMs ?? 25_000)]);
    try {
      await this.options.deliveries.drain(managedDelivery(sandbox), budget);
      return;
    } catch (error) {
      if (!(error instanceof DeliveryIncompleteError)) throw error;
      return (await this.keep(sandbox, error.message)) ? { keep: true } : undefined;
    }
  };

  /** Decide and pause, under the `maxKept` cap. False: not kept (the manager removes it), with the loss recorded. */
  private keep(sandbox: Omit<DrainableSandbox, "driver" | "instanceId">, reason: string): Promise<boolean> {
    const decision = this.decisions.then(async () => {
      const { maxKept } = this.options.settings();
      if ((await this.keptIds()).size >= maxKept) {
        log.warn(
          `Sandbox session ${sandbox.sessionId}: ${maxKept} sandbox(es) already kept for recovery (Settings → Sandbox desktop); removing this one (${reason})`,
        );
        await this.options.deliveries.markLost(owner(sandbox), "not-kept");
        return false;
      }
      try {
        await this.options.docker(["pause", this.options.manager.nameOf(sandbox.sessionId)], { timeoutMs: PAUSE_TIMEOUT_MS });
      } catch (error) {
        log.warn(`Sandbox session ${sandbox.sessionId}: could not pause it to keep it (${error instanceof Error ? error.message : "unknown"}); removing it`);
        await this.options.deliveries.markLost(owner(sandbox), "gone");
        return false;
      }
      this.reserved.set(sandbox.sessionId, Date.now());
      log.warn(`Sandbox session ${sandbox.sessionId} (${sandbox.cause}): paused and kept for recovery (${reason})`);
      return true;
    });
    this.decisions = decision.catch(() => {});
    return decision;
  }

  /** Kept now, plus kept a moment ago by this process and not yet recorded. */
  private async keptIds(): Promise<Set<string>> {
    const ids = new Set((await this.options.manager.keptSandboxes()).map((k) => k.sessionId));
    for (const [id, at] of this.reserved) if (ids.has(id) || Date.now() - at > RESERVATION_MS) this.reserved.delete(id);
    for (const id of this.reserved.keys()) ids.add(id);
    return ids;
  }

  /**
   * For the manager's `adoptPaused`: a container of ours found paused with
   * no keep recorded (a daemon killed between our pause and the manager's
   * record) is adopted as kept if its chat still exists and there is room.
   */
  readonly adoptPaused = async (sandbox: { sessionId: string; chatId: string; workspaceId?: string; folder?: string }): Promise<boolean> => {
    if (!this.options.chatExists(sandbox.chatId)) return false;
    const decision = this.decisions.then(async () => (await this.keptIds()).size < this.options.settings().maxKept);
    this.decisions = decision.catch(() => {});
    const adopt = await decision;
    if (!adopt) await this.options.deliveries.markLost(owner(sandbox), "not-kept");
    return adopt;
  };

  private expiresAt(kept: KeptSandbox): number {
    return kept.keptAt + this.options.settings().keepHours * 3_600_000;
  }

  /**
   * A chat's kept sandboxes, for its deliverables view and cu_status: its
   * own, and those of the chats it replaced (`replaced`: Continue from,
   * Rerun, Compress — the hidden original's recovery is otherwise
   * unreachable). Never a fork's parent's: that chat is still there to act.
   */
  async keptFor(chatId: string, replaced: readonly string[] = []): Promise<SandboxKeptContainer[]> {
    const chats = new Set([chatId, ...replaced]);
    const kept = (await this.options.manager.keptSandboxes()).filter((k) => chats.has(k.chatId));
    if (!kept.length) return [];
    const problems = new Map<string, string | undefined>();
    for (const id of new Set(kept.map((k) => k.chatId)))
      for (const s of await this.options.deliveries.forChat(id, owner(kept.find((k) => k.chatId === id)!))) problems.set(s.sessionId, s.problem);
    return kept.map((k) => ({
      sessionId: k.sessionId,
      keptAt: k.keptAt,
      expiresAt: this.expiresAt(k),
      reason: problems.get(k.sessionId) ?? "not every file could be copied",
      ...(this.busy.has(k.sessionId) ? { retrying: true } : {}),
    }));
  }

  private async keptOf(chatId: string, sessionId: string, replaced: readonly string[]): Promise<KeptSandbox> {
    const kept = (await this.options.manager.keptSandboxes()).find((k) => k.sessionId === sessionId);
    if (!kept || (kept.chatId !== chatId && !replaced.includes(kept.chatId)))
      throw new ComputerUseError("not_found", "No sandbox desktop is kept for that session in this chat");
    if (this.busy.has(sessionId)) throw new ComputerUseError("lease_conflict", "That kept sandbox desktop is already being retried or discarded");
    return kept;
  }

  /** `paused`, `running`, or `gone` (no such container, or it exited: its tmpfs is gone with it). */
  private async state(name: string): Promise<"paused" | "running" | "gone"> {
    try {
      const status = (await this.options.docker(["inspect", "--format", "{{.State.Status}}", name], { timeoutMs: 15_000 })).trim();
      return status === "paused" || status === "running" ? status : "gone";
    } catch (error) {
      if (error instanceof DockerError && /no such (container|object)/i.test(error.stderr)) return "gone";
      throw error;
    }
  }

  private async end(kept: KeptSandbox, why: "discarded" | "expired" | "gone" | "exported"): Promise<void> {
    await this.options.manager.release(kept.sessionId);
    if (why !== "exported") await this.options.deliveries.markLost(owner(kept), why);
  }

  /**
   * Retry export: unpause, reconnect (endpoint from Docker, instance
   * proved), copy again, and release it on success. If the copy is still
   * incomplete it is paused again and stays kept — its retention not
   * extended, as it runs from `keptAt`. Another instance answering (the
   * container restarted) or a vanished container means what it held is
   * gone: it is released and reported so.
   */
  async retry(chatId: string, sessionId: string, replaced: readonly string[] = []): Promise<SandboxKeptRetryResult> {
    const kept = await this.keptOf(chatId, sessionId, replaced);
    this.busy.add(sessionId);
    try {
      // The chat that owns the session (it may be a replaced original).
      if (!this.options.chatExists(kept.chatId)) {
        await this.end(kept, "discarded");
        return { outcome: "gone", reason: "The chat no longer exists, so the kept sandbox was discarded." };
      }
      const state = await this.state(kept.name);
      if (state === "gone") {
        await this.end(kept, "gone");
        return { outcome: "gone", reason: "The kept container no longer exists (Docker or this machine restarted), so what it held is gone." };
      }
      if (state === "paused") await this.options.docker(["unpause", kept.name], { timeoutMs: 30_000 });
      let failed: string | undefined;
      try {
        const sandbox = await this.options.manager.connectKept(sessionId);
        await this.options.deliveries.drain(managedDelivery(sandbox), AbortSignal.timeout(this.options.copyBudgetMs ?? 25_000));
      } catch (error) {
        if (error instanceof SandboxInstanceChangedError) {
          await this.end(kept, "gone");
          return { outcome: "gone", reason: "The kept container restarted, so what it held is gone; it was removed." };
        }
        failed = error instanceof Error ? error.message : "the copy failed";
      }
      if (!failed) {
        await this.end(kept, "exported");
        log.info(`Sandbox session ${sessionId}: kept sandbox exported on retry and released`);
        return { outcome: "removed" };
      }
      try {
        await this.options.docker(["pause", kept.name], { timeoutMs: PAUSE_TIMEOUT_MS });
      } catch (error) {
        log.warn(`Sandbox session ${sessionId}: could not pause it again (${error instanceof Error ? error.message : "unknown"}); removing it`);
        await this.end(kept, "gone");
        return { outcome: "gone", reason: `The retry failed (${failed}), and the container could not be paused again, so it was removed.` };
      }
      return { outcome: "kept", reason: failed };
    } finally {
      this.busy.delete(sessionId);
    }
  }

  /** Discard: release it, and what it held, now. */
  async discard(chatId: string, sessionId: string, replaced: readonly string[] = []): Promise<void> {
    const kept = await this.keptOf(chatId, sessionId, replaced);
    this.busy.add(sessionId);
    try {
      await this.end(kept, "discarded");
      log.info(`Sandbox session ${sessionId}: kept sandbox discarded`);
    } finally {
      this.busy.delete(sessionId);
    }
  }

  /** The chat was deleted: discard every sandbox kept for it. */
  async discardForChat(chatId: string): Promise<number> {
    let count = 0;
    for (const kept of (await this.options.manager.keptSandboxes()).filter((k) => k.chatId === chatId)) {
      if (this.busy.has(kept.sessionId)) continue; // a retry in flight finds the chat gone and discards it
      await this.end(kept, "discarded").then(
        () => count++,
        (error) => log.warn(`Could not discard kept sandbox ${kept.sessionId}: ${error instanceof Error ? error.message : "unknown"}`),
      );
    }
    return count;
  }

  /**
   * After each reaper pass: release kept sandboxes whose retention ended, or
   * whose container is gone (Docker or the machine restarted), and pause one
   * found running (a retry interrupted by a crash): kept means supervised.
   */
  async sweep(now = Date.now()): Promise<void> {
    for (const kept of await this.options.manager.keptSandboxes()) {
      if (this.busy.has(kept.sessionId)) continue;
      try {
        if (this.expiresAt(kept) <= now) {
          log.info(`Sandbox session ${kept.sessionId}: kept for recovery past its retention; releasing it`);
          await this.end(kept, "expired");
          continue;
        }
        const state = await this.state(kept.name);
        if (state === "gone") {
          log.info(`Sandbox session ${kept.sessionId}: its kept container no longer exists; what it held is gone`);
          await this.end(kept, "gone");
        } else if (state === "running") await this.options.docker(["pause", kept.name], { timeoutMs: PAUSE_TIMEOUT_MS });
      } catch (error) {
        log.debug(`Kept sandbox sweep skipped ${kept.sessionId}: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
  }
}
