#!/usr/bin/env node

// ── Published dependency check ───────────────────────────────────────
// The npm tarball ships `backend/dist` but NOT `backend/package.json`
// (see the root `files` list), so the ROOT `dependencies` block is the
// only manifest a global install ever reads. Anything imported by
// shipped runtime code must be declared there, or `callboard start`
// dies at import time with ERR_MODULE_NOT_FOUND — which is exactly how
// @agentclientprotocol/sdk shipped broken in 1.0.0-alpha.43.
//
// Two checks:
//   1. Every bare import in shipped runtime code is in root dependencies.
//   2. Ranges shared with backend/package.json don't drift apart.
// ─────────────────────────────────────────────────────────────────────

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Directories whose compiled output is published (root `files` entries).
const SHIPPED_ROOTS = ["backend/dist", "bin"];

// Mirrors the negations in root `files` — keep the two in sync.
const isExcluded = (path) =>
  /\.d\.ts$/.test(path) ||
  /\.test\.[cm]?js$/.test(path) ||
  /(^|\/)__fixtures__\//.test(path) ||
  /(^|\/)swagger\.js$/.test(path);

// Workspace-internal specifier: rewritten to a relative path at build time.
const INTERNAL = new Set(["shared"]);

const BUILTINS = new Set(builtinModules);

const IMPORT_RE =
  /(?:^|[;{}\n]\s*)(?:import|export)[^;\n]*?\bfrom\s*["']([^"'\n]+)["']|\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)|\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

/** Package name for a specifier: "@scope/pkg/sub" → "@scope/pkg", "pkg/sub" → "pkg". */
function packageName(specifier) {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

/** Map of package name → sorted list of shipped files importing it. */
function collectImports() {
  const found = new Map();

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return; // not built yet — reported by the caller
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "node_modules") walk(path);
        continue;
      }
      if (!/\.[cm]?js$/.test(path)) continue;
      const rel = relative(ROOT, path);
      if (isExcluded(rel)) continue;

      for (const match of readFileSync(path, "utf-8").matchAll(IMPORT_RE)) {
        const specifier = match[1] || match[2] || match[3];
        if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
        const name = packageName(specifier);
        if (BUILTINS.has(name) || INTERNAL.has(name)) continue;
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(rel);
      }
    }
  };

  for (const dir of SHIPPED_ROOTS) walk(join(ROOT, dir));
  return found;
}

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const backendPkg = JSON.parse(readFileSync(join(ROOT, "backend/package.json"), "utf-8"));
const declared = rootPkg.dependencies ?? {};
const backendDeps = backendPkg.dependencies ?? {};

const errors = [];

if (!readdirSync(join(ROOT, "backend")).includes("dist")) {
  console.error("backend/dist not found — run `npm run build` before checking published deps.");
  process.exit(1);
}

// ── 1. Undeclared runtime imports ────────────────────────────────────
const imports = collectImports();
const undeclared = [...imports.entries()].filter(([name]) => !declared[name]).sort(([a], [b]) => a.localeCompare(b));

for (const [name, files] of undeclared) {
  const hint = backendDeps[name] ? ` (backend/package.json has "${backendDeps[name]}")` : "";
  errors.push(`missing from root "dependencies": ${name}${hint}\n    imported by ${[...files].sort().join(", ")}`);
}

// ── 2. Range drift against the backend workspace ─────────────────────
for (const [name, range] of Object.entries(backendDeps)) {
  if (INTERNAL.has(name)) continue;
  if (declared[name] && declared[name] !== range) {
    errors.push(`version drift: ${name} is "${declared[name]}" at root but "${range}" in backend/package.json`);
  }
}

if (errors.length > 0) {
  console.error(`\nPublished dependency check failed (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n`);
  for (const error of errors) console.error(`  • ${error}\n`);
  console.error("The tarball ships backend/dist without backend/package.json, so root\n" + '"dependencies" must list everything shipped code imports.\n');
  process.exit(1);
}

console.log(`Published dependency check passed — ${imports.size} runtime imports, all declared.`);
