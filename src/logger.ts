import pino from "pino";
import type { Logger as PinoLogger } from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function createPinoLogger(level: LogLevel, stream: NodeJS.WritableStream): PinoLogger {
  return pino(
    {
      base: undefined,
      level,
      messageKey: "message",
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    stream,
  );
}

function maskLocalPaths(value: string): string {
  let masked = value.replaceAll(process.cwd(), "[APP_ROOT]");
  if (process.env.HOME) {
    masked = masked.replaceAll(process.env.HOME, "[HOME]");
  }
  return masked;
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskLocalPaths(value.message),
      stack: value.stack ? maskLocalPaths(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (value && typeof value === "object") {
    const out: LogContext = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = normalizeValue(nested);
    }
    return out;
  }

  return value;
}

export function createLogger(minLevel = parseLogLevel(process.env.LOG_LEVEL)): Logger {
  const outLogger = createPinoLogger(minLevel, process.stdout);
  const errLogger = createPinoLogger(minLevel, process.stderr);

  function write({ level, message, context = {} }: WriteLogArgs): void {
    const ctx = normalizeValue(context) as LogContext;
    const pinoLogger = level === "warn" || level === "error" ? errLogger : outLogger;
    pinoLogger[level](ctx, message);
  }

  return {
    debug: (message, context) => write({ level: "debug", message, context }),
    info: (message, context) => write({ level: "info", message, context }),
    warn: (message, context) => write({ level: "warn", message, context }),
    error: (message, context) => write({ level: "error", message, context }),
  };
}

interface WriteLogArgs {
  level: LogLevel;
  message: string;
  context?: LogContext;
}
