#!/usr/bin/env node

/**
 * Reload script that rebuilds callboard locally and global-installs it,
 * with two drawlatch sourcing modes.
 *
 * Usage:
 *   node scripts/drawlatch-reload.cjs local   (default)
 *   node scripts/drawlatch-reload.cjs prod
 *
 * ── local ─────────────────────────────────────────────────────────────
 * Builds drawlatch from the sibling ../drawlatch checkout, packs it, points
 * callboard at that tarball, and adds bundleDependencies so the local
 * drawlatch is embedded in callboard's global tarball.
 *
 * Problem this solves: `npm install -g <tarball>` resolves dependencies from
 * npm. If drawlatch points to a local file: path or an unpublished version,
 * the global install fails — so we bundle it.
 *
 * Requires the ../drawlatch sibling directory to exist.
 *
 * ── prod ──────────────────────────────────────────────────────────────
 * Leaves drawlatch as a published semver range so the global install pulls
 * it from the npm registry. Does NOT build or bundle local drawlatch. If the
 * working tree currently points drawlatch at a local file: path, it is
 * temporarily pinned to `^<../drawlatch version>` for the build (and restored
 * afterward); if no ../drawlatch checkout exists to read a version from, it
 * errors and asks you to run `npm run drawlatch:prod` first.
 *
 * Both modes restore your package.json files exactly as they were on exit.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DRAWLATCH_DIR = path.resolve(ROOT, "../drawlatch");
const PKG = "@wolpertingerlabs/drawlatch";

const mode = process.argv[2] || "local";
if (mode !== "local" && mode !== "prod") {
  console.error(`Usage: node scripts/drawlatch-reload.cjs <local|prod>\n  Unknown mode: ${mode}`);
  process.exit(1);
}

function readPkg(relPath) {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, relPath), "utf8"));
}

function writePkg(relPath, obj) {
  fs.writeFileSync(path.resolve(ROOT, relPath), JSON.stringify(obj, null, 2) + "\n");
}

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

/** Read drawlatch's own version from the sibling checkout, or null if absent. */
function getDrawlatchVersion() {
  const pkgPath = path.resolve(DRAWLATCH_DIR, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
}

// Snapshot original package.json contents so we can restore exactly
const origRoot = fs.readFileSync(path.resolve(ROOT, "package.json"), "utf8");
const origBackend = fs.readFileSync(path.resolve(ROOT, "backend/package.json"), "utf8");

console.log(`=== callboard reload (mode: ${mode}) ===`);

let dlTgz = null;

try {
  if (mode === "local") {
    // 1. Build & pack drawlatch from the sibling checkout
    if (!fs.existsSync(DRAWLATCH_DIR)) {
      console.error(`Error: local mode needs a drawlatch checkout at ${DRAWLATCH_DIR}.\n` + `Use "npm run reload:prod" to build against the published drawlatch instead.`);
      process.exit(1);
    }
    console.log("\n=== Building and packing local drawlatch ===");
    run("npm run build", { cwd: DRAWLATCH_DIR });
    const dlVersion = getDrawlatchVersion();
    run("npm pack --pack-destination /tmp", { cwd: DRAWLATCH_DIR });
    dlTgz = `/tmp/wolpertingerlabs-drawlatch-${dlVersion}.tgz`;
    console.log(`  Packed drawlatch ${dlVersion} -> ${dlTgz}`);

    // 2. Point callboard at the drawlatch tarball & add bundleDependencies
    console.log("\n=== Configuring callboard for bundled pack ===");
    const rootPkg = readPkg("package.json");
    rootPkg.dependencies[PKG] = `file:${dlTgz}`;
    rootPkg.bundleDependencies = [PKG];
    writePkg("package.json", rootPkg);
    console.log(`  Root drawlatch -> file:${dlTgz}`);
    console.log(`  Added bundleDependencies: [${PKG}]`);

    // Backend doesn't matter for the global install (it's a workspace),
    // but keep it consistent so npm install doesn't complain
    const backendPkg = readPkg("backend/package.json");
    backendPkg.dependencies[PKG] = `file:${dlTgz}`;
    writePkg("backend/package.json", backendPkg);
  } else {
    // prod: use a published drawlatch range — no local build, no bundling.
    console.log("\n=== Using published drawlatch (no local build) ===");
    const rootPkg = readPkg("package.json");
    const current = rootPkg.dependencies[PKG];

    if (current && current.startsWith("file:")) {
      // Currently pinned to local; pin to a published range for the build.
      const ver = getDrawlatchVersion();
      if (!ver) {
        console.error(
          `Error: package.json points drawlatch at a local path (${current}) and no\n` +
            `../drawlatch checkout exists to derive a published version from.\n` +
            `Run "npm run drawlatch:prod" to pin a published version first.`,
        );
        process.exit(1);
      }
      const range = `^${ver}`;
      rootPkg.dependencies[PKG] = range;
      writePkg("package.json", rootPkg);
      const backendPkg = readPkg("backend/package.json");
      backendPkg.dependencies[PKG] = range;
      writePkg("backend/package.json", backendPkg);
      console.log(`  Pinned drawlatch ${current} -> ${range} for this build`);
    } else {
      console.log(`  drawlatch already published range: ${current}`);
    }
  }

  // 3. Install, build, pack, global-install
  console.log("\n=== Building callboard ===");
  run("npm install --include=dev");
  run("npm run build");

  const cbVersion = readPkg("package.json").version;
  const cbTgz = `/tmp/wolpertingerlabs-callboard-${cbVersion}.tgz`;

  run("npm pack --pack-destination /tmp");
  run(`npm install -g "${cbTgz}"`);

  // 4. Cleanup tarballs
  for (const f of [dlTgz, cbTgz]) {
    if (!f) continue;
    try {
      fs.unlinkSync(f);
    } catch {
      // ignore
    }
  }

  // 5. Restart
  run("callboard restart");
  run("callboard status");
} finally {
  // Restore original package.json files exactly as they were
  console.log("\n=== Restoring package.json files ===");
  fs.writeFileSync(path.resolve(ROOT, "package.json"), origRoot);
  fs.writeFileSync(path.resolve(ROOT, "backend/package.json"), origBackend);
  console.log("  Restored root and backend package.json");

  // Reinstall with original deps (skip prepare to avoid redundant build)
  run("npm install --ignore-scripts");
}
