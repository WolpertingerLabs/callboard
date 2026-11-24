#!/usr/bin/env node

// ── Callboard CLI ────────────────────────────────────────────────────
// Entry point for the `callboard` command after global npm install.
// Provides daemon management, log viewing, config introspection, and
// a first-run setup experience — all with zero extra dependencies.
// ─────────────────────────────────────────────────────────────────────

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

// ── Paths & constants ────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, "..");
const SERVER_ENTRY = join(PKG_ROOT, "backend/dist/index.js");

// Import shared path utilities from compiled backend
const { DATA_DIR, ENV_FILE, ensureDataDir, ensureEnvFile } = await import(join(PKG_ROOT, "backend/dist/utils/paths.js"));

// Import dotenv for .env parsing (already a project dependency)
const require = createRequire(import.meta.url);
const dotenv = require("dotenv");

const PID_FILE = join(DATA_DIR, "callboard.pid");
const LOG_DIR = join(DATA_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "callboard.log");
const VERSION_CACHE_FILE = join(DATA_DIR, "version-check.json");
const VERSION_CHECK_TTL = 4 * 60 * 60 * 1000; // 4 hours
const DEFAULT_PORT = 8000;
// How long `stop` (and `restart`) waits for a graceful shutdown before SIGKILL: the
// 30 s sandbox drain bound plus removal and the rest of shutdown.
const STOP_GRACE_MS = 45_000;

// Read version from package.json
const pkgJson = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8"));
const VERSION = pkgJson.version;
const PKG_NAME = pkgJson.name;

// ── Argument parsing ─────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const subcommand = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs.shift() : null;

