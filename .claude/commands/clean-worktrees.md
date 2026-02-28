---
name: clean-worktrees
description: Audit all git worktrees, identify stale ones with no changes older than 1 day, and interactively remove and prune them.
---

## Steps

1. **List all worktrees** for the current repository:

   ```
   git worktree list --porcelain
   ```

   Parse the output to get each worktree's path, branch, and HEAD commit. Ignore the **main working tree** (the first entry) — only consider secondary worktrees.

   If there are no secondary worktrees, inform the user and stop.

2. **Inspect each worktree** — for every secondary worktree, gather:

   a. **Age**: Check the creation/modification time of the worktree directory itself:
      ```
      stat -f "%m" <worktree-path>    # macOS
      ```
      or
      ```
      stat -c "%Y" <worktree-path>    # Linux
      ```
      Compare the timestamp to the current time. Mark the worktree as **stale** if it is older than 1 day (86400 seconds).

   b. **Uncommitted changes**: Check if there are any uncommitted modifications in the worktree:
      ```
      git -C <worktree-path> status --porcelain
      ```
      If the output is empty, the worktree has **no changes**. If there is output, note it has **uncommitted changes**.

   c. **Branch status**: Note the branch name and whether it has been merged into the primary branch (`main` or `master`):
      ```
      git branch --merged main
      ```

3. **Categorize worktrees** into three groups:

   - **Safe to delete**: Older than 1 day AND has no uncommitted changes
   - **Caution — has uncommitted changes**: Older than 1 day BUT has uncommitted changes (flag these with a warning)
   - **Recent — skipping**: Younger than 1 day (not candidates for deletion regardless of change status)

4. **Present a summary table** to the user showing all worktrees with:
   - Path
   - Branch name
   - Age (human-readable, e.g. "3 days ago")
   - Change status (clean / has uncommitted changes)
   - Recommended action (delete / warning / skip)

   Format the table clearly so the user can review it at a glance.

5. **Ask the user** using AskUserQuestion to confirm:
   - Present the list of worktrees recommended for deletion (the "safe to delete" group)
   - If any worktrees have uncommitted changes, warn the user and ask if those should also be included
   - Let the user confirm the final list, remove entries, or add entries before proceeding

6. **Delete confirmed worktrees** — for each worktree the user approved:

   ```
   git worktree remove <worktree-path>
   ```

   If removal fails (e.g. due to uncommitted changes), use `--force`:
   ```
   git worktree remove --force <worktree-path>
   ```

7. **Prune worktree metadata** — clean up any stale worktree tracking data:

   ```
   git worktree prune
   ```

8. **Verify** — list remaining worktrees and confirm cleanup:

   ```
   git worktree list
   ```

   Report how many worktrees were removed and what remains.

## Important

- **Never delete the main working tree** — only secondary worktrees are candidates.
- **Always warn about uncommitted changes** — do not silently delete worktrees that have modifications. The user must explicitly opt in.
- **The 1-day age threshold** protects recently created worktrees from accidental deletion — these are likely still in active use.
- If the user asks to adjust the age threshold, respect their preference for that run.
- If any `git worktree remove` command fails even with `--force`, report the error and continue with the remaining worktrees.
