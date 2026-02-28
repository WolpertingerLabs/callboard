---
name: clean-local-branches
description: Audit all local git branches, identify stale ones with no unpushed work, and interactively delete them.
---

## Steps

1. **Identify the primary branch** for this repository:

   ```
   git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'
   ```

   If that fails, fall back to whichever of `main` or `master` exists locally. Store this as `PRIMARY_BRANCH`.

2. **Get the current branch** so it can be excluded from deletion:

   ```
   git branch --show-current
   ```

   Store this as `CURRENT_BRANCH`. It must never be deleted.

3. **List all local branches**:

   ```
   git branch --format='%(refname:short)'
   ```

   Exclude `PRIMARY_BRANCH` and `CURRENT_BRANCH` from further analysis — they are never candidates for deletion.

   If there are no other branches, inform the user and stop.

4. **Fetch latest remote state** so tracking comparisons are accurate:

   ```
   git fetch --prune
   ```

5. **Inspect each candidate branch** — for every branch, gather:

   a. **Merged status**: Has the branch been merged into the primary branch?
      ```
      git branch --merged <PRIMARY_BRANCH> --format='%(refname:short)'
      ```
      If the branch appears in this list, it is **merged**.

   b. **Remote tracking status**: Does the branch have a remote counterpart that still exists?
      ```
      git rev-parse --verify origin/<branch> 2>/dev/null
      ```
      If this fails, the remote branch is **gone** (already deleted on the remote).

   c. **Unpushed commits**: Are there local commits not yet pushed to the remote?
      ```
      git log origin/<branch>..<branch> --oneline 2>/dev/null
      ```
      If there is output, the branch has **unpushed commits**. If the remote branch doesn't exist, treat ALL local commits (since divergence from the primary branch) as unpushed:
      ```
      git log <PRIMARY_BRANCH>..<branch> --oneline
      ```

   d. **Uncommitted changes**: Check if the branch's tip has a dirty state stashed or if a worktree is using it. This is primarily relevant if the branch is checked out in a worktree — detect with:
      ```
      git worktree list --porcelain
      ```
      If any worktree is on this branch, flag it as **in use by a worktree**.

   e. **Last commit date**: How old is the branch's latest commit?
      ```
      git log -1 --format='%ci' <branch>
      ```

6. **Categorize branches** into groups:

   - **Safe to delete**: Merged into primary branch AND no unpushed commits AND not in use by a worktree
   - **Remote deleted, but merged**: Remote branch is gone AND branch is merged (safe, but call it out)
   - **Caution — has unpushed work**: Branch has unpushed commits (either unmerged work or commits ahead of remote). Flag these with a warning and list the unpushed commit subjects
   - **In use — skipping**: Branch is checked out in a worktree (cannot be deleted without removing the worktree first)

7. **Present a summary table** to the user showing all candidate branches with:
   - Branch name
   - Merged status (merged / unmerged)
   - Remote status (tracking / remote gone)
   - Unpushed commits (count and short subjects if any)
   - Last commit date (human-readable, e.g. "3 weeks ago")
   - Recommended action (delete / warning / skip)

   Format the table clearly so the user can review at a glance.

8. **Ask the user** using AskUserQuestion to confirm:
   - Present the list of branches recommended for deletion (the "safe to delete" group)
   - If any branches have unpushed work, warn clearly and ask if those should also be included
   - Let the user confirm the final list, remove entries, or add entries before proceeding

9. **Delete confirmed branches** — for each branch the user approved:

   For merged / safe branches:
   ```
   git branch -d <branch>
   ```

   For unmerged branches the user explicitly approved:
   ```
   git branch -D <branch>
   ```

10. **Verify** — list remaining branches and confirm cleanup:

    ```
    git branch -a
    ```

    Report how many branches were removed, how many remain, and whether any remote-tracking refs were pruned by the earlier `git fetch --prune`.

## Important

- **Never delete the primary branch** (`main` / `master`) or the **currently checked-out branch**.
- **Never delete a branch checked out in a worktree** — tell the user to use `/clean-worktrees` first if they want to remove those.
- **Always warn about unpushed commits** — show the commit subjects so the user can make an informed decision. Do not silently discard work.
- **Use `git branch -d` (lowercase)** for safe deletes; only escalate to `git branch -D` (uppercase) when the user explicitly confirms deletion of an unmerged branch.
- If a branch delete fails for any reason, report the error and continue with the remaining branches.
