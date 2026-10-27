/**
 * Shared structured logging utility
 *
 * Outputs structured JSON logs in production for log aggregation.
 * Apps can extend this with their own analytics integrations (PostHog, Sentry, etc.)
 *
 * Usage:
 * ```ts
 * import { createLogger } from '@icecore/shared/lib/logger';
 *
 * const logger = createLogger('my-service');
 * logger.info('User logged in', { userId: '123' });
 * logger.error('API failed', error, { endpoint: '/api/users' });
 * ```
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  environment: string;
  message: string;
  [key: string]: unknown;
}

// Safe way to access process.env without Node.js types
declare const process: { env: Record<string, string | undefined> } | undefined;

export class Logger {
  private serviceName: string;
  private environment: string;

  constructor(serviceName: string = "icecore") {
    this.serviceName = serviceName;
    // Safe access to NODE_ENV
    this.environment =
      (typeof process !== "undefined" && process.env?.NODE_ENV) ||
      "development";
  }

  private log(
    level: LogLevel,
    message: string,
    context?: LogContext,
  ): LogEntry {
    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.serviceName,
      environment: this.environment,
      message,
      ...context,
    };

    // In production, output as JSON for log aggregation services
    if (this.environment === "production") {
      console[level === "debug" ? "log" : level](JSON.stringify(logEntry));
    } else {
      // In development, output as readable format
      console[level === "debug" ? "log" : level](
        `[${level.toUpperCase()}] ${message}`,
        context || "",
      );
    }

    return logEntry;
  }

  debug(message: string, context?: LogContext): LogEntry {
    return this.log("debug", message, context);
  }

  info(message: string, context?: LogContext): LogEntry {
    return this.log("info", message, context);
  }

  warn(message: string, context?: LogContext): LogEntry {
    return this.log("warn", message, context);
  }

  error(
    message: string,
    error?: Error | unknown,
    context?: LogContext,
  ): LogEntry {
    const errorContext: LogContext = {
      ...context,
    };

    if (error instanceof Error) {
      errorContext.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    } else if (error) {
      errorContext.error = error;
    }

    return this.log("error", message, errorContext);
  }
}

/**
 * Create a logger instance for a service
 */
export function createLogger(serviceName: string): Logger {
  return new Logger(serviceName);
}

/**
 * Default logger instance
 */
export const logger = new Logger("icecore");
