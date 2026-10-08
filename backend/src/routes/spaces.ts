/**
 * Spaces REST API — named partitions of the chat list (shared/types/space.ts).
 *
 * Writes are deltas (PATCH merges only the keys it names), because two tabs
 * editing the same install over remote access is the ordinary case and a
 * whole-record write from one would undo the other. DELETE refuses a space
 * that still holds chats unless it is told where to move them.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { DEFAULT_SPACE_ID, type SpaceListItem, type SpacePatch } from "shared";
import { spaceOfChat, chatCountsBySpace, chatsStampedWith, folderGroups, moveChatsToSpace, restampSpace, rootsInFolder, SpaceMoveError } from "../services/space-service.js";
import { createSpace, deleteSpaceRecord, getSpace, isValidSpaceId, listSpaces, SpaceValidationError, updateSpace } from "../services/space-store.js";
import { listJobs, updateJob } from "../services/job-store.js";
import { clearListCaches } from "../services/list-caches.js";
import { sessionRegistry } from "../services/session-registry.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("spaces");

export const spacesRouter = Router();

function fail(res: Response, err: any, what: string) {
  if (err instanceof SpaceValidationError || err instanceof SpaceMoveError) return res.status(400).json({ error: err.message });
  log.error(`${what}: ${err}`);
  return res.status(500).json({ error: what, details: err?.message });
}

/** Tell every open tab the space set changed (switcher, settings, chips). */
function notifySpacesChanged(): void {
  clearListCaches();
  sessionRegistry.notifyMetadata("spaces", { cardEvent: "updated" });
}

spacesRouter.get("/", (req: Request, res: Response) => {
  // #swagger.tags = ['Spaces']
  // #swagger.summary = 'List spaces'
  // #swagger.description = 'Every space in switcher order. The default space ("General") is always present. Archived spaces only with includeArchived=true. chatCount (stored chats whose tree resolves to the space) only with includeCounts=true — it is a pass over the whole chat corpus, and the switcher refetches this list on every metadata bump.'
  /* #swagger.parameters['includeArchived'] = { in: 'query', type: 'string', description: 'Include archived spaces' } */
  /* #swagger.parameters['includeCounts'] = { in: 'query', type: 'string', description: 'Compute chatCount per space (otherwise 0)' } */
  try {
    const counts = req.query.includeCounts === "true" ? chatCountsBySpace() : new Map<string, number>();
    const spaces: SpaceListItem[] = listSpaces({ includeArchived: req.query.includeArchived === "true" }).map((space) => ({
      ...space,
      chatCount: counts.get(space.id) ?? 0,
    }));
    res.json({ spaces });
  } catch (err) {
    fail(res, err, "Failed to list spaces");
  }
});

spacesRouter.get("/folder-groups", (req: Request, res: Response) => {
  // #swagger.tags = ['Spaces']
  // #swagger.summary = "Group a space's trees by repo, for the first-run sort sheet"
  /* #swagger.parameters['from'] = { in: 'query', type: 'string', description: 'Space to group (default: default)' } */
  try {
    const from = typeof req.query.from === "string" && req.query.from ? req.query.from : DEFAULT_SPACE_ID;
    res.json({ groups: folderGroups(from) });
  } catch (err) {
    fail(res, err, "Failed to group chats by folder");
  }
});

spacesRouter.post("/", (req: Request, res: Response) => {
  // #swagger.tags = ['Spaces']
  // #swagger.summary = 'Create a space'
  /* #swagger.requestBody = { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, emoji: { type: "string" }, color: { type: "string" }, folderRules: { type: "array", items: { type: "string" } }, instructions: { type: "string" } } } } } } */
  const body = (req.body ?? {}) as SpacePatch;
  if (typeof body.name !== "string") return res.status(400).json({ error: "name is required" });
  try {
    const space = createSpace(body as SpacePatch & { name: string });
    notifySpacesChanged();
    res.status(201).json({ space: { ...space, chatCount: 0 } });
  } catch (err) {
    fail(res, err, "Failed to create space");
  }
});

spacesRouter.get("/of/:chatId", (req: Request, res: Response) => {
  // #swagger.tags = ['Spaces']
  // #swagger.summary = "The space a chat's tree belongs to"
  // #swagger.description = 'What the client asks when a chat is opened by URL, so it can switch to that chat's space. Cheap: a lineage walk over a handful of records, not a corpus scan.'
  try {
    res.json({ chatId: req.params.chatId, spaceId: spaceOfChat(req.params.chatId) });
  } catch (err) {
    fail(res, err, "Failed to resolve the chat's space");
  }
});

