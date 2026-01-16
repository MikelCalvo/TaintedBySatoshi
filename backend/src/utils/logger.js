/**
 * Simple logger without external dependencies
 * Levels: debug < info < warn < error
 */

const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  reset: "\x1b[0m",
};

const minLevel = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;
const useColors = process.env.NODE_ENV !== "production";

function formatTimestamp() {
  return new Date().toISOString().slice(0, 19);
}

function formatMessage(level, message, meta) {
  const timestamp = formatTimestamp();
  const levelUpper = level.toUpperCase().padEnd(5);

  let metaStr = "";
  if (meta && Object.keys(meta).length > 0) {
    metaStr = " " + JSON.stringify(meta);
  }

  if (useColors) {
    return `${COLORS[level]}[${timestamp}] ${levelUpper}${COLORS.reset} ${message}${metaStr}`;
  }

  return `[${timestamp}] ${levelUpper} ${message}${metaStr}`;
}

function log(level, message, meta) {
  if (LEVELS[level] < minLevel) return;

  const formatted = formatMessage(level, message, meta);

  if (level === "error") {
    console.error(formatted);
  } else if (level === "warn") {
    console.warn(formatted);
  } else {
    console.log(formatted);
  }
}

const logger = {
  debug: (message, meta) => log("debug", message, meta),
  info: (message, meta) => log("info", message, meta),
  warn: (message, meta) => log("warn", message, meta),
  error: (message, meta) => log("error", message, meta),
};

module.exports = logger;
