/**
 * Workspace tools — the agent-facing half of the Phase 2 lifecycle.
 *
 *   list_workspaces    — every workspace, with whether its worktree can be
 *                        removed and every reason it cannot
 *   archive_workspace  — archive one, cascading to its chats and removing the
 *                        worktree only when all the gates pass
 *
 * Two tools, on purpose. There is no create, no rename, no delete and no bulk
 * cleanup: workspaces are still written only when a chat starts in a worktree,
 * and nothing here may adopt a worktree Callboard did not create.
 *
 * @see plans/workspace-object.md — Phase 2
 */
import { z } from "zod";
import { defineTool } from "../agents/ports/tools.js";
import type { AnyToolDefinition } from "../agents/ports/tools.js";
import { archiveWorkspace, listWorkspacesWithRemovability } from "./workspace-service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-tools");

function ok(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

export function buildWorkspaceTools(): AnyToolDefinition[] {
  return [
    defineTool(
      "list_workspaces",
      "List Callboard workspaces — the persisted record of where work happens (a directory, and for a git worktree the branch and the " +
        "intent that created it). Each entry carries a removability verdict: whether archiving it would remove its worktree, and every " +
        "reason it would not (not created by Callboard, still referenced by another workspace, uncommitted changes, untracked files, " +
        "commits that exist on no other branch or remote). Use this before archive_workspace to see what will actually happen.",
      {
        status: z.enum(["active", "archived", "all"]).optional().describe('Filter by status. Default: "active".'),
      },
      async (args) => {
        try {
          const status = args.status ?? "active";
          const workspaces = listWorkspacesWithRemovability(status === "all" ? undefined : { status });
          return ok({ workspaces });
        } catch (e: any) {
          log.error(`list_workspaces failed: ${e.message}`);
          return err(`Failed to list workspaces: ${e.message}`);
        }
      },
    ),

    defineTool(
      "archive_workspace",
      "Archive a workspace: interrupt and archive its chats, mark the workspace archived, and remove its git worktree — but only when " +
        "Callboard created that worktree, its identity token still verifies, no other active workspace shares the directory, and it is " +
        "clean (no uncommitted changes, no untracked files, no commits reachable from no other ref). A worktree is never force-removed " +
        "and a local (non-worktree) directory is never removed at all; when a gate refuses, the directory is kept and the reasons are " +
        "returned as `worktree.blockers`. Archiving is not deleting: chat records and their logs stay.",
      {
        workspaceId: z.string().describe("Workspace id (opaque — from list_workspaces; never a path)"),
      },
      async (args) => {
        try {
          const result = await archiveWorkspace(args.workspaceId);
          if (!result) return err(`Workspace "${args.workspaceId}" not found — use list_workspaces to see available ids`);
          return ok({ ...result });
        } catch (e: any) {
          log.error(`archive_workspace failed: ${e.message}`);
          return err(`Failed to archive workspace: ${e.message}`);
        }
      },
    ),
  ];
}
