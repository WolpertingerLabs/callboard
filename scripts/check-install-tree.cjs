#!/usr/bin/env node

/**
 * Install-tree integrity check.
 *
 * Walks an installed package's node_modules and verifies that every non-optional
 * `dependencies` entry of every package in the tree actually resolves, the way
 * Node resolves it: up the node_modules chain from the requiring package.
 *
 * Why this exists: `npm install` can report success and still leave holes. The
 * one that bit us — a tarball with `bundleDependencies` makes npm drop the whole
 * direct-dependency set of any *other* dependency that ships an
 * npm-shrinkwrap.json (@earendil-works/pi-coding-agent does), logging only
 * "invalid or damaged lockfile detected" at warn level. Nothing fails until a pi
 * chat is spawned days later and dies with ERR_MODULE_NOT_FOUND for chalk.
 *
 * `npm ls` is not a substitute: it reports unmet *optional* deps as plain
 * `missing` in `--json`, so a healthy tree and a broken one look alike.
 *
 * Usage:
 *   node scripts/check-install-tree.cjs                # the global callboard install
 *   node scripts/check-install-tree.cjs <package-dir>  # any installed package
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PKG_NAME = "@wolpertingerlabs/callboard";

/** Directory of the globally installed callboard, or null if it isn't installed. */
function globalPackageDir() {
  let root;
  try {
    root = execSync("npm root -g", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
  const dir = path.join(root, ...PKG_NAME.split("/"));
  return fs.existsSync(dir) ? dir : null;
}

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Every package directory under `dir`/node_modules, including nested node_modules. */
function childPackageDirs(dir) {
  const nm = path.join(dir, "node_modules");
  let entries;
  try {
    entries = fs.readdirSync(nm, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of fs.readdirSync(path.join(nm, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory() || scoped.isSymbolicLink()) dirs.push(path.join(nm, entry.name, scoped.name));
      }
    } else {
      dirs.push(path.join(nm, entry.name));
    }
  }
  return dirs;
}

/**
 * Resolve `name` from `fromDir` the way Node does — up the node_modules chain.
 * Returns the installed version, or null if nothing resolves.
 */
function resolveVersion(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...name.split("/"));
    const pkg = readPkg(candidate);
    if (pkg) return pkg.version ?? "unknown";
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Optional: semver lets us also catch a dep that resolves to the *wrong* version,
// which is the other half of a mis-reified tree. It is a dev-tree transitive, not
// a declared dependency, so its absence downgrades the check rather than failing it.
let semver = null;
try {
  semver = require("semver");
} catch {
  // version checks skipped
}

/** Ranges npm resolves from somewhere other than the registry — version comparison is meaningless. */
const isNonRegistryRange = (range) => /^(file:|link:|git|github:|https?:|workspace:|npm:)/.test(range);

function main() {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : globalPackageDir();
  if (!target) {
    console.error(`Install-tree check: ${PKG_NAME} is not installed globally — nothing to check.`);
    process.exit(1);
  }

  const rootPkg = readPkg(target);
  if (!rootPkg) {
    console.error(`Install-tree check: no package.json at ${target}`);
    process.exit(1);
  }

  const missing = [];
  const mismatched = [];
  let checked = 0;
  const seen = new Set();
  const queue = [target];

  while (queue.length > 0) {
    const dir = queue.pop();
    const real = fs.realpathSync(dir);
    if (seen.has(real)) continue;
    seen.add(real);

    const pkg = readPkg(dir);
    if (pkg) {
      checked++;
      const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
      for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
        if (optional.has(name)) continue;
        const where = { name, required: range, by: `${pkg.name}@${pkg.version}`, at: path.relative(target, dir) || "." };
        const found = resolveVersion(name, dir);
        if (found === null) {
          missing.push(where);
        } else if (semver && !isNonRegistryRange(range) && semver.validRange(range) && !semver.satisfies(found, range)) {
          mismatched.push({ ...where, found });
        }
      }
    }
    queue.push(...childPackageDirs(dir));
  }

  if (missing.length > 0 || mismatched.length > 0) {
    console.error(
      `\nInstall-tree check FAILED — ${missing.length + mismatched.length} broken dependenc${missing.length + mismatched.length === 1 ? "y" : "ies"} in ${target}:\n`,
    );
    for (const m of missing) {
      console.error(`  • unresolvable: ${m.name}@${m.required} required by ${m.by} (${m.at})`);
    }
    for (const m of mismatched) {
      console.error(`  • wrong version: ${m.name}@${m.found} resolved where ${m.by} wants ${m.required} (${m.at})`);
    }
    console.error(
      "\nThe install reported success but the tree has holes, so the code that\n" +
        "imports these packages will die at runtime — ERR_MODULE_NOT_FOUND for a\n" +
        "missing one, or something stranger for a wrong-version one.\n" +
        `Recover with:  npm uninstall -g ${PKG_NAME} && npm run reload\n` +
        "If it recurs, check for bundleDependencies in the packed manifest — see\n" +
        "the header of scripts/check-install-tree.cjs.\n",
    );
    process.exit(1);
  }

  const versions = semver ? "" : " (version checks skipped — semver not resolvable)";
  console.log(`Install-tree check passed — ${checked} packages, every non-optional dependency resolves${versions}.`);
}

main();
