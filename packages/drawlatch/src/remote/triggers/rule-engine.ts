/**
 * Trigger Rule Engine.
 *
 * Subscribes to ingestor `'event'` emissions and evaluates trigger rules
 * against each event. When a rule matches, dispatches the event to the
 * configured Claude Code remote trigger.
 *
 * Features:
 * - Source + event type + dot-path filter matching
 * - Token-bucket rate limiting per rule
 * - Deduplication within the throttle window
 * - Graceful error handling (dispatch failures never crash ingestors)
 * - Audit logging for all dispatch attempts
 */

import type { IngestedEvent } from '../ingestors/types.js';
import type { TriggerRule, TriggerDispatchResult } from './types.js';
import { createLogger } from '../../shared/logger.js';
import { safeFetch, sameOriginAs } from '../safe-fetch.js';

const log = createLogger('trigger-engine');

/** Default maximum dispatches per minute when no throttle is configured. */
const DEFAULT_MAX_PER_MINUTE = 10;

/** Duration of the throttle window in milliseconds. */
const THROTTLE_WINDOW_MS = 60_000;

/** Maximum dedup keys to track per rule (prevents memory leaks). */
const MAX_DEDUP_KEYS = 1_000;

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Resolve a dot-separated path on an object.
 * E.g., `getByPath(obj, 'payload.action')` → `obj.payload.action`.
 */
function getByPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ── Per-rule runtime state ───────────────────────────────────────────────

interface RuleState {
  /** Timestamps of recent dispatches within the throttle window. */
  dispatchTimestamps: number[];
  /** Recently seen dedup keys (to prevent duplicate triggers). */
  recentDedupKeys: Set<string>;
}

// ── Rule Engine ──────────────────────────────────────────────────────────

export class TriggerRuleEngine {
  private readonly rules: TriggerRule[];
  private readonly secrets: Record<string, string>;
  private readonly ruleStates = new Map<string, RuleState>();

  /** Recent dispatch results for diagnostics. */
  private readonly dispatchLog: TriggerDispatchResult[] = [];
  private static readonly MAX_DISPATCH_LOG = 100;

  constructor(rules: TriggerRule[], secrets: Record<string, string>) {
    this.rules = rules.filter((r) => r.enabled !== false);
    this.secrets = secrets;

    // Initialize per-rule state
    for (const rule of this.rules) {
      this.ruleStates.set(rule.name, {
        dispatchTimestamps: [],
        recentDedupKeys: new Set(),
      });
    }

    if (this.rules.length > 0) {
      log.info(`Trigger rule engine initialized with ${this.rules.length} active rule(s)`);
    }
  }

  /** Handle an ingestor event — evaluate all rules and dispatch matches. */
  handleEvent(event: IngestedEvent): void {
    for (const rule of this.rules) {
      if (this.matches(rule, event)) {
        void this.dispatch(rule, event);
      }
    }
  }

  /** Get recent dispatch results for diagnostics. */
  getDispatchLog(): readonly TriggerDispatchResult[] {
    return this.dispatchLog;
  }

  /** Get the number of active rules. */
  get activeRuleCount(): number {
    return this.rules.length;
  }

  // ── Rule matching ──────────────────────────────────────────────────────

  /** Check if an event matches a rule's criteria. */
  private matches(rule: TriggerRule, event: IngestedEvent): boolean {
    // Source must match
    if (rule.source !== event.source) return false;

    // Instance ID filter (if specified)
    if (rule.instanceId !== undefined && rule.instanceId !== event.instanceId) return false;

    // Event type filter (empty = match all)
    if (rule.eventTypes && rule.eventTypes.length > 0) {
      if (!rule.eventTypes.includes(event.eventType)) return false;
    }

    // Dot-path filter predicates (AND logic)
    if (rule.filter) {
      for (const [path, acceptedValues] of Object.entries(rule.filter)) {
        const actualValue = getByPath(event.data, path);
        if (!Array.isArray(acceptedValues)) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!acceptedValues.includes(actualValue as any)) return false;
      }
    }

