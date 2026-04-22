export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

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

function maskLocalPaths(value: string): string {
  let masked = value;
  if (process.cwd()) {
    masked = masked.replaceAll(process.cwd(), "[APP_ROOT]");
  }
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
  const minPriority = LEVELS[minLevel];

  function write(level: LogLevel, message: string, context: LogContext = {}): void {
    if (LEVELS[level] < minPriority) return;
    const normalizedContext = normalizeValue(context) as LogContext;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...normalizedContext,
    };

    const line = JSON.stringify(entry);
    if (level === "error") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}