let values;
try {
  ({ values } = parseArgs({
    args: rawArgs,
    options: {
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      foreground: { type: "boolean", short: "f", default: false },
      port: { type: "string" },
      lines: { type: "string", short: "n", default: "50" },
      // parseArgs has no `--no-` negation, so the off-switch is its own option.
      follow: { type: "boolean", default: true },
      "no-follow": { type: "boolean", default: false },
      path: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      profile: { type: "string" },
      scope: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  }));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

// ── Dispatch ─────────────────────────────────────────────────────────
if (values.version) {
  console.log(VERSION);
  process.exit(0);
}
if (values.help && !subcommand) {
  printHelp();
  const latestVersion = await checkForUpdate();
  if (latestVersion) printUpdateNotice(latestVersion);
  process.exit(0);
}

switch (subcommand) {
  case null:
    await cmdDefault();
    break;
  case "start":
    if (values.help) {
      printStartHelp();
    } else {
      await cmdStart();
    }
    break;
  case "stop":
    if (values.help) {
      printStopHelp();
    } else {
      await cmdStop();
    }
    break;
  case "restart":
    if (values.help) {
      printRestartHelp();
    } else {
      await cmdRestart();
    }
    break;
  case "status":
    if (values.help) {
      printStatusHelp();
    } else {
      await cmdStatus();
    }
    break;
  case "logs":
    if (values.help) {
      printLogsHelp();
    } else {
      await cmdLogs();
    }
    break;
  case "config":
    if (values.help) {
      printConfigHelp();
    } else {
      cmdConfig();
    }
    break;
  case "set-password":
    if (values.help) {
      printSetPasswordHelp();
    } else {
      await cmdSetPassword();
    }
    break;
  case "sandbox":
    if (values.help) {
      printSandboxHelp();
    } else {
      await cmdSandbox();
    }
    break;
  case "help": {
    printHelp();
    const latestVersion = await checkForUpdate();
    if (latestVersion) printUpdateNotice(latestVersion);
    break;
  }
  default:
    console.error(`Unknown command: ${subcommand}\n`);
    printHelp();
    process.exit(1);
}

// ── Commands ─────────────────────────────────────────────────────────

// `callboard sandbox build|status|profiles|rm`: the Sandbox desktop's images.
// Building is only ever explicit (this command or Settings → Sandbox desktop);
// Callboard never builds or pulls one on its own. The context is the shipped
// packages/computer-use (dist/ + docker/), so this works from an npm install as
// well as from a source checkout.
async function cmdSandbox() {
  const action = rawArgs.find((arg, i) => !arg.startsWith("-") && rawArgs[i - 1] !== "--profile" && rawArgs[i - 1] !== "--scope");
  const image = await import(join(PKG_ROOT, "backend/dist/services/sandbox-image.js"));
  const docker = image.execDocker();
  if (values.profile !== undefined && action !== "build" && action !== "rm") {
    console.error("--profile goes with build or rm\n");
    printSandboxHelp();
    process.exit(1);
  }
  if (action === "build" && values.profile !== undefined) {
    await cmdSandboxProfileBuild(image, docker, values.profile);
    return;
  }
  if (action === "profiles") {
    await cmdSandboxProfiles(image, docker);
    return;
  }
  if (action === "rm") {
    if (!values.profile) {
      console.error("Usage: callboard sandbox rm --profile <name>");
      process.exit(1);
    }
    const profiles = await import(join(PKG_ROOT, "backend/dist/services/sandbox-profiles.js"));
    const id = profiles.entryIdOf(values.profile, values.scope ?? "global");
    const entry = id && profiles.resolveProfileId(id);
    if (!entry) {
      console.error(`No sandbox profile ${JSON.stringify(values.profile)} in scope ${values.scope ?? "global"}. See: callboard sandbox profiles`);
      process.exit(1);
    }
    try {
      const removed = await profiles.removeProfileImage(docker, entry);
      console.log(removed ? `Removed ${entry.image}.` : `${entry.image} was not built; nothing to remove.`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    return;
  }
  if (action === "build") {
    const present = await image.inspectSandboxImage(docker).catch(() => undefined);
    if (present?.present && present.compatible && present.secure && present.current && !values.force) {
      console.log(`${image.SANDBOX_IMAGE} is up to date (protocol ${present.protocol}, built from the files this Callboard ships).`);
      console.log("Rebuild it anyway with: callboard sandbox build --force");
      return;
    }
    if (present?.present && !values.force)
      console.log(
        !present.compatible
          ? `${image.SANDBOX_IMAGE} speaks protocol ${present.protocol ?? "unlabelled"}, not ${image.SANDBOX_PROTOCOL_LABEL_VALUE}; rebuilding.`
          : !present.secure
            ? `${image.SANDBOX_IMAGE} has a known security issue (security level ${present.securityFloor ?? "unlabelled"}, at least ${image.SANDBOX_SECURITY_FLOOR} required); rebuilding.`
            : `${image.SANDBOX_IMAGE} is out of date (not built from the files this Callboard ships); rebuilding.`,
      );
    console.log(`Building ${image.SANDBOX_IMAGE} (and its builder stage, ${image.SANDBOX_BUILDER}) from ${image.sandboxBuildContext()} ...`);
    try {
      await image.buildSandboxImage({ stdio: "inherit" });
    } catch (err) {
      console.error(`\nBuild failed: ${err.message.split("\n")[0]}`);
      process.exit(1);
    }
    console.log(`\nBuilt ${image.SANDBOX_IMAGE}. Turn on Sandbox desktop in a chat's permissions to use it.`);
    console.log(
      "Sandbox profiles built on an older base are now out of date: they still start, but run the old driver host. Rebuild them (callboard sandbox profiles lists them).",
    );
    return;
  }
  if (action === "status" || action === undefined) {
    let server;
    try {
      server = (await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10000 })).trim();
    } catch (err) {
      console.log(`Docker:  not reachable (${err.message})`);
      process.exit(1);
    }
    console.log(`Docker:  ${server}`);
    const info = await image.inspectSandboxImage(docker).catch((err) => ({ error: err.message }));
    if (info.error) console.log(`Image:   ${image.SANDBOX_IMAGE}: ${info.error}`);
    else if (!info.present) console.log(`Image:   ${image.SANDBOX_IMAGE} is not built. Run: callboard sandbox build`);
    else
      console.log(
        `Image:   ${image.SANDBOX_IMAGE} (protocol ${info.protocol ?? "unlabelled"}${info.compatible ? "" : `, INCOMPATIBLE with ${image.SANDBOX_PROTOCOL_LABEL_VALUE}`}, ${!info.secure ? `KNOWN SECURITY ISSUE (level ${info.securityFloor ?? "unlabelled"} < ${image.SANDBOX_SECURITY_FLOOR}): refused until you run callboard sandbox build` : info.current ? "up to date" : "OUT OF DATE: run callboard sandbox build"}, version ${info.version ?? "unknown"})`,
      );
    const owner = image.sandboxOwnerId(DATA_DIR);
    const running = await docker(["ps", "--quiet", "--filter", "label=dev.callboard.managed=1", "--filter", `label=dev.callboard.owner=${owner}`]).catch(
      () => "",
    );
    console.log(`Owner:   ${owner} (from ${DATA_DIR})`);
    console.log(`Running: ${running.split("\n").filter((line) => line.trim()).length} managed sandbox container(s)`);
    return;
  }
  console.error(`Unknown sandbox command: ${action}\n`);
  printSandboxHelp();
  process.exit(1);
}

// `callboard sandbox build --profile <name>`: one profile's image, after the
// base and its builder if they are not current. Up-to-date images are left
// alone unless --force.
async function cmdSandboxProfileBuild(image, docker, name) {
  const profiles = await import(join(PKG_ROOT, "backend/dist/services/sandbox-profiles.js"));
  const id = profiles.entryIdOf(name, values.scope ?? "global");
  const entry = id && profiles.resolveProfileId(id);
  if (!entry) {
    console.error(`No sandbox profile ${JSON.stringify(name)} in scope ${values.scope ?? "global"}. See: callboard sandbox profiles`);
    process.exit(1);
  }
  const arch = profiles.architectureProblem(entry, await profiles.hostArchitecture(docker).catch(() => undefined));
  if (arch) {
    console.error(`${arch} Nothing was built.`);
    process.exit(1);
  }
  const info = await profiles
    .inspectProfileImage(docker, entry, await profiles.currentBase(docker, image.SANDBOX_IMAGE))
    .catch((err) => ({ state: "unknown", detail: err.message }));
  if (info.state === "current" && !values.force) {
    console.log(`${entry.image} is up to date (recipe ${entry.digest.slice(0, 12)}, on the current base).`);
    console.log(`Rebuild it anyway with: callboard sandbox build --profile ${name}${entry.scope === "global" ? "" : ` --scope ${entry.scope}`} --force`);
    return;
  }
  if (info.state !== "missing" && info.detail) console.log(`${entry.image}: ${info.detail}`);
  console.log(`Building sandbox profile ${entry.id} as ${entry.image} ...`);
  const started = Date.now();
  try {
    await profiles.buildProfileImage({ entry, docker, dataDir: DATA_DIR, stdio: "inherit" });
  } catch (err) {
    console.error(`\nBuild failed: ${err.message.split("\n")[0]}`);
    process.exit(1);
  }
  console.log(
    `\nBuilt ${entry.image} in ${Math.round((Date.now() - started) / 1000)}s. An agent can now ask for it: cu_request_control with profile "${name}".`,
  );
}

// `callboard sandbox profiles`: every profile, its limits and its image's state.
async function cmdSandboxProfiles(image, docker) {
  const profiles = await import(join(PKG_ROOT, "backend/dist/services/sandbox-profiles.js"));
  const { errors } = profiles.loadBuiltinProfiles();
  for (const error of errors) console.log(`Skipped an invalid built-in recipe: ${error}`);
  const base = await profiles.currentBase(docker, image.SANDBOX_IMAGE).catch(() => ({}));
  const entries = profiles.listAllProfiles();
  const arch = await profiles.hostArchitecture(docker).catch(() => undefined);
  if (!entries.length) console.log("No sandbox profiles.");
  for (const entry of entries) {
    const info = await profiles.inspectProfileImage(docker, entry, base).catch((err) => ({ state: "unknown", detail: err.message }));
    const r = entry.recipe;
    const limits = Object.entries(r.limits)
      .map(([key, value]) => `${key} ${value}`)
      .join(", ");
    const size = info.sizeBytes ? `, ${Math.round(info.sizeBytes / 1024 / 1024)} MB` : "";
    console.log(`${entry.id}  [${info.state}${info.outdatedBy ? `: ${info.outdatedBy.join(" and ")} changed` : ""}${size}]`);
    console.log(`  ${r.description}`);
    console.log(
      `  image ${entry.image}, gl ${r.gl}, ${r.architectures.length ? r.architectures.join("/") : "any architecture"}, requests ${limits || "the base limits"} (clamped by Settings → Sandbox desktop)`,
    );
    const archProblem = profiles.architectureProblem(entry, arch);
    if (archProblem) console.log(`  ${archProblem}`);
    else if (info.state !== "current")
      console.log(
        `  ${info.detail ? `${info.detail} ` : ""}Build: callboard sandbox build --profile ${r.name}${entry.scope === "global" ? "" : ` --scope ${entry.scope}`}`,
      );
  }
}

async function cmdDefault() {
  ensureDataDir();
  const isFirstRun = ensureEnvFile();
  if (isFirstRun) {
    printFirstRunBanner();
    return;
  }

  // Show status if running, otherwise show help
  const pid = readPid();
  if (pid) {
    await cmdStatus();
  } else {
    printHelp();
  }

  const latestVersion = await checkForUpdate();
  if (latestVersion) printUpdateNotice(latestVersion);
}

async function cmdStart() {
  if (values.foreground) return cmdStartForeground();

  ensureDataDir();
  const isFirstRun = ensureEnvFile();
  if (isFirstRun) printFirstRunBanner();

  const existingPid = readPid();
  if (existingPid) {
    console.log(`Server is already running (PID ${existingPid}).`);
    console.log(`  Use: callboard status`);
    process.exit(0);
  }

  const port = values.port || getConfiguredPort() || DEFAULT_PORT;
  mkdirSync(LOG_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, "a");

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
    },
    cwd: PKG_ROOT,
  });

  writeFileSync(PID_FILE, String(child.pid) + "\n");
  child.unref();

  console.log(`Starting Callboard on port ${port}...`);
  const healthy = await waitForHealth(port, 5000);

  if (healthy) {
    console.log(`\nCallboard is running (PID ${child.pid}).`);
    console.log(`  URL:  http://localhost:${port}`);
    console.log(`  Logs: callboard logs`);
  } else {
    console.log(`\nServer started (PID ${child.pid}) but health check did not pass.`);
    console.log(`  Check logs: callboard logs`);
    await diagnoseStartFailure();
  }

  warnIfNoPassword();
}

