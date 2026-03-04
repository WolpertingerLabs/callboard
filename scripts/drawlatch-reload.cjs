#!/usr/bin/env node

/**
 * Reload script that handles local drawlatch transparently.
 *
 * Problem: `npm install -g <tarball>` resolves dependencies from npm.
 * If drawlatch points to a local file: path or an unpublished version,
 * the global install fails.
 *
 * Solution: pack drawlatch separately, point callboard at the tarball,
 * add bundleDependencies so drawlatch is embedded in callboard's tarball,
 * then global-install. The global package carries its own copy of drawlatch.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DRAWLATCH_DIR = path.resolve(ROOT, "../drawlatch");
const PKG = "@wolpertingerlabs/drawlatch";

function readPkg(relPath) {
  return JSON.parse(
    fs.readFileSync(path.resolve(ROOT, relPath), "utf8"),
  );
}

function writePkg(relPath, obj) {
  fs.writeFileSync(
    path.resolve(ROOT, relPath),
    JSON.stringify(obj, null, 2) + "\n",
  );
}

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

// Snapshot original package.json contents so we can restore exactly
const origRoot = fs.readFileSync(path.resolve(ROOT, "package.json"), "utf8");
const origBackend = fs.readFileSync(
  path.resolve(ROOT, "backend/package.json"),
  "utf8",
);

try {
  // 1. Build & pack drawlatch
  console.log("=== Building and packing drawlatch ===");
  run("npm run build", { cwd: DRAWLATCH_DIR });
  const dlVersion = JSON.parse(
    fs.readFileSync(path.resolve(DRAWLATCH_DIR, "package.json"), "utf8"),
  ).version;
  run("npm pack --pack-destination /tmp", { cwd: DRAWLATCH_DIR });
  const dlTgz = `/tmp/wolpertingerlabs-drawlatch-${dlVersion}.tgz`;
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
