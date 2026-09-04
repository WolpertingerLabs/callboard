# Plan: one worktree control, and a box that says what it will do

Replace the `Auto-create` + `Worktree` checkbox pair in `BranchSelector` with a single
sticky **New worktree** toggle, an always-visible branch-name field where empty means
"generate one", and a one-line summary that states in plain words what the current
selection will do.

Status: **Approved, not started.** Branch `refactor/auto-create-worktree`.

---

## Why the current control is wrong

Three widgets encode two decisions, and one of them is not a decision at all.

`autoCreateBranch` does not gate a capability. It gates a Haiku call —
`generateBranchName` (`backend/src/services/quick-completion.ts:343`), which already
validates the `<type>/<kebab>` structure, scrubs to git-safe characters, caps at 60
chars and returns `null` on anything malformed. The checkbox is an opt-in to a default,
not a choice between two behaviours.

Worse, the two boxes are coupled in the direction nobody predicts:
`worktreeEnabled` (`frontend/src/components/BranchSelector.tsx:45`) is true only when
there is a branch change pending, and **checking `Auto-create` is one of the three
things that enables the `Worktree` checkbox**. So the box you want is disabled until you
check a different box whose name does not mention worktrees.

And in every state, the box tells you nothing about what will happen. The only feedback
is a path preview, rendered only when `worktreeEnabled && useWorktree && !autoCreateBranch`
(`BranchSelector.tsx:328`) — i.e. never in the state we are about to make most common.

---

## What the user gets

Two controls and a sentence:

```
[ base branch ▾ ] / [ branch name (auto) ......... ]   [x] New worktree

Will create a new worktree off `main`, on a branch named from your first message.
```

The toggle **defaults off** and is **sticky** — it restores the last choice made on this
browser. The name field is never sticky and never hidden; empty means "generate one".

### Every state, and the sentence it renders

| Toggle | Name field | Base | Emitted `BranchConfig` | Summary line |
|---|---|---|---|---|
| on | empty | `main` | `{useWorktree, autoCreateBranch, baseBranch}` | Will create a new worktree off `main`, on a branch named from your first message. |
| on | `feat/x` | `main` | `{useWorktree, baseBranch, newBranch}` | Will create `callboard.feat-x` on new branch `feat/x`, off `main`. |
| off | empty | unchanged | `{}` | Runs here on `main`. No branch or worktree change. |
| off | empty | `feat/y` | `{baseBranch}` | Will switch this checkout to `feat/y`. |
| off | empty | `feat/y` *(checked out elsewhere)* | `{baseBranch}` | `feat/y` is checked out at `callboard.feat-y` — the chat will run there. This checkout is untouched. |
| off | `feat/x` | `main` | `{baseBranch, newBranch}` | Will create branch `feat/x` off `main` in this checkout. |

The fifth row is the one worth building this for. It is today's behaviour
(`switchBranch` finds the branch in another worktree and returns that path,
`backend/src/utils/git.ts:681-686`), it is completely silent, and it is symmetric: start
a chat *in* `callboard.feat-a`, pick `main`, and the chat runs in the main checkout. The
only existing signal is `folder !== displayFolder` on the resulting chat
(`frontend/src/pages/Chat.tsx:2526`) — after the fact.

### What is deliberately removed

Today `Auto-create` checked with `Worktree` unchecked generates a name and creates that
branch **in place** in your working checkout. Under "empty means auto only when the
toggle is on", that mode is gone. This is intentional: inventing a branch name and
switching the user's checkout onto it is more invasive than making a worktree, and it is
not what anyone reaches for the sparkles icon to get. Typing a name with the toggle off
still creates a branch in place.

---

## What does not change

- **`BranchConfig.autoCreateBranch` stays the wire flag** (`shared/types/git.ts`). Do not
  infer generation from `useWorktree && !newBranch` — that pair already means "check out
  this *existing* branch in a worktree" (`resolveBranch`'s `checkout-branch` mode, pinned
  by `backend/src/utils/git.worktree.test.ts:75`, and what `start_chat_session` sends).
  The UI simply always sets `autoCreateBranch` when the toggle is on and the field is
  empty. Backend semantics move zero millimetres.
- **The off-state emits exactly what it emits today**, so the redirect behaviour above is
  preserved verbatim. We are describing it, not changing it.
- **`start_chat_session` stays opt-in** (`backend/src/services/callboard-tools.ts:823-825`).
  Agent-spawned children each minting a worktree is the failure mode "always" would
  actually cause.
- `shared/types/stream.ts` is untouched, so the wire-surface snapshot is not in play.
  The REST body gains no field; `autoCreateBranch` keeps its meaning.

---

## Phase 1 — backend correctness (own PR, lands first)

