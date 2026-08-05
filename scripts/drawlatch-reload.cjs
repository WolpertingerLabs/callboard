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
 * Builds drawlatch from the sibling ../drawlatch checkout, packs it, and points
 * callboard at that tarball by absolute `file:` path. `npm install -g` reads the
 * tarball straight off disk and installs drawlatch's own dependencies normally,
 * so the local build lands in the global install without being bundled.
 *
 * Do NOT reach for `bundleDependencies` here, however tempting. A tarball with
 * bundleDependencies makes npm mis-handle any *other* dependency that ships an
 * npm-shrinkwrap.json — @earendil-works/pi-coding-agent does — and silently drop
 * that package's entire direct-dependency set from the reified tree ("invalid or
 * damaged lockfile detected" / "unrecognized node in tree" in the npm debug log).
 * The install reports success; pi then dies at spawn time with
 * ERR_MODULE_NOT_FOUND for chalk. The tree check at the end of this script exists
 * to catch that class of failure at reload time instead.
 *
 * Requires the ../drawlatch sibling directory to exist.
 *
 * ── prod ──────────────────────────────────────────────────────────────
 * Leaves drawlatch as a published semver range so the global install pulls
 * it from the npm registry. Does NOT build local drawlatch. If the
 * working tree currently points drawlatch at a local file: path, it is
 * temporarily pinned to `^<../drawlatch version>` for the build (and restored
 * afterward); if no ../drawlatch checkout exists to read a version from, it
 * errors and asks you to run `npm run drawlatch:prod` first.
 *
 * Both modes restore your package.json files exactly as they were on exit.
 *
 * The global install (`npm install -g`) transparently falls back to sudo when
 * the npm global modules dir is not writable by the current user (e.g. a
 * root-owned /usr prefix).
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DRAWLATCH_DIR = path.resolve(ROOT, "../drawlatch");
const PKG = "@wolpertingerlabs/drawlatch";
const PKG_SELF = "@wolpertingerlabs/callboard";

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

/**
 * Whether `npm install -g` can write to the global modules dir as the current
 * user. When the prefix is root-owned (e.g. /usr), it can't — and we fall back
 * to sudo for the global install step.
 */
function canWriteGlobalModules() {
  let prefix;
  try {
    prefix = execSync("npm prefix -g", { encoding: "utf8" }).trim();
  } catch {
    return true; // can't determine — let npm error naturally rather than force sudo
  }
  const candidates = [path.join(prefix, "lib", "node_modules"), path.join(prefix, "node_modules"), prefix];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      try {
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
  }
  return true; // nothing exists yet — assume creatable, let npm decide
}

/** Global-install a tarball, transparently using sudo if the global dir isn't writable. */
function globalInstall(tgz) {
  if (canWriteGlobalModules()) {
    run(`npm install -g "${tgz}"`);
    return;
  }
  console.log("  Global node_modules is not writable by the current user — using sudo for the global install.");
  try {
    execSync("sudo -n true", { stdio: "ignore" });
  } catch {
    console.log("  (sudo may prompt for your password)");
  }
  run(`sudo npm install -g "${tgz}"`);
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
let treeCheckFailed = false;

try {
  if (mode === "local") {
    // 1. Build & pack drawlatch from the sibling checkout
    if (!fs.existsSync(DRAWLATCH_DIR)) {
      console.error(
        `Error: local mode needs a drawlatch checkout at ${DRAWLATCH_DIR}.\n` + `Use "npm run reload:prod" to build against the published drawlatch instead.`,
      );
      process.exit(1);
    }
    console.log("\n=== Building and packing local drawlatch ===");
    run("npm run build", { cwd: DRAWLATCH_DIR });
    const dlVersion = getDrawlatchVersion();
    run("npm pack --pack-destination /tmp", { cwd: DRAWLATCH_DIR });
    dlTgz = `/tmp/wolpertingerlabs-drawlatch-${dlVersion}.tgz`;
    console.log(`  Packed drawlatch ${dlVersion} -> ${dlTgz}`);

    // 2. Point callboard at the drawlatch tarball (absolute file: path)
    console.log("\n=== Configuring callboard for local drawlatch ===");
    const rootPkg = readPkg("package.json");
    rootPkg.dependencies[PKG] = `file:${dlTgz}`;
    writePkg("package.json", rootPkg);
    console.log(`  Root drawlatch -> file:${dlTgz}`);

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
  globalInstall(cbTgz);

  // 4. Verify what npm actually reified. `npm install` exits 0 on trees with
  //    holes in them (see the check's header), and the daemon only discovers
  //    the hole when it spawns the agent whose dependency went missing.
  console.log("\n=== Verifying the global install tree ===");
  try {
    run(`node "${path.join(__dirname, "check-install-tree.cjs")}"`);
  } catch {
    treeCheckFailed = true;
  }

  // 5. Cleanup tarballs
  for (const f of [dlTgz, cbTgz]) {
    if (!f) continue;
    try {
      fs.unlinkSync(f);
    } catch {
      // ignore
    }
  }

  // 6. Restart — but never onto a tree we know is broken
  if (treeCheckFailed) {
    console.error("\nGlobal install tree is broken (see above) — leaving the running daemon alone.");
  } else {
    run("callboard restart");
    run("callboard status");
  }
} finally {
  // Restore original package.json files exactly as they were
  console.log("\n=== Restoring package.json files ===");
  fs.writeFileSync(path.resolve(ROOT, "package.json"), origRoot);
  fs.writeFileSync(path.resolve(ROOT, "backend/package.json"), origBackend);
  console.log("  Restored root and backend package.json");

  // Reinstall with original deps (skip prepare to avoid redundant build)
  run("npm install --ignore-scripts");
}

// Surface a broken install as a failed reload, after the restore above has run.
if (treeCheckFailed) {
  console.error(`\nReload finished with a broken global install.\nRecover with:  npm uninstall -g ${PKG_SELF} && npm run reload:${mode}`);
  process.exit(1);
}
