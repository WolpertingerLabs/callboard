/**
 * Live tail of a run's Codex rollout file, for the events the public event
 * stream does not carry.
 *
 * ## Why this exists
 *
 * `codex exec --experimental-json` emits exactly five event types —
 * `thread.started`, `turn.started`, `item.started`, `item.completed`,
 * `turn.completed` — and its `ThreadItem` union has eight members. Context
 * compaction is not among them. The CLI *records* every compaction in the
 * durable rollout as an `event_msg` / `item_completed` / `ContextCompaction`
 * entry, but it never projects one onto the public lane, so a compacting Codex
 * run looks identical to a hung one from the adapter's side.
 *
 * That is not a cosmetic gap. A run whose system prompt exceeds the model's
 * context window compacts on *every* turn, and each compaction discards the
 * progress the previous one preserved. The observed failure (chat
 * `01a07b74`, 2026-09-07) spent 235 seconds of a 320-second run with nothing
 * renderable on the stream: six compactions and four pure-JS code-mode `exec`
 * calls, none of which the public lane mentions.
 *
 * ## Why not derive it from token telemetry
 *
 * The obvious cheaper route — infer compaction from `turn.completed.usage` —
 * does not work, and the reason is worth recording so it is not retried.
 * `turn.completed.usage.input_tokens` is **cumulative across the whole turn**,
 * not the last request's input: a two-request turn measured 15,286 then 15,593
 * and reported 30,879. So "input exceeded the context window" is also true of
 * any long, healthy, multi-request turn, and no threshold separates the two.
 * The stream carries no per-request usage and no `model_context_window` at all.
 * The rollout carries both, per request, as it happens.
 *
 * ## Contract with the CLI's file
 *
 * The rollout belongs to the Codex CLI. This module opens it **read-only**,
 * never writes/truncates/removes it, and treats every shape in it as untrusted:
 *
 *  - It may not exist yet when the turn starts (the CLI creates it slightly
 *    after `thread.started`), so discovery retries on an interval.
 *  - Reads land mid-write, so a trailing partial line is buffered rather than
 *    parsed; a line that never completes is simply never emitted.
 *  - Reads are incremental from the last byte offset — the file reaches
 *    megabytes (2 MB in the observed failure, 1.4 MB of it on line 1), so it is
 *    never re-read whole.
 *  - A truncation/rotation (size < offset) resets the offset rather than
 *    seeking past the end.
 *  - Emission is deduped on each record's own `item.id`, so a resumed session
 *    re-reading earlier bytes cannot double-report a compaction.
 *
 * Nothing here can fail a run: every filesystem error is logged and swallowed.
 *
 * @see messageAdapter.ts (the public-lane translation this supplements)
 * @see sessionParser.ts (the durable read path, which owns transcript content)
 */
import { createReadStream, existsSync, opendirSync, statSync } from "node:fs";
import { join } from "node:path";
import { extractThreadIdFromFilename, resolveCodexSessionsRoot } from "./sessionParser.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("codex-rollout-tail");

/** How often to poll the rollout for new bytes, and to look for it before it exists. */
export const ROLLOUT_POLL_MS = 500;

/**
 * Cap on bytes consumed per poll. A compaction record is a few hundred bytes;
 * this only bounds a pathological single read (e.g. the 1.4 MB `session_meta`
 * line), it does not drop data — the offset advances by what was read, so the
 * remainder arrives on the next tick.
 */
export const ROLLOUT_MAX_CHUNK_BYTES = 1024 * 1024;

/**
 * A compaction observed in the rollout. `id` is the CLI's own item id, used for
 * dedupe; `contextWindow` is the model's window when the neighbouring
 * `token_count` reported one (it rides on `token_count`, not on the compaction
 * record itself, so it may be absent).
 */
export interface RolloutCompaction {
  id: string;
  contextWindow?: number;
}

/** Callbacks the tail invokes. Both are optional; neither may throw. */
export interface RolloutTailHandlers {
  onCompaction: (compaction: RolloutCompaction) => void;
}

/**
 * Locate the rollout file for `threadId`.
 *
 * The layout is `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<iso>-<threadId>.jsonl`.
 * Rather than walk the whole dated tree (which holds every session ever run —
 * 374 of them on the machine this was measured on), search only today's and
 * yesterday's directories: a run's rollout is created when the run starts, so
 * it cannot be older than that, and the two-day window covers a turn that
 * crosses local midnight or a `$CODEX_HOME` on a different timezone offset.
 *
 * Returns null when the file does not exist yet, which is expected for the
 * first few polls of a run.
 */
export function findRolloutPath(threadId: string, now: Date = new Date()): string | null {
  const root = resolveCodexSessionsRoot();
  if (!existsSync(root)) return null;

  for (const offsetDays of [0, -1, 1]) {
    const day = new Date(now);
    day.setDate(day.getDate() + offsetDays);
    const dir = join(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    );
    if (!existsSync(dir)) continue;

    let handle;
    try {
      handle = opendirSync(dir);
    } catch {
      continue;
    }
    try {
      let entry = handle.readSync();
      while (entry) {
        if (entry.name.endsWith(".jsonl") && extractThreadIdFromFilename(entry.name) === threadId) {
          return join(dir, entry.name);
        }
        entry = handle.readSync();
      }
    } catch {
      // Directory vanished mid-scan (a concurrent cleanup) — try the next day.
    } finally {
      try {
        handle.closeSync();
      } catch {
        /* already closed */
      }
    }
  }
  return null;
}

