#!/usr/bin/env node

// ── Drawlatch CLI ─────────────────────────────────────────────────
// Entry point for the `drawlatch` command after global npm install.
// Provides daemon management for the remote server, key generation,
// log viewing, config introspection — all with zero extra dependencies.
// ───────────────────────────────────────────────────────────────────

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths & constants ─────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = resolve(__dirname, "..");
const SERVER_ENTRY = join(PKG_ROOT, "dist/remote/server.js");
const GENERATE_KEYS_ENTRY = join(PKG_ROOT, "dist/cli/generate-keys.js");

// Import config helpers from compiled drawlatch code
const { getConfigDir, getEnvFilePath, getCallerKeysDir, getServerKeysDir, getProxyConfigPath, getRemoteConfigPath, loadProxyConfig, loadRemoteConfig, connectorWithholdingWarnings, STOP_KILL_AFTER_MS } = await import(
  join(PKG_ROOT, "dist/shared/config.js")
);

// Import crypto helpers for init command
const { generateKeyBundle, saveKeyBundle, extractPublicKeys, fingerprint, loadKeyBundle, loadPublicKeys } = await import(
  join(PKG_ROOT, "dist/shared/crypto/index.js")
);

// Import connection template helpers
const { listConnectionTemplates } = await import(
  join(PKG_ROOT, "dist/shared/connections.js")
);

// Import env utils
const { isSecretSetForCaller, loadEnvFile: loadEnvFileVars } = await import(
  join(PKG_ROOT, "dist/shared/env-utils.js")
);

// Import the vault health check (doctor). It reads the vault files; this CLI never names them.
const { vaultDiagnostics } = await import(
  join(PKG_ROOT, "dist/remote/vault/store.js")
);

const CONFIG_DIR = getConfigDir();
const ENV_FILE = getEnvFilePath();
const PID_FILE = join(CONFIG_DIR, "drawlatch.pid");
const LOG_DIR = join(CONFIG_DIR, "logs");
const LOG_FILE = join(LOG_DIR, "drawlatch.log");
const VERSION_CACHE_FILE = join(CONFIG_DIR, "latest-version.json");
const VERSION_CHECK_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Read version from package.json
const pkgJson = JSON.parse(
  readFileSync(join(PKG_ROOT, "package.json"), "utf-8"),
);
const VERSION = pkgJson.version;

// ── Argument parsing ──────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const subcommand =
  rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs.shift() : null;

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    args: rawArgs,
    options: {
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      foreground: { type: "boolean", short: "f", default: false },
      tunnel: { type: "boolean", short: "t", default: false },
      port: { type: "string" },
      host: { type: "string" },
      lines: { type: "string", short: "n", default: "50" },
      follow: { type: "boolean", default: false },
      path: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      requests: { type: "boolean", default: false },
      name: { type: "string" },
      connections: { type: "string" },
      endpoint: { type: "string" },
      passphrase: { type: "boolean", default: false },
      output: { type: "string", short: "o" },
      into: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  }));
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

// ── Kick off version check early (non-blocking) ──────────────────
const updateCheckPromise = (subcommand === null || subcommand === "help" || (values.help && !subcommand))
  ? checkForUpdate()
  : Promise.resolve(null);

// ── Dispatch ──────────────────────────────────────────────────────
if (values.version) {
  console.log(VERSION);
  process.exit(0);
}
if (values.help && !subcommand) {
  printHelp();
  const latestVersion = await Promise.race([
    updateCheckPromise,
    new Promise((r) => setTimeout(() => r(null), 100)),
  ]);
  if (latestVersion) console.log(formatUpdateNotice(latestVersion));
  process.exit(0);
}

switch (subcommand) {
  case null:
    await cmdDefault();
    break;
  case "init":
    if (values.help) {
      printInitHelp();
    } else {
      await cmdInit();
    }
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
  case "generate-keys":
    if (values.help) {
      printGenerateKeysHelp();
    } else {
      await cmdGenerateKeys();
    }
    break;
  case "doctor":
    if (values.help) {
      printDoctorHelp();
    } else {
      await cmdDoctor();
    }
    break;
  case "issue-caller":
    if (values.help) {
      printIssueCallerHelp();
    } else {
      await cmdIssueCaller();
    }
    break;
  case "set-password":
  case "change-password":
    if (values.help) {
      printSetPasswordHelp(subcommand);
    } else {
      await cmdSetPassword();
    }
    break;
  case "watch":
    if (values.help) {
      printWatchHelp();
    } else {
      await cmdWatch();
    }
    break;
  case "help":
    printHelp();
    {
      const latestVersion = await Promise.race([
        updateCheckPromise,
        new Promise((r) => setTimeout(() => r(null), 100)),
      ]);
      if (latestVersion) console.log(formatUpdateNotice(latestVersion));
    }
    break;
  default:
    console.error(`Unknown command: ${subcommand}\n`);
    printHelp();
    process.exit(1);
}

// ── Commands ──────────────────────────────────────────────────────

async function cmdDefault() {
  const pid = readPid();
  if (pid) {
    await cmdStatus();
  } else {
    console.log("Drawlatch remote server is not running.\n");
    printHelp();
  }
  // Show update notice only if the check already resolved (don't block on network)
  const latestVersion = await Promise.race([
    updateCheckPromise,
    new Promise((r) => setTimeout(() => r(null), 100)),
  ]);
  if (latestVersion) console.log(formatUpdateNotice(latestVersion));
}

