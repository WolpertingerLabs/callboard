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
import { join, relative, dirname, resolve } from "node:path";
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

/**
 * npm's package-name grammar, near enough: scope optional, lowercase, no path.
 * A second guard behind {@link blankComments} — a specifier that cannot name a
 * package cannot be a missing dependency, whatever it was written inside.
 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Package name for a specifier: "@scope/pkg/sub" → "@scope/pkg", "pkg/sub" → "pkg". */
function packageName(specifier) {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

/**
 * Replace every comment with equivalent whitespace, leaving offsets and line
 * breaks intact so {@link IMPORT_RE} still sees the statement boundaries it
 * anchors on.
 *
 * Why this is not optional: tsc emits JSDoc into the output it compiles, so a
 * doc comment explaining why the code does *not* `require("<pkg>/package.json")`
 * reads to a raw-text scan as a dependency on a package named `<pkg>`. That is
 * a publish blocked on prose. A comment naming a package that is genuinely
 * absent — `// we used to require("lodash")` — is the same bug wearing a name
 * that survives {@link PACKAGE_NAME_RE}.
 *
 * The scanner tracks strings, template literals and regex literals only so far
 * as it must to know where a comment can begin. Where a bare `/` is ambiguous
 * it resolves to division, which is the safe direction: mistaking a regex for
 * division scans a few literal characters as code and can at worst over-report,
 * while mistaking division for a regex would skip forward to the next `/` and
 * could swallow a real import. This check exists to catch a missing dependency
 * before npm does; it must never be the reason one gets through.
 */
export function blankComments(source) {
  let out = "";
  let i = 0;

  /** Whitespace of the same length, so offsets and line numbers do not move. */
  const blank = (text) => text.replace(/[^\n]/g, " ");

  /** Does a `/` here open a regex literal, or divide? Ambiguity resolves to divide. */
  const regexCanStartHere = () => {
    const before = out.replace(/\s+$/, "");
    if (before === "") return true;
    if ("(,=:[!&|?{};+-*%~^<>".includes(before[before.length - 1])) return true;
    return /\b(return|typeof|instanceof|in|of|do|else|case|void|delete|yield|await|new)$/.test(before);
  };

  /** Index just past a literal opened at `start` and closed by an unescaped `quote`. */
  const endOfLiteral = (start, quote) => {
    for (let j = start + 1; j < source.length; j++) {
      if (source[j] === "\\") {
        j++;
        continue;
      }
      // A regex's terminator cannot be on another line; an unterminated one is
      // a lexing error we do not need to model, so stop and treat it as text.
      if (quote === "/" && source[j] === "\n") return start + 1;
      if (source[j] === quote) return j + 1;
    }
    return source.length;
  };

  while (i < source.length) {
    const two = source.slice(i, i + 2);

    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }

    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // Template literals are copied whole, `${...}` included. An import inside
      // an interpolation is not a static specifier, and a comment inside one is
      // too rare to be worth a nesting stack.
      const stop = endOfLiteral(i, ch);
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && regexCanStartHere()) {
      const stop = endOfLiteral(i, "/");
      out += source.slice(i, stop);
      i = stop;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** Bare package names imported by `source`, comments and non-packages excluded. */
export function importedPackages(source) {
  const names = new Set();
  for (const match of blankComments(source).matchAll(IMPORT_RE)) {
    const specifier = match[1] || match[2] || match[3];
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
    const name = packageName(specifier);
    if (BUILTINS.has(name) || INTERNAL.has(name)) continue;
    if (!PACKAGE_NAME_RE.test(name)) continue;
    names.add(name);
  }
  return names;
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

      for (const name of importedPackages(readFileSync(path, "utf-8"))) {
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(rel);
      }
    }
  };

  for (const dir of SHIPPED_ROOTS) walk(join(ROOT, dir));
  return found;
}

function main() {
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
}

// Importing this file must not run the check or exit the process — the scanner
// above is unit-tested, and `backend/dist` need not even exist for that.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
