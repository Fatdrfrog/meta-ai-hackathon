export const CONVERSATION_CLASSIFICATION_WAKE_SCHEMA_VERSION = 1 as const;

export const CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC_DEFAULT =
  "icecore-conversation-classification-events";
export const CONVERSATION_CLASSIFICATION_PUBSUB_SUBSCRIPTION_DEFAULT =
  "icecore-conversation-classification-events-worker";
export const CONVERSATION_CLASSIFICATION_PUBSUB_DLQ_TOPIC_DEFAULT =
  "icecore-conversation-classification-events-dlq";
export const CONVERSATION_CLASSIFICATION_PUBSUB_DLQ_SUBSCRIPTION_DEFAULT =
  "icecore-conversation-classification-events-dlq-worker";

export type ConversationClassificationWakeData = {
  schemaVersion: typeof CONVERSATION_CLASSIFICATION_WAKE_SCHEMA_VERSION;
  eventId: string;
  conversationId: string;
  requestedRevision: number;
  generation: number;
  requestedAt: string;
};

const WAKE_DATA_FIELDS = [
  "schemaVersion",
  "eventId",
  "conversationId",
  "requestedRevision",
  "generation",
  "requestedAt",
] as const;

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function assertExactFields(value: Record<string, unknown>): void {
  const fields = Object.keys(value);
  if (
    fields.length !== WAKE_DATA_FIELDS.length ||
    fields.some(
      (field) =>
        !WAKE_DATA_FIELDS.includes(
          field as (typeof WAKE_DATA_FIELDS)[number],
        ),
    )
  ) {
    throw new Error("Classification wake data has invalid fields");
  }
}

function requireId(value: unknown, field: "eventId" | "conversationId"): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value
  ) {
    throw new Error(`Classification wake ${field} is invalid`);
  }
  return value;
}

function requirePositiveInteger(
  value: unknown,
  field: "requestedRevision" | "generation",
): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Classification wake ${field} must be a positive integer`);
  }
  return value as number;
}

function requireIsoTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("Classification wake requestedAt must be an ISO timestamp");
  }
  return value;
}

export function buildConversationClassificationWakeEventId(input: {
  conversationId: string;
  requestedRevision: number;
  generation: number;
}): string {
  const conversationId = requireId(input.conversationId, "conversationId");
  const requestedRevision = requirePositiveInteger(
    input.requestedRevision,
    "requestedRevision",
  );
  const generation = requirePositiveInteger(input.generation, "generation");

  return `conversation-classification:v${CONVERSATION_CLASSIFICATION_WAKE_SCHEMA_VERSION}:${encodeURIComponent(conversationId)}:r${requestedRevision}:g${generation}`;
}

export function normalizeConversationClassificationWakeData(
  value: unknown,
): ConversationClassificationWakeData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Classification wake data must be an object");
  }

  const wakeData = value as Record<string, unknown>;
  assertExactFields(wakeData);

  if (
    wakeData.schemaVersion !==
    CONVERSATION_CLASSIFICATION_WAKE_SCHEMA_VERSION
  ) {
    throw new Error("Classification wake schemaVersion is invalid");
  }

  const conversationId = requireId(wakeData.conversationId, "conversationId");
  const requestedRevision = requirePositiveInteger(
    wakeData.requestedRevision,
    "requestedRevision",
  );
  const generation = requirePositiveInteger(wakeData.generation, "generation");
  const eventId = requireId(wakeData.eventId, "eventId");
  const expectedEventId = buildConversationClassificationWakeEventId({
    conversationId,
    requestedRevision,
    generation,
  });
  if (eventId !== expectedEventId) {
    throw new Error("Classification wake eventId is not deterministic");
  }

  return {
    schemaVersion: CONVERSATION_CLASSIFICATION_WAKE_SCHEMA_VERSION,
    eventId,
    conversationId,
    requestedRevision,
    generation,
    requestedAt: requireIsoTimestamp(wakeData.requestedAt),
  };
}
