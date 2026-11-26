#!/usr/bin/env node

/**
 * Rebuild callboard and global-install it together with the packages/drawlatch
 * workspace, then restart the daemon.
 *
 * Usage:
 *   node scripts/reload.cjs [--prefix <dir>] [--no-restart]
 *
 *   --prefix DIR  Passed to `npm install -g`, so the install lands in DIR
 *                 instead of the global prefix (no sudo fallback). Implies
 *                 --no-restart: the running daemon is not the one installed.
 *   --no-restart  Skip `callboard restart` / `callboard status`.
 *
 * drawlatch always comes from the workspace, never the npm registry, so a
 * reload works whether or not the pinned drawlatch version has been published.
 *
 * Before building, the script refuses to run if node_modules does not match
 * package-lock.json (typically after a `git pull` that changed the lockfile):
 * the build would otherwise fail confusingly, or succeed against stale
 * dependencies. Run `npm install` and reload again.
 *
 * How the install works: the workspace drawlatch is packed, then callboard is
 * packed with its drawlatch dependency pointed at that tarball by absolute
 * `file:` path. `npm install -g` reads the tarball straight off disk and
 * installs drawlatch's own dependencies normally, so the local build lands in
 * the global install without being bundled. The root package.json is rewritten
 * only for the duration of that one `npm pack` and restored immediately;
 * `npm install` is never run against the rewritten manifest (it would unlink
 * the workspace and rewrite the lockfile).
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
  console.error(`Usage: node scripts/reload.cjs [--prefix <dir>] [--no-restart]${message ? `\n  ${message}` : ""}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { prefix: null, restart: true };
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
    } else if (arg === "local" || arg === "prod") {
      usage(`"${arg}" mode was removed: reload always installs the workspace drawlatch. Run it without a mode.`);
    } else {
      usage(`Unknown argument: ${arg}`);
    }
  }
  if (opts.prefix) opts.restart = false;
  return opts;
}

/**
 * Describe how node_modules differs from package-lock.json, or return null if
 * it matches. Compares the lockfile against npm's hidden lockfile
 * (node_modules/.package-lock.json), which npm rewrites on every install:
 * every lockfile entry must be installed at the same version (or as the same
 * workspace link). Optional entries may be absent — platform-specific binaries
 * are never installed on other platforms.
 */
function installDrift(lock, hidden) {
  if (!hidden) return "node_modules is missing or was not installed by npm";
  const installed = hidden.packages ?? {};
  const problems = [];
  for (const [key, want] of Object.entries(lock.packages ?? {})) {
    if (key === "" || !key.includes("node_modules/")) continue; // root and workspace sources
    const have = installed[key];
    if (!have) {
      if (!want.optional && !want.devOptional) problems.push(`${key} is not installed`);
      continue;
    }
    if (Boolean(want.link) !== Boolean(have.link)) {
      problems.push(`${key} should be ${want.link ? `a link to ${want.resolved}` : "an installed package"}`);
    } else if (!want.link && want.version !== have.version) {
      problems.push(`${key} is ${have.version}, lockfile wants ${want.version}`);
    }
  }
  if (problems.length === 0) return null;
  const shown = problems.slice(0, 5).map((p) => `    ${p}`);
  if (problems.length > shown.length) shown.push(`    … and ${problems.length - shown.length} more`);
  return shown.join("\n");
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function readPkg(relPath) {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, relPath), "utf8"));
}

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

/** Tarball filename from `npm pack --json`: an array before npm 12, an object keyed by package name since. */
function packedFilename(out) {
  const parsed = JSON.parse(out);
  const [info] = Array.isArray(parsed) ? parsed : Object.values(parsed);
  if (!info?.filename) throw new Error(`npm pack --json gave no filename: ${out.slice(0, 200)}`);
  return info.filename;
}

/** `npm pack --json` into `dest`; returns the absolute path of the tarball it wrote. */
function pack(args, dest) {
  const cmd = `npm pack ${args} --ignore-scripts --json --pack-destination "${dest}"`;
  console.log(`\n> ${cmd}`);
  const out = execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return path.join(dest, packedFilename(out));
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
        resolve(path.join(dest, packedFilename(out)));
      } catch (err) {
        reject(err);
      }
    });
  });
}

// SIGHUP: the terminal was closed. Each exits 128 + signo (130 / 143 / 129).
const WINDOW_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Pack callboard with its drawlatch dependency rewritten to `file:<dlTgz>`,
 * restoring package.json afterwards — including on SIGINT/SIGTERM/SIGHUP, which would
 * otherwise kill the process mid-pack and skip every `finally`, leaving
 * package.json pointing at a temp tarball. The handlers exist only for this
 * window; on a signal they restore, remove the temp dir and exit 128 + signo.
 */
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

async function main() {
  const { prefix, restart } = parseArgs(process.argv.slice(2));

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

  const statusBefore = gitStatus();
  const dlVersion = readPkg("packages/drawlatch/package.json").version;

  console.log(`=== callboard reload${prefix ? ` (prefix: ${prefix})` : ""} ===`);

  const drift = installDrift(readPkg("package-lock.json"), readJsonIfExists(path.join(ROOT, "node_modules", ".package-lock.json")));
  if (drift) {
    console.error(`\nnode_modules does not match package-lock.json:\n${drift}\n\nRun \`npm install\`, then reload again.`);
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "callboard-reload-"));
  let treeCheckFailed = false;
  let versionMismatch = null;

  try {
    console.log("\n=== Building callboard ===");
    run("npm run build");

    console.log("\n=== Packing workspace drawlatch ===");
    const dlTgz = pack(`-w ${PKG}`, tmp);
    console.log(`  Packed drawlatch ${dlVersion} -> ${dlTgz}`);

    console.log("\n=== Packing callboard against the drawlatch tarball ===");
    const cbTgz = await packAgainstDrawlatchTarball(dlTgz, tmp);

    // The installed callboard's manifest keeps the `file:<tmp>/…drawlatch….tgz`
    // spec after the temp dir is deleted below, so `npm ls -g` reports drawlatch
    // as "invalid". Harmless — drawlatch is installed and resolves normally.
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

    try {
      const installed = JSON.parse(fs.readFileSync(path.join(dir, "node_modules", ...PKG.split("/"), "package.json"), "utf8")).version;
      if (installed !== dlVersion) versionMismatch = `installed drawlatch is ${installed}, expected ${dlVersion}`;
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
    console.error(`\nReload finished with a broken global install.\nRecover with:  ${recover} && npm run reload`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { installDrift, parseArgs };