async function cmdInit() {
  console.log(`\nDrawlatch Setup`);
  console.log(`===============\n`);

  const steps = [];

  // Step 1: Ensure config directory
  ensureConfigDir();
  steps.push(`Config directory: ${CONFIG_DIR}`);

  // Step 2: Generate server keypair
  const serverKeysDir = getServerKeysDir();
  if (existsSync(join(serverKeysDir, "signing.key.pem"))) {
    const existing = loadKeyBundle(serverKeysDir);
    const fp = fingerprint(extractPublicKeys(existing));
    steps.push(`Server keys: already exist (${fp})`);
  } else {
    const bundle = generateKeyBundle();
    saveKeyBundle(bundle, serverKeysDir);
    const fp = fingerprint(extractPublicKeys(bundle));
    steps.push(`Server keys: CREATED (${fp})`);
  }

  // Step 3: Scaffold proxy.config.json
  const proxyConfigPath = getProxyConfigPath();
  if (existsSync(proxyConfigPath)) {
    steps.push(`Proxy config: already exists`);
  } else {
    // No proxy.config.json yet, so loadProxyConfig() returns the built-in
    // defaults. Taking the timeouts from there keeps the scaffold from drifting
    // past MAX_LOCAL_TIMEOUT_MS, where requestTimeout is silently clamped.
    const { connectTimeout, requestTimeout } = loadProxyConfig();
    const proxyConfig = {
      remoteUrl: "http://127.0.0.1:9999",
      connectTimeout,
      requestTimeout,
    };
    writeFileSync(proxyConfigPath, JSON.stringify(proxyConfig, null, 2) + "\n", { mode: 0o600 });
    steps.push(`Proxy config: CREATED`);
  }

  // Step 4: Scaffold remote.config.json
  const remoteConfigPath = getRemoteConfigPath();
  if (existsSync(remoteConfigPath)) {
    steps.push(`Remote config: already exists`);
  } else {
    const remoteConfig = {
      host: "0.0.0.0",
      port: 9999,
      rateLimitPerMinute: 60,
      callers: {},
    };
    writeFileSync(remoteConfigPath, JSON.stringify(remoteConfig, null, 2) + "\n", { mode: 0o600 });
    steps.push(`Remote config: CREATED`);
  }

  // Step 5: Scaffold .env file
  if (existsSync(ENV_FILE)) {
    steps.push(`.env file: already exists`);
  } else {
    const envLines = [
      "# Drawlatch environment secrets",
      "# Set tokens for your enabled connections",
      "# Secrets are prefixed per caller (e.g., DEFAULT_GITHUB_TOKEN)",
      "",
    ];
    writeFileSync(ENV_FILE, envLines.join("\n") + "\n", { mode: 0o600 });
    steps.push(`.env file: CREATED`);
  }

  // Print summary
  for (const step of steps) {
    console.log(`  ${step}`);
  }

  console.log(`\nSetup complete! Next steps:\n`);
  console.log(`  1. Set the dashboard password:`);
  console.log(`       drawlatch set-password\n`);
  console.log(`  2. Start the remote server:`);
  console.log(`       drawlatch start\n`);
  console.log(`  3. Issue a caller credential bundle (or use the dashboard Callers page):`);
  console.log(`       drawlatch issue-caller callboard-prod -o callboard-prod.drawlatch-caller.json\n`);
  console.log(`  4. Verify your setup:`);
  console.log(`       drawlatch doctor\n`);
}



async function cmdStart() {
  if (values.foreground) return cmdStartForeground();

  ensureConfigDir();

  const existingPid = readPid();
  if (existingPid) {
    console.log(`Remote server is already running (PID ${existingPid}).`);
    console.log(`  Use: drawlatch status`);
    process.exit(0);
  }

  const config = loadRemoteConfig();
  const port = values.port ? parseInt(values.port, 10) : config.port;
  const host = values.host || config.host;

  mkdirSync(LOG_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, "a");

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      NODE_ENV: "production",
      ...(values.port ? { DRAWLATCH_PORT: String(port) } : {}),
      ...(values.host ? { DRAWLATCH_HOST: host } : {}),
      ...(values.tunnel ? { DRAWLATCH_TUNNEL: "1" } : {}),
    },
    cwd: PKG_ROOT,
  });

  writeFileSync(PID_FILE, String(child.pid) + "\n");
  child.unref();

  console.log(`Starting drawlatch remote server on ${host}:${port}...`);
  const healthy = await waitForHealth(host, port, 5000);

  if (healthy) {
    console.log(`\nRemote server is running (PID ${child.pid}).`);
    console.log(`  Listening: ${host}:${port}`);
    if (values.tunnel) {
      // The tunnel starts asynchronously after the server is healthy —
      // poll the health endpoint until the tunnel URL appears (up to 20s).
      console.log(`  Tunnel:    waiting for cloudflared...`);
      const tunnelUrl = await waitForTunnelUrl(host, port, 20000);
      if (tunnelUrl) {
        console.log(`  Tunnel:    ${tunnelUrl}`);
        console.log(`  Webhooks:  ${tunnelUrl}/webhooks/<path>`);
      } else {
        console.log(`  Tunnel:    not available (check logs: drawlatch logs)`);
      }
    }
    console.log(`  Logs:      drawlatch logs`);
  } else {
    const stillAlive = isProcessAlive(child.pid);
    if (stillAlive) {
      console.log(
        `\nServer started (PID ${child.pid}) but health check did not pass within 5s.`,
      );
      console.log(`  The server process is still running — it may need more time.`);
    } else {
      console.log(`\nServer process (PID ${child.pid}) exited before becoming healthy.`);
      cleanPidFile();
    }
    await diagnoseStartFailure();
  }
}

async function cmdStartForeground() {
  process.env.NODE_ENV = process.env.NODE_ENV || "production";
  if (values.port) process.env.DRAWLATCH_PORT = values.port;
  if (values.host) process.env.DRAWLATCH_HOST = values.host;
  if (values.tunnel) process.env.DRAWLATCH_TUNNEL = "1";

  ensureConfigDir();

  const { main } = await import(SERVER_ENTRY);
  main();
}

