#!/usr/bin/env node

/**
 * Rebuild callboard and global-install it, with drawlatch taken either from the
 * packages/drawlatch workspace or from the npm registry.
 *
 * Usage:
 *   node scripts/reload.cjs [local|prod] [--prefix <dir>] [--no-restart]
 *
 *   local         (default) Install the workspace's drawlatch. Works when the
 *                 pinned drawlatch version is not on npm yet.
 *   prod          Install drawlatch from the registry at callboard's exact pin.
 *                 Fails if that version has not been published.
 *   --prefix DIR  Passed to `npm install -g`, so the install lands in DIR
 *                 instead of the global prefix (no sudo fallback). Implies
 *                 --no-restart: the running daemon is not the one installed.
 *   --no-restart  Skip `callboard restart` / `callboard status`.
 *
 * ── local ─────────────────────────────────────────────────────────────
 * Packs the workspace drawlatch, then packs callboard with its drawlatch
 * dependency pointed at that tarball by absolute `file:` path. `npm install -g`
 * reads the tarball straight off disk and installs drawlatch's own dependencies
 * normally, so the local build lands in the global install without being
 * bundled. The root package.json is rewritten only for the duration of that one
 * `npm pack` and restored immediately; `npm install` is never run against the
 * rewritten manifest (it would unlink the workspace and rewrite the lockfile).
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
 * ── prod ──────────────────────────────────────────────────────────────
 * Packs callboard unchanged, so the global install pulls drawlatch from the
 * registry at the exact pinned version.
 *
 * The global install (`npm install -g`) transparently falls back to sudo when
 * the npm global modules dir is not writable by the current user (e.g. a
 * root-owned /usr prefix) and no --prefix was given.
 */