**Status: landed** — `c30aa9e`, `437285c`, `f346a2e`, `2c534ad`. See "Landed" below for
the four ways it differs from what is written here.

All four are live bugs today. They are prerequisites for making auto-naming ordinary,
which is why they go first and alone.

**1.1 Unique auto-generated names.** `ensureWorktreeDetailed` (`git.ts:585`) deliberately
reuses an existing directory or an already-checked-out branch. That is right for a name
you typed and wrong for one we invented: two chats that both generate
`fix/login-redirect` silently share one worktree and one branch. Add to `utils/git.ts`:

```ts
export function uniqueBranchName(repoDir: string, candidate: string): string
```

checking `getGitBranches` (`:444`), `getGitWorktrees` (`:498`) and `existsSync` of the
derived sibling path, suffixing `-2`, `-3`… to a cap (20, then fall through to the
timestamp fallback below). The path check is the one that catches `feat/a-b` vs
`feat/a/b`, which `sanitizeBranchForPath` collapses onto the same directory. Call it in
`stream.ts` immediately after `generateBranchName` (`:126`) — **only on the generated
path**, so a typed name keeps today's reuse semantics (`git.worktree.test.ts:34`).

**1.2 A generation failure must not land in the main checkout.** `stream.ts:130-135` logs
a warning and proceeds with no `newBranch`. With `useWorktree` set and `baseBranch`
present, `resolveBranch` then reaches `ensureWorktreeDetailed:607-614`, finds the base
branch already checked out in the main worktree, and returns **the main checkout**. The
user asked for isolation and silently got none. Replace with a deterministic
`chat/<yyyymmdd>-<6 hex>` run through `uniqueBranchName`. Extract as an exported helper
so it is testable without the route (`stream.new-message.test.ts` stubs `sendMessage` and
cannot see git).

**1.3 A typed name that already exists is a 500.** `resolveBranch:1083` passes
`createBranch = !!newBranch`, so `ensureWorktreeDetailed` runs `git worktree add -b`. If
the branch exists but is checked out nowhere, neither reuse path in `:594-614` fires and
git refuses:

```
$ git worktree add -b feat/exists ../repo.feat-exists main
Preparing worktree (new branch 'feat/exists')
fatal: a branch named 'feat/exists' already exists
```

*(verified against a throwaway repo, 2026-09-03)*

Fix in `ensureWorktreeDetailed`: when `createBranch` is true and the branch already
exists, drop `-b` and check it out into the new worktree instead.

**1.4 Ignore `branchConfig` outside a git repo.** `branchConfig` will now ride on nearly
every new chat. The UI gate (`info?.is_git_repo`, `Chat.tsx:3416`) stays the first line of
defence, but make `resolveBranch` a no-op on a non-repo folder rather than letting
`git worktree add` throw a 500 out of the route.

**Tests** — `git.worktree.test.ts`, against real throwaway repos as the file already does:

- generated name collides with an existing branch → `-2`
- generated name collides only via the sanitized *path* → `-2`
- typed name still reuses an existing worktree (regression guard on 1.1)
- typed name for an existing, unchecked-out branch → worktree created, no throw (1.3)
- `useWorktree` with a null generated name never resolves to the main checkout (1.2)

### Landed

Four departures from the text above, all of them deliberate:

- **A fourth signal for "taken".** The three checks named in 1.1 are not exhaustive:
  `getGitBranches` is `git branch --list`, local refs only, so a generated `feat/x` that
  exists solely as `origin/feat/x` reads as free and `git worktree add -b` happily mints
  an unrelated local branch — verified exit 0 on a real repo — with the collision
  surfacing at push time. `uniqueBranchName` now also consults
  `git for-each-ref --format=%(refname:strip=3) refs/remotes/`, one subprocess for all
  candidates, with `origin/HEAD` filtered out (a symref to the remote's default branch,
  which would otherwise make `main` look permanently taken). Generated names only — a
  typed name that matches a remote branch is the user's call to make.

- **A fifth bug, found by fixing 1.1.** The `-b`-on-an-existing-branch failure in 1.3 has
  an in-place twin: without a worktree, a generated name that already exists reaches
  `switchBranch(…, createNew: true)` → `git checkout -b x` → the same `fatal: a branch
  named 'x' already exists`. This is why uniquification is unconditional while the
  stamped fallback is gated on `useWorktree`: the fallback keeps an isolation promise
  that only exists on the worktree path, but the collision it would paper over exists on
  both.

- **`branchCreated` is now distinct from `created`.** `created` is about the directory;
  `branchCreated` is about the ref. `resolveBranch` derives `mode` and the presence of
  `baseBranch` from the latter, so a 1.3 resolution no longer records `branch-off` from a
  base it never branched from. Side effect: pre-existing *reuse* paths carrying a
  `newBranch` also flip `branch-off` → `checkout-branch`. Checked before accepting —
  `mode` is written to workspace records and read by nothing; removability gates on
  `repoPath` and `not-a-worktree-on-disk`.

