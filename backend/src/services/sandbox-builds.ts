/**
 * Sandbox desktop image builds, as records: the base image (with its builder
 * stage) or one profile's image. Settings starts them; the record is what it
 * polls, by id. Each build is a record file (`<id>.json`) and a log file
 * (`<id>.log`, capped) under `<data dir>/sandbox-desktop/builds/`, so the
 * history and the logs survive a restart; a build that was queued or running
 * when the daemon stopped reads back as `interrupted`.
 *
 * **One at a time, in order (a FIFO queue), not concurrently.** Builds share
 * one Docker daemon and are CPU-, disk- and network-heavy; and a profile build
 * depends on the base: it builds the base first when the base is not current.
 * Two at once would race to build the same base, and a base rebuild mid-way
 * through a profile build would make that profile out of date the moment it
 * finished. Queued, a base build never clobbers a profile build or the reverse,
 * each gets its own record and log, and the order is the order asked. Asking
 * for a target that is already queued or running returns that build instead
 * of a second one. (`callboard sandbox build` from a shell is a separate
 * process outside this queue; Docker serialises nothing for it, but a profile
 * build pins the base by image ID, so the worst case is a redundant base build.)
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileScopeKey } from "./sandbox-profiles.js";

export type BuildPhase = "queued" | "running" | "succeeded" | "failed" | "interrupted" | "cancelled";
/**
 * Who asked for a build. Today only a signed-in human (Settings) or the
 * operator's shell; an agent's request, approved by a human, is a later
 * change (`{ kind: "agent", chatId, approvalId }`).
 */
export type BuildRequester = { kind: "human" };
export interface BuildRecord {
  id: string;
  kind: "base" | "profile";
  /** Profile builds: the entry id (`global/blender`), its scope and name. */
  profile?: string;
  scope?: ProfileScopeKey;
  name?: string;
  phase: BuildPhase;
  requestedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** The first line of the failure. */
  error?: string;
  requestedBy: BuildRequester;
}
export type BuildTarget = { kind: "base" } | { kind: "profile"; id: string; scope: ProfileScopeKey; name: string };

/** Each build's log is capped at this; past it the oldest half is dropped (the end of a build log is what explains it). */
export const BUILD_LOG_LIMIT = 2 * 1024 * 1024;
/** Records kept; the oldest finished ones (and their logs) go first. */
export const BUILD_RECORDS_KEPT = 50;
const ID = /^[0-9a-f-]{36}$/;
const TRUNCATED = "[… earlier output dropped: the log is capped …]\n";

export class SandboxBuilds {
  private readonly records = new Map<string, BuildRecord>();
  private readonly queue: { record: BuildRecord; target: BuildTarget }[] = [];
  private running?: Promise<void>;
  private current?: { id: string; abort: AbortController };
  private disposed = false;

  constructor(
    private readonly options: {
      dir: string;
      /** Run one build, streaming its output; stop it (and reject) when `signal` aborts. */
      run: (target: BuildTarget, onOutput: (chunk: string) => void, signal: AbortSignal) => Promise<void>;
      logLimit?: number;
      keep?: number;
      onFinished?: (record: BuildRecord) => void;
    },
  ) {
    this.load();
  }

  /** Read the records back; any that was queued or running belonged to a process that is gone. */
  private load(): void {
    let files: string[] = [];
    try {
      files = readdirSync(this.options.dir).filter((file) => file.endsWith(".json"));
    } catch {
      return;
    }
    for (const file of files) {
      try {
        const record = JSON.parse(readFileSync(join(this.options.dir, file), "utf8")) as BuildRecord;
        if (!ID.test(record.id) || `${record.id}.json` !== file) continue;
        record.requestedBy ??= { kind: "human" };
        if (record.phase === "queued" || record.phase === "running") {
          record.phase = "interrupted";
          record.finishedAt ??= Date.now();
          record.error = "Callboard stopped before this build finished";
          this.save(record);
        }
        this.records.set(record.id, record);
      } catch {
        /* An unreadable record is skipped. */
      }
    }
  }

