import { Router } from "express";
import type { Request, Response } from "express";
import { agentExists } from "../services/agent-file-service.js";
import { appendActivity } from "../services/agent-activity.js";
import { listTriggers, getTrigger, createTrigger, updateTrigger, deleteTrigger } from "../services/agent-triggers.js";
import { backtestFilter } from "../services/trigger-dispatcher.js";
import { getAllEvents } from "../services/event-log.js";
import type { Trigger, TriggerFilter, CronAction, QuietHours } from "shared";

export const agentTriggersRouter = Router({ mergeParams: true });

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateQuietHours(qh: QuietHours | undefined): string | null {
  if (!qh) return null;
  if (typeof qh.enabled !== "boolean") return "quietHours.enabled must be a boolean";
  if (qh.enabled) {
    if (!TIME_REGEX.test(qh.start) || !TIME_REGEX.test(qh.end)) {
      return "quietHours start/end must be in HH:MM format (00:00 - 23:59)";
    }
  }
  return null;
}

/** GET /api/agents/:alias/triggers — list all triggers for this agent */
agentTriggersRouter.get("/", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const triggers = listTriggers(alias);
  res.json({ triggers });
});

/** POST /api/agents/:alias/triggers/backtest — test a filter against stored events */
// Must be defined BEFORE /:triggerId to avoid Express treating "backtest" as a triggerId
agentTriggersRouter.post("/backtest", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const { filter, limit } = req.body as { filter: TriggerFilter; limit?: number };

  if (!filter) {
    res.status(400).json({ error: "filter is required" });
    return;
  }

  // Load recent events from all sources
  const allEvents = getAllEvents({ limit: limit || 500 });
  const matches = backtestFilter(allEvents, filter);

  res.json({
    totalScanned: allEvents.length,
    matchCount: matches.length,
    matches: matches.slice(0, 50), // Cap response size
  });
});

/** GET /api/agents/:alias/triggers/:triggerId — get a single trigger */
agentTriggersRouter.get("/:triggerId", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const triggerId = req.params.triggerId as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const trigger = getTrigger(alias, triggerId);
  if (!trigger) {
    res.status(404).json({ error: "Trigger not found" });
    return;
  }

  res.json({ trigger });
});

/** POST /api/agents/:alias/triggers — create a new trigger */
agentTriggersRouter.post("/", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const { name, description, filter, action, status, quietHours } = req.body as Partial<Trigger>;

  if (!name || !filter) {
    res.status(400).json({ error: "name and filter are required" });
    return;
  }

  const qhError = validateQuietHours(quietHours);
  if (qhError) {
    res.status(400).json({ error: qhError });
    return;
  }

  const cronAction: CronAction = action || { type: "start_session" };

  const trigger = createTrigger(alias, {
    name: name.trim(),
    description: (description || "").trim(),
    status: status || "active",
    filter,
    action: cronAction,
    triggerCount: 0,
    ...(quietHours && { quietHours }),
  });

  appendActivity(alias, {
    type: "trigger",
    message: `Trigger "${trigger.name}" created`,
    metadata: { triggerId: trigger.id, action: "created" },
  });

  res.status(201).json({ trigger });
});

/** PUT /api/agents/:alias/triggers/:triggerId — update a trigger */
agentTriggersRouter.put("/:triggerId", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const triggerId = req.params.triggerId as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const updates = req.body as Partial<Trigger>;

  const qhError = validateQuietHours(updates.quietHours);
  if (qhError) {
    res.status(400).json({ error: qhError });
    return;
  }

  const trigger = updateTrigger(alias, triggerId, updates);

  if (!trigger) {
    res.status(404).json({ error: "Trigger not found" });
    return;
  }

  appendActivity(alias, {
    type: "trigger",
    message: `Trigger "${trigger.name}" updated`,
    metadata: { triggerId: trigger.id, action: "updated" },
  });

  res.json({ trigger });
});

/** DELETE /api/agents/:alias/triggers/:triggerId — delete a trigger */
agentTriggersRouter.delete("/:triggerId", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;
  const triggerId = req.params.triggerId as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const existing = getTrigger(alias, triggerId);
  const deleted = deleteTrigger(alias, triggerId);
  if (!deleted) {
    res.status(404).json({ error: "Trigger not found" });
    return;
  }

  appendActivity(alias, {
    type: "trigger",
    message: `Trigger "${existing?.name || triggerId}" deleted`,
    metadata: { triggerId, action: "deleted" },
  });

  res.json({ ok: true });
});