- **Known limitation: `uniqueBranchName` is check-then-act.** Generation, the uniqueness
  check and `git worktree add` are three separate moments, so two chats generating the
  same name at the same instant both see it free and the second silently reuses the
  first's worktree. Bounded in practice: only this route generates names
  (`start_chat_session` never sets `autoCreateBranch`) and the Phase 3 toggle defaults
  off, so it takes two tabs racing in one repo. The fix, if it ever bites, is to stop
  asking and let creation arbitrate — attempt `git worktree add -b`, and on
  "already exists" / "is already checked out" retry with the next suffix. Not done here:
  it rewrites the reuse semantics every other caller depends on.

---

## Phase 2 — the branches endpoint learns about worktrees

The summary line's fifth row needs to know where a branch is checked out. `GET
/git/branches` returns `{ branches: string[] }` (`backend/src/routes/git.ts:37`).

Add an optional sibling field — additive, so an older bundle ignores it:

```ts
{ branches: string[], checkedOut?: { branch: string; path: string; isMainWorktree: boolean }[] }
```

sourced from `getGitWorktrees(folder)`, whose `WorktreeInfo` (`git.ts:487`) already
carries exactly these fields. Update `getGitBranches` in `frontend/src/api.ts:715` and
the swagger block.

---

## Phase 3 — rebuild `BranchSelector`

**Storage.** New key `worktreeByDefault`, default `false`, in
`frontend/src/utils/localStorage.ts`. Do not reuse `useWorktree` (`:362`): under the old
gated semantics a stored `true` meant "checked while a branch change was pending" and did
nothing on a no-change chat. Leave `useWorktree` and `autoCreateBranch` in the stored
type, unread, so an older bundle in another tab still parses. Their accessors
(`:362-382`) become dead and go.

**Component.** Delete the `autoCreateBranch` state (`:39`), its toggle (`:214-239`), the
`worktreeEnabled` computation (`:45`) and every disabled/`title`/opacity branch that hung
off it (`:247-263`, `:132`, `:172-190`). `propagateChange` (`:68-95`) collapses to the
state table above. The name input is always rendered and always enabled.

**Summary line.** Always visible, replacing the conditional path preview (`:328-342`).
Renders the sentence for the current state; muted, one line, wraps to two on mobile.
Uses `basename` of the derived path rather than the absolute path — the full path was
mostly noise and forced `wordBreak: "break-all"`.

**Chat.tsx.** The send-time guard (`:1868`) keeps working unchanged, since the toggle-on
path still sets `autoCreateBranch` or `newBranch`. No other caller of `branchConfig`
exists (`rg branchConfig` → `stream.ts`, `Chat.tsx`).

**Tests** — new `frontend/src/components/BranchSelector.test.tsx` (there are none today):
the six emitted configs from the state table, the sticky toggle round-tripping through
localStorage, and the checked-out-elsewhere sentence rendering from a stubbed
`checkedOut`.

---

## Phase 4 — the dirty guard asks the wrong directory (independent)

Pre-existing, unrelated to this refactor, worth its own small PR.

`resolveBranch:1067-1070` runs the uncommitted-changes check against `folder` — the
checkout you are starting from. But when the target branch lives in another worktree,
`switchBranch` returns that path and `folder` is never touched. So uncommitted changes in
your current checkout can 409 a chat that was never going to disturb them.

Fix: hoist `switchBranch`'s worktree lookup ahead of the dirty check and skip the guard
when it hits.

---

## Risks and follow-ups

- **Accumulation.** Even opt-in, worktrees outlive their chats. Removal exists
  (`utils/worktree-trash.ts`, `archive_workspace`) but is user- or agent-initiated and
  nothing reaps. Default-off keeps this at today's rate; the natural follow-up is an
  offer to clean up when the branch merges.
- **Cold worktrees.** No `node_modules`. The first test run in a fresh worktree pays an
  install. Unchanged by this plan, more visible if the toggle gets used more.
- **Latency.** `generateBranchName` sits in the request path before the stream opens,
  for toggle-on chats only. Accepted.
- **Real name preview.** `POST /git/generate-branch-name` exists
  (`routes/git.ts:143`) and its client wrapper `generateGitBranchName`
  (`frontend/src/api.ts:721`) is **currently called from nowhere**. It could give the
  summary line the actual branch name and path instead of "named from your first
  message", at the cost of a Haiku call on prompt blur. Out of scope for v1; either wire
  it up later or delete the dead wrapper.
- **Per-repo stickiness.** One global preference may be too blunt — some checkouts you
  always want isolated, others never. The storage helpers are flat key-value today;
  revisit only if the single toggle actually annoys.