    return true;
  }

  // ── Throttle & dedup ───────────────────────────────────────────────────

  /** Check and update throttle state. Returns true if the dispatch should proceed. */
  private checkThrottle(rule: TriggerRule, event: IngestedEvent): boolean {
    const state = this.ruleStates.get(rule.name);
    if (!state) return false;

    const now = Date.now();
    const maxPerMinute = rule.throttle?.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE;

    // Prune timestamps outside the window
    state.dispatchTimestamps = state.dispatchTimestamps.filter(
      (ts) => now - ts < THROTTLE_WINDOW_MS,
    );

    // Rate limit check
    if (state.dispatchTimestamps.length >= maxPerMinute) {
      log.warn(`${rule.name}: throttled (${maxPerMinute}/min limit reached)`);
      return false;
    }

    // Dedup check
    if (rule.throttle?.deduplicateBy) {
      const dedupValue = getByPath(event.data, rule.throttle.deduplicateBy);
      if (dedupValue !== undefined && dedupValue !== null) {
        const dedupKey = typeof dedupValue === 'string' ? dedupValue : JSON.stringify(dedupValue);
        if (state.recentDedupKeys.has(dedupKey)) {
          log.debug(`${rule.name}: deduplicated (key: ${dedupKey})`);
          return false;
        }
        state.recentDedupKeys.add(dedupKey);
        if (state.recentDedupKeys.size > MAX_DEDUP_KEYS) {
          // Prune oldest half
          const pruneCount = Math.floor(state.recentDedupKeys.size / 2);
          let removed = 0;
          for (const key of state.recentDedupKeys) {
            if (removed >= pruneCount) break;
            state.recentDedupKeys.delete(key);
            removed++;
          }
        }
      }
    }

    // Record this dispatch
    state.dispatchTimestamps.push(now);
    return true;
  }

  // ── Dispatch ───────────────────────────────────────────────────────────

  /** Dispatch an event to the rule's target. Never throws. */
  private async dispatch(rule: TriggerRule, event: IngestedEvent): Promise<void> {
    // Check throttle/dedup before dispatching
    if (!this.checkThrottle(rule, event)) return;

    const { triggerId } = rule.target;
    const now = new Date().toISOString();

    try {
      const apiKey = this.secrets.ANTHROPIC_API_KEY;
      if (!apiKey) {
        this.logDispatch({
          rule: rule.name,
          success: false,
          triggerId,
          error: 'ANTHROPIC_API_KEY not configured in caller secrets',
          dispatchedAt: now,
        });
        return;
      }

      const url = `https://api.anthropic.com/v1/code/triggers/${triggerId}/run`;
      const body = JSON.stringify({
        event: {
          source: event.source,
          instanceId: event.instanceId,
          eventType: event.eventType,
          receivedAt: event.receivedAt,
          data: event.data,
        },
      });

      log.info(`${rule.name}: dispatching to trigger ${triggerId} (event: ${event.eventType})`);

      const { response } = await safeFetch(url, {
        isAllowed: sameOriginAs(url),
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body,
      });

      if (response.ok) {
        this.logDispatch({
          rule: rule.name,
          success: true,
          triggerId,
          statusCode: response.status,
          dispatchedAt: now,
        });
        log.info(`${rule.name}: trigger ${triggerId} invoked successfully`);
      } else {
        const errorBody = await response.text().catch(() => '');
        this.logDispatch({
          rule: rule.name,
          success: false,
          triggerId,
          statusCode: response.status,
          error: `HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
          dispatchedAt: now,
        });
        log.warn(
          `${rule.name}: trigger dispatch failed (${response.status}): ${errorBody.slice(0, 200)}`,
        );
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logDispatch({
        rule: rule.name,
        success: false,
        triggerId,
        error,
        dispatchedAt: now,
      });
      log.error(`${rule.name}: trigger dispatch error: ${error}`);
    }
  }

  /** Record a dispatch result in the audit log. */
  private logDispatch(result: TriggerDispatchResult): void {
    this.dispatchLog.push(result);
    if (this.dispatchLog.length > TriggerRuleEngine.MAX_DISPATCH_LOG) {
      this.dispatchLog.splice(0, this.dispatchLog.length - TriggerRuleEngine.MAX_DISPATCH_LOG);
    }
  }
}