async function cmdStop() {
  const pid = readPid();
  if (!pid) {
    console.log("Remote server is not running.");
    process.exit(0);
  }

  console.log(`Stopping remote server (PID ${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already gone
    cleanPidFile();
    console.log("Server stopped.");
    return;
  }

  // Long enough for the daemon's own forced exit and final audit flush;
  // SIGKILL is only for a daemon that has wedged.
  const stopped = await waitForExit(pid, STOP_KILL_AFTER_MS);
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
    // If the previous server had an active tunnel, carry the flag forward
    // so the restarted server also starts a tunnel (unless --tunnel is
    // already set or the user explicitly omitted it).
    if (!values.tunnel) {
      const config = loadRemoteConfig();
      const prevHealth = await healthCheckFull(config.host, config.port);
      if (prevHealth?.tunnelUrl) {
        console.log("Previous server had an active tunnel — re-enabling --tunnel.");
        values.tunnel = true;
      }
    }
    await cmdStop();
  }
  await cmdStart();
}

async function cmdStatus() {
  const pid = readPid();
  if (!pid) {
    console.log("Drawlatch remote server is not running.");
    process.exit(0);
  }

  const config = loadRemoteConfig();
  const port = config.port;
  const host = config.host;

  let uptime = "unknown";
  try {
    const pidStat = await stat(PID_FILE);
    uptime = formatUptime(Date.now() - pidStat.mtimeMs);
  } catch {
    // Can't stat PID file
  }

  const healthData = await healthCheckFull(host, port);

  console.log("Drawlatch remote server is running.");
  console.log(`  PID:             ${pid}`);
  console.log(`  Listening:       ${host}:${port}`);
  console.log(`  Dashboard:       http://${connectHost(host)}:${port}/`);
  console.log(
    `  Password:        ${isPasswordConfigured() ? "configured" : "not set (run: drawlatch set-password)"}`,
  );
  console.log(`  Uptime:          ${uptime}`);
  console.log(
    `  Health:          ${healthData ? "healthy" : "unhealthy (not responding)"}`,
  );
  if (healthData) {
    console.log(`  Active sessions: ${healthData.activeSessions}`);
    if (healthData.tunnelUrl) {
      console.log(`  Tunnel:          ${healthData.tunnelUrl}`);
    }
  }
}

async function cmdLogs() {
  if (!existsSync(LOG_FILE)) {
    console.log("No log file found. Start the server first:");
    console.log("  drawlatch start");
    process.exit(0);
  }

  const lines = parseInt(values.lines, 10) || 50;
  const follow = values.follow;
  const showRequests = values.requests;

  const tailArgs = follow
    ? ["-n", String(lines), "-f", LOG_FILE]
    : ["-n", String(lines), LOG_FILE];

  if (showRequests) {
    // Show everything — pipe directly to stdout
    const tail = spawn("tail", tailArgs, { stdio: "inherit" });

    tail.on("error", () => logsFallback(lines, follow, null));

    process.on("SIGINT", () => {
      tail.kill();
      process.exit(0);
    });

    await new Promise((res) => tail.on("close", res));
  } else {
    // Filter out [audit] lines (request/response noise from poll_events etc.)
    const tail = spawn("tail", tailArgs, { stdio: ["ignore", "pipe", "inherit"] });
    const grepProc = spawn("grep", ["-v", "^\\[audit\\]"], {
      stdio: [tail.stdout, "inherit", "inherit"],
    });

    tail.on("error", () => logsFallback(lines, follow, "[audit]"));

    process.on("SIGINT", () => {
      tail.kill();
      grepProc.kill();
      process.exit(0);
    });

    await new Promise((res) => grepProc.on("close", res));
  }
}

function logsFallback(lines, follow, filterPrefix) {
  try {
    const content = readFileSync(LOG_FILE, "utf-8");
    let allLines = content.split("\n");
    if (filterPrefix) {
      allLines = allLines.filter((l) => !l.startsWith(filterPrefix));
    }
    const lastLines = allLines.slice(-lines).join("\n");
    console.log(lastLines);
    if (follow) {
      console.log(
        "\n(Live following not available \u2014 'tail' command not found)",
      );
    }
  } catch (err) {
    console.error(`Error reading log file: ${err.message}`);
    process.exit(1);
  }
}

async function cmdWatch() {
  const config = loadRemoteConfig();
  const port = config.port;
  const host = config.host;

  // Verify the server is running
  const healthy = await healthCheck(host, port);
  if (!healthy) {
    console.error("Remote server is not running. Start it first:");
    console.error("  drawlatch start");
    process.exit(1);
  }

  const showFull = values.full;
  const sourceFilter = positionals[0] || null;

  console.log("Watching for events" + (sourceFilter ? ` from "${sourceFilter}"` : "") + "...");
  console.log("Press Ctrl+C to stop.\n");

  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
    process.exit(0);
  });

  try {
    const res = await fetch(
      `http://${connectHost(host)}:${port}/events/stream`,
      { signal: controller.signal },
    );

    if (!res.ok) {
      console.error(`Failed to connect to event stream: HTTP ${res.status}`);
      process.exit(1);
    }

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });

      // Parse SSE lines
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n\n")) !== -1) {
        const message = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 2);

        for (const line of message.split("\n")) {
          if (!line.startsWith("data: ")) continue;

          try {
            const event = JSON.parse(line.slice(6));

            // Apply source filter if set
            if (sourceFilter && event.source !== sourceFilter) continue;

            const time = new Date(event.receivedAt).toLocaleTimeString();
            const source = event.source;
            const instance = event.instanceId ? `:${event.instanceId}` : "";
            const caller = event.callerAlias || "?";
            const eventType = event.eventType;

            const dataStr = JSON.stringify(event.data);

            if (showFull) {
              console.log(
                `\x1b[2m${time}\x1b[0m \x1b[36m${source}${instance}\x1b[0m \x1b[33m${eventType}\x1b[0m \x1b[2m(${caller})\x1b[0m`
              );
              console.log(dataStr);
              console.log("");
            } else {
              const preview =
                dataStr.length > 100
                  ? dataStr.slice(0, 100) + "…"
                  : dataStr;
              console.log(
                `\x1b[2m${time}\x1b[0m \x1b[36m${source}${instance}\x1b[0m \x1b[33m${eventType}\x1b[0m \x1b[2m(${caller})\x1b[0m ${preview}`
              );
            }
          } catch {
            // Skip malformed SSE data
          }
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(`Event stream error: ${err.message}`);
    process.exit(1);
  }
}

