/**
 * Trigger dispatcher.
 *
 * Evaluates incoming events against all active triggers across all agents.
 * When a trigger's filter matches an event, interpolates the prompt template
 * with event data and fires an agent session via executeAgent().
 *
 * Also provides backtestFilter() for previewing which events a filter matches.
 */
import { listAgents } from "./agent-file-service.js";
import { listTriggers, updateTrigger } from "./agent-triggers.js";
import { executeAgent } from "./agent-executor.js";
import { createLogger } from "../utils/logger.js";
import type { TriggerFilter, FilterCondition } from "shared";
import type { StoredEvent } from "./event-log.js";

const log = createLogger("trigger-dispatcher");

// ── Public API ──────────────────────────────────────────────────

/**
 * Dispatch a newly stored event against all active triggers across all agents.
 * Called by event-watcher.ts after each event is appended.
 *
 * Filter matching runs synchronously, but executeAgent() is fire-and-forget
 * so the event watcher polling loop is not blocked.
 */
export function dispatchEvent(event: StoredEvent): void {
  const agents = listAgents();

  for (const agent of agents) {
    const triggers = listTriggers(agent.alias);

    for (const trigger of triggers) {
      if (trigger.status !== "active") continue;
      if (!matchesFilter(event, trigger.filter)) continue;

      log.info(
        `Trigger "${trigger.name}" (${trigger.id}) matched event ${event.source}:${event.eventType} for agent ${agent.alias}`,
      );

      // Update trigger stats
      updateTrigger(agent.alias, trigger.id, {
        lastTriggered: Date.now(),
        triggerCount: trigger.triggerCount + 1,
      });

      // Interpolate prompt template and fire agent session
      const prompt = interpolatePrompt(trigger.action.prompt || "", event);

      executeAgent({
        agentAlias: agent.alias,
        prompt,
        triggeredBy: "trigger",
        metadata: {
          triggerId: trigger.id,
          triggerName: trigger.name,
          eventSource: event.source,
          eventType: event.eventType,
          eventId: event.id,
        },
        maxTurns: trigger.action.maxTurns,
      }).catch((err) => {
        log.error(`Trigger dispatch failed for ${agent.alias}/${trigger.id}: ${err.message}`);
      });
    }
  }
}

// ── Filter Matching ─────────────────────────────────────────────

/**
 * Check whether a stored event matches a trigger filter.
 * All specified fields must match (AND logic).
 * Unspecified fields (undefined/empty) are treated as "match any".
 */
export function matchesFilter(event: StoredEvent, filter: TriggerFilter): boolean {
  // Source match (exact, case-sensitive)
  if (filter.source && filter.source !== event.source) return false;

  // Event type match (exact, case-sensitive)
  if (filter.eventType && filter.eventType !== event.eventType) return false;

  // Data field conditions (all must pass)
  if (filter.conditions && filter.conditions.length > 0) {
    for (const condition of filter.conditions) {
      if (!evaluateCondition(event.data, condition)) return false;
    }
  }

  return true;
}

/**
 * Evaluate a single filter condition against event data.
 */
function evaluateCondition(data: unknown, condition: FilterCondition): boolean {
  const value = getNestedValue(data, condition.field);

  switch (condition.operator) {
    case "exists":
      return value !== undefined && value !== null;

    case "not_exists":
      return value === undefined || value === null;

    case "equals":
      return String(value) === condition.value;

    case "contains":
      return typeof value === "string" && condition.value != null && value.includes(condition.value);

    case "matches":
      if (typeof value !== "string" || !condition.value) return false;
      try {
        return new RegExp(condition.value).test(value);
      } catch {
        return false; // Invalid regex — fail gracefully
      }

    default:
      return false;
  }
}

// ── Prompt Template Interpolation ───────────────────────────────

/**
 * Interpolate {{event.*}} placeholders in a prompt template.
 *
 * Supported placeholders:
 *   {{event.source}}              — connection alias
 *   {{event.eventType}}           — event type string
 *   {{event.id}}                  — event ID number
 *   {{event.receivedAt}}          — ISO-8601 timestamp
 *   {{event.data}}                — full JSON payload
 *   {{event.data.field.path}}     — dot-notation into data
 *
 * If template is empty, generates a default prompt with full event info.
 */
export function interpolatePrompt(template: string, event: StoredEvent): string {
  if (!template) {
    return `Event received: ${event.source}:${event.eventType}\n\nPayload:\n${JSON.stringify(event.data, null, 2)}`;
  }

  return template.replace(/\{\{event\.([^}]+)\}\}/g, (_match, path: string) => {
    switch (path) {
      case "source":
        return event.source;
      case "eventType":
        return event.eventType;
      case "receivedAt":
        return event.receivedAt;
      case "id":
        return String(event.id);
      case "data":
        return JSON.stringify(event.data, null, 2);
      default:
        // Handle "data.fieldPath" — strip the "data." prefix and traverse
        if (path.startsWith("data.")) {
          const fieldPath = path.slice(5);
          const val = getNestedValue(event.data, fieldPath);
          if (val === undefined || val === null) return "";
          return typeof val === "object" ? JSON.stringify(val) : String(val);
        }
        return ""; // Unknown placeholder
    }
  });
}

// ── Backtest ────────────────────────────────────────────────────

/**
 * Test a filter against a list of stored events.
 * Returns the events that match, useful for previewing trigger behavior.
 */
export function backtestFilter(events: StoredEvent[], filter: TriggerFilter): StoredEvent[] {
  return events.filter((event) => matchesFilter(event, filter));
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Resolve a dot-notation path against an arbitrary object.
 * e.g., getNestedValue({author: {username: "bob"}}, "author.username") => "bob"
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
