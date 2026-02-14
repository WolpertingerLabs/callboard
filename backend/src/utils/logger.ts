import winston from "winston";

const { combine, timestamp, colorize, printf } = winston.format;

const logFormat = printf(({ level, message, timestamp, module }) => {
  const mod = module ? ` [${module}]` : "";
  return `[${timestamp}] [${level}]${mod} ${message}`;
});

// Lazily initialize the logger so that dotenv has loaded .env by the time
// the log level is read from process.env.
let _logger: winston.Logger | null = null;

function getLogger(): winston.Logger {
  if (!_logger) {
    _logger = winston.createLogger({
      level: process.env.LOG_LEVEL || "info",
      format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), colorize(), logFormat),
      transports: [new winston.transports.Console()],
    });
  }
  return _logger;
}

/**
 * Create a child logger with a fixed module label.
 */
export function createLogger(module: string): winston.Logger {
  return getLogger().child({ module });
}

export default getLogger;
