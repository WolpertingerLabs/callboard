/**
 * Workspace tools — the agent-facing half of the worktree lifecycle.
 *
 *   list_workspaces           — every workspace, with whether its worktree can
 *                               be removed and every reason it cannot
 *   archive_workspace         — archive one, cascading to its chats and
 *                               removing the worktree only when all gates pass
 *   list_unmanaged_worktrees  — read-only: worktrees with no workspace record,
 *                               the adoption candidates
 *   adopt_worktrees           — bring specific NAMED worktrees under management
 *   create_workspace          — a LOCAL record for an existing directory
 *   rename_workspace          — relabel a record; nothing on disk moves
 *
 * Still no delete, and — importantly — **no bulk cleanup**. `adopt_worktrees`
 * takes paths, never a filter and never an "adopt everything that looks like
 * ours": an agent lists, chooses, and names, which keeps the decision explicit
 * at every step. The naming heuristic in the listing is a labelled guess for
 * the reader; adoption does not consult it.
 *
 * The two Phase 4b tools are narrower than their names read, and the narrowness
 * is the design. `create_workspace` writes local records only — it takes no
 * isolation, no worktree block and no ownership flag, so it cannot become the
 * third writer of `owned: true`, and it refuses a worktree directory rather
 * than doing adoption's job without adoption's gates (services/
 * workspace-create.ts has the full argument). `rename_workspace` changes a
 * label on a record; no path is derived from a workspace name anywhere.
 *
 * @see plans/workspace-object.md — Phases 2, 2b and 4
 */
