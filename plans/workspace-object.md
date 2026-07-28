# Plan: workspace as a first-class object

Introduce a persisted **workspace** entity that owns "where work happens" — path, git
isolation, lifecycle — instead of deriving it from chat rows and filesystem archaeology.
Make worktrees reference-counted and actually removable.

Status: **Proposed.** Model observed in getpaseo/paseo (AGPLv3) — architecture only, no code
reuse.

---

## What callboard does today

There is no workspace object. There are chats with paths on them:

```ts
// shared/types/chat.ts
export interface Chat {
  /** The actual working directory (may be a worktree). Logs are stored under this path. */
  folder: string;
  /** Resolved main repo path for display/grouping (equals folder when not a worktree). */
  displayFolder?: string;
  is_git_repo?: boolean;
  git_branch?: string;
}
```

and a `FolderSummary` that is a **projection over chats**, not an object:

```ts
export interface FolderSummary {
  folder: string;
  mostRecentChatId: string;
  status: "ongoing" | "waiting" | "stopped";   // ← derived from the most recent chat
  isWorktree: boolean;                          // ← derived from the filesystem
  chatCount: number;
}
```

Everything about a folder is recomputed from whatever chats happen to reference it. The
consequences, all verifiable in the tree today:

**1. Worktrees are never removed.** Grepping `backend/src` and `frontend/src` for
`worktree remove|worktree prune|removeWorktree|deleteWorktree` returns **zero hits**. We
create worktrees and we never clean them up — not on chat delete, not on branch merge, not
ever. Every agent run with `useWorktree` leaks a directory permanently.

**2. Identity is filesystem archaeology.** `backend/src/utils/git.ts:135-195` determines
"is this a worktree?" by reading the `.git` *file*, parsing a `gitdir:` line, resolving it
relative, checking that the parent directory is literally named `worktrees`, then walking
up. It needs a TTL cache (`worktreeResolutionCache`, line 197) because the answer is
expensive and asked constantly. All of this would be one stored field.

**3. Nothing owns the branch/PR intent.** We know a chat's folder and can ask git for the
current branch. We don't know *why* the worktree exists — branched off `main`? checked out
someone's PR? — so we can't offer "this PR merged, clean up its worktree", and we can't
distinguish a worktree that's finished from one mid-flight.

**4. Two chats on the same folder are indistinguishable from one context.** There is no way
to express "two separate pieces of work in the same checkout" or to scope UI state to one of
them.

---

## The model being borrowed

Paseo's workspace (from `docs/architecture.md`, `public-docs/mcp.md`, `skills/paseo/SKILL.md`):

- A workspace is a persisted object with an **opaque `workspaceId`** — explicitly *not* a
  path. Their docs repeat "`workspaceId` is opaque; do not parse this key back into a path."
- `isolation: "local" | "worktree"`. Worktree mode takes
  `mode: "branch-off" | "checkout-branch" | "checkout-pr"` plus `branchName`/`baseBranch`,
  `branch`, or `prNumber` — the *intent* is stored, not just the result.
- Registries at `$PASEO_HOME/projects/projects.json` and `projects/workspaces.json`.
- **Reference counting:** "Paseo removes an owned worktree only after its final active
  workspace reference is archived." Archiving a workspace cascades to its agents and
  terminals; local directories are left alone; only *owned* worktrees are removed.
- Multiple workspaces may share one `cwd`, and that is a supported state, not a bug.

The last point comes with the sharpest idea in their architecture doc — the
**directory-backed vs workspace-owned** split:

| Keyed by `(serverId, cwd)` — shared | Keyed by `workspaceId` — private |
| --- | --- |
| git status, git diff, PR status | review draft comments |
| PR timeline | diff mode override |
| file preview content | composer attachments |
| file explorer listings | file explorer nav/expanded state |

Their doc adds: *"Do not 'fix' the sharing away."* Re-keying a directory-backed query by
workspace makes two views of the same git tree disagree; re-keying owned state by path leaks
drafts between workspaces. The rule is mechanical — the key *is* the boundary.

---

## Design

### The entity