  private save(record: BuildRecord): void {
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    const file = join(this.options.dir, `${record.id}.json`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  private append(record: BuildRecord, chunk: string): void {
    const file = join(this.options.dir, `${record.id}.log`);
    try {
      appendFileSync(file, chunk, { mode: 0o600 });
      const limit = this.options.logLimit ?? BUILD_LOG_LIMIT;
      if (statSync(file).size > limit) {
        const text = readFileSync(file, "utf8");
        writeFileSync(file, `${TRUNCATED}${text.slice(-Math.floor(limit / 2))}`, { mode: 0o600 });
      }
    } catch {
      /* A log that cannot be written does not fail the build. */
    }
  }

  private same(a: BuildTarget, b: BuildRecord): boolean {
    return a.kind === b.kind && (a.kind === "base" || a.id === b.profile);
  }

  /** Queue a build (or return the one already queued or running for the same target). */
  enqueue(target: BuildTarget, requestedBy: BuildRequester = { kind: "human" }): BuildRecord {
    if (this.disposed) throw new Error("Callboard is shutting down");
    const pending = [...this.records.values()].find((r) => (r.phase === "queued" || r.phase === "running") && this.same(target, r));
    if (pending) return pending;
    const record: BuildRecord = {
      id: randomUUID(),
      kind: target.kind,
      ...(target.kind === "profile" ? { profile: target.id, scope: target.scope, name: target.name } : {}),
      phase: "queued",
      requestedAt: Date.now(),
      requestedBy,
    };
    this.records.set(record.id, record);
    this.save(record);
    this.queue.push({ record, target });
    this.prune();
    this.pump();
    return record;
  }

  private pump(): void {
    if (this.running || this.disposed) return;
    const next = this.queue.shift();
    if (!next) return;
    const { record, target } = next;
    record.phase = "running";
    record.startedAt = Date.now();
    this.save(record);
    const abort = new AbortController();
    this.current = { id: record.id, abort };
    this.running = Promise.resolve()
      .then(() => this.options.run(target, (chunk) => this.append(record, chunk), abort.signal))
      .then(
        () => {
          // A build that finished as it was cancelled did finish.
          record.phase = "succeeded";
        },
        (error) => {
          if (abort.signal.aborted) {
            // Stopped by shutdown reads as interrupted, like a build a crash cut short.
            record.phase = this.disposed ? "interrupted" : "cancelled";
            record.error = this.disposed ? "Callboard stopped before this build finished" : "Cancelled";
            this.append(record, this.disposed ? "\nInterrupted: Callboard is stopping.\n" : "\nCancelled.\n");
            return;
          }
          record.phase = "failed";
          record.error = error instanceof Error ? error.message.split("\n")[0] : "Build failed";
          this.append(record, `\n${error instanceof Error ? error.message : String(error)}\n`);
        },
      )
      .finally(() => {
        record.finishedAt = Date.now();
        this.save(record);
        this.running = undefined;
        this.current = undefined;
        try {
          this.options.onFinished?.(record);
        } catch {
          /* A listener cannot break the queue. */
        }
        this.pump();
      });
  }

  /** Drop the oldest finished records past the cap, with their logs. */
  private prune(): void {
    const keep = this.options.keep ?? BUILD_RECORDS_KEPT;
    const finished = [...this.records.values()].filter((r) => r.phase !== "queued" && r.phase !== "running").sort((a, b) => a.requestedAt - b.requestedAt);
    while (this.records.size > keep && finished.length) {
      const old = finished.shift()!;
      this.records.delete(old.id);
      for (const ext of ["json", "log"]) rmSync(join(this.options.dir, `${old.id}.${ext}`), { force: true });
    }
  }

  /**
   * Cancel a queued build (it never starts) or the running one (its signal
   * aborts; the record reads `cancelled` once the build has stopped). Returns
   * the record, or undefined if there is no such build; a finished one is
   * returned unchanged.
   */
  cancel(id: string): BuildRecord | undefined {
    const record = this.get(id);
    if (!record) return undefined;
    if (record.phase === "queued") {
      const at = this.queue.findIndex((entry) => entry.record.id === id);
      if (at >= 0) this.queue.splice(at, 1);
      record.phase = "cancelled";
      record.error = "Cancelled before it started";
      record.finishedAt = Date.now();
      this.save(record);
      try {
        this.options.onFinished?.(record);
      } catch {
        /* A listener cannot break the queue. */
      }
    } else if (record.phase === "running" && this.current?.id === id) this.current.abort.abort();
    return record;
  }
  /** The build running now, if any. */
  runningBuild(): BuildRecord | undefined {
    return this.current ? this.records.get(this.current.id) : undefined;
  }

  /** Newest first. */
  list(): BuildRecord[] {
    // Newest first; within one millisecond, the later-asked first (insertion order, reversed; the sort is stable).
    return [...this.records.values()].reverse().sort((a, b) => b.requestedAt - a.requestedAt);
  }
  get(id: string): BuildRecord | undefined {
    return ID.test(id) ? this.records.get(id) : undefined;
  }
  /** A build's log, or its last `tail` characters. */
  log(id: string, tail?: number): string | undefined {
    if (!this.get(id)) return undefined;
    const file = join(this.options.dir, `${id}.log`);
    if (!existsSync(file)) return "";
    const text = readFileSync(file, "utf8");
    return tail !== undefined && text.length > tail ? text.slice(-tail) : text;
  }
  /** Resolves when nothing is queued or running (tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }
  /** Shutdown: nothing new starts, and the running build is stopped (it reads back as interrupted). */
  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.current?.abort.abort();
  }
}
