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

8. **Redeploy production** (skip if in a worktree):

   If in a worktree, **skip this step** — production runs from the main working tree, not from worktrees.

   Otherwise, run detached so it survives if the server process dies mid-redeploy:

   ```
   nohup npm run redeploy:prod > /tmp/callboard-redeploy.log 2>&1 &
   ```

   Wait 3 seconds, then confirm PM2 restarted:

   ```
   sleep 3 && pm2 list && echo "--- Redeploy log ---" && cat /tmp/callboard-redeploy.log
   ```

## Important

- If any step fails, **stop immediately**, diagnose the issue, fix it, and restart from the failed step.
- The commit message should accurately describe the changes — do NOT use a generic message like "save and reboot".
- After the final step, if production was redeployed, confirm that the PM2 process is running with `pm2 list`.
- If in a worktree, the pipeline ends after pushing (and creating a PR if on a non-primary branch).