async function cmdStartForeground() {
  process.env.NODE_ENV = process.env.NODE_ENV || "production";
  if (values.port) process.env.PORT = values.port;

  ensureDataDir();
  const isFirstRun = ensureEnvFile();
  if (isFirstRun) printFirstRunBanner();
  warnIfNoPassword();

  await import(SERVER_ENTRY);
}

async function cmdStop() {
  const pid = readPid();
  if (!pid) {
    console.log("Server is not running.");
    process.exit(0);
  }

  console.log(`Stopping server (PID ${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already gone
    cleanPidFile();
    console.log("Server stopped.");
    return;
  }

  // Long enough for a graceful shutdown to drain managed Sandbox desktops
  // (each drain is bounded at 30 s, all in parallel) and remove them. A
  // daemon with nothing to drain exits in well under a second.
  let stopped = await waitForExit(pid, 5000);
  if (!stopped) {
    console.log("Still stopping (sandbox desktops may be draining)...");
    stopped = await waitForExit(pid, STOP_GRACE_MS - 5000);
  }
  if (!stopped) {
    console.log("Server did not stop gracefully, sending SIGKILL...");
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone
    }
  }

  cleanPidFile();
  console.log("Server stopped.");
}

async function cmdRestart() {
  const pid = readPid();
  if (pid) {
    await cmdStop();
  }
  await cmdStart();
}

async function cmdStatus() {
  ensureDataDir();
  const isFirstRun = ensureEnvFile();
  if (isFirstRun) printFirstRunBanner();

  const pid = readPid();
  if (!pid) {
    console.log("Callboard is not running.");
    warnIfNoPassword();
    process.exit(0);
  }

  const port = getConfiguredPort() || DEFAULT_PORT;

  let uptime = "unknown";
  try {
    const pidStat = await stat(PID_FILE);
    uptime = formatUptime(Date.now() - pidStat.mtimeMs);
  } catch {
    // Can't stat PID file
  }

  const healthy = await healthCheck(port);

  console.log("Callboard is running.");
  console.log(`  PID:    ${pid}`);
  console.log(`  Port:   ${port}`);
  console.log(`  Uptime: ${uptime}`);
  console.log(`  Health: ${healthy ? "healthy" : "unhealthy (not responding)"}`);
  console.log(`  URL:    http://localhost:${port}`);
  warnIfNoPassword();
}

async function cmdLogs() {
  if (!existsSync(LOG_FILE)) {
    console.log("No log file found. Start the server first:");
    console.log("  callboard start");
    process.exit(0);
  }

  const lines = parseInt(values.lines, 10) || 50;
  const follow = values["no-follow"] ? false : values.follow;

  const tailArgs = follow ? ["-n", String(lines), "-f", LOG_FILE] : ["-n", String(lines), LOG_FILE];

  const tail = spawn("tail", tailArgs, { stdio: "inherit" });

  tail.on("error", () => {
    // Fallback: read last N lines with Node.js if tail is not available
    try {
      const content = readFileSync(LOG_FILE, "utf-8");
      const allLines = content.split("\n");
      const lastLines = allLines.slice(-lines).join("\n");
      console.log(lastLines);
      if (follow) {
        console.log("\n(Live following not available — 'tail' command not found)");
      }
    } catch (err) {
      console.error(`Error reading log file: ${err.message}`);
      process.exit(1);
    }
  });

  // Forward SIGINT to cleanly exit
  process.on("SIGINT", () => {
    tail.kill();
    process.exit(0);
  });

  // Wait for tail to exit (when using --no-follow)
  await new Promise((res) => tail.on("close", res));
}

function cmdConfig() {
  ensureDataDir();
  ensureEnvFile();

  if (values.path) {
    console.log(ENV_FILE);
    return;
  }

  const config = loadEffectiveConfig();
  const port = config.PORT || String(DEFAULT_PORT);

  console.log(`\nCallboard Configuration`);
  console.log(`=======================`);

  const passwordStatus = config.AUTH_PASSWORD_HASH ? "****  (hashed)" : "(not set)";
  const configLines = [
    ["PASSWORD", passwordStatus],
    ["PORT", port],
    ["LOG_LEVEL", config.LOG_LEVEL || "info"],
    ["SESSION_COOKIE_NAME", config.SESSION_COOKIE_NAME || "callboard_session  (default)"],
    ["CALLBOARD_WORKSPACES_DIR", config.CALLBOARD_WORKSPACES_DIR || "~/.callboard/agent-workspaces  (default)"],
  ];

  for (const [key, val] of configLines) {
    console.log(`  ${key.padEnd(28)} ${val}`);
  }

  console.log(`\nPaths:`);
  console.log(`  Config:    ${ENV_FILE}`);
  console.log(`  Data:      ${DATA_DIR}/`);
  console.log(`  Logs:      ${LOG_FILE}`);
  console.log(`  PID file:  ${PID_FILE}`);
  console.log();

  warnIfNoPassword();
}

// ── PID utilities ────────────────────────────────────────────────────

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // EPERM = alive but owned by another user
  }
}