/**
 * Pull the compaction records out of a batch of complete rollout lines.
 *
 * Exported for tests: this is the pure half of the tail, so the parsing rules
 * can be asserted against real captured rollout text without a filesystem or a
 * timer. Malformed lines are skipped silently — the rollout is another
 * process's file and a parse failure here must never surface as a run error.
 *
 * `token_count` records carry `info.model_context_window`; compaction records
 * do not. Since `token_count` precedes the `ContextCompaction` it belongs to,
 * the most recently seen window is carried forward onto the next compaction.
 */
export function extractCompactions(lines: string[], carriedContextWindow?: number): { compactions: RolloutCompaction[]; contextWindow?: number } {
  const compactions: RolloutCompaction[] = [];
  let contextWindow = carriedContextWindow;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;

    const payload = (record as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") continue;
    const typed = payload as { type?: unknown; item?: unknown; info?: unknown };

    if (typed.type === "token_count") {
      const info = typed.info;
      if (info && typeof info === "object") {
        const window = (info as { model_context_window?: unknown }).model_context_window;
        if (typeof window === "number" && window > 0) contextWindow = window;
      }
      continue;
    }

    if (typed.type !== "item_completed") continue;
    const item = typed.item;
    if (!item || typeof item !== "object") continue;

    // The rollout lane uses the CLI's internal PascalCase serialization
    // (`ContextCompaction`), NOT the public lane's snake_case. Both spellings
    // are accepted so a future CLI that unifies them still parses — see the
    // two-lane note in messageAdapter.ts.
    const itemType = (item as { type?: unknown }).type;
    if (itemType !== "ContextCompaction" && itemType !== "context_compaction") continue;

    const rawId = (item as { id?: unknown }).id;
    const id = typeof rawId === "string" && rawId ? rawId : `compaction-${compactions.length}-${trimmed.length}`;
    compactions.push({ id, ...(contextWindow !== undefined && { contextWindow }) });
  }

  return { compactions, ...(contextWindow !== undefined && { contextWindow }) };
}

/**
 * Tail a run's rollout, invoking `handlers.onCompaction` once per compaction.
 *
 * Lifecycle is caller-owned and must be symmetric: {@link RolloutTail.start}
 * once the thread id is known (it arrives on `thread.started`), and
 * {@link RolloutTail.stop} on **every** exit path — normal completion, thrown
 * error, and abort. A leaked interval would otherwise outlive the run and
 * accumulate for the life of the daemon.
 */
export class RolloutTail {
  private timer: NodeJS.Timeout | null = null;
  private path: string | null = null;
  private offset = 0;
  private buffer = "";
  private contextWindow: number | undefined;
  private readonly seen = new Set<string>();
  private reading = false;
  private stopped = false;

  constructor(
    private readonly threadId: string,
    private readonly handlers: RolloutTailHandlers,
    private readonly pollMs: number = ROLLOUT_POLL_MS,
  ) {}

  /** Begin polling. Idempotent; a second call is a no-op. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollMs);
    // Never hold the event loop open on account of this tail: the run's
    // lifetime is what decides when it ends, not the reverse.
    this.timer.unref?.();
    log.debug(`tail started for thread ${this.threadId}`);
  }

  /**
   * Stop polling and drop all state. Idempotent, safe before `start()`, and
   * safe to call from a `finally` that also runs on the abort path.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.buffer = "";
    this.seen.clear();
    log.debug(`tail stopped for thread ${this.threadId}`);
  }

  /**
   * One poll cycle: find the file if it is not known yet, then consume whatever
   * whole lines have appeared since the last offset. Re-entrancy is guarded —
   * a slow read must not overlap the next interval tick.
   */
  private async poll(): Promise<void> {
    if (this.stopped || this.reading) return;
    this.reading = true;
    try {
      if (!this.path) {
        this.path = findRolloutPath(this.threadId);
        if (!this.path) return;
        log.debug(`tail resolved rollout ${this.path}`);
      }

      let size: number;
      try {
        size = statSync(this.path).size;
      } catch {
        // The file was removed underneath us; nothing further to read.
        return;
      }

      // Truncated or rotated — restart from the beginning rather than seeking
      // past EOF. Dedupe on item id keeps the replay from re-emitting.
      if (size < this.offset) {
        this.offset = 0;
        this.buffer = "";
      }
      if (size === this.offset) return;

      const end = Math.min(size, this.offset + ROLLOUT_MAX_CHUNK_BYTES);
      const chunk = await this.readRange(this.offset, end - 1);
      this.offset = end;

      // Everything up to the last newline is complete; the remainder is a
      // partial line still being written and stays buffered.
      this.buffer += chunk;
      const lastNewline = this.buffer.lastIndexOf("\n");
      if (lastNewline === -1) return;
      const complete = this.buffer.slice(0, lastNewline).split("\n");
      this.buffer = this.buffer.slice(lastNewline + 1);

      const { compactions, contextWindow } = extractCompactions(complete, this.contextWindow);
      this.contextWindow = contextWindow;

      for (const compaction of compactions) {
        if (this.seen.has(compaction.id)) continue;
        this.seen.add(compaction.id);
        try {
          this.handlers.onCompaction(compaction);
        } catch (err) {
          log.warn(`onCompaction handler threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      log.warn(`rollout tail poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.reading = false;
    }
  }

  /** Read a byte range as UTF-8. Read-only; never opens the file for writing. */
  private readRange(start: number, end: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = createReadStream(this.path as string, { start, end, flags: "r" });
      stream.on("data", (c) => chunks.push(Buffer.from(c)));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
  }
}