const { execSync, execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PKG = "@wolpertingerlabs/drawlatch";
const PKG_SELF = "@wolpertingerlabs/callboard";

function usage(message) {
  console.error(`Usage: node scripts/reload.cjs [local|prod] [--prefix <dir>] [--no-restart]${message ? `\n  ${message}` : ""}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { mode: "local", prefix: null, restart: true };
  let modeSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--prefix") {
      const value = argv[++i];
      if (!value) usage("--prefix needs a directory");
      opts.prefix = path.resolve(value);
    } else if (arg.startsWith("--prefix=")) {
      opts.prefix = path.resolve(arg.slice("--prefix=".length));
    } else if (arg === "--no-restart") {
      opts.restart = false;
    } else if ((arg === "local" || arg === "prod") && !modeSeen) {
      opts.mode = arg;
      modeSeen = true;
    } else {
      usage(`Unknown argument: ${arg}`);
    }
  }
  if (opts.prefix) opts.restart = false;
  return opts;
}

const { mode, prefix, restart } = parseArgs(process.argv.slice(2));

function readPkg(relPath) {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, relPath), "utf8"));
}

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

/** `npm pack --json` into `dest`; returns the absolute path of the tarball it wrote. */
function pack(args, dest) {
  const cmd = `npm pack ${args} --ignore-scripts --json --pack-destination "${dest}"`;
  console.log(`\n> ${cmd}`);
  const out = execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const [info] = JSON.parse(out);
  return path.join(dest, info.filename);
}

/** Async `npm pack --json`, so signal handlers can run while it does (execSync blocks the event loop). */
function packAsync(args, dest, onChild) {
  const argv = ["pack", ...args, "--ignore-scripts", "--json", "--pack-destination", dest];
  console.log(`\n> npm ${argv.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn("npm", argv, { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
    onChild(child);
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) return reject(new Error(`npm pack failed (${signal ?? `exit ${code}`})`));
      try {
        resolve(path.join(dest, JSON.parse(out)[0].filename));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Pack callboard with its drawlatch dependency rewritten to `file:<dlTgz>`,
 * restoring package.json afterwards — including on SIGINT/SIGTERM/SIGHUP, which would
 * otherwise kill the process mid-pack and skip every `finally`, leaving
 * package.json pointing at a temp tarball. The handlers exist only for this
 * window; on a signal they restore, remove the temp dir and exit 128 + signo.
 */
// SIGHUP: the terminal was closed. Each exits 128 + signo (130 / 143 / 129).
const WINDOW_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

async function packAgainstDrawlatchTarball(dlTgz, tmp) {
  const pkgPath = path.join(ROOT, "package.json");
  const original = fs.readFileSync(pkgPath, "utf8");
  let restored = false;
  const restore = () => {
    if (restored) return;
    fs.writeFileSync(pkgPath, original);
    restored = true;
  };
  let child = null;
  const onSignal = (signal) => {
    restore();
    console.error(`\n${signal}: restored package.json`);
    if (child && child.exitCode === null) child.kill(signal);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(128 + os.constants.signals[signal]);
  };
  for (const signal of WINDOW_SIGNALS) process.on(signal, onSignal);
  try {
    const rootPkg = JSON.parse(original);
    rootPkg.dependencies[PKG] = `file:${dlTgz}`;
    fs.writeFileSync(pkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
    return await packAsync([], tmp, (c) => (child = c));
  } finally {
    restore();
    for (const signal of WINDOW_SIGNALS) process.off(signal, onSignal);
  }
}

function gitStatus() {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  } catch {
    return null; // not a git checkout — nothing to compare
  }
}

/**
 * Whether `npm install -g` can write to the global modules dir as the current
 * user. When the prefix is root-owned (e.g. /usr), it can't — and we fall back
 * to sudo for the global install step.
 */
function canWriteGlobalModules() {
  let globalPrefix;
  try {
    globalPrefix = execSync("npm prefix -g", { encoding: "utf8" }).trim();
  } catch {
    return true; // can't determine — let npm error naturally rather than force sudo
  }
  const candidates = [path.join(globalPrefix, "lib", "node_modules"), path.join(globalPrefix, "node_modules"), globalPrefix];
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

/** Global-install a tarball; into --prefix if given, else with a sudo fallback if the global dir isn't writable. */
function globalInstall(tgz) {
  if (prefix) {
    run(`npm install -g --prefix "${prefix}" "${tgz}"`);
    return;
  }
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

/** Directory the callboard package was installed into. */
function installedDir() {
  if (prefix) return path.join(prefix, "lib", "node_modules", ...PKG_SELF.split("/"));
  const root = execSync("npm root -g", { encoding: "utf8" }).trim();
  return path.join(root, ...PKG_SELF.split("/"));
}

async function main() {
  const statusBefore = gitStatus();
  const dlVersion = readPkg("packages/drawlatch/package.json").version;
  const pin = readPkg("package.json").dependencies[PKG];

  console.log(`=== callboard reload (mode: ${mode}${prefix ? `, prefix: ${prefix}` : ""}) ===`);

  if (mode === "prod") {
    let published = "";
    try {
      published = execSync(`npm view "${PKG}@${pin}" version`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // E404 → not published
    }
    if (!published) {
      console.error(`\ndrawlatch ${pin} is not on npm yet — publish it (publish workflow) or use reload:local`);
      process.exit(1);
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "callboard-reload-"));
  let treeCheckFailed = false;
  let versionMismatch = null;

  try {
    console.log("\n=== Building callboard ===");
    run("npm run build");

    let cbTgz;
    if (mode === "local") {
      console.log("\n=== Packing workspace drawlatch ===");
      const dlTgz = pack(`-w ${PKG}`, tmp);
      console.log(`  Packed drawlatch ${dlVersion} -> ${dlTgz}`);

      console.log("\n=== Packing callboard against the drawlatch tarball ===");
      cbTgz = await packAgainstDrawlatchTarball(dlTgz, tmp);
    } else {
      console.log("\n=== Packing callboard (drawlatch from the registry) ===");
      cbTgz = pack("", tmp);
    }

    // In local mode the installed callboard's manifest keeps the
    // `file:<tmp>/…drawlatch….tgz` spec after the temp dir is deleted below, so
    // `npm ls -g` reports drawlatch as "invalid". Harmless — drawlatch is
    // installed and resolves normally — and the same as before the workspace.
    globalInstall(cbTgz);

    // Verify what npm actually reified. `npm install` exits 0 on trees with
    // holes in them (see the check's header), and the daemon only discovers the
    // hole when it spawns the agent whose dependency went missing.
    const dir = installedDir();
    console.log("\n=== Verifying the global install tree ===");
    try {
      run(`node "${path.join(__dirname, "check-install-tree.cjs")}" "${dir}"`);
    } catch {
      treeCheckFailed = true;
    }

    const expected = mode === "local" ? dlVersion : pin;
    try {
      const installed = JSON.parse(fs.readFileSync(path.join(dir, "node_modules", ...PKG.split("/"), "package.json"), "utf8")).version;
      if (installed !== expected) versionMismatch = `installed drawlatch is ${installed}, expected ${expected}`;
      else console.log(`  Installed drawlatch ${installed}`);
    } catch (err) {
      versionMismatch = `could not read the installed drawlatch: ${err.message}`;
    }
    if (versionMismatch) console.error(`\n${versionMismatch}`);

    // Restart — but never onto a tree we know is broken
    if (treeCheckFailed || versionMismatch) {
      console.error("\nGlobal install is broken (see above) — leaving the running daemon alone.");
    } else if (restart) {
      run("callboard restart");
      run("callboard status");
    } else {
      console.log("\nSkipping restart (--no-restart / --prefix).");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    const statusAfter = gitStatus();
    if (statusBefore !== null && statusAfter !== statusBefore) {
      console.warn(`\nWarning: \`git status --porcelain\` changed during the reload:\n${statusAfter}`);
    }
  }

  // Surface a broken install as a failed reload.
  if (treeCheckFailed || versionMismatch) {
    const recover = prefix ? `rm -rf "${prefix}"` : `npm uninstall -g ${PKG_SELF}`;
    console.error(`\nReload finished with a broken global install.\nRecover with:  ${recover} && npm run reload:${mode}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