function readPid() {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (isNaN(pid)) {
    cleanPidFile();
    return null;
  }
  if (!isProcessAlive(pid)) {
    cleanPidFile();
    return null;
  }
  return pid;
}

function cleanPidFile() {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // Already gone
  }
}

// ── Health check utilities ───────────────────────────────────────────

async function healthCheck(port) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://localhost:${port}/api/auth/check`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await healthCheck(port)) return true;
    await sleep(500);
  }
  return false;
}

async function waitForExit(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(250);
  }
  return false;
}

// ── Config utilities ─────────────────────────────────────────────────

function loadEffectiveConfig() {
  const config = {};
  if (existsSync(ENV_FILE)) {
    Object.assign(config, dotenv.parse(readFileSync(ENV_FILE)));
  }
  // Package-root .env override (same strategy as backend/src/index.ts)
  const rootEnv = join(PKG_ROOT, ".env");
  if (existsSync(rootEnv)) {
    Object.assign(config, dotenv.parse(readFileSync(rootEnv)));
  }
  return config;
}

function getConfiguredPort() {
  const config = loadEffectiveConfig();
  return config.PORT ? parseInt(config.PORT, 10) : null;
}

function warnIfNoPassword() {
  const config = loadEffectiveConfig();
  if (!config.AUTH_PASSWORD_HASH) {
    console.log();
    console.log("  \u26A0 No password is set. Login will be disabled.");
    console.log(`    Set one with: callboard set-password`);
  }
}

