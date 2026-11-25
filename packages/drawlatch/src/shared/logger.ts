/**
 * Lightweight leveled logger.
 *
 * Reads `LOG_LEVEL` from the environment (via dotenv) and gates output
 * accordingly.  Supports the standard levels: error, warn, info, debug.
 *
 * Usage:
 *   import { createLogger } from '../../shared/logger.js';
 *   const log = createLogger('discord-gw');
 *   log.info('Connected');        // [2026-02-21 12:00:00] [INFO]  [discord-gw] Connected
 *   log.debug('Payload', data);   // only shown when LOG_LEVEL=debug
 *
 * The logger is lazily initialised so that `dotenv/config` has loaded the
 * .env file before the log level is read from `process.env`.
 *
 * Follows the same `createLogger(module)` pattern used in ../callboard.
 */

// ── Log levels (lower = more severe) ────────────────────────────────────

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LevelName = keyof typeof LEVELS;

// ANSI colour codes for each level (matches Winston's defaults)
const COLORS: Record<LevelName, string> = {
  error: '\x1b[31m', // red
  warn: '\x1b[33m', // yellow
  info: '\x1b[32m', // green
  debug: '\x1b[34m', // blue
};
const RESET = '\x1b[0m';

// ── Resolve effective level lazily ──────────────────────────────────────

let resolvedThreshold: number | null = null;

function threshold(): number {
  if (resolvedThreshold === null) {
    const env = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
    resolvedThreshold = env in LEVELS ? LEVELS[env as LevelName] : LEVELS.info;
  }
  return resolvedThreshold;
}

// ── Formatting ──────────────────────────────────────────────────────────

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatMessage(level: LevelName, mod: string, msg: string): string {
  const tag = level.toUpperCase().padEnd(5);
  return `[${timestamp()}] [${COLORS[level]}${tag}${RESET}] [${mod}] ${msg}`;
}

// ── Logger interface ────────────────────────────────────────────────────

interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Create a child logger with a fixed module label.
 *
 * @param module - Short identifier for the module (e.g., 'discord-gw', 'poll', 'webhook').
 */
export function createLogger(module: string): Logger {
  const emit = (level: LevelName, message: string, args: unknown[]) => {
    if (LEVELS[level] > threshold()) return;
    const formatted = formatMessage(level, module, message);
    if (level === 'error') {
      console.error(formatted, ...args);
    } else if (level === 'warn') {
      console.warn(formatted, ...args);
    } else {
      console.log(formatted, ...args);
    }
  };

  return {
    error: (message: string, ...args: unknown[]) => emit('error', message, args),
    warn: (message: string, ...args: unknown[]) => emit('warn', message, args),
    info: (message: string, ...args: unknown[]) => emit('info', message, args),
    debug: (message: string, ...args: unknown[]) => emit('debug', message, args),
  };
}
