import type { ConversationChannel } from "../types/sources";

export const RAW_SOURCE_REDACTED_VALUE = "[redacted]";

const DEFAULT_REDACTED_KEYS = new Set([
  "access_token",
  "accesstoken",
  "authorization",
  "bot_token",
  "bottoken",
  "client_key",
  "clientkey",
  "page_access_token",
  "pageaccesstoken",
  "password",
  "secret",
  "secret_token",
  "secrettoken",
  "token",
  "webhook_secret_token",
  "webhooksecrettoken",
]);

export interface RawSourcePayload {
  provider: ConversationChannel;
  eventType?: string | null;
  capturedAt: Date;
  payload: unknown;
}

interface BuildRawSourcePayloadParams {
  provider: ConversationChannel;
  eventType?: string | null;
  capturedAt?: Date;
  payload: unknown;
  redactKeys?: string[];
}

function normalizeKey(key: string): string {
  return key.replace(/[-\s]/g, "_").toLowerCase();
}

function createRedactedKeySet(redactKeys: string[] = []): Set<string> {
  const keys = new Set(DEFAULT_REDACTED_KEYS);
  for (const key of redactKeys) {
    keys.add(normalizeKey(key));
  }
  return keys;
}

function redactValue(
  value: unknown,
  redactedKeys: Set<string>,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, redactedKeys, seen));
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    output[key] = redactedKeys.has(normalizeKey(key))
      ? RAW_SOURCE_REDACTED_VALUE
      : redactValue(nestedValue, redactedKeys, seen);
  }

  seen.delete(value);
  return output;
}

export function buildRawSourcePayload({
  provider,
  eventType = null,
  capturedAt = new Date(),
  payload,
  redactKeys,
}: BuildRawSourcePayloadParams): RawSourcePayload {
  return {
    provider,
    eventType:
      typeof eventType === "string" && eventType.trim()
        ? eventType.trim()
        : null,
    capturedAt,
    payload: redactValue(
      payload,
      createRedactedKeySet(redactKeys),
      new WeakSet(),
    ),
  };
}