// ── Diagnostic utilities ─────────────────────────────────────────────

async function diagnoseStartFailure() {
  if (!existsSync(LOG_FILE)) return;
  try {
    const content = readFileSync(LOG_FILE, "utf-8");
    const lines = content.split("\n").slice(-20);
    const eaddrinuse = lines.find((l) => l.includes("EADDRINUSE"));
    const eacces = lines.find((l) => l.includes("EACCES"));
    if (eaddrinuse) {
      console.log("\n  Error: Port is already in use.");
      console.log("  Another process may be using the same port.");
    } else if (eacces) {
      console.log("\n  Error: Permission denied.");
      console.log("  Try using a port >= 1024.");
    }
  } catch {
    // Best effort
  }
}

// ── Output / formatting ──────────────────────────────────────────────

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function printFirstRunBanner() {
  console.log(`
Welcome to Callboard!

  Created config: ${ENV_FILE}

  Next steps:
    1. Set a password:  callboard set-password
    2. Start server:    callboard start
    3. Open browser:    http://localhost:${DEFAULT_PORT}

  All commands: callboard --help
`);
}

// ── Set-password command ─────────────────────────────────────────────

async function cmdSetPassword() {
  ensureDataDir();
  ensureEnvFile();

  const { hashPassword, generateSalt, validateNewPassword } = await import(join(PKG_ROOT, "backend/dist/utils/password.js"));
  const { updateEnvFile } = await import(join(PKG_ROOT, "backend/dist/utils/env-writer.js"));

  const password = await promptPassword("Enter new password: ");
  if (!password) {
    console.error("Error: Password cannot be empty.");
    process.exit(1);
  }

  const strength = validateNewPassword(password);
  if (!strength.valid) {
    console.error(`Error: ${strength.error}`);
    process.exit(1);
  }

  const confirm = await promptPassword("Confirm new password: ");
  if (password !== confirm) {
    console.error("Error: Passwords do not match.");
    process.exit(1);
  }

  const salt = generateSalt();
  const hash = await hashPassword(password, salt);

  updateEnvFile(
    {
      AUTH_PASSWORD_HASH: hash,
      AUTH_PASSWORD_SALT: salt,
    },
    ["AUTH_PASSWORD"],
  );

  console.log("\nPassword set successfully.");

  const pid = readPid();
  if (pid) {
    console.log("  Restart the server to apply: callboard restart");
  }
}

