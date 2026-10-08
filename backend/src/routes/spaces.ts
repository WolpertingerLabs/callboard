/**
 * Spaces REST API — named partitions of the chat list (shared/types/space.ts).
 *
 * Writes are deltas (PATCH merges only the keys it names), because two tabs
 * editing the same install over remote access is the ordinary case and a
 * whole-record write from one would undo the other. DELETE refuses a space
 * that still holds chats or jobs unless it is told where to move them.
 *
 * "Holds" has ONE definition, shared with `chatCount` and every listing: a
 * chat is in the space its tree's root resolves to (see spaceContents).
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { DEFAULT_SPACE_ID, type SpaceListItem, type SpacePatch } from "shared";
import { spaceOfChat, chatCountsBySpace, emptySpace, folderGroups, moveChatsToSpace, rootsInFolder, spaceContents, SpaceMoveError } from "../services/space-service.js";
import { createSpace, deleteSpaceRecord, getSpace, isValidSpaceId, listSpaces, reorderSpaces, SpaceValidationError, updateSpace } from "../services/space-store.js";
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

/** Job definitions per `defaults.spaceId` — what a delete also has to move. */
function jobCountsBySpace(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const job of listJobs()) {
    const space = job.defaults?.spaceId;
    if (space) counts.set(space, (counts.get(space) ?? 0) + 1);
  }
  return counts;
}

/** A space as a response row: counts only when the caller asked for them. */
function spaceRow(space: NonNullable<ReturnType<typeof getSpace>>, req: Request): SpaceListItem {
  if (req.query.includeCounts !== "true") return { ...space, chatCount: 0 };
  return { ...space, chatCount: chatCountsBySpace().get(space.id) ?? 0, jobCount: jobCountsBySpace().get(space.id) ?? 0 };
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
    const withCounts = req.query.includeCounts === "true";
    const counts = withCounts ? chatCountsBySpace() : new Map<string, number>();
    const jobs = withCounts ? jobCountsBySpace() : new Map<string, number>();
    const spaces: SpaceListItem[] = listSpaces({ includeArchived: req.query.includeArchived === "true" }).map((space) => ({
      ...space,
      chatCount: counts.get(space.id) ?? 0,
      ...(withCounts && { jobCount: jobs.get(space.id) ?? 0 }),
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
  // #swagger.description = 'What the client asks when a chat is opened by URL, so it can switch to that chat's space. A lineage walk over direct session-id reads; a chat id that is not its own session id costs one snapshot pass the first time and is memoised after. archived is true when the space exists but is archived.'
  try {
    const spaceId = spaceOfChat(req.params.chatId);
    return res.json({ chatId: req.params.chatId, spaceId, ...(getSpace(spaceId)?.archived && { archived: true }) });
  } catch (err) {
    fail(res, err, "Failed to resolve the chat's space");
  }
});

spacesRouter.post("/order", (req: Request, res: Response) => {
  // #swagger.tags = ['Spaces']
  // #swagger.summary = 'Reorder spaces in one request'
  // #swagger.description = 'Body: { ids: string[] } in the wanted switcher order. Listed spaces get order 0..n-1; unlisted ones keep theirs after them. One request, so a failure cannot leave two spaces tied half-way through a swap.'
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.some((id: unknown) => typeof id !== "string")) return res.status(400).json({ error: "ids must be an array of strings" });
  try {
    reorderSpaces(ids);
    notifySpacesChanged();
    res.json({ spaces: listSpaces({ includeArchived: true }).map((space) => ({ ...space, chatCount: 0 })) });
  } catch (err) {
    fail(res, err, "Failed to reorder spaces");
  }
});

spacesRouter.get("/:id", (req: Request, res: Response) => {
  // #swagger.tags = ['Spaces']
  // #swagger.summary = 'Get a space'
  /* #swagger.parameters['includeCounts'] = { in: 'query', type: 'string', description: 'Compute chatCount/jobCount (a corpus pass); otherwise chatCount is 0' } */
  const space = getSpace(req.params.id);
  if (!space) return res.status(404).json({ error: "Space not found" });
  res.json({ space: spaceRow(space, req) });
});

spacesRouter.patch("/:id", (req: Request, res: Response) => {
  // #swagger.tags = ['Spaces']
  // #swagger.summary = 'Update a space (delta)'
  // #swagger.description = 'Only the keys present are changed; null clears an optional field. defaults and agentScope merge key by key.'
  try {
    const space = updateSpace(req.params.id, (req.body ?? {}) as SpacePatch);
    if (!space) return res.status(404).json({ error: "Space not found" });
    notifySpacesChanged();
    // No counts unless asked: every settings toggle is a PATCH, and a corpus
    // pass per toggle is the cost includeCounts was made opt-in to avoid.
    res.json({ space: spaceRow(space, req) });
  } catch (err) {
    fail(res, err, "Failed to update space");
  }
});

spacesRouter.delete("/:id", (req: Request, res: Response) => {
  // #swagger.tags = ['Spaces']
  // #swagger.summary = 'Delete a space'
  // #swagger.description = 'Refused (409, with chatCount and jobCount) while any chat or job is in the space, unless moveTo names a live (unarchived) space to move them into. A chat is in the space its tree root resolves to — the same rule as chatCount. Member records whose own stamp still names the space while their root lives elsewhere never block; they are cleaned up.'
  /* #swagger.parameters['moveTo'] = { in: 'query', type: 'string', description: 'Live space to move remaining chats and jobs into' } */
  const id = req.params.id;
  if (id === DEFAULT_SPACE_ID) return res.status(400).json({ error: "The default space cannot be deleted" });
  if (!isValidSpaceId(id) || !getSpace(id)) return res.status(404).json({ error: "Space not found" });
  const moveTo = typeof req.query.moveTo === "string" ? req.query.moveTo : typeof req.body?.moveTo === "string" ? req.body.moveTo : undefined;
  try {
    if (moveTo !== undefined) {
      if (moveTo === id) return res.status(400).json({ error: "moveTo must be a different space" });
      const target = getSpace(moveTo);
      if (!target) return res.status(400).json({ error: `Space "${moveTo}" not found` });
      // Same rule as every other move: an archived space is out of every
      // default view, so filing chats there would quietly hide them.
      if (target.archived) return res.status(400).json({ error: `Space "${target.name}" is archived — unarchive it or pick another space` });
    }
    const { members } = spaceContents(id);
    const jobs = listJobs().filter((job) => job.defaults?.spaceId === id);
    if ((members.length || jobs.length) && moveTo === undefined) {
      return res.status(409).json({
        error: "space_not_empty",
        message: `This space still holds ${members.length} chat(s) and ${jobs.length} job(s). Pass moveTo to move them first.`,
        chatCount: members.length,
        jobCount: jobs.length,
      });
    }
    const { moved } = emptySpace(id, moveTo ?? DEFAULT_SPACE_ID);
    for (const job of jobs) {
      const { spaceId: _drop, ...rest } = job.defaults ?? {};
      updateJob(job.id, { ...job, defaults: { ...rest, ...(moveTo && moveTo !== DEFAULT_SPACE_ID && { spaceId: moveTo }) } });
    }
    deleteSpaceRecord(id);
    notifySpacesChanged();
    res.json({ ok: true, movedChats: moved, movedJobs: jobs.length });
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