function cmdConfig() {
  ensureConfigDir();

  if (values.path) {
    console.log(join(CONFIG_DIR, "remote.config.json"));
    return;
  }

  const config = loadRemoteConfig();

  console.log(`\nDrawlatch Configuration`);
  console.log(`=======================`);

  console.log(`\nRemote Server:`);
  console.log(`  Host:               ${config.host}`);
  console.log(`  Port:               ${config.port}`);
  console.log(`  Rate limit:         ${config.rateLimitPerMinute} req/min`);
  console.log(`  Server keys dir:    ${getServerKeysDir()}`);

  // Show key fingerprints if keys exist
  const serverKeysPath = getServerKeysDir();
  if (existsSync(join(serverKeysPath, "signing.key.pem"))) {
    try {
      const serverKeys = loadKeyBundle(serverKeysPath);
      console.log(`  Server key fp:      ${fingerprint(extractPublicKeys(serverKeys))}`);
    } catch { /* skip */ }
  }

  const callerEntries = Object.entries(config.callers || {});
  console.log(`  Callers:            ${callerEntries.length}`);

  // Build template map for secret status checking
  const templates = listConnectionTemplates();
  const templateMap = new Map(templates.map((t) => [t.alias, t]));

  // Load .env vars into process.env so isSecretSetForCaller works.
  // Force-set to override empty shell env vars.
  const envVars = loadEnvFileVars();
  for (const [k, v] of Object.entries(envVars)) {
    process.env[k] = v;
  }

  for (const [alias, caller] of callerEntries) {
    console.log(
      `    ${alias}: ${caller.connections ? caller.connections.length : 0} connection(s)`,
    );
    for (const connName of caller.connections || []) {
      const tpl = templateMap.get(connName);
      if (!tpl) {
        console.log(`      ${connName} (custom connector)`);
        continue;
      }
      const secretStatuses = tpl.requiredSecrets.map((s) => {
        const set = isSecretSetForCaller(s, alias, caller.env);
        return `${s}: ${set ? "SET" : "NOT SET"}`;
      });
      if (secretStatuses.length > 0) {
        console.log(`      ${connName}: ${secretStatuses.join(", ")}`);
      } else {
        console.log(`      ${connName}: (no secrets required)`);
      }
    }
  }

  console.log(
    `  Connectors:         ${config.connectors ? config.connectors.length : 0}`,
  );

  console.log(`\nPaths:`);
  console.log(`  Config dir:  ${CONFIG_DIR}`);
  console.log(`  Env file:    ${ENV_FILE}`);
  console.log(`  Remote cfg:  ${join(CONFIG_DIR, "remote.config.json")}`);
  console.log(`  Proxy cfg:   ${join(CONFIG_DIR, "proxy.config.json")}`);
  console.log(`  Logs:        ${LOG_FILE}`);
  console.log(`  PID file:    ${PID_FILE}`);
  console.log();
}

async function cmdGenerateKeys() {
  // Forward all remaining positional args to the generate-keys script
  const child = spawn(process.execPath, [GENERATE_KEYS_ENTRY, ...positionals], {
    stdio: "inherit",
    cwd: PKG_ROOT,
  });

  await new Promise((res) => child.on("close", res));
  process.exit(child.exitCode ?? 0);
}