function promptPassword(prompt) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      // TTY mode: hide input character by character
      process.stdout.write(prompt);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      let password = "";
      const onData = (ch) => {
        ch = ch.toString();
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(password);
        } else if (ch === "\u0003") {
          // Ctrl+C
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(0);
        } else if (ch === "\u007F" || ch === "\b") {
          // Backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
          }
        } else {
          password += ch;
        }
      };
      stdin.on("data", onData);
    } else {
      // Non-TTY (piped input): just read a line
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

function printSetPasswordHelp() {
  console.log(`
callboard set-password

Set or change the server password.

Usage: callboard set-password [options]

Options:
  -h, --help   Show this help message

Prompts for a new password interactively, hashes it with scrypt,
and stores the hash in ~/.callboard/.env. The plaintext password
is never stored.

If the server is running, restart it to apply the new password:
  callboard restart
`);
}

// ── Version check ────────────────────────────────────────────────────

/** Read cached latest version from disk. Returns null if stale or missing. */
function readVersionCache() {
  try {
    if (!existsSync(VERSION_CACHE_FILE)) return null;
    const cache = JSON.parse(readFileSync(VERSION_CACHE_FILE, "utf-8"));
    if (Date.now() - cache.ts < VERSION_CHECK_TTL) return cache.latestVersion;
  } catch {
    // Corrupt cache — ignore
  }
  return null;
}

/** Write latest version to cache file. */
function writeVersionCache(latestVersion) {
  try {
    writeFileSync(VERSION_CACHE_FILE, JSON.stringify({ latestVersion, ts: Date.now() }) + "\n");
  } catch {
    // Best effort
  }
}

/** Fetch the latest version from the npm registry (non-blocking, best effort). */
async function fetchLatestVersion() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data.version || null;
  } catch {
    return null;
  }
}

