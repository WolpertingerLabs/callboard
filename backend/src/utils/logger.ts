import winston from "winston";

const { combine, timestamp, colorize, printf } = winston.format;

const logFormat = printf(({ level, message, timestamp, module }) => {
  const mod = module ? ` [${module}]` : "";
  return `[${timestamp}] [${level}]${mod} ${message}`;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), colorize(), logFormat),
  transports: [new winston.transports.Console()],
});

/**
 * Create a child logger with a fixed module label.
 */
export function createLogger(module: string): winston.Logger {
  return logger.child({ module });
}

export default logger;
