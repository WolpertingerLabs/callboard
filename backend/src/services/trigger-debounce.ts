/**
 * Trigger debounce buffer.
 *
 * When a trigger has debounce enabled, matching events are buffered here
 * instead of immediately spawning agent sessions. The debounce timer resets
 * on each new event. Once the window expires (or maxWaitMs ceiling is hit),
 * a single agent session fires with all accumulated events in its prompt.
 */
import { executeAgent } from "./agent-executor.js";
import { updateTrigger } from "./agent-triggers.js";
import { interpolatePrompt } from "./trigger-dispatcher.js";
import { createLogger } from "../utils/logger.js";
import type { Trigger } from "shared";
import type { StoredEvent } from "./event-log.js";

const log = createLogger("trigger-debounce");

// ── Buffer state ───────────────────────────────────────────────────

interface DebouncedBatch {
  agentAlias: string;
  trigger: Trigger;
  events: StoredEvent[];
  timer: ReturnType<typeof setTimeout>;
  maxTimer?: ReturnType<typeof setTimeout>;
  firstEventAt: number;
}

/** Keyed by "agentAlias:triggerId" */
const batches = new Map<string, DebouncedBatch>();

function batchKey(agentAlias: string, triggerId: string): string {
  return `${agentAlias}:${triggerId}`;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Buffer an event for a debounce-enabled trigger.
 *
 * Resets the debounce timer on each call. Sets a maxWait ceiling timer
 * on the first event if maxWaitMs is configured.
 */
export function enqueueEvent(agentAlias: string, trigger: Trigger, event: StoredEvent): void {
  const key = batchKey(agentAlias, trigger.id);
  const windowMs = trigger.debounce!.windowMs;
  const maxWaitMs = trigger.debounce!.maxWaitMs;

  const existing = batches.get(key);

  if (existing) {
    // Add event to existing batch and reset debounce timer
    existing.events.push(event);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushBatch(key), windowMs);
    log.debug(`[${key}] Debounce reset — ${existing.events.length} events buffered`);
  } else {
    // First event — create new batch
    const batch: DebouncedBatch = {
      agentAlias,
      trigger,
      events: [event],
      timer: setTimeout(() => flushBatch(key), windowMs),
      firstEventAt: Date.now(),
    };

    // Set ceiling timer if configured
    if (maxWaitMs && maxWaitMs > 0) {
      batch.maxTimer = setTimeout(() => flushBatch(key), maxWaitMs);
    }

    batches.set(key, batch);
    log.debug(`[${key}] Debounce started — windowMs=${windowMs}, maxWaitMs=${maxWaitMs ?? "none"}`);
  }
}

/**
 * Flush all pending batches. Called on graceful shutdown.
 */
export function shutdownDebounce(): void {
  const pending = batches.size;
  if (pending === 0) return;

  log.info(`Flushing ${pending} pending debounce batch(es) on shutdown`);
  for (const key of [...batches.keys()]) {
    flushBatch(key);
  }
}

/**
 * Get the number of pending debounce batches (for diagnostics).
 */
export function pendingBatchCount(): number {
  return batches.size;
}

// ── Internal ───────────────────────────────────────────────────────

/**
 * Flush a debounce batch: build the combined prompt and fire executeAgent().
 */
function flushBatch(key: string): void {
  const batch = batches.get(key);
  if (!batch) return;

  // Clean up timers and remove from map
  clearTimeout(batch.timer);
  if (batch.maxTimer) clearTimeout(batch.maxTimer);
  batches.delete(key);

  const { agentAlias, trigger, events } = batch;
  const eventCount = events.length;

  log.info(`[${key}] Flushing batch — ${eventCount} event(s)`);

  // Update trigger stats
  updateTrigger(agentAlias, trigger.id, {
    lastTriggered: Date.now(),
    triggerCount: trigger.triggerCount + eventCount,
  });

  // Build prompt
  const prompt = buildBatchedPrompt(trigger, events);

  // Fire agent session
  executeAgent({
    agentAlias,
    prompt,
    triggeredBy: "trigger",
    metadata: {
      triggerId: trigger.id,
      triggerName: trigger.name,
      debounced: true,
      eventCount,
      eventIds: events.map((e) => e.id),
      eventSources: [...new Set(events.map((e) => `${e.source}:${e.eventType}`))],
    },
    maxTurns: trigger.action.maxTurns,
    ...(trigger.action.provider && { provider: trigger.action.provider }),
    ...(trigger.action.model && { model: trigger.action.model }),
    ...(trigger.action.effort && { effort: trigger.action.effort }),
    ...(trigger.action.requireExplicitCompletion === true && { requireExplicitCompletion: true }),
  }).catch((err) => {
    log.error(`[${key}] Debounced trigger dispatch failed: ${err.message}`);
  });
}

/**
 * Build a prompt from a batch of events.
 *
 * Single event: use normal interpolation.
 * Multiple events: interpolate with the first event, then append all events.
 */
function buildBatchedPrompt(trigger: Trigger, events: StoredEvent[]): string {
  if (events.length === 1) {
    return interpolatePrompt(trigger.action.prompt || "", events[0]);
  }

  // Interpolate the template with the first event for framing context
  const basePrompt = interpolatePrompt(trigger.action.prompt || "", events[0]);

  const elapsed = events.length > 1 ? Math.round((Date.now() - new Date(events[0].receivedAt).getTime()) / 1000) : 0;

  const eventList = events
    .map((e, i) => {
      const payload = typeof e.data === "string" ? e.data : JSON.stringify(e.data, null, 2);
      return `Event ${i + 1} (${e.source}:${e.eventType} at ${e.receivedAt}):\n${payload}`;
    })
    .join("\n\n");

  return `${basePrompt}\n\n---\nThis trigger matched ${events.length} events over ~${elapsed}s (debounced). All events:\n\n${eventList}`;
}
