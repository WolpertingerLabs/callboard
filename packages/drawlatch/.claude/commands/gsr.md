---
name: git-save-reboot
description: Run the full build, lint, format, commit, push, and redeploy pipeline. Stop immediately if any step fails.
---

## Steps

1. **Build:** `npm run build` (TypeScript, connection templates, dashboard). Fix any errors before continuing.

2. **Lint:** `npm run lint:fix` (ESLint on `src/`). Fix anything it could not auto-fix.

3. **Format:** `npm run format` (Prettier on `src/**/*.ts` and root `*.json`/`*.ts`/`*.js`; markdown is not covered).

4. **Commit** everything, including lint and format fixes, with a message that describes the change:

   ```
   git add -A
   git commit -m "<descriptive message>"
   ```

5. **Detect context:**
   - Branch: `git branch --show-current`. Anything other than `main`/`master` is a feature branch.
   - Worktree: you are in one if `git rev-parse --git-common-dir` differs from `git rev-parse --git-dir`.

6. **Push:** `git push`, or `git push -u origin <branch>` on a branch's first push.

7. **Open a PR** (feature branches only): `gh pr create --fill`. Skip this if `gh pr view` shows one already exists.

8. **Reinstall and restart production** (main working tree only; skip in a worktree):

   ```
   npm pack --pack-destination /tmp
   npm install -g /tmp/wolpertingerlabs-drawlatch-<version>.tgz && rm /tmp/wolpertingerlabs-drawlatch-<version>.tgz
   drawlatch restart
   drawlatch status
   ```

   `<version>` is the `version` field in `package.json` (for example, `1.0.0-alpha.61`). `npm run reload` does the same, with an extra install and build first.

## Rules

- If a step fails, stop, fix it, and resume from that step.
- Don't use a generic commit message like "save and reboot".
- In a worktree, the pipeline ends after the push (and the PR, on a feature branch).