```ts
export interface Workspace {
  id: string;                        // opaque; never parsed
  name: string;                      // user-visible, renameable
  cwd: string;                       // absolute path work happens in
  repoPath?: string;                 // main checkout when cwd is a worktree
  isolation: "local" | "worktree";
  worktree?: {
    owned: boolean;                  // did callboard create it? gates removal
    mode: "branch-off" | "checkout-branch" | "checkout-pr";
    branch: string;
    baseBranch?: string;
    prNumber?: number;
  };
  status: "active" | "archived";
  createdAt: string;
  archivedAt?: string;
}
```

Stored in `~/.callboard/workspaces/` alongside jobs and runs — same flat-file pattern the
codebase already uses, no new storage tech.

`owned` is the safety property that matters. A worktree we created is ours to remove; a
folder the user pointed us at is never touched. Same distinction paseo draws, and the same
one that makes automatic cleanup safe to ship.

> **Ownership on reuse — architect ruling, 2026-07-27.** `ensureWorktree` reuses an existing
> directory far more often than it creates one, and the spec did not say what `owned` should
> be then. Phase 1 resolves it conservatively: an existing *active* workspace for that `cwd`
> is adopted outright (so reuse can never downgrade `owned`), and only when no record exists
> does "did we just create it?" decide. **Never infer ownership.**
>
> The consequence is deliberate and needs stating: every worktree predating this entity
> records as `owned: false` and is therefore permanently unremovable by Phase 2. As of
> 2026-07-27 that is **41 leaked worktrees** in this repo alone (`git worktree list`) — the
> entire existing backlog, which Phase 2 will not touch.
>
> That is the right default and it stays. The backlog gets its own route: an
> **explicit, user-initiated adoption** step — "these N worktrees match callboard's creation
> pattern and have no unmerged work; adopt them for management?" — rather than silent
> inference. Offering is safe; guessing is not. The cleanliness check applies to adopted
> worktrees exactly as it does to owned ones.

> **Phase 2b — adoption, implemented 2026-07-28.** The ruling above, shipped. One distinction
> governs the whole of it:
>
> > **Pattern-matching may only ever be used to *offer*. It must never be used to *act*.**
>
> Callboard has used at least two naming conventions (`callboard-wt-chatcards` then
> `callboard.feat-…`), and the current one derives the directory from the branch name — so a
> renamed branch leaves a worktree Callboard really did create looking unfamiliar, and a user
> can produce either shape by hand in one command. The heuristic is wrong in both directions,
> which is why it lives in `utils/worktree-naming.ts`, is consumed only by the read-only
> `services/workspace-discovery.ts`, and is *not imported at all* by
> `services/workspace-adoption.ts` — the module that writes `owned: true`.
>
> - **Discovery** (`GET /api/workspaces/unmanaged`, `list_unmanaged_worktrees`) enumerates
>   registered worktrees with no active record and reports, per candidate: path, branch, disk
>   usage (`du -sk`; the motivating number), cleanliness from Phase 2's own
>   `checkWorktreeClean`, Phase 2's ignored-entry preview, the adoption refusal it would hit,
>   and the naming guess, labelled as one. It writes nothing.
> - **Adoption** (`POST /api/workspaces/adopt`, `adopt_worktrees`) takes **paths the caller
>   named**. There is no adopt-all and no filter: an agent lists, chooses, and names. It
>   deletes nothing and quarantines nothing — it writes the identity token and creates the
>   record, and removal stays a separate action behind every Phase 2 gate.
> - **`owned: true` now has exactly two writers**, and that is the invariant to defend:
>   `recordWorktreeWorkspace` ("this call ran `git worktree add`") and `adoptWorktrees`
>   ("a caller named this path"). A third would quietly redefine what the removal gate means.
> - **A record never outlives a failed token write.** The token's content *is* the record id,
>   so it cannot literally be written first; instead the record is created, the token written
>   and read back through the same verification the removal gate uses, and the record deleted
>   again on any failure. A record without a token looks managed and can never be cleaned up —
>   the worst outcome this phase could produce.
> - **Dirty worktrees are adopted, not refused.** Cleanliness gates *removal*, which Phase 2
>   already handles; refusing to manage work-in-progress would just leave it in the
>   unmanageable backlog forever. The state is reported (the `removability` verdict comes back
>   with the adoption) and Phase 2 still declines to touch it.
> - **Detached HEAD is refused** — not in the spec's refusal list, but a record requires a
>   branch and so does the quarantine's restore recipe (`git worktree add <path> <branch>`).
>   Inventing one from a sha would produce a record that cannot be restored from.

