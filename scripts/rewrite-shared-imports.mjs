// Rewrites bare `shared` / `shared/types/*` import specifiers in the compiled
// backend output to relative paths into `shared/dist`.
//
// Why: `shared` is a private workspace package. In the dev checkout it resolves
// via the `node_modules/shared` workspace symlink plus its `exports` map. But
// npm cannot bundle workspace packages (they are symlinks, not real installs),
// so a published/global install has no `node_modules/shared` and crashes at
// boot with `ERR_MODULE_NOT_FOUND: Cannot find package 'shared'`.
//
// Rewriting the bare specifiers to relative paths makes the published tarball
// self-contained (it already ships `shared/dist` at the package root via the
// `files` field). The relative paths also resolve in the dev checkout, where
// `shared/dist` sits at the repo root, so `node backend/dist/index.js` keeps
// working there too.
//
// The mapping mirrors shared/package.json "exports":
//   "."            -> ./dist/index.js
//   "./types/*.js" -> ./dist/*.js
//
// Run automatically as the root `postbuild` step. Idempotent: once a specifier
// is relative it no longer matches, so re-running is a no-op.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendDist = join(repoRoot, 'backend', 'dist');
const sharedDist = join(repoRoot, 'shared', 'dist');

// Resolve a bare `shared` specifier to its absolute target under shared/dist.
function targetFor(spec) {
  if (spec === 'shared') return join(sharedDist, 'index.js');
  const m = spec.match(/^shared\/types\/(.+)$/);
  if (m) return join(sharedDist, m[1]);
  return null;
}

// Match the specifier only in import/export/dynamic-import position so plain
// string literals like "shared" are never touched.
const SPEC_RE = /((?:\bfrom|\bimport)\s*\(?\s*)(['"])(shared(?:\/[^'"]*)?)\2/g;

function toRel(fromFile, targetAbs) {
  let rel = relative(dirname(fromFile), targetAbs).split('\\').join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

let changedFiles = 0;
let changedSpecs = 0;

function rewriteFile(file) {
  const src = readFileSync(file, 'utf8');
  let touched = false;
  const out = src.replace(SPEC_RE, (whole, prefix, quote, spec) => {
    const target = targetFor(spec);
    if (!target) return whole;
    touched = true;
    changedSpecs++;
    return `${prefix}${quote}${toRel(file, target)}${quote}`;
  });
  if (touched) {
    writeFileSync(file, out);
    changedFiles++;
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (entry.endsWith('.js') || entry.endsWith('.d.ts')) rewriteFile(p);
  }
}

walk(backendDist);
console.log(
  `[rewrite-shared-imports] rewrote ${changedSpecs} specifier(s) across ${changedFiles} file(s)`,
);