spacesRouter.get("/:id", (req: Request, res: Response) => {
  // #swagger.tags = ['Spaces']
  // #swagger.summary = 'Get a space'
  const space = getSpace(req.params.id);
  if (!space) return res.status(404).json({ error: "Space not found" });
  res.json({ space: { ...space, chatCount: chatCountsBySpace().get(space.id) ?? 0 } });
});

spacesRouter.patch("/:id", (req: Request, res: Response) => {
  // #swagger.tags = ['Spaces']
  // #swagger.summary = 'Update a space (delta)'
  // #swagger.description = 'Only the keys present are changed; null clears an optional field. defaults and agentScope merge key by key.'
  try {
    const space = updateSpace(req.params.id, (req.body ?? {}) as SpacePatch);
    if (!space) return res.status(404).json({ error: "Space not found" });
    notifySpacesChanged();
    res.json({ space: { ...space, chatCount: chatCountsBySpace().get(space.id) ?? 0 } });
  } catch (err) {
    fail(res, err, "Failed to update space");
  }
});

spacesRouter.delete("/:id", (req: Request, res: Response) => {
  // #swagger.tags = ['Spaces']
  // #swagger.summary = 'Delete a space'
  // #swagger.description = 'Refused (409) while any chat or job still names the space, unless moveTo names the space to move them into.'
  /* #swagger.parameters['moveTo'] = { in: 'query', type: 'string', description: 'Space to move remaining chats and jobs into' } */
  const id = req.params.id;
  if (id === DEFAULT_SPACE_ID) return res.status(400).json({ error: "The default space cannot be deleted" });
  if (!isValidSpaceId(id) || !getSpace(id)) return res.status(404).json({ error: "Space not found" });
  const moveTo = typeof req.query.moveTo === "string" ? req.query.moveTo : typeof req.body?.moveTo === "string" ? req.body.moveTo : undefined;
  try {
    const stamped = chatsStampedWith(id);
    const jobs = listJobs().filter((job) => job.defaults?.spaceId === id);
    if ((stamped.length || jobs.length) && !moveTo) {
      return res.status(409).json({
        error: "space_not_empty",
        message: `This space still holds ${stamped.length} chat(s) and ${jobs.length} job(s). Pass moveTo to move them first.`,
        chatCount: stamped.length,
        jobCount: jobs.length,
      });
    }
    let moved = 0;
    if (moveTo) {
      if (moveTo === id) return res.status(400).json({ error: "moveTo must be a different space" });
      const target = getSpace(moveTo);
      if (!target) return res.status(400).json({ error: `Space "${moveTo}" not found` });
      moved = restampSpace(id, moveTo);
      for (const job of jobs) {
        const { spaceId: _drop, ...rest } = job.defaults ?? {};
        updateJob(job.id, { ...job, defaults: { ...rest, ...(moveTo !== DEFAULT_SPACE_ID && { spaceId: moveTo }) } });
      }
    }
    deleteSpaceRecord(id);
    notifySpacesChanged();
    res.json({ ok: true, movedChats: moved, movedJobs: moveTo ? jobs.length : 0 });
  } catch (err) {
    fail(res, err, "Failed to delete space");
  }
});

spacesRouter.post("/:id/move", (req: Request, res: Response) => {
  // #swagger.tags = ['Spaces']
  // #swagger.summary = 'Move chats (whole trees) into this space'
  // #swagger.description = 'Body: { chatIds?: string[], folder?: string, fromSpace?: string }. Any member id moves its whole tree. folder moves every tree in fromSpace (default: default) whose root ran in that folder, under it, or in a worktree of it. Partial success is a 200 with failed[].'
  const target = req.params.id;
  const { chatIds, folder, fromSpace } = req.body ?? {};
  if (chatIds !== undefined && (!Array.isArray(chatIds) || chatIds.some((id: unknown) => typeof id !== "string"))) {
    return res.status(400).json({ error: "chatIds must be an array of strings" });
  }
  if (folder !== undefined && (typeof folder !== "string" || !folder.startsWith("/"))) {
    return res.status(400).json({ error: "folder must be an absolute path" });
  }
  if (!chatIds?.length && !folder) return res.status(400).json({ error: "chatIds or folder is required" });
  try {
    const ids: string[] = [...(chatIds ?? [])];
    if (folder) ids.push(...rootsInFolder(folder, typeof fromSpace === "string" && fromSpace ? fromSpace : DEFAULT_SPACE_ID));
    const result = ids.length ? moveChatsToSpace(ids, target) : { movedRoots: [], chatCount: 0, failed: [] };
    res.json(result);
  } catch (err) {
    fail(res, err, "Failed to move chats");
  }
});
