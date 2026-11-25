# Drawlatch in the callboard monorepo

Design record for moving drawlatch from `WolpertingerLabs/drawlatch` into callboard as the `packages/drawlatch` npm workspace.

## Import

- **Full-history `git subtree add`** of drawlatch `main` at `36e1b597abe50598497de47a974b6ed7d3ee8815` (merge `911f37ab`). The merge's `packages/drawlatch` tree is byte-identical to `36e1b597^{tree}` (`88291c84…`) and it changes nothing outside `packages/drawlatch`. All later changes are separate integration commits.
- Why full history rather than squashed or a copy: `git blame` follows into drawlatch's history, and drawlatch branches can be brought over with `git merge -X subtree=packages/drawlatch`, because the histories are shared. A squash saves nothing (433 commits, ~4 MB, already public).
- `git log -- packages/drawlatch/<file>` stops at the import; use `git log 911f37ab^2 -- <path without prefix>`.
- PRs containing the import must be merged with a merge commit. Squash flattens the history; rebase-merge (or rebasing locally) replays drawlatch's commits at the repo root.

## Workspace

- Root `workspaces` lists both `packages/drawlatch` and `packages/drawlatch/frontend` (npm ignores a workspace's own `workspaces`). drawlatch's own scripts are unchanged: from its directory, `npm -w frontend` resolves to `packages/drawlatch/frontend`.
- `packages/drawlatch/package-lock.json` is removed; the root lock covers it.
- On install npm runs drawlatch's `prepare` (its build) and then the root `prepare`, so drawlatch builds twice. Accepted: standalone and git installs rely on its `prepare`.

## Versioning: independent numbers, exact lockstep pin

Root and backend pin `@wolpertingerlabs/drawlatch` exactly to `packages/drawlatch/package.json` `version`. `check-published-deps.mjs` enforces it (`drawlatchLockstepErrors`). Equal version numbers were rejected: they would force empty releases of one package whenever the other ships.

## Dependency conflicts

- Express 4 (callboard) vs 5 (drawlatch), and `express-rate-limit` 7 vs 8: separate copies, no problem.
- `@types/cookie-parser` has a `@types/express: "*"` peer. Deduped to the root, it resolves to callboard's `@types/express@4` and drawlatch's `tsc` fails. `overrides` do not help. Fix: root and backend devDependencies pin `@types/cookie-parser@1.4.9`, so drawlatch's `^1.4.10` nests under `packages/drawlatch/node_modules` beside `@types/express@5`. Removed by the Express 5 migration (follow-up).
- The root `zod` override forces drawlatch's zod to 4.5.2 in the workspace; drawlatch's tests pass and the published package is unaffected.
- The hoisted `typescript-eslint` 8.61 flagged 22 `no-unnecessary-type-assertion` errors in drawlatch. They were fixed in their own commit; emitted JS is unchanged apart from comments.

## Lint, format, tests

- drawlatch keeps its own eslint config (run from its directory via `lint:drawlatch`) and its own `.prettierrc`. The root eslint and vitest configs ignore `packages/drawlatch/**`.
- Prettier run from the root resolves `packages/drawlatch/.prettierrc` for every drawlatch file, but drawlatch's `format` script only ever covered `src/**/*.ts` and its top-level `*.{json,ts,js}`. Its frontend (double-quoted), connection templates, fixtures, `bin/` and editor config were never formatted, and the root `prettier` script, lint-staged and format-on-save would have rewritten them. The root `.prettierignore` excludes those paths, so callboard tooling formats exactly what drawlatch's `format` does.
- `test:drawlatch` runs in `npm test` / `test:coverage`; e2e (`test:drawlatch:e2e`) stays manual, as before.
- drawlatch's `.github/workflows` were removed (they don't run from a subdirectory). CI gains `lint:drawlatch` and `deps:check` steps.

## Scripts

- `drawlatch-switch.cjs` and `drawlatch:*` scripts are gone; the workspace link replaces them.
- `scripts/reload.cjs` (`reload`, `reload:local`, `reload:prod`): `local` packs the workspace drawlatch and packs callboard against it through a `file:` dependency that exists only for that one `npm pack`; `prod` fails if the pinned version isn't on npm. `--prefix` installs into a scratch prefix without restarting.
- drawlatch's `release:gh` script (`scripts/release-gh.mjs`) was removed. Inside callboard, `gh release create v<drawlatch-version>` would create releases and tags in the callboard repo under callboard's bare `v<ver>` tag scheme. The publish workflow replaces it.

## Published package

- drawlatch's tarball has the same file list as one packed from the standalone repo, except the frontend asset hash (the monorepo lock resolves a newer `react-router-dom` patch).
- Its `package.json` differs in `repository` (now callboard, `directory: packages/drawlatch`, which npm provenance requires) and the removed `release:gh` script.
- Callboard's own tarball file list is unchanged.

## Follow-ups

- Publish workflow (`.github/workflows/publish.yml`) with tags `v<ver>` (callboard) and `drawlatch-v<ver>` (drawlatch), plus npm trusted-publisher setup for both packages.
- Freeze and archive the standalone drawlatch repo; migrate its open branches and PRs (`git merge -X subtree=packages/drawlatch`), and transfer its issues.
- Migrate callboard to Express 5 and drop the `@types/cookie-parser` placement pin.