### Chat linkage

`Chat` gains `workspaceId?: string`. `folder`/`displayFolder` **stay** — they remain the
truth for log paths and for every chat that predates this. Reads prefer the workspace when
present and fall back to the path fields when absent. No migration is forced.

A lazy backfill is available: the first time a folder is opened, adopt-or-create a workspace
for it and stamp existing chats. Optional, and it can be a later phase.

### Reference-counted worktree removal

```
archiveWorkspace(id):
  cascade: interrupt/archive the workspace's chats
  mark archived
  if worktree?.owned:
    if no other active workspace has this cwd:
      if worktree is clean (no uncommitted changes, no unpushed commits):
        git worktree remove
      else:
        keep it, flag it in the UI as "has unmerged work"
```

The cleanliness check is ours to add, not borrowed — we should never silently destroy work,
and "the branch is merged" is not the same as "the directory is clean". Refusing to remove a
dirty worktree and surfacing it is strictly better than a `--force`.

> **Removal is quarantine, not deletion — architect ruling, 2026-07-27.** Supersedes the
> `git worktree remove` design above and the ignored-file allowlist I proposed before it.
>
> **What I got wrong.** Ignored files are invisible to `git status --porcelain` but are deleted
> by `git worktree remove` — a `.env` or local sqlite goes with the directory. I proposed
> refusing on ignored entries outside an allowlist of regenerables. Review implemented that
> proposal exactly and measured it against all 44 worktrees on this machine: **it refuses
> 44 of 44.** The feature would never remove anything. Causes, each sufficient alone:
> `.env` exists in every worktree with 34 distinct contents (it is per-worktree state, and it
> is precisely the file you must protect — so it can never be allowlisted); top-level
> collapsing turns `backend/node_modules/` into `backend`, a tracked source directory; and my
> claimed mechanism was backwards — **`--ignored=traditional` collapses, `--ignored=matching`
> expands**, one line per file for extension-based ignores.
>
> The deeper error: a refuse-by-default policy over ignored files is *unsatisfiable* on real
> repositories, and an unsatisfiable safety gate creates pressure to widen the allowlist or
> add `--force` later. That is how this phase's guarantees get dismantled.
>
> **The mechanism instead:**
> ```
> mv <worktree> ~/.callboard/trash/<workspaceId>-<timestamp>/   # content intact, incl. ignored
> git worktree prune                                            # unregisters; admin dir + token go
> # restore: git worktree add <path> <branch>
> ```
> Make removal **reversible** and the ignored-file question stops needing a policy at all. It
> also covers the unknown-unknowns an allowlist cannot enumerate — per-worktree reflogs,
> `refs/worktree/*`, detached-HEAD commits — and it sidesteps git's partial-destruction
> behaviour, where a failed `git worktree remove` has already deleted tracked files and the
> admin dir before exiting non-zero.
>
> The cleanliness gate stays. Refusing to quarantine work-in-progress is still right; the
> difference is that a mistake is now recoverable rather than terminal. Add a retention sweep,
> and require the trash directory to be on the same filesystem so the move is a real atomic
> rename rather than a copy-and-delete.

> **Implementation notes, 2026-07-27.** Two things the ruling above did not anticipate, both
> measured rather than reasoned:
>
> - **Submodules survive the `mv` and die on the `prune`.** A submodule initialised inside a
>   worktree keeps its object database in the worktree's admin dir
>   (`<repo>/.git/worktrees/<slug>/modules/<path>`), which `git worktree prune` deletes. A
>   commit made in that submodule was verified to become unreachable while its working files
>   sat intact in the trash — and the superproject can be perfectly clean at that moment. So
>   `has-submodules` is a blocker under quarantine too, not an inherited one. It fires on 0 of
>   the 44 worktrees here, so unlike the allowlist it is a gate that can actually be satisfied.
> - **`git worktree prune` can fail silently.** With a read-only admin dir it prints
>   `error: failed to delete ...` and still exits 0, leaving the worktree registered after its
>   directory has moved. The archive therefore re-inspects (directory, registration, admin dir,
>   token) after acting and reports `disposition: "partial"` rather than trusting an exit code.
>
> Restore, verified end to end: `git worktree add <path> <branch>` recreates the tracked
> checkout at the original path, then the untracked/ignored files are copied back out of the
> trash entry. Each entry carries a `.callboard-trash.json` manifest holding that recipe, the
> original path and the quarantine timestamp — the sweep reads its age from there, never from
> the directory's mtime, which `rename(2)` does not update.