async function cmdDoctor() {
  console.log(`\nDrawlatch Setup Check`);
  console.log(`=====================\n`);

  let passed = 0;
  let failed = 0;

  function check(label, ok, fix) {
    const padded = label.padEnd(50);
    if (ok) {
      console.log(`  ${padded} PASS`);
      passed++;
    } else {
      console.log(`  ${padded} FAIL`);
      if (fix) console.log(`    -> ${fix}`);
      failed++;
    }
    return ok;
  }

  // Load .env for secret checks
  const envVars = loadEnvFileVars();
  for (const [k, v] of Object.entries(envVars)) {
    process.env[k] = v;
  }

  // 1. Config directory
  check("Config directory", existsSync(CONFIG_DIR), "Run: drawlatch init");

  // 2. Remote config
  const remoteConfigPath = getRemoteConfigPath();
  const hasRemoteConfig = existsSync(remoteConfigPath);
  check("Remote config (remote.config.json)", hasRemoteConfig, "Run: drawlatch init");

  // 3. Proxy config
  const proxyConfigPath = getProxyConfigPath();
  const hasProxyConfig = existsSync(proxyConfigPath);
  check("Proxy config (proxy.config.json)", hasProxyConfig, "Run: drawlatch init");

  // 4. Server keys
  const serverKeysPath = getServerKeysDir();
  const hasServerKeys = existsSync(join(serverKeysPath, "signing.key.pem")) &&
                        existsSync(join(serverKeysPath, "exchange.key.pem")) &&
                        existsSync(join(serverKeysPath, "signing.pub.pem")) &&
                        existsSync(join(serverKeysPath, "exchange.pub.pem"));
  check("Server keys (keys/server/)", hasServerKeys, "Run: drawlatch generate-keys server");

  if (hasServerKeys) {
    try {
      const sk = loadKeyBundle(serverKeysPath);
      console.log(`    Fingerprint: ${fingerprint(extractPublicKeys(sk))}`);
    } catch { /* skip */ }
  }

  // 5. Caller keys — check each caller from config
  if (hasRemoteConfig) {
    try {
      const config = loadRemoteConfig();
      const callersDir = getCallerKeysDir();
      for (const [alias] of Object.entries(config.callers)) {
        const callerDir = join(callersDir, alias);
        const hasCallerKeys = existsSync(join(callerDir, "signing.pub.pem")) &&
                              existsSync(join(callerDir, "exchange.pub.pem"));
        check(`Caller keys for "${alias}" (keys/callers/${alias}/)`, hasCallerKeys, `Run: drawlatch generate-keys caller ${alias}`);

        if (hasCallerKeys) {
          try {
            const pk = loadPublicKeys(callerDir);
            console.log(`    Fingerprint: ${fingerprint(pk)}`);
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  // 8. .env file
  check("Environment file (.env)", existsSync(ENV_FILE), "Run: drawlatch init");

  // 9. Required secrets for each caller's connections
  if (hasRemoteConfig) {
    try {
      const config = loadRemoteConfig();
      const templates = listConnectionTemplates();
      const templateMap = new Map(templates.map((t) => [t.alias, t]));

      for (const [callerAlias, caller] of Object.entries(config.callers)) {
        for (const connName of caller.connections) {
          const tpl = templateMap.get(connName);
          if (!tpl) continue;
          for (const secret of tpl.requiredSecrets) {
            const isSet = isSecretSetForCaller(secret, callerAlias, caller.env);
            check(`  ${callerAlias}/${connName}: ${secret}`, isSet, `Set ${secret} in ${ENV_FILE}`);
          }
        }
      }
    } catch { /* skip */ }
  }

  // 9b. Custom connectors affected by secret withholding (header secrets
  // can't be referenced in requests; placeholderSecrets is the escape hatch).
  if (hasRemoteConfig) {
    try {
      const config = loadRemoteConfig();
      for (const connector of config.connectors ?? []) {
        const warnings = connectorWithholdingWarnings(connector);
        check(
          `Connector "${connector.alias ?? connector.name ?? "(unnamed)"}": withheld secrets`,
          warnings.length === 0,
          warnings.join("\n    -> "),
        );
      }
    } catch { /* skip */ }
  }

  // 9c. Vault: key present when the file exists, key mode 0600, file decrypts.
  try {
    for (const c of vaultDiagnostics()) {
      check(c.label, c.ok, c.fix);
      if (c.ok && c.info) console.log(`    ${c.info}`);
    }
  } catch (err) {
    check("Vault", false, err instanceof Error ? err.message : String(err));
  }

  // 10. Remote server health check
  if (hasRemoteConfig) {
    try {
      const config = loadRemoteConfig();
      const healthy = await healthCheck(config.host, config.port);
      check(`Remote server health (${config.host}:${config.port})`, healthy, "Run: drawlatch start");
    } catch {
      check("Remote server health", false, "Run: drawlatch start");
    }
  }

  // Summary
  const total = passed + failed;
  console.log(`\nResult: ${passed}/${total} checks passed`);
  if (failed > 0) {
    console.log(`Fix the ${failed} failing check(s) above and re-run: drawlatch doctor`);
  } else {
    console.log(`All checks passed! Your setup is ready.`);
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

// ── issue-caller ──────────────────────────────────────────────────────────
//
// Mint a caller credential bundle using the same primitive as the dashboard
// "Issue credentials" action. Two delivery modes:
//   - default / -o file : emit the {alias}.drawlatch-caller.json bundle (the
//     caller PRIVATE key is in the file; drawlatch keeps only the public key).
//   - --into <keysDir>  : write the UNPACKED key files straight into a
//     co-located callboard's keys dir (same-host convenience).
async function cmdIssueCaller() {
  const alias = positionals[0];
  if (!alias) {
    console.error("Error: caller alias is required.\n  Usage: drawlatch issue-caller <alias> [options]");
    process.exit(1);
  }

  ensureConfigDir();

  const { issueCallerBundle, issueLocalCaller, CALLER_ALIAS_REGEX } = await import(
    join(PKG_ROOT, "dist/remote/caller-bootstrap.js")
  );

  if (!CALLER_ALIAS_REGEX.test(alias)) {
    console.error(
      "Error: invalid alias. Use letters, numbers, dashes or underscores (must start alphanumeric).",
    );
    process.exit(1);
  }

  const connections = values.connections
    ? values.connections.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const name = values.name;

  try {
    // ── Mode 2: write unpacked key files directly into callboard's keys dir ──
    if (values.into) {
      const keysDir = resolve(values.into);
      const res = issueLocalCaller({
        alias,
        keysDir,
        ...(connections ? { connections } : {}),
        ...(name ? { name } : {}),
      });
      console.log(`\nIssued local caller "${res.alias}" (write-to-path).`);
      console.log(`  Key files:   ${res.callerKeysDir}/`);
      console.log(`  Server keys: ${join(keysDir, "server")}/`);
      console.log(`  Fingerprint: ${res.fingerprint}`);
      console.log(`  Connections: ${res.connections.join(", ") || "(none)"}`);
      notifyDaemonReloadNeeded();
      return;
    }

    // ── Mode 1: emit a bundle (file or stdout) ──────────────────────────────
    const config = loadRemoteConfig();
    const endpoint = values.endpoint || `http://${connectHost(config.host)}:${config.port}`;

    let passphrase;
    if (values.passphrase) {
      let confirm;
      if (process.stdin.isTTY) {
        passphrase = await promptPasswordTTY("Passphrase to protect private keys: ");
        confirm = await promptPasswordTTY("Confirm passphrase: ");
      } else {
        // Piped input — read both lines from one readline interface.
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin });
        [passphrase, confirm] = await readTwoLines(rl);
        rl.close();
      }
      if (!passphrase) {
        console.error("Error: passphrase cannot be empty.");
        process.exit(1);
      }
      if (passphrase !== confirm) {
        console.error("Error: passphrases do not match.");
        process.exit(1);
      }
    }

    const bundle = issueCallerBundle({
      alias,
      endpointUrl: endpoint,
      ...(connections ? { connections } : {}),
      ...(name ? { name } : {}),
      ...(passphrase ? { passphrase } : {}),
    });

    const json = JSON.stringify(bundle, null, 2) + "\n";

    if (values.output) {
      const outPath = resolve(values.output);
      writeFileSync(outPath, json, { mode: 0o600 });
      console.error(`\nWrote credential bundle to ${outPath}`);
      console.error(`  Caller:      ${bundle.callerAlias}`);
      console.error(`  Fingerprint: ${bundle.fingerprint}`);
      console.error(`  Endpoint:    ${bundle.endpointUrl}`);
      console.error(
        bundle.encryption
          ? `  Private keys: passphrase-protected (share the passphrase out-of-band).`
          : `  Private keys: PLAINTEXT in the file — protect it (or use --passphrase).`,
      );
      console.error(`  This file contains the caller PRIVATE key and won't be re-issued.`);
      notifyDaemonReloadNeeded();
    } else {
      // Bundle (with private keys) to stdout; notes to stderr.
      process.stdout.write(json);
      console.error(`\n# Caller "${bundle.callerAlias}" issued (fingerprint ${bundle.fingerprint}).`);
      if (!bundle.encryption) {
        console.error(`# WARNING: private keys are PLAINTEXT above. Use --passphrase or -o to a 0600 file.`);
      }
      notifyDaemonReloadNeeded();
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

/** If the daemon is running, it won't authorize a freshly-issued caller until
 *  it reloads its peer set — tell the user to restart it. (The dashboard issue
 *  flow live-reloads peers; the offline CLI path cannot.) */
function notifyDaemonReloadNeeded() {
  if (readPid()) {
    console.error(`\nNote: restart the daemon so it authorizes the new caller — drawlatch restart`);
  }
}

// ── set-password / change-password ────────────────────────────────
//
// Sets the dashboard/admin password. The scrypt hash + salt are written to
// ~/.drawlatch/.env (AUTH_PASSWORD_HASH / AUTH_PASSWORD_SALT) using the same
// env-writer the daemon's change-password handler uses, so both stay in sync.
async function cmdSetPassword() {
  ensureConfigDir();

  const { hashPassword, generateSalt } = await import(
    join(PKG_ROOT, "dist/auth/password.js")
  );
  const { updateEnvFile } = await import(
    join(PKG_ROOT, "dist/auth/env-writer.js")
  );

  let password, confirm;
  if (process.stdin.isTTY) {
    password = await promptPasswordTTY("Enter new password: ");
    if (!password) {
      console.error("Error: password cannot be empty.");
      process.exit(1);
    }
    if (password.length < 8) {
      console.error("Error: password must be at least 8 characters.");
      process.exit(1);
    }
    confirm = await promptPasswordTTY("Confirm new password: ");
  } else {
    // Piped input — read both lines from a single readline interface so
    // closing it doesn't break the second prompt.
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin });
    [password, confirm] = await readTwoLines(rl);
    rl.close();
    if (!password) {
      console.error("Error: password cannot be empty.");
      process.exit(1);
    }
    if (password.length < 8) {
      console.error("Error: password must be at least 8 characters.");
      process.exit(1);
    }
  }

  if (password !== confirm) {
    console.error("Error: passwords do not match.");
    process.exit(1);
  }

  const salt = generateSalt();
  const hash = await hashPassword(password, salt);

  updateEnvFile(
    { AUTH_PASSWORD_HASH: hash, AUTH_PASSWORD_SALT: salt },
    ["AUTH_PASSWORD"], // strip any plaintext leftover, just in case
  );

  console.log("\nPassword set successfully.");
  console.log(`  Stored in: ${ENV_FILE}`);

  const pid = readPid();
  if (pid) {
    console.log("  Restart the server to apply: drawlatch restart");
  }
}

function readTwoLines(rl) {
  return new Promise((resolveP) => {
    const lines = [];
    const onLine = (line) => {
      lines.push(line);
      if (lines.length >= 2) {
        rl.removeListener("line", onLine);
        resolveP(lines);
      }
    };
    rl.on("line", onLine);
    rl.once("close", () => {
      while (lines.length < 2) lines.push("");
      resolveP(lines);
    });
  });
}

function promptPasswordTTY(prompt) {
  return new Promise((resolveP) => {
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
        resolveP(password);
      } else if (ch === "\u0003") {
        // Ctrl+C
        stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(0);
      } else if (ch === "\u007F" || ch === "\b") {
        if (password.length > 0) password = password.slice(0, -1);
      } else {
        password += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Read ~/.drawlatch/.env and report whether a dashboard password hash is set. */
function isPasswordConfigured() {
  try {
    const envVars = loadEnvFileVars();
    return !!envVars.AUTH_PASSWORD_HASH;
  } catch {
    return false;
  }
}

// ── PID utilities ─────────────────────────────────────────────────

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

// ── Health check utilities ────────────────────────────────────────

/** Resolve the host for client connections — 0.0.0.0 is a bind address, not connectable. */
function connectHost(host) {
  return host === "0.0.0.0" ? "127.0.0.1" : host;
}

async function healthCheck(host, port) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://${connectHost(host)}:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function healthCheckFull(host, port) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://${connectHost(host)}:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitForTunnelUrl(host, port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await healthCheckFull(host, port);
    if (data?.tunnelUrl) return data.tunnelUrl;
    await sleep(500);
  }
  return null;
}

async function waitForHealth(host, port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await healthCheck(host, port)) return true;
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

// ── Config utilities ──────────────────────────────────────────────

function ensureConfigDir() {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

// ── Diagnostic utilities ──────────────────────────────────────────

async function diagnoseStartFailure() {
  if (!existsSync(LOG_FILE)) {
    console.log("\n  No log file found. The server may not have started at all.");
    return;
  }
  try {
    const content = readFileSync(LOG_FILE, "utf-8");
    const lines = content.split("\n").filter(Boolean).slice(-15);
    if (lines.length > 0) {
      console.log("\n  Recent logs:");
      for (const line of lines) {
        console.log(`    ${line}`);
      }
    }
  } catch {
    // Best effort
  }
}

// ── Output / formatting ──────────────────────────────────────────

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

// ── Version check utilities ───────────────────────────────────────

const NPM_PACKAGE_NAME = pkgJson.name;

function readVersionCache() {
  try {
    if (!existsSync(VERSION_CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(VERSION_CACHE_FILE, "utf-8"));
    if (data.checkedAt && Date.now() - data.checkedAt < VERSION_CHECK_TTL_MS) {
      return data.latestVersion;
    }
    return null; // stale
  } catch {
    return null;
  }
}

function writeVersionCache(latestVersion) {
  try {
    ensureConfigDir();
    writeFileSync(
      VERSION_CACHE_FILE,
      JSON.stringify({ latestVersion, checkedAt: Date.now() }) + "\n",
      { mode: 0o600 },
    );
  } catch {
    // Best effort
  }
}

async function fetchLatestVersion() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`,
      { signal: controller.signal },
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data.version || null;
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  // Returns > 0 if a > b, < 0 if a < b, 0 if equal
  // Handles pre-release: 1.0.0 > 1.0.0-alpha.1
  const parseVer = (v) => {
    const [core, pre] = v.split("-", 2);
    const parts = core.split(".").map(Number);
    return { parts, pre: pre || null };
  };
  const va = parseVer(a);
  const vb = parseVer(b);

  // Compare core version parts
  const maxLen = Math.max(va.parts.length, vb.parts.length);
  for (let i = 0; i < maxLen; i++) {
    const pa = va.parts[i] || 0;
    const pb = vb.parts[i] || 0;
    if (pa !== pb) return pa - pb;
  }

  // Same core: no pre-release > pre-release
  if (!va.pre && vb.pre) return 1;
  if (va.pre && !vb.pre) return -1;
  if (!va.pre && !vb.pre) return 0;

  // Both have pre-release: compare segments
  const aParts = va.pre.split(".");
  const bParts = vb.pre.split(".");
  const preLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < preLen; i++) {
    const sa = aParts[i];
    const sb = bParts[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    const na = Number(sa);
    const nb = Number(sb);
    const aIsNum = !isNaN(na);
    const bIsNum = !isNaN(nb);
    if (aIsNum && bIsNum) {
      if (na !== nb) return na - nb;
    } else if (aIsNum) {
      return -1; // numbers sort before strings
    } else if (bIsNum) {
      return 1;
    } else {
      if (sa < sb) return -1;
      if (sa > sb) return 1;
    }
  }
  return 0;
}

async function checkForUpdate() {
  // Try cache first
  const cached = readVersionCache();
  if (cached) return cached !== VERSION && compareVersions(cached, VERSION) > 0 ? cached : null;

  // Fetch in background-ish (awaited but with short timeout)
  const latest = await fetchLatestVersion();
  if (latest) writeVersionCache(latest);
  if (latest && latest !== VERSION && compareVersions(latest, VERSION) > 0) return latest;
  return null;
}

function formatUpdateNotice(latestVersion) {
  return `\n  Update available: ${VERSION} → ${latestVersion}\n  Run: npm install -g ${NPM_PACKAGE_NAME}\n`;
}

// ── Help text ─────────────────────────────────────────────────────

function printHelp() {
  console.log(`
drawlatch v${VERSION}

Usage: drawlatch [command] [options]

Commands:
  init               Set up drawlatch server (keys, config, .env)
  start              Start the remote server (background by default)
  stop               Stop the background remote server
  restart            Restart the background remote server
  status             Show server status (PID, port, uptime, health, sessions)
  logs               View and follow remote server logs
  config             Show effective configuration
  watch              Watch ingestor events in real time
  doctor             Validate setup and diagnose issues
  generate-keys      Generate Ed25519 + X25519 keypairs
  issue-caller       Issue a caller credential bundle (for a callboard instance)
  set-password       Set/change the dashboard password (alias: change-password)

Options:
  -h, --help         Show this help message
  -v, --version      Show version number

Running 'drawlatch' with no arguments shows status (if running) or this help.

Examples:
  drawlatch init                       Set up the remote server
  drawlatch start                      Start remote server in background
  drawlatch start -f                   Start remote server in foreground
  drawlatch start -f --tunnel          Start with a public tunnel for webhooks
  drawlatch doctor                     Validate full setup
  drawlatch status                     Check if server is running
  drawlatch logs -n 100                View last 100 log lines
`);
}

function printStartHelp() {
  console.log(`
drawlatch start

Start the drawlatch remote server.

Usage: drawlatch start [options]

Options:
  -f, --foreground   Run in foreground (default when no command given)
  -t, --tunnel       Start a Cloudflare tunnel for webhook ingestion (requires cloudflared)
  --port <number>    Override the configured port
  --host <address>   Override the configured host
  -h, --help         Show this help message

By default, starts the server as a background daemon. The server
process ID is stored in ~/.drawlatch/drawlatch.pid.
`);
}

function printStopHelp() {
  console.log(`
drawlatch stop

Stop the drawlatch remote server.

Usage: drawlatch stop [options]

Options:
  -h, --help   Show this help message

Sends SIGTERM to the server process and waits for graceful shutdown.
Falls back to SIGKILL if the process does not exit within 15 seconds
(the daemon's own 10s forced exit plus its final audit flush, with slack).
`);
}

function printRestartHelp() {
  console.log(`
drawlatch restart

Restart the drawlatch remote server.

Usage: drawlatch restart [options]

Options:
  --port <number>    Override the configured port
  --host <address>   Override the configured host
  -h, --help         Show this help message

Stops the running server (if any) and starts a new instance.
`);
}

function printStatusHelp() {
  console.log(`
drawlatch status

Show server status.

Usage: drawlatch status [options]

Options:
  -h, --help   Show this help message

Displays PID, host, port, uptime, health check result, and
active session count.
`);
}

function printLogsHelp() {
  console.log(`
drawlatch logs

View server logs (request/response audit lines are hidden by default).

Usage: drawlatch logs [options]

Options:
  -n, --lines <number>  Number of lines to show (default: 50)
  --follow               Follow/tail the log output (default: print and exit)
  --requests             Include request/response audit lines (noisy with polling)
  -h, --help             Show this help message

Log file: ~/.drawlatch/logs/drawlatch.log
`);
}

function printWatchHelp() {
  console.log(`
drawlatch watch

Watch ingestor events in real time.

Usage: drawlatch watch [source] [options]

Arguments:
  source                 Filter to a specific connection (e.g., "discord-bot", "github")

Options:
  --full                 Show full event payload (default: truncate to 100 chars)
  -h, --help             Show this help message

Examples:
  drawlatch watch                     Watch all events
  drawlatch watch github              Watch only GitHub events
  drawlatch watch discord-bot --full  Watch Discord events with full payloads
`);
}

function printConfigHelp() {
  console.log(`
drawlatch config

Show effective configuration.

Usage: drawlatch config [options]

Options:
  --path       Print the config file path only
  -h, --help   Show this help message

Reads ~/.drawlatch/remote.config.json and displays the effective
server configuration including callers and connections.
`);
}

function printInitHelp() {
  console.log(`
drawlatch init

Set up the drawlatch remote server. Generates server keys, creates
config files, and scaffolds a .env template.

Callers are issued separately via 'drawlatch issue-caller' (or the dashboard
Callers page) after the server is running.

Usage: drawlatch init [options]

Options:
  -h, --help     Show this help message

All steps are idempotent — safe to re-run without overwriting existing files.
`);
}

function printDoctorHelp() {
  console.log(`
drawlatch doctor

Validate your drawlatch setup and diagnose common issues.

Usage: drawlatch doctor [options]

Options:
  --full         Include a live handshake test (requires server running)
  -h, --help     Show this help message

Checks config files, keys, peer directories, secrets, the vault, and server health.
Each failure includes the exact command to fix it.
`);
}

function printIssueCallerHelp() {
  console.log(`
drawlatch issue-caller

Issue a caller credential bundle that a callboard instance imports to gain a
caller identity. drawlatch mints the keypair, keeps only the PUBLIC key, and
hands the private key out in the bundle (shown once — re-issue to rotate).

Usage: drawlatch issue-caller <alias> [options]

Options:
  --name <name>           Human-readable display name (defaults to the alias)
  --connections <a,b,c>   Comma-separated connections to authorize
                          (defaults to cloning the "default" caller)
  --endpoint <url>        Endpoint URL to pin in the bundle
                          (defaults to this server's host:port)
  --passphrase            Prompt for a passphrase and scrypt+AES-256-GCM wrap
                          the private keys in the bundle (for untrusted transport)
  -o, --output <file>     Write the bundle to a file (0600) instead of stdout
  --into <keysDir>        Same-host: write the UNPACKED key files directly into a
                          co-located callboard's keys dir (no bundle file)
  -h, --help              Show this help message

Examples:
  drawlatch issue-caller callboard-prod -o callboard-prod.drawlatch-caller.json
  drawlatch issue-caller callboard-prod --passphrase -o bundle.json
  drawlatch issue-caller callboard-local --into ~/.callboard/keys
`);
}

function printSetPasswordHelp(cmd = "set-password") {
  console.log(`
drawlatch ${cmd}

Set or change the password that gates the admin dashboard and /api/admin/*.

Usage: drawlatch ${cmd} [options]

Options:
  -h, --help   Show this help message

Prompts for a new password (hidden in a TTY; reads two lines when piped),
hashes it with scrypt, and stores AUTH_PASSWORD_HASH / AUTH_PASSWORD_SALT in
${ENV_FILE}.

The password must be at least 8 characters. 'change-password' is an alias.
Restart the server afterwards (drawlatch restart) to apply the new password.
`);
}

function printGenerateKeysHelp() {
  console.log(`
drawlatch generate-keys

Generate Ed25519 + X25519 keypairs for authentication and encryption.

Usage: drawlatch generate-keys <subcommand> [options]

Subcommands:
  caller [alias]     Generate caller keypair
                     Alias defaults to "default" if omitted.
                     Keys are stored in keys/callers/<alias>/
  server             Generate server keypair
                     Keys are stored in keys/server/
  --dir <path>       Generate keypair in a custom directory
  show <path>        Show fingerprint of an existing keypair

Keys are saved as PEM files:
  <dir>/signing.pub.pem       Ed25519 public key (safe to share)
  <dir>/signing.key.pem       Ed25519 private key (keep secret!)
  <dir>/exchange.pub.pem      X25519 public key (safe to share)
  <dir>/exchange.key.pem      X25519 private key (keep secret!)
`);
}
