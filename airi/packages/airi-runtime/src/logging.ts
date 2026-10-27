import { createLogger } from "@icecore/shared/lib/logger";

export interface AiriLogContext {
  [key: string]: unknown;
  event?: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  inboundMessageId?: string | null;
  outboundMessageId?: string | null;
  workflowId?: string | null;
  taskQueue?: string | null;
  scenarioId?: string | null;
  scenarioName?: string | null;
  channel?: string | null;
  outcome?: string | null;
  durationMs?: number | null;
  note?: string | null;
}

function normalizeContext<TContext extends AiriLogContext>(
  event: string,
  context?: TContext,
): TContext & { event: string } {
  return {
    event,
    ...(context || {}),
  } as TContext & { event: string };
}

function createAiriEventLogger(serviceName: string) {
  const baseLogger = createLogger(serviceName);

  return {
    info(event: string, context?: AiriLogContext) {
      baseLogger.info(event, normalizeContext(event, context));
    },

    warn(event: string, context?: AiriLogContext) {
      baseLogger.warn(event, normalizeContext(event, context));
    },

    error(event: string, error?: Error | unknown, context?: AiriLogContext) {
      baseLogger.error(event, error, normalizeContext(event, context));
    },
  };
}

export function compactLogText(
  value: unknown,
  limit: number = 120,
): string | null {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, limit);
}

export type LogErrorSummary = {
  name: string;
  code?: string | number;
  codeName?: string;
  message: string | null;
};

// Connection strings, URLs, user:password@host credentials, bearer values,
// JWTs, key/value secrets (key=value, key: value, "key": "value", including
// escaped JSON) and prefixed or long opaque tokens never reach structured
// logs through an error. Identifiers that merely end in "Key" (for example a
// duplicate idempotencyKey) stay readable for diagnosis.
// Every pattern scans in linear time: repeats before a required literal are
// bounded, and the input itself is bounded before any pattern runs.
const LOG_SECRET_KEY =
  "(?:[\\w-]{0,40}(?:token|secret|passw(?:or)?d|pwd|signature|authorization|credentials?)" +
  "|[\\w-]{0,40}(?:api|secret|access|private|client|session|auth|signing|encryption|master)[_ -]?key" +
  "|(?<![\\w-])key)";
const LOG_QUOTE = "(?:\\\\?[\"'])?";
const LOG_SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[a-z][a-z0-9+.-]{0,31}:\/\/\S+/gi, "[url]"],
  [/\beyJ[\w-]{0,512}\.[\w-]+\.[\w-]+/g, "[token]"],
  [/\b(?:bearer|basic)\s+[\w.~+/=-]+/gi, "[credential]"],
  [
    new RegExp(
      `(${LOG_QUOTE}${LOG_SECRET_KEY}${LOG_QUOTE} ?(?:[:=]|%3[dD]) ?${LOG_QUOTE})` +
        "(?:(?:bearer|basic|digest|token) +)?[^\\s\"'\\\\&,;{}[\\]]+",
      "gi",
    ),
    "$1[redacted]",
  ],
  [/\b[^\s:@/]{1,64}:[^\s:@]{1,128}@/g, "[credential]@"],
  [/\b(?:sk|pk|rk)[-_][\w-]{8,}/g, "[token]"],
  [/\b[A-Za-z0-9_]{32,}\b/g, "[token]"],
  [/\b[A-Za-z0-9][\w-]{39,}/g, "[token]"],
];
/** Characters of raw error text read at all; the rest is never scanned. */
const LOG_ERROR_INPUT_LIMIT = 2_000;

function boundLogInput(text: string, max: number): string {
  if (text.length <= max) return text;
  // Drop the token cut in half so a split secret cannot slip past the
  // patterns as a short piece that no longer looks like a token.
  let end = max;
  while (end > 0 && /[\w.~+/=%-]/.test(text[end] ?? "")) end--;
  return text.slice(0, end || max);
}

function redactLogText(value: string, limit: number): string | null {
  // Collapse whitespace first so separators and quotes need no unbounded \s*.
  const bounded = boundLogInput(
    value,
    Math.max(LOG_ERROR_INPUT_LIMIT, limit),
  ).replace(/\s+/g, " ");
  return compactLogText(
    LOG_SECRET_PATTERNS.reduce(
      (text, [pattern, replacement]) => text.replace(pattern, replacement),
      bounded,
    ),
    limit,
  );
}

/**
 * A bounded, secret-free cause for error logs; the raw error is never echoed.
 * Never throws: an error whose properties cannot be read becomes a bare Error.
 */
export function describeLogError(
  error: unknown,
  limit: number = 200,
): LogErrorSummary {
  try {
    const row =
      error && typeof error === "object"
        ? (error as {
            name?: unknown;
            code?: unknown;
            codeName?: unknown;
            message?: unknown;
          })
        : null;
    const rawMessage = row ? row.message : error;
    const rawName = row?.name,
      rawCode = row?.code,
      rawCodeName = row?.codeName;
    const code =
      typeof rawCode === "number" && Number.isFinite(rawCode)
        ? rawCode
        : typeof rawCode === "string"
          ? (redactLogText(rawCode, 40) ?? undefined)
          : undefined;
    const codeName =
      typeof rawCodeName === "string"
        ? (redactLogText(rawCodeName, 80) ?? undefined)
        : undefined;
    return {
      name:
        (typeof rawName === "string" ? redactLogText(rawName, 80) : null) ??
        (row ? "Error" : typeof error),
      ...(code !== undefined ? { code } : {}),
      ...(codeName ? { codeName } : {}),
      message:
        typeof rawMessage === "string"
          ? redactLogText(rawMessage, limit)
          : null,
    };
  } catch {
    return { name: "Error", message: null };
  }
}

export function compactLogList(
  values: unknown,
  options?: {
    itemLimit?: number;
    maxItems?: number;
  },
): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const itemLimit = options?.itemLimit ?? 80;
  const maxItems = options?.maxItems ?? 4;

  return Array.from(
    new Set(
      values
        .map((value) => compactLogText(value, itemLimit))
        .filter((value): value is string => Boolean(value)),
    ),
  ).slice(0, maxItems);
}

export const airiReplyLogger = createAiriEventLogger("airi-reply");
export const airiOrchestrationLogger =
  createAiriEventLogger("airi-orchestration");
export const airiWorkerLogger = createAiriEventLogger("airi-temporal-worker");