/** Compare two semver-like version strings. Returns true if remote > local. */
function isNewerVersion(local, remote) {
  if (!local || !remote || local === remote) return false;
  // Normalize: split on "-" to separate base from prerelease
  const [localBase, localPre] = local.split("-");
  const [remoteBase, remotePre] = remote.split("-");
  const localParts = localBase.split(".").map(Number);
  const remoteParts = remoteBase.split(".").map(Number);
  for (let i = 0; i < Math.max(localParts.length, remoteParts.length); i++) {
    const l = localParts[i] || 0;
    const r = remoteParts[i] || 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  // Same base version — compare prerelease
  // No prerelease > any prerelease (1.0.0 > 1.0.0-alpha)
  if (!remotePre && localPre) return true;
  if (remotePre && !localPre) return false;
  if (remotePre && localPre) return remotePre > localPre;
  return false;
}

/**
 * Check for a newer version. Uses cache if fresh, otherwise fetches in background.
 * Returns the latest version string if newer, or null.
 */
async function checkForUpdate() {
  const cached = readVersionCache();
  if (cached) {
    return isNewerVersion(VERSION, cached) ? cached : null;
  }
  // Fetch and cache in background — don't block CLI
  const latest = await fetchLatestVersion();
  if (latest) {
    writeVersionCache(latest);
    return isNewerVersion(VERSION, latest) ? latest : null;
  }
  return null;
}

/** Print an update notice to the console. */
function printUpdateNotice(latestVersion) {
  console.log();
  console.log(`  Update available: v${VERSION} → v${latestVersion}`);
  console.log(`  Run: npm install -g ${PKG_NAME}`);
}

// ── Help text ────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
callboard v${VERSION}

Usage: callboard [command] [options]

Commands:
  start          Start the server (background by default)
  stop           Stop the background server
  restart        Restart the background server
  status         Show server status (PID, port, uptime, health)
  logs           View and follow server logs
  config         Show effective configuration
  set-password   Set or change the server password
  sandbox        Build or check the Sandbox desktop image and profiles (Docker)

Options:
  -h, --help     Show this help message
  -v, --version  Show version number

Running 'callboard' with no arguments shows status (if running) or this help.
Use 'callboard start --foreground' to run in the foreground.

Examples:
  callboard                    Show status or help
  callboard start              Start server in background
  callboard start -f           Start server in foreground
  callboard start --port 3000  Start on a custom port
  callboard status             Check if server is running
  callboard logs -n 100        View last 100 log lines
`);
}

function printSandboxHelp() {
  console.log(`
callboard sandbox

Build or check the Sandbox desktop image. Callboard starts and stops one
container per computer-control session itself; this only provides the image.

Usage: callboard sandbox <build|status|profiles|rm> [options]

Commands:
  build             Build the image and its builder stage (docker build); skipped if up to date
  build --profile <name> [--scope <scope>]
                    Build one sandbox profile's image (the base first, if needed)
  profiles          List the sandbox profiles, their limits and image state
  rm --profile <name> [--scope <scope>]
                    Remove a profile's image (scope: global, the default, or a workspace key)
  status            Show Docker, the image and running managed sandboxes

Options:
  --force           build: rebuild even if the image is up to date
`);
}

function printStartHelp() {
  console.log(`
callboard start

Start the Callboard server.

Usage: callboard start [options]

Options:
  -f, --foreground  Run in foreground instead of daemonizing
  --port <number>   Override the configured port
  -h, --help        Show this help message

By default, starts the server as a background daemon. The server
process ID is stored in ~/.callboard/callboard.pid.
`);
}

function printStopHelp() {
  console.log(`
callboard stop

Stop the Callboard server.

Usage: callboard stop [options]

Options:
  -h, --help   Show this help message

Sends SIGTERM to the server process and waits for graceful shutdown.
Falls back to SIGKILL if the process does not exit within 45 seconds
(time for managed Sandbox desktops to be drained and removed).
`);
}

function printRestartHelp() {
  console.log(`
callboard restart

Restart the Callboard server.

Usage: callboard restart [options]

Options:
  --port <number>   Override the configured port
  -h, --help        Show this help message

Stops the running server (if any) and starts a new instance.
`);
}

function printStatusHelp() {
  console.log(`
callboard status

Show server status.

Usage: callboard status [options]

Options:
  -h, --help   Show this help message

Displays PID, port, uptime, and health check result.
Also warns if AUTH_PASSWORD is not configured.
`);
}

function printLogsHelp() {
  console.log(`
callboard logs

View server logs.

Usage: callboard logs [options]

Options:
  -n, --lines <number>  Number of lines to show (default: 50)
  --no-follow            Print lines and exit (default: follow/tail)
  -h, --help             Show this help message

Log file: ~/.callboard/logs/callboard.log
`);
}

function printConfigHelp() {
  console.log(`
callboard config

Show effective configuration.

Usage: callboard config [options]

Options:
  --path       Print the config file path only
  -h, --help   Show this help message

Reads ~/.callboard/.env (and any project-root .env overrides)
and displays the merged configuration. Passwords are masked.
`);
}
