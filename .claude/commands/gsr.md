---
name: git-save-reboot
description: Run the full build, lint, format, commit, push, and redeploy pipeline. Stop immediately if any step fails.
---

## Steps

1. **Build** the project:

   ```
   npm run build
   ```

   Stop and fix any build errors before continuing.

2. **Lint** all files:

   ```
   npm run lint:all:fix
   ```

   Stop and fix any lint errors that could not be auto-fixed.

3. **Prettier** — format only touched (uncommitted) files:

   ```
   npm run prettier
   ```

4. **Git commit** — stage all changes (including any formatting/lint fixes from above) and commit with a descriptive message summarizing what changed:

   ```
   git add -A
   git commit -m "<descriptive message>"
   ```

5. **Detect branch and worktree context** before pushing:
   - Check if on a **non-primary branch** (i.e. not `main` or `master`):
     ```
     git branch --show-current
     ```
   - Check if in a **git worktree** (not the main working tree):
     ```
     git rev-parse --git-common-dir
     ```
     If the output of `git rev-parse --git-common-dir` differs from `git rev-parse --git-dir`, you are in a worktree.

6. **Git push**:

   ```
   git push
   ```

   If on a non-primary branch and pushing for the first time, use `git push -u origin <branch>`.

7. **Create PR** (only if on a non-primary branch):

   ```
   gh pr create --fill
   ```

   If a PR already exists for the branch, skip this step (check with `gh pr view` first).

8. **Install and restart production** (skip if in a worktree):

   If in a worktree, **skip this step** — production runs from the main working tree, not from worktrees.

   Otherwise, pack the build, install globally, and restart.
   Read the version from `package.json` to construct the tarball filename:

   ```
   npm pack --pack-destination /tmp
   ```

   ```
   npm install -g /tmp/wolpertingerlabs-callboard-<version>.tgz && rm /tmp/wolpertingerlabs-callboard-<version>.tgz
   ```

   (Replace `<version>` with the actual version from package.json, e.g. `1.0.0-alpha.1`)

   ```
   callboard restart
   ```

   Confirm the server is running:

   ```
   callboard status
   ```

9. **Offer worktree cleanup** (only if in a worktree):

   If in a worktree, ask the user if they would like to remove this worktree. Use `AskUserQuestion` with options:
   - **Yes, remove worktree** — remove the worktree directory.
   - **No, keep it** — leave the worktree in place for further work.

   If the user chooses to remove:
   1. Capture the current worktree path and branch name before leaving.
   2. Navigate out of the worktree to the main working tree:
      ```
      cd "$(git rev-parse --git-common-dir)/.."
      ```
   3. Remove the worktree:
      ```
      git worktree remove <worktree-path>
      ```

   If the user chooses to keep it, skip to step 10.

10. **Offer branch cleanup** (only if on a non-primary branch):

    If the current branch (or the branch that was just used, if the worktree was removed in step 9) is not `main` or `master`, ask the user if they would like to delete the local branch and switch back to the primary branch. Use `AskUserQuestion` with options:
    - **Yes, delete branch** — delete the local branch and switch to the primary branch.
    - **No, keep it** — leave the branch as-is.

    If the user chooses to delete:
    1. Switch to the primary branch (if not already there):
       ```
       git checkout <primary-branch>
       ```
    2. Delete the local branch:
       ```
       git branch -D <branch-name>
       ```

    If the user chooses to keep it, the pipeline is complete.

## Important

- If any step fails, **stop immediately**, diagnose the issue, fix it, and restart from the failed step.
- The commit message should accurately describe the changes — do NOT use a generic message like "save and reboot".
- After the final step, if production was restarted, confirm with `callboard status`.
- If in a worktree, the pipeline ends after pushing (and creating a PR if on a non-primary branch), then offers worktree and branch cleanup.
- If on a non-primary branch (without a worktree), the pipeline ends after production restart, then offers branch cleanup.
