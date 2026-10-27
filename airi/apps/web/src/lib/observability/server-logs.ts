import "server-only";

import { SeverityNumber, type LogAttributes } from "@opentelemetry/api-logs";
import { after } from "next/server";
import { loggerProvider } from "@/instrumentation";
import { getAppVersion } from "@/lib/app-version";

type Primitive = string | number | boolean;
type SerializableLogValue =
  | Primitive
  | Primitive[]
  | null
  | undefined
  | Error
  | object;

export interface ServerLogContext {
  [key: string]: SerializableLogValue;
}

const REQUEST_ID_HEADERS = [
  "x-vercel-id",
  "x-request-id",
  "x-correlation-id",
] as const;
const DEFAULT_CONSOLE_LOG_SCOPES = [
  "api.webhooks.whatsapp",
  "api.realtime.token",
  "api.conversations.detail",
  "whatsapp.embedded-signup",
  "api.mcp",
] as const;
const CONSOLE_LOG_MODES = ["off", "selected", "all", "errors"] as const;

type ConsoleLogMode = (typeof CONSOLE_LOG_MODES)[number];

function getRequestId(request: Request): string | undefined {
  for (const headerName of REQUEST_ID_HEADERS) {
    const headerValue = request.headers.get(headerName);
    if (headerValue) {
      return headerValue;
    }
  }

  return undefined;
}

function toLogAttributeValue(
  value: SerializableLogValue
): LogAttributes[string] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }

  if (Array.isArray(value)) {
    return value.map(item =>
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
        ? item
        : JSON.stringify(item)
    );
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function toConsoleLogValue(
  value: SerializableLogValue,
  seen = new WeakSet<object>()
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(process.env.NODE_ENV !== "production" && value.stack
        ? { stack: value.stack }
        : {}),
    };
  }

  if (Array.isArray(value)) {
    return value.map(item =>
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean" ||
      item === null ||
      item === undefined
        ? item
        : toConsoleLogValue(item, seen)
    );
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);

    return Object.fromEntries(
      Object.entries(value as Record<string, SerializableLogValue>)
        .filter(([, nestedValue]) => nestedValue !== undefined)
        .map(([key, nestedValue]) => [
          key,
          toConsoleLogValue(nestedValue, seen),
        ])
    );
  }

  return String(value);
}

function sanitizeAttributes(
  context?: ServerLogContext
): LogAttributes | undefined {
  if (!context) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(context)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, toLogAttributeValue(value)])
  );
}

function sanitizeConsoleContext(context?: ServerLogContext): object {
  if (!context) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(context)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, toConsoleLogValue(value)])
  );
}

function readConsoleLogMode(): ConsoleLogMode {
  const configured = process.env.SERVER_LOG_CONSOLE_MODE?.trim().toLowerCase();
  if (CONSOLE_LOG_MODES.includes(configured as ConsoleLogMode)) {
    return configured as ConsoleLogMode;
  }

  return process.env.VERCEL ? "selected" : "off";
}

function readConsoleLogScopes(): Set<string> {
  const configured = process.env.SERVER_LOG_CONSOLE_SCOPES?.trim();
  if (!configured) {
    return new Set(DEFAULT_CONSOLE_LOG_SCOPES);
  }

  return new Set(
    configured
      .split(",")
      .map(scope => scope.trim())
      .filter(Boolean)
  );
}

function shouldMirrorToConsole(
  scope: string,
  severityNumber: SeverityNumber,
  context?: ServerLogContext
): boolean {
  const mode = readConsoleLogMode();
  if (mode === "off") return false;
  if (mode === "errors") return severityNumber >= SeverityNumber.ERROR;
  if (mode === "all") return true;
  if (context?.logStage === "start") return false;

  return readConsoleLogScopes().has(scope);
}

function severityToConsoleMethod(
  severityNumber: SeverityNumber
): "info" | "warn" | "error" {
  if (severityNumber >= SeverityNumber.ERROR) return "error";
  if (severityNumber >= SeverityNumber.WARN) return "warn";
  return "info";
}

function emitConsoleLog(
  scope: string,
  message: string,
  severityNumber: SeverityNumber,
  context?: ServerLogContext
) {
  if (!shouldMirrorToConsole(scope, severityNumber, context)) {
    return;
  }

  const version = getAppVersion();
  const method = severityToConsoleMethod(severityNumber);
  const payload = {
    timestamp: new Date().toISOString(),
    level: method,
    service: "@icecore/web",
    scope,
    message,
    appVersion: version.version,
    appVersionSource: version.source,
    ...sanitizeConsoleContext(context),
  };

  console[method](JSON.stringify(payload));
}

export function flushServerLogsAfterResponse() {
  try {
    after(async () => {
      try {
        await loggerProvider.forceFlush();
      } catch (error) {
        console.error("[observability] Failed to flush server logs", error);
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("outside a request scope")) {
      console.error(
        "[observability] Failed to schedule server log flush",
        error
      );
    }
  }
}

export function createServerLogger(scope: string) {
  const logger = loggerProvider.getLogger(scope);

  function emit(
    message: string,
    severityNumber: SeverityNumber,
    context?: ServerLogContext
  ) {
    logger.emit({
      body: message,
      severityNumber,
      attributes: sanitizeAttributes(context),
    });
    emitConsoleLog(scope, message, severityNumber, context);
  }

  return {
    info(message: string, context?: ServerLogContext) {
      emit(message, SeverityNumber.INFO, context);
    },
    warn(message: string, context?: ServerLogContext) {
      emit(message, SeverityNumber.WARN, context);
    },
    error(
      message: string,
      error?: Error | unknown,
      context?: ServerLogContext
    ) {
      emit(message, SeverityNumber.ERROR, {
        ...context,
        ...(error instanceof Error
          ? { error }
          : error !== undefined
            ? { error: String(error) }
            : {}),
      });
    },
  };
}

export function createRequestLogger(
  scope: string,
  request: Request,
  baseContext?: ServerLogContext
) {
  const logger = createServerLogger(scope);
  const startedAt = Date.now();
  const requestContext: ServerLogContext = {
    method: request.method,
    requestId: getRequestId(request),
    ...baseContext,
  };

  flushServerLogsAfterResponse();

  return {
    start(message = "Request started", context?: ServerLogContext) {
      logger.info(message, {
        ...requestContext,
        logStage: "start",
        ...context,
      });
    },
    info(message: string, context?: ServerLogContext) {
      logger.info(message, { ...requestContext, ...context });
    },
    warn(message: string, context?: ServerLogContext) {
      logger.warn(message, { ...requestContext, ...context });
    },
    success(message = "Request completed", context?: ServerLogContext) {
      logger.info(message, {
        ...requestContext,
        logStage: "complete",
        durationMs: Date.now() - startedAt,
        ...context,
      });
    },
    error(
      message: string,
      error?: Error | unknown,
      context?: ServerLogContext
    ) {
      logger.error(message, error, {
        ...requestContext,
        logStage: "error",
        durationMs: Date.now() - startedAt,
        ...context,
      });
    },
  };
}