import { z } from "zod";
import { defineTool } from "../agents/ports/tools.js";
import type { AnyToolDefinition } from "../agents/ports/tools.js";
import { adoptWorktrees } from "./workspace-adoption.js";
import { createLocalWorkspace } from "./workspace-create.js";
import { listUnmanagedWorktrees } from "./workspace-discovery.js";
import { archiveWorkspace, listWorkspacesWithRemovability } from "./workspace-service.js";
import { renameWorkspace } from "./workspace-store.js";
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
        "intent that created it). Each entry carries a removability verdict: whether archiving it would quarantine its worktree, and " +
        "every reason it would not (not created by Callboard, still referenced by another workspace, a session still running in it, " +
        "submodules, uncommitted changes, untracked files, commits that exist on no other branch or remote). For a removable one, " +
        "`removability.ignored` previews the gitignored entries that would move with it. Use this before archive_workspace to see what " +
        "will actually happen. " +
        "Each entry also carries `directory`, observed fresh on every call: `present`, `missing` (nothing at that path) or " +
        "`not-a-worktree` (the directory is there but is no longer a git worktree of the recorded repo). Records outlive their " +
        "directories — nothing reaps them — so `missing` is common and is NOT a reason to archive on your own initiative: a directory " +
        "that is absent is not proof the work is gone (an unmounted volume looks identical). Report what you see and let the user " +
        "decide; archive_workspace is theirs to ask for.",
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
      "Archive a workspace: interrupt and archive its chats, mark the workspace archived, and quarantine its git worktree — but only " +
        "when Callboard created that worktree, its identity token still verifies, no other active workspace shares the directory, no " +
        "session is running in it, it has no submodules, and it is clean (no uncommitted changes, no untracked files, no commits " +
        "reachable from no other ref). Quarantine MOVES the directory to ~/.callboard/trash rather than deleting it — gitignored files " +
        "(.env, local databases) travel with it intact, and it can be restored with `git worktree add <path> <branch>` plus copying " +
        'those files back. `worktree.disposition` is "quarantined", "kept" (nothing was touched) or "partial" (acted on and now ' +
        "inconsistent — `worktree.state` says what was found). A worktree is never force-removed and a local (non-worktree) directory " +
        "is never removed at all; when a gate refuses, the reasons come back as `worktree.blockers`. Archiving is not deleting: chat " +
        "records and their logs stay.",
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

    // ── Adoption (Phase 2b) ─────────────────────────────────────────
    // Worktrees that predate the workspace entity have no record, so the
    // lifecycle above can do nothing with them. These two close that gap
    // without loosening a gate: one lists, one acts on names.

    defineTool(
      "list_unmanaged_worktrees",
      "List the git worktrees of a repository that Callboard has NO workspace record for — the candidates for adopt_worktrees. Purely " +
        "read-only: it creates no records, writes nothing, and changes nothing on disk. Each entry reports the path (pass this to " +
        "adopt_worktrees), the branch, disk usage in bytes (the reason this exists — leaked worktrees are gigabytes), `cleanliness` from " +
        "the same check that gates removal (uncommitted changes, untracked files, commits reachable from no other ref), `ignored` — the " +
        "gitignored entries such as .env that would travel into the trash if it were ever archived — and `adoptable`/`adoptionBlockers`, " +
        "so a refusal is visible before you try. " +
        "`naming` is a HEURISTIC and nothing more: whether the path looks like one of Callboard's worktree naming conventions. Callboard " +
        "has used more than one convention and a user can create either by hand, so it is a hint for a human reading the list — never a " +
        "reason to adopt. Adoption does not read it. Do not use it to decide anything on your own; if you are choosing what to adopt, " +
        "cleanliness, disk usage and the branch are the real signals, and the user's instruction is the only authority.",
      {
        repoPath: z.string().describe("The repository: its main checkout, or any worktree of it (both resolve to the same repo)"),
        includeDiskUsage: z.boolean().optional().describe("Measure disk usage per worktree. Default true; the slow part, so pass false for a quick listing."),
      },
      async (args) => {
        try {
          return ok({ ...(await listUnmanagedWorktrees(args.repoPath, { includeDiskUsage: args.includeDiskUsage !== false })) });
        } catch (e: any) {
          log.error(`list_unmanaged_worktrees failed: ${e.message}`);
          return err(`Failed to list unmanaged worktrees: ${e.message}`);
        }
      },
    ),

    defineTool(
      "adopt_worktrees",
      "Bring the worktrees at the given paths under Callboard management: write Callboard's identity token into each one's git admin " +
        "directory and create an owned workspace record with the branch and repository git actually reports. " +
        "ADOPTION DELETES NOTHING AND QUARANTINES NOTHING. It only makes a worktree *eligible* to be archived later, through " +
        "archive_workspace and every gate that already applies there. Adopting a worktree with uncommitted work is fine and expected — " +
        "the record is created and archive_workspace still refuses to remove it; the returned `removability` shows exactly that. " +
        "You must name the paths. There is no adopt-all and no pattern filter: list with list_unmanaged_worktrees, decide, then pass " +
        "the specific paths — and only ones the user has asked for. A path is refused if it is not a registered worktree of its " +
        "repository, if it is the main checkout, if it already has an active workspace record (so repeating the call is safe), if its " +
        "HEAD is detached, or if its git admin directory cannot be resolved (no identity token could be written there, and a record " +
        "without one could never be acted on). Each path is independent: `outcomes` says what happened to each, with `refusal.code` and " +
        "a readable `refusal.detail` for the ones that were not adopted.",
      {
        paths: z
          .array(z.string())
          .min(1)
          .describe("Absolute paths of the worktrees to adopt — from list_unmanaged_worktrees. Named explicitly, never inferred."),
      },
      async (args) => {
        try {
          return ok({ ...adoptWorktrees(args.paths) });
        } catch (e: any) {
          log.error(`adopt_worktrees failed: ${e.message}`);
          return err(`Failed to adopt worktrees: ${e.message}`);
        }
      },
    ),

    // ── Create and rename (Phase 4b) ────────────────────────────────
    // Both are deliberately small. Creation cannot mint ownership and cannot
    // stand in for adoption; rename cannot move anything.

    defineTool(
      "create_workspace",
      "Create a Callboard workspace record for an existing directory: a named entry for 'where work happens', so the directory has an identity in the " +
        "workspace list and the sidebar instead of being just a path on some chats. " +
        "THIS CREATES NOTHING ON DISK. No directory is made, no git worktree is added, no branch is touched, and the record can never mark a directory as " +
        "owned by Callboard — records made here carry no worktree block at all, so the flag that gates worktree removal does not exist on them. " +
        "A directory that is ALREADY A GIT WORKTREE is refused (`is-a-worktree`): use adopt_worktrees for those. That is not a formality — adoption writes " +
        "the identity token that makes a worktree removable later and checks that git still registers the path, and a record created here would carry " +
        "neither while still making the worktree permanently unadoptable, because adoption refuses any directory that already has an active record. " +
        "To get a worktree in the first place, start a chat with useWorktree; that path records one properly. " +
        "Several workspaces may share one directory — that is supported, not a bug — so this does not refuse a directory that already has a record; the " +
        "existing ones come back as `sharedWith`. Note that a directory with more than one record shows the directory's own name in the sidebar rather than " +
        "any record's, since no single record identifies the row.",
      {
        cwd: z.string().describe("Absolute path of the existing directory. It must exist, and must not be a git worktree."),
        name: z.string().optional().describe("Label for the workspace. Defaults to the directory's last path segment — which is what the sidebar shows anyway."),
      },
      async (args) => {
        try {
          const result = createLocalWorkspace({ cwd: args.cwd, ...(args.name !== undefined && { name: args.name }) });
          if (!result.created) return err(result.refusal?.detail ?? `Could not create a workspace for ${args.cwd}`);
          return ok({ ...result });
        } catch (e: any) {
          log.error(`create_workspace failed: ${e.message}`);
          return err(`Failed to create workspace: ${e.message}`);
        }
      },
    ),

    defineTool(
      "rename_workspace",
      "Rename a workspace record — change its label, and only its label. " +
        "NOTHING ON DISK MOVES. A workspace name is not the directory, not the branch and not the worktree path, and no path is ever derived from it: " +
        "`cwd`, `repoPath` and the branch are what every path-producing operation reads. Renaming will not move a directory, will not rename a git branch " +
        "and will not affect where a chat's logs are written. " +
        "The name must be 1–200 characters and may not contain control or text-direction characters, because it is rendered in lists and written to log " +
        "lines. Archived workspaces can be renamed too. " +
        "Where the name is visible: the workspace list, and — when exactly one active record claims a directory — that directory's row in the sidebar. A " +
        "directory claimed by several records keeps showing its own name, because no single record identifies the row.",
      {
        workspaceId: z.string().describe("Workspace id (opaque — from list_workspaces; never a path)"),
        name: z.string().describe("The new label. 1–200 characters, no control or text-direction characters."),
      },
      async (args) => {
        try {
          const workspace = renameWorkspace(args.workspaceId, args.name);
          if (!workspace) return err(`Workspace "${args.workspaceId}" not found — use list_workspaces to see available ids`);
          return ok({ workspace });
        } catch (e: any) {
          // The store throws only on an unusable name; that sentence is the
          // answer the caller needs, so it is returned rather than logged as a
          // failure of the tool.
          return err(e.message);
        }
      },
    ),
  ];
}
