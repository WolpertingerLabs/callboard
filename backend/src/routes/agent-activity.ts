import { Router } from "express";
import type { Request, Response } from "express";
import { agentExists } from "../services/agent-file-service.js";
import { getActivity, appendActivity } from "../services/agent-activity.js";
import { getAllEvents } from "../services/event-log.js";
import type { ActivityEntry } from "shared";

export const agentActivityRouter = Router({ mergeParams: true });

/** GET /api/agents/:alias/activity — list activity entries with optional type filter.
 *  Global proxy events are merged into the timeline as type="event" entries. */
agentActivityRouter.get("/", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const type = req.query.type as ActivityEntry["type"] | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
  const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

  const validTypes = ["chat", "event", "cron", "connection", "system"];
  if (type && !validTypes.includes(type)) {
    res.status(400).json({ error: `type must be one of: ${validTypes.join(", ")}` });
    return;
  }

  // Get agent-specific activity (all types to merge properly, we'll filter after)
  const agentEntries = getActivity(alias, { limit: 10000 });

  // Merge global proxy events as "event" type entries (unless filtering to a non-event type)
  let merged: ActivityEntry[] = [...agentEntries];

  if (!type || type === "event") {
    const globalEvents = getAllEvents({ limit: 10000 });
    const eventEntries: ActivityEntry[] = globalEvents.map((e) => ({
      id: `proxy-${e.source}-${e.id}`,
      type: "event" as const,
      message: `${e.source}:${e.eventType}`,
      timestamp: e.storedAt,
      metadata: {
        eventId: e.id,
        eventSource: e.source,
        eventType: e.eventType,
        receivedAt: e.receivedAt,
        eventData: typeof e.data === "string" ? e.data.slice(0, 500) : JSON.stringify(e.data).slice(0, 500),
      },
    }));
    merged.push(...eventEntries);
  }

  // Filter by type if specified
  if (type) {
    merged = merged.filter((e) => e.type === type);
  }

  // Sort newest first
  merged.sort((a, b) => b.timestamp - a.timestamp);

  // Apply pagination
  const entries = merged.slice(offset, offset + limit);
  res.json({ entries });
});

/** POST /api/agents/:alias/activity — append a new activity entry */
agentActivityRouter.post("/", (req: Request, res: Response): void => {
  const alias = req.params.alias as string;

  if (!agentExists(alias)) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }

  const { type, message, metadata } = req.body as Partial<ActivityEntry>;

  if (!type || !message) {
    res.status(400).json({ error: "type and message are required" });
    return;
  }

  const validTypes = ["chat", "event", "cron", "connection", "system"];
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `type must be one of: ${validTypes.join(", ")}` });
    return;
  }

  const entry = appendActivity(alias, { type, message, metadata });
  res.status(201).json({ entry });
});
