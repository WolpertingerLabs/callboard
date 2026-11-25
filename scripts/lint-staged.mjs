#!/usr/bin/env node

// ── Lint staged files ────────────────────────────────────────────────
// `npm run lint` / `lint:fix` (used as the pre-commit check in workflows).
//
// Two configs, because ESLint 9 flat config only reads the config in its cwd:
//   - callboard files → the root eslint.config.js, from the repo root.
//   - packages/drawlatch/src files → drawlatch's own typed config, from
//     packages/drawlatch. That is exactly what drawlatch's `lint` script
//     (`eslint src/`) covers; its typed project (tsconfig.eslint.json) only
//     includes src/, so its frontend and bin are not linted, as before.
// Other drawlatch files are ignored by the root config and skipped here.
//
// No staged files for a side → that side does nothing. Deleted files are not
// passed on (eslint errors on a path that does not exist).
// ─────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRAWLATCH_DIR = "packages/drawlatch/";
const DRAWLATCH_SRC = "packages/drawlatch/src/";
const LINTABLE = /\.(js|jsx|ts|tsx)$/;

/**
 * Split staged paths (repo-relative, forward slashes) into the root's files and
 * drawlatch's files, the latter relative to packages/drawlatch.
 */
export function partitionStaged(paths) {
  const root = [];
  const drawlatch = [];
  for (const path of paths) {
    if (!LINTABLE.test(path)) continue;
    if (path.startsWith(DRAWLATCH_SRC)) drawlatch.push(path.slice(DRAWLATCH_DIR.length));
    else if (!path.startsWith(DRAWLATCH_DIR)) root.push(path);
  }
  return { root, drawlatch };
}

function stagedPaths() {
  const out = execFileSync("git", ["diff", "--name-only", "--cached", "--diff-filter=d", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function eslint(cwd, files, fix) {
  const args = ["eslint", "--no-warn-ignored", ...(fix ? ["--fix"] : []), "--", ...files];
  try {
    execFileSync("npx", args, { cwd, stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const fix = process.argv.includes("--fix");
  const { root, drawlatch } = partitionStaged(stagedPaths());
  let ok = true;
  if (root.length > 0) ok = eslint(ROOT, root, fix) && ok;
  if (drawlatch.length > 0) ok = eslint(join(ROOT, DRAWLATCH_DIR), drawlatch, fix) && ok;
  if (!ok) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