This is also the hook for auto-cleanup on merge later; paseo has an `auto-archive-on-merge`
module. Out of scope for v1, but the ref-count is the thing that makes it possible.

### The keying rule, adopted verbatim in spirit

Write it into `CLAUDE.md` when the entity lands, because it is the part that's easy to get
wrong later and expensive to unpick:

- Anything the **directory** determines (git status, diff, file contents, branch list) keys
  on `cwd`. Two workspaces on one checkout see the same git state — that's correct.
- Anything the **workspace** owns (drafts, view state, attachments, per-context UI) keys on
  `workspaceId`.
- Don't collapse the two.

Callboard has less workspace-owned client state than paseo today, so the immediate payoff is
small — but adopting the rule before we accumulate that state is the entire point.

---

## Phases

**Phase 1 — entity + registry, additive only.** `Workspace` type, flat-file store, CRUD
service. `Chat.workspaceId` optional. Workspaces are created when a chat is started with
`useWorktree`, capturing the intent (`mode`, `branch`, `baseBranch`, `prNumber`) that today
is thrown away. Nothing reads from it yet. **Zero behavior change** — this phase is pure
groundwork and should be boring.

**Phase 2 — worktree lifecycle.** `owned` tracking, ref-counted archive, cleanliness check,
`git worktree remove`. This is the phase that fixes the leak, and it is the one with real
user value. Ship it close behind Phase 1.

**Phase 2b — adoption of the existing backlog.** Discovery of worktrees with no record
(read-only) and an explicit, path-named adoption that writes the identity token and an
`owned: true` record. No UI. See the ruling above for why pattern-matching only ever
offers.

**Phase 3 — reads move to the workspace.** `FolderSummary` becomes a projection over
*workspaces* rather than over chats. `isWorktree`/`repoPath` come from the record instead of
`git.ts:135`'s `.git`-file parsing; the resolution cache can go. Sidebar groups by workspace.

**Phase 4 — MCP + UI surface.** `create_workspace` / `list_workspaces` /
`archive_workspace` / `rename_workspace` agent tools. Workspace management UI. Explicit
multi-workspace-per-folder support.

---

## Non-goals

- A separate **project** entity above workspaces. Paseo has one
  (`projects/projects.json`, a daemon-global git observer). We don't need the extra layer at
  our scale; `repoPath` on the workspace covers grouping. Revisit if it starts hurting.
- Moving chat logs. They stay under `folder`. Storage paths derived from `cwd` are fine —
  paseo does the same thing deliberately and documents it.
- Terminals/scripts owned by a workspace. That's the Applications platform, and it should be
  designed against this entity once it exists — see below.
- Removing `folder`/`displayFolder`. They stay indefinitely.

## Risks

- **Two sources of truth during phases 1–3.** Chats have paths *and* an optional workspace.
  Mitigation: strict read precedence (workspace when present, path otherwise), never write
  both from different code paths, and keep the window short by not stalling Phase 3.
- **Destroying work.** The whole failure mode of automatic worktree removal. Mitigation:
  `owned` gate, cleanliness check, no `--force`, and surface-don't-delete when dirty.
- **Sidebar behavior change in Phase 3.** Grouping by workspace instead of by folder path is
  user-visible. Needs a real look at the multi-workspace-per-folder case before it ships.

## Open questions

1. Backfill existing chats, or leave them path-only forever? Leaning: lazy adopt-on-open,
   never a bulk migration.
2. Does an agent's home workspace (`~/.callboard/agent-workspaces/<alias>/`) become a
   `Workspace` record? It's the same concept and it would unify the sidebar — but it also
   drags agent identity into this scope. Probably yes, probably not in v1.
3. Ordering against the **Applications platform**. Paseo's `paseo.json` service scripts
   attach to a workspace and inherit its lifecycle; their service proxy derives hostnames
   from `<script>--<branch>--<project>`. If Applications is coming, this entity should land
   first so scripts have something to hang off. Worth reading their `docs/service-proxy.md`
   before designing that one.
4. Should `Workspace` carry the default provider/model for chats started in it? Natural
   home for it; adjacent to model routing; easy to add later.
