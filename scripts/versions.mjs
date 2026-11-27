#!/usr/bin/env node

// ── One version for the whole repo ───────────────────────────────────
// The root package.json's `version` is the only version anyone edits. Every
// versioned workspace (drawlatch, computer-use) carries the same number, and
// callboard pins drawlatch exactly at it, so a release names one version for
// everything it was built and tested with.
//
//   npm version <v>                       at the root: npm bumps package.json and
//                                         the root lockfile entries, then runs the
//                                         `version` lifecycle script, which is this
//                                         file. The root .npmrc (git-tag-version=false)
//                                         stops npm from committing or tagging.
//   npm run version:sync                  the same, after a hand edit of the root version
//   npm run version:check                 report drift only (exit 1 on any)
//   node scripts/versions.mjs --lock-only refresh package-lock.json without node_modules
//
// What the version is written into (the one list, shared by the sync and the
// check so they can't disagree):
//   - `version` of every workspace manifest that has one (never added to a
//     private workspace that has none)
//   - every dependency on a versioned workspace package that isn't "*", in any
//     manifest: today the two exact drawlatch pins (package.json, backend)
//   - packages/computer-use/docker/package-lock.json (its own lockfile, which
//     the Dockerfile's `npm ci` uses)
//   - package-lock.json, through `npm install`
//
// Never `npm version -w <pkg>` or `--workspaces`: the first fails with
// ETARGET (it resolves the still-old pins against the registry), the second
// also adds a `version` to every private workspace. `deps:check` runs
// versionDriftErrors, so a missed sync fails CI with the fix in the message.
//
// Node built-ins only: release-plan.mjs imports this before `npm ci`.
// ─────────────────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DRAWLATCH = "@wolpertingerlabs/drawlatch";
/** The exact drawlatch pins: [manifest path, its package-lock.json `packages` key]. */
export const DRAWLATCH_PINS = [
  ["package.json", ""],
  ["backend/package.json", "backend"],
];
/** computer-use's standalone lockfile, used by `npm ci` in its Dockerfile. */
export const DOCKER_LOCK = "packages/computer-use/docker/package-lock.json";
export const DEP_BLOCKS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** A semver version (not a range). The groups are major, minor, patch and the prerelease. */
export const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const FIX = "Run `npm run version:sync`.";
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Everything the check needs, read from disk. Pure data out; the tests build it from fixtures instead. */
export function readVersionState(root = ROOT) {
  const rootPkg = readJson(join(root, "package.json"));
  const manifests = { "package.json": rootPkg };
  const workspaces = [];
  for (const dir of rootPkg.workspaces ?? []) {
    if (/[*?{[]/.test(dir)) throw new Error(`package.json workspaces: "${dir}" is a glob; scripts/versions.mjs only knows explicit directories`);
    const path = `${dir}/package.json`;
    const pkg = readJson(join(root, path));
    manifests[path] = pkg;
    workspaces.push({ dir, name: pkg.name, private: pkg.private === true, version: pkg.version });
  }
  return {
    version: rootPkg.version,
    workspaces,
    manifests,
    lock: existsSync(join(root, "package-lock.json")) ? readJson(join(root, "package-lock.json")) : undefined,
    dockerLock: existsSync(join(root, DOCKER_LOCK)) ? readJson(join(root, DOCKER_LOCK)) : undefined,
  };
}

/** Every way the repo disagrees with the root version, as messages that end with the fix. Pure. */
export function versionDriftErrors(state) {
  const { version, workspaces, manifests, lock, dockerLock } = state;
  if (typeof version !== "string" || !SEMVER_RE.test(version))
    return [`package.json "version" is ${JSON.stringify(version)}, which isn't a semver version. Set it with \`npm version <version>\` at the root.`];
  const errors = [];
  const differs = (where, actual) => errors.push(`${where} is ${JSON.stringify(actual ?? null)}, but the root version is "${version}". ${FIX}`);

  // 1. Every versioned workspace, and every published one, carries the root version.
  for (const ws of workspaces) {
    if (ws.version === undefined) {
      if (!ws.private) errors.push(`${ws.dir}/package.json (${ws.name}) is not private but has no "version"; give it the root version "${version}". ${FIX}`);
    } else if (ws.version !== version) differs(`${ws.dir}/package.json "version"`, ws.version);
  }
  const versioned = new Set(workspaces.filter((ws) => ws.version !== undefined || !ws.private).map((ws) => ws.name));

  // 2. The drawlatch pins exist and are exact.
  for (const [path] of DRAWLATCH_PINS) {
    const pin = manifests[path]?.dependencies?.[DRAWLATCH];
    if (pin === undefined) errors.push(`${path} does not depend on ${DRAWLATCH}; pin it exactly at "${version}". ${FIX}`);
    else if (pin !== version) differs(`${path} dependencies["${DRAWLATCH}"]`, pin);
  }

  // 3. Any other dependency on a versioned workspace package is "*" or the root version.
  const pinned = new Set(DRAWLATCH_PINS.map(([path]) => `${path}\0dependencies\0${DRAWLATCH}`));
  for (const [path, pkg] of Object.entries(manifests))
    for (const block of DEP_BLOCKS)
      for (const [name, spec] of Object.entries(pkg?.[block] ?? {}))
        if (versioned.has(name) && !pinned.has(`${path}\0${block}\0${name}`) && spec !== "*" && spec !== version)
          errors.push(
            `${path} ${block}["${name}"] is ${JSON.stringify(spec)}; a workspace package must be "*" or exactly the root version "${version}". ${FIX}`,
          );

  // 4. The root lockfile agrees (manifests edited without `npm install`).
  if (!lock) errors.push(`package-lock.json is missing. ${FIX}`);
  else {
    const packages = lock.packages ?? {};
    if (lock.version !== version) differs(`package-lock.json "version"`, lock.version);
    if (packages[""]?.version !== version) differs(`package-lock.json packages[""].version`, packages[""]?.version);
    for (const ws of workspaces)
      if (ws.version !== undefined && packages[ws.dir]?.version !== version)
        differs(`package-lock.json packages["${ws.dir}"].version`, packages[ws.dir]?.version);
    for (const [path, key] of DRAWLATCH_PINS) {
      if (manifests[path]?.dependencies?.[DRAWLATCH] === undefined) continue; // reported above
      const pin = packages[key]?.dependencies?.[DRAWLATCH];
      if (pin !== version) differs(`package-lock.json packages["${key}"].dependencies["${DRAWLATCH}"]`, pin);
    }
  }

  // 5. computer-use's own lockfile (the Dockerfile's `npm ci`).
  if (!dockerLock) errors.push(`${DOCKER_LOCK} is missing.`);
  else {
    if (dockerLock.version !== version) differs(`${DOCKER_LOCK} "version"`, dockerLock.version);
    if (dockerLock.packages?.[""]?.version !== version) differs(`${DOCKER_LOCK} packages[""].version`, dockerLock.packages?.[""]?.version);
  }
  return errors;
}

/**
 * Writes the root version everywhere it belongs (only files whose content
 * changes), then refreshes package-lock.json: `"install"` runs `npm install
 * --ignore-scripts` (which also refreshes node_modules/.package-lock.json, so
 * `npm run reload` doesn't see install drift), `"lock-only"` adds
 * `--package-lock-only`, `"none"` skips it (tests).
 */
export function syncVersions(root = ROOT, { lockfile = "install", log = () => {} } = {}) {
  const state = readVersionState(root);
  const { version } = state;
  if (typeof version !== "string" || !SEMVER_RE.test(version))
    throw new Error(`package.json "version" is ${JSON.stringify(version)}, which isn't a semver version`);
  const versioned = new Set(state.workspaces.filter((ws) => ws.version !== undefined || !ws.private).map((ws) => ws.name));
  const changed = [];
  const save = (path, text) => {
    writeFileSync(join(root, path), text);
    changed.push(path);
  };

  // A file is rewritten only when a field in it changes: JSON.stringify isn't
  // byte-identical for every manifest (shared/package.json's arrays), so an
  // untouched file is never re-serialized.
  for (const [path, pkg] of Object.entries(state.manifests)) {
    let dirty = false;
    const set = (obj, key) => {
      if (obj[key] !== version) [obj[key], dirty] = [version, true];
    };
    // npm already wrote the root version; only the root's dependencies can need it.
    if (path !== "package.json" && pkg.version !== undefined) set(pkg, "version");
    for (const block of DEP_BLOCKS) for (const [name, spec] of Object.entries(pkg[block] ?? {})) if (versioned.has(name) && spec !== "*") set(pkg[block], name);
    if (dirty) save(path, writeJson(pkg));
  }

  if (state.dockerLock) {
    const lock = state.dockerLock;
    if (lock.version !== version || (lock.packages?.[""] && lock.packages[""].version !== version)) {
      lock.version = version;
      if (lock.packages?.[""]) lock.packages[""].version = version;
      save(DOCKER_LOCK, writeJson(lock));
    }
  }

  if (lockfile !== "none") {
    const before = readFileSync(join(root, "package-lock.json"), "utf8");
    const args = ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...(lockfile === "lock-only" ? ["--package-lock-only"] : [])];
    log(`npm ${args.join(" ")}`);
    execFileSync("npm", args, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    if (readFileSync(join(root, "package-lock.json"), "utf8") !== before) changed.push("package-lock.json");
  }
  return { version, changed, errors: versionDriftErrors(readVersionState(root)) };
}

function main(argv) {
  const at = argv.indexOf("--root");
  const root = at === -1 ? ROOT : resolve(argv[at + 1]);
  if (argv.includes("--check")) {
    const errors = versionDriftErrors(readVersionState(root));
    if (errors.length) {
      console.error(`Version drift (${errors.length}):\n${errors.map((e) => `  • ${e}`).join("\n")}`);
      process.exit(1);
    }
    console.log(`Every package, pin and lockfile is at ${readVersionState(root).version}.`);
    return;
  }
  const { version, changed, errors } = syncVersions(root, { lockfile: argv.includes("--lock-only") ? "lock-only" : "install", log: (m) => console.log(m) });
  console.log(changed.length ? `Synced ${version} into ${changed.join(", ")}.` : `Everything is already at ${version}.`);
  if (errors.length) {
    console.error(`Still out of step after the sync:\n${errors.map((e) => `  • ${e}`).join("\n")}`);
    process.exit(1);
  }
}

// Importing this file must not run anything: the tests and the other scripts import it.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
