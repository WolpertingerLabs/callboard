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
const DEFAULT_PORT = 8000;

// Read version from package.json
const pkgJson = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8"));
const VERSION = pkgJson.version;

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
      follow: { type: "boolean", default: true },
      path: { type: "boolean", default: false },
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
  case "help":
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${subcommand}\n`);
    printHelp();
    process.exit(1);
}

// ── Commands ─────────────────────────────────────────────────────────

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

  const stopped = await waitForExit(pid, 5000);
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
  const follow = values.follow;

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

  const configLines = [
    ["AUTH_PASSWORD", config.AUTH_PASSWORD ? "****  (set)" : "(not set)"],
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
  if (!config.AUTH_PASSWORD) {
    console.log();
    console.log("  \u26A0 AUTH_PASSWORD is not set. Login will be disabled.");
    console.log(`    Set it in: ${ENV_FILE}`);
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
    1. Set a password:  edit ${ENV_FILE}
       Set AUTH_PASSWORD=your-secret-password
    2. Start server:    callboard start
    3. Open browser:    http://localhost:${DEFAULT_PORT}

  All commands: callboard --help
`);
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
Falls back to SIGKILL if the process does not exit within 5 seconds.
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
