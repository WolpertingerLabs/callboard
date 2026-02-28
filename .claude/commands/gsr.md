---
name: git-save-reboot
description: Run the full build, lint, format, commit, push, and redeploy pipeline. Stop immediately if any step fails.
---

## Arguments

`$ARGUMENTS`

- If the arguments contain `install-deps`, run step 1 (Install dev dependencies). Otherwise, **skip step 1** entirely.

## Steps

1. **Install dev dependencies** (only if `install-deps` is passed):

   ```
   npm install --include=dev
   ```

   Stop and fix any installation errors before continuing.

2. **Build** the project:

   ```
   npm run build
   ```

   Stop and fix any build errors before continuing.

3. **Lint** all files:

   ```
   npm run lint:all:fix
   ```

   Stop and fix any lint errors that could not be auto-fixed.

4. **Prettier** — format only touched (uncommitted) files:

   ```
   npm run prettier
   ```

5. **Git commit** — stage all changes (including any formatting/lint fixes from above) and commit with a descriptive message summarizing what changed:

   ```
   git add -A
   git commit -m "<descriptive message>"
   ```

6. **Detect branch and worktree context** before pushing:
   - Check if on a **non-primary branch** (i.e. not `main` or `master`):
     ```
     git branch --show-current
     ```
   - Check if in a **git worktree** (not the main working tree):
     ```
     git rev-parse --git-common-dir
     ```
     If the output of `git rev-parse --git-common-dir` differs from `git rev-parse --git-dir`, you are in a worktree.

7. **Git push**:

   ```
   git push
   ```

   If on a non-primary branch and pushing for the first time, use `git push -u origin <branch>`.

8. **Create PR** (only if on a non-primary branch):

   ```
   gh pr create --fill
   ```

   If a PR already exists for the branch, skip this step (check with `gh pr view` first).

9. **Install and restart production** (skip if in a worktree):

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

## Important

- If any step fails, **stop immediately**, diagnose the issue, fix it, and restart from the failed step.
- The commit message should accurately describe the changes — do NOT use a generic message like "save and reboot".
- After the final step, if production was restarted, confirm with `callboard status`.
- If in a worktree, the pipeline ends after pushing (and creating a PR if on a non-primary branch).
