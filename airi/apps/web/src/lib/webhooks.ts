import { createHash, createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createLogger } from "@icecore/shared/lib/logger";
import { isRecord, isPlainRecord } from "@icecore/shared/lib/value-utils";
import { supabaseAdmin } from "./supabase/admin";
import {
  decryptCustomerWebhookSecret,
  safeCustomerWebhookFetch,
} from "./customer-webhook-config";

export const WEBHOOK_EVENTS = {
  CONVERSATION_CREATED: "conversation.created",
  CONVERSATION_UPDATED: "conversation.updated",
  CONVERSATION_RESOLVED: "conversation.resolved",
  CONVERSATION_REOPENED: "conversation.reopened",
  MESSAGE_RECEIVED: "message.received",
  MESSAGE_SENT: "message.sent",
  MESSAGE_STATUS_UPDATED: "message.status_updated",
  CLASSIFICATION_COMPLETED: "classification.completed",
  CSAT_SUBMITTED: "csat.submitted",
  CSAT_LOW: "csat.low",
  COACHING_TIP_GENERATED: "coaching.tip_generated",
  COACHING_TIP_APPLIED: "coaching.tip_applied",
  SLA_BREACH: "sla.breach",
  SLA_WARNING: "sla.warning",
} as const;

export type WebhookEventType =
  (typeof WEBHOOK_EVENTS)[keyof typeof WEBHOOK_EVENTS];

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  workspace_id: string;
  data: Record<string, unknown>;
}

export type DispatchWebhookEventInput = {
  workspaceId: string;
  eventType: WebhookEventType;
  resourceId: string;
  timestamp: string;
  data: Record<string, unknown>;
  subscriptionIds?: string[];
};

type WebhookSubscription = {
  id: string;
  url: string;
  secret: string;
  headers: Record<string, string>;
};

type WebhookDeliveryLog = {
  id: string;
  webhook_id: string;
  event_type: string;
  payload: WebhookPayload;
  response_status: number | null;
  response_body: string | null;
  error_message: string | null;
  attempt_number: number;
  delivered_at: string | null;
  next_retry_at: string | null;
  idempotency_key: string;
};

type Reservation =
  | { status: "completed" }
  | { status: "reserved"; log: WebhookDeliveryLog };

type TransportResult = {
  success: boolean;
  statusCode: number | null;
  responseBody: string | null;
  errorMessage: string | null;
};

const WEBHOOK_RESERVATION_MS = 30_000;
const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_CONCURRENCY = 8;
const WEBHOOK_CAS_ATTEMPTS = 8;
const WEBHOOK_STORED_TEXT_LIMIT = 1_000;
const RESERVED_WEBHOOK_HEADER_NAMES = new Set([
  "content-type",
  "user-agent",
  "x-airi.chat-signature",
  "x-airi.chat-event",
  "x-airi.chat-timestamp",
  "x-airi.chat-delivery-attempt",
  "x-airi.chat-idempotency-key",
]);
const DELIVERY_LOG_COLUMNS =
  "id, webhook_id, event_type, payload, response_status, response_body, error_message, attempt_number, delivered_at, next_retry_at, idempotency_key";
const webhookLogger = createLogger("webhooks");

function boundedText(value: string): string {
  return value.slice(0, WEBHOOK_STORED_TEXT_LIMIT);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function databaseError(context: string, error: unknown): Error {
  const code =
    isRecord(error) && typeof error.code === "string" ? ` (${error.code})` : "";
  return new Error(`${context}${code}: ${errorMessage(error)}`);
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson);
  if (!isPlainRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortForStableJson(entry)])
  );
}

function stableSerialize(value: unknown): string {
  const serialized = JSON.stringify(sortForStableJson(value));
  if (serialized === undefined) {
    throw new Error("Webhook payload cannot be serialized");
  }
  return serialized;
}

function canonicalizeWebhookPayload(payload: WebhookPayload): WebhookPayload {
  return JSON.parse(stableSerialize(payload)) as WebhookPayload;
}

function createWebhookSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function hashPayload(payload: WebhookPayload): string {
  return createHash("sha256")
    .update(stableSerialize(payload))
    .digest("hex")
    .slice(0, 32);
}

function buildIdempotencyKey(input: {
  webhookId: string;
  eventType: WebhookEventType;
  resourceId: string;
  payload: WebhookPayload;
}): string {
  const base = `${input.webhookId}:${input.eventType}:${input.resourceId}`;
  return input.eventType === WEBHOOK_EVENTS.CLASSIFICATION_COMPLETED
    ? base
    : `${base}:${hashPayload(input.payload)}`;
}

function parseHeaders(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (!isRecord(value)) {
    throw new Error("Webhook subscription headers are invalid");
  }

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      throw new Error("Webhook subscription headers are invalid");
    }
    if (!RESERVED_WEBHOOK_HEADER_NAMES.has(name.toLowerCase())) {
      headers[name] = headerValue;
    }
  }
  return headers;
}

function parseSubscription(value: unknown): WebhookSubscription {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.url !== "string" ||
    typeof value.secret !== "string"
  ) {
    throw new Error("Webhook subscription is invalid");
  }
  return {
    id: value.id,
    url: value.url,
    secret: decryptCustomerWebhookSecret(value.secret),
    headers: parseHeaders(value.headers),
  };
}

function nullableString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new Error(`Webhook delivery log ${field} is invalid`);
  }
  return value;
}

function parseDeliveryLog(value: unknown): WebhookDeliveryLog {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.webhook_id !== "string" ||
    typeof value.event_type !== "string" ||
    !isRecord(value.payload) ||
    !Number.isSafeInteger(value.attempt_number) ||
    (value.attempt_number as number) < 1 ||
    typeof value.idempotency_key !== "string" ||
    (value.response_status != null &&
      !Number.isSafeInteger(value.response_status))
  ) {
    throw new Error("Webhook delivery log is invalid");
  }

  return {
    id: value.id,
    webhook_id: value.webhook_id,
    event_type: value.event_type,
    payload: value.payload as unknown as WebhookPayload,
    response_status: (value.response_status as number | null) ?? null,
    response_body: nullableString(value.response_body, "response_body"),
    error_message: nullableString(value.error_message, "error_message"),
    attempt_number: value.attempt_number as number,
    delivered_at: nullableString(value.delivered_at, "delivered_at"),
    next_retry_at: nullableString(value.next_retry_at, "next_retry_at"),
    idempotency_key: value.idempotency_key,
  };
}

function assertDeliveryIdentity(
  log: WebhookDeliveryLog,
  expected: {
    webhookId: string;
    eventType: WebhookEventType;
    payload: WebhookPayload;
    idempotencyKey: string;
  }
): void {
  if (
    log.webhook_id !== expected.webhookId ||
    log.event_type !== expected.eventType ||
    log.idempotency_key !== expected.idempotencyKey ||
    !isDeepStrictEqual(log.payload, expected.payload)
  ) {
    throw new Error(
      `Webhook delivery ${expected.idempotencyKey} conflicts with immutable payload`
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === "23505";
}

function isLiveReservation(log: WebhookDeliveryLog, now: Date): boolean {
  if (
    log.response_status !== null ||
    log.response_body !== null ||
    log.error_message !== null ||
    !log.next_retry_at
  ) {
    return false;
  }
  const expiresAt = Date.parse(log.next_retry_at);
  if (!Number.isFinite(expiresAt)) {
    throw new Error("Webhook delivery reservation expiry is invalid");
  }
  return expiresAt > now.getTime();
}

async function loadDeliveryLog(
  idempotencyKey: string
): Promise<WebhookDeliveryLog | null> {
  const { data, error } = await supabaseAdmin
    .from("webhook_delivery_logs")
    .select(DELIVERY_LOG_COLUMNS)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) {
    throw databaseError("Webhook delivery log query failed", error);
  }
  return data ? parseDeliveryLog(data) : null;
}

async function reserveWebhookAttempt(input: {
  webhookId: string;
  eventType: WebhookEventType;
  payload: WebhookPayload;
  idempotencyKey: string;
}): Promise<Reservation> {
  const identity = {
    webhookId: input.webhookId,
    eventType: input.eventType,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey,
  };
  let existing: WebhookDeliveryLog | null = null;
  let insertAttempted = false;

  for (let casAttempt = 0; casAttempt < WEBHOOK_CAS_ATTEMPTS; casAttempt += 1) {
    const now = new Date();
    const reservationExpiresAt = new Date(
      now.getTime() + WEBHOOK_RESERVATION_MS
    ).toISOString();

    if (!insertAttempted) {
      insertAttempted = true;
      const { data, error } = await supabaseAdmin
        .from("webhook_delivery_logs")
        .insert({
          webhook_id: input.webhookId,
          event_type: input.eventType,
          payload: input.payload,
          response_status: null,
          response_body: null,
          error_message: null,
          attempt_number: 1,
          delivered_at: null,
          next_retry_at: reservationExpiresAt,
          idempotency_key: input.idempotencyKey,
        })
        .select(DELIVERY_LOG_COLUMNS)
        .single();

      if (!error && data) {
        const inserted = parseDeliveryLog(data);
        assertDeliveryIdentity(inserted, identity);
        return { status: "reserved", log: inserted };
      }
      if (error && !isUniqueViolation(error)) {
        throw databaseError(
          "Webhook delivery reservation insert failed",
          error
        );
      }
    }

    existing = await loadDeliveryLog(input.idempotencyKey);
    if (!existing) {
      throw new Error(
        `Webhook delivery ${input.idempotencyKey} is missing after unique conflict`
      );
    }
    assertDeliveryIdentity(existing, identity);

    if (existing.delivered_at) {
      return { status: "completed" };
    }
    if (isLiveReservation(existing, now)) {
      throw new Error(
        `Webhook delivery ${input.idempotencyKey} has a live reservation`
      );
    }

    const nextAttempt = existing.attempt_number + 1;
    let update = supabaseAdmin
      .from("webhook_delivery_logs")
      .update({
        response_status: null,
        response_body: null,
        error_message: null,
        attempt_number: nextAttempt,
        next_retry_at: reservationExpiresAt,
      })
      .eq("id", existing.id)
      .eq("attempt_number", existing.attempt_number)
      .is("delivered_at", null);
    update = existing.next_retry_at
      ? update.eq("next_retry_at", existing.next_retry_at)
      : update.is("next_retry_at", null);

    const { data, error } = await update
      .select(DELIVERY_LOG_COLUMNS)
      .maybeSingle();
    if (error) {
      throw databaseError("Webhook delivery reservation update failed", error);
    }
    if (data) {
      const reserved = parseDeliveryLog(data);
      assertDeliveryIdentity(reserved, identity);
      if (reserved.attempt_number !== nextAttempt) {
        throw new Error("Webhook delivery reservation attempt is invalid");
      }
      return { status: "reserved", log: reserved };
    }
  }

  throw new Error(
    `Webhook delivery ${input.idempotencyKey} reservation CAS exhausted`
  );
}

async function sendReservedWebhook(input: {
  subscription: WebhookSubscription;
  payload: WebhookPayload;
  idempotencyKey: string;
  attemptNumber: number;
}): Promise<TransportResult> {
  const payloadString = stableSerialize(input.payload);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await safeCustomerWebhookFetch(input.subscription.url, {
      method: "POST",
      redirect: "error",
      headers: {
        ...input.subscription.headers,
        "Content-Type": "application/json",
        "User-Agent": "Airi.chat-Webhooks/1.0",
        "X-Airi.chat-Signature": createWebhookSignature(
          payloadString,
          input.subscription.secret
        ),
        "X-Airi.chat-Event": input.payload.event,
        "X-Airi.chat-Timestamp": input.payload.timestamp,
        "X-Airi.chat-Delivery-Attempt": String(input.attemptNumber),
        "X-Airi.chat-Idempotency-Key": input.idempotencyKey,
      },
      body: payloadString,
      signal: controller.signal,
    });
    const responseBody = boundedText(await response.text());
    return {
      success: response.ok,
      statusCode: response.status,
      responseBody,
      errorMessage: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      success: false,
      statusCode: null,
      responseBody: null,
      errorMessage: boundedText(errorMessage(error)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function finalizeWebhookAttempt(input: {
  log: WebhookDeliveryLog;
  identity: {
    webhookId: string;
    eventType: WebhookEventType;
    payload: WebhookPayload;
    idempotencyKey: string;
  };
  result: TransportResult;
}): Promise<void> {
  const deliveredAt = input.result.success ? new Date().toISOString() : null;
  const { data, error } = await supabaseAdmin
    .from("webhook_delivery_logs")
    .update({
      response_status: input.result.statusCode,
      response_body: input.result.responseBody,
      error_message: input.result.errorMessage,
      delivered_at: deliveredAt,
      next_retry_at: null,
    })
    .eq("id", input.log.id)
    .eq("attempt_number", input.log.attempt_number)
    .is("delivered_at", null)
    .select(DELIVERY_LOG_COLUMNS)
    .maybeSingle();
  if (error) {
    throw databaseError("Webhook delivery result update failed", error);
  }

  if (data) {
    const finalized = parseDeliveryLog(data);
    assertDeliveryIdentity(finalized, input.identity);
    if (input.result.success) return;
    throw new Error(input.result.errorMessage || "Webhook delivery failed");
  }

  const current = await loadDeliveryLog(input.identity.idempotencyKey);
  if (!current) {
    throw new Error(
      `Webhook delivery ${input.identity.idempotencyKey} disappeared after HTTP`
    );
  }
  assertDeliveryIdentity(current, input.identity);
  if (current.delivered_at) return;
  throw new Error(
    `Webhook delivery ${input.identity.idempotencyKey} lost its reserved attempt`
  );
}

async function deliverSubscription(input: {
  subscription: WebhookSubscription;
  event: DispatchWebhookEventInput;
  payload: WebhookPayload;
}): Promise<void> {
  const idempotencyKey = buildIdempotencyKey({
    webhookId: input.subscription.id,
    eventType: input.event.eventType,
    resourceId: input.event.resourceId,
    payload: input.payload,
  });
  const identity = {
    webhookId: input.subscription.id,
    eventType: input.event.eventType,
    payload: input.payload,
    idempotencyKey,
  };
  const reservation = await reserveWebhookAttempt(identity);
  if (reservation.status === "completed") return;

  const result = await sendReservedWebhook({
    subscription: input.subscription,
    payload: input.payload,
    idempotencyKey,
    attemptNumber: reservation.log.attempt_number,
  });
  await finalizeWebhookAttempt({
    log: reservation.log,
    identity,
    result,
  });
}

async function collectDeliveryFailures(
  subscriptions: unknown[],
  deliver: (subscription: WebhookSubscription) => Promise<void>
): Promise<unknown[]> {
  const failures: unknown[] = [];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(WEBHOOK_CONCURRENCY, subscriptions.length) },
    async () => {
      while (cursor < subscriptions.length) {
        const subscription = subscriptions[cursor];
        cursor += 1;
        try {
          await deliver(parseSubscription(subscription));
        } catch (error) {
          failures.push(error);
        }
      }
    }
  );
  await Promise.all(workers);
  return failures;
}

export async function dispatchWebhookEvent(
  input: DispatchWebhookEventInput
): Promise<void> {
  if (!Number.isFinite(Date.parse(input.timestamp))) {
    throw new Error("Webhook event timestamp is invalid");
  }
  if (input.subscriptionIds?.length === 0) return;

  let query = supabaseAdmin
    .from("webhook_subscriptions")
    .select("id, url, secret, headers")
    .eq("workspace_id", input.workspaceId)
    .eq("is_active", true)
    .contains("events", [input.eventType]);
  if (input.subscriptionIds) {
    query = query.in("id", [...new Set(input.subscriptionIds)]);
  }

  const { data, error } = await query;
  if (error) {
    throw databaseError("Webhook subscription query failed", error);
  }
  if (!data?.length) return;

  const payload = canonicalizeWebhookPayload({
    event: input.eventType,
    timestamp: input.timestamp,
    workspace_id: input.workspaceId,
    data: input.data,
  });
  const failures = await collectDeliveryFailures(data, subscription =>
    deliverSubscription({ subscription, event: input, payload })
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} webhook delivery failed: ${failures
        .map(errorMessage)
        .join("; ")}`
    );
  }
}

/** Resolve subscriptions once, before the first HTTP attempt, then freeze IDs in the outbox. */
export async function snapshotWebhookSubscriptionIds(input: {
  workspaceId: string;
  eventType: WebhookEventType;
}): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("webhook_subscriptions")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("is_active", true)
    .contains("events", [input.eventType]);
  if (error) throw databaseError("Webhook subscription query failed", error);
  return (data || []).map(row => {
    if (typeof row.id !== "string")
      throw new Error("Webhook subscription ID is invalid");
    return row.id;
  });
}

// PostgREST returns at most 1,000 rows without saying so. A workspace holds
// at most 20 subscriptions (customer-api/management), so 40 workspaces stay
// below it; reaching it anyway fails the read instead of hiding subscribers.
const SUBSCRIBED_EVENT_TYPES_WORKSPACE_CHUNK = 40;
const SUBSCRIBED_EVENT_TYPES_ROW_CEILING = 1_000;

/**
 * Active subscription event types per workspace, read in one query per chunk.
 * Keys are lowercase workspace ids.
 */
export async function listActiveWebhookEventTypes(
  workspaceIds: readonly string[]
): Promise<Map<string, Set<string>>> {
  const ids = [...new Set(workspaceIds.filter(Boolean))];
  const subscribed = new Map<string, Set<string>>();
  for (
    let offset = 0;
    offset < ids.length;
    offset += SUBSCRIBED_EVENT_TYPES_WORKSPACE_CHUNK
  ) {
    const { data, error } = await supabaseAdmin
      .from("webhook_subscriptions")
      .select("workspace_id, events")
      .eq("is_active", true)
      .in(
        "workspace_id",
        ids.slice(offset, offset + SUBSCRIBED_EVENT_TYPES_WORKSPACE_CHUNK)
      );
    if (error) throw databaseError("Webhook subscription query failed", error);
    if ((data || []).length >= SUBSCRIBED_EVENT_TYPES_ROW_CEILING)
      throw new Error("Webhook subscription listing may be truncated");
    for (const row of data || []) {
      if (typeof row.workspace_id !== "string" || !Array.isArray(row.events))
        throw new Error("Webhook subscription row is invalid");
      const workspaceId = row.workspace_id.toLowerCase();
      const events = subscribed.get(workspaceId) || new Set<string>();
      for (const event of row.events)
        if (typeof event === "string") events.add(event);
      subscribed.set(workspaceId, events);
    }
  }
  return subscribed;
}

/** Persist first; customer HTTP and subscriber lookup run only in the existing drain. */
export async function queueCustomerWebhookEvent(
  input: DispatchWebhookEventInput
): Promise<void> {
  if (
    !input.workspaceId ||
    !input.resourceId ||
    !Number.isFinite(Date.parse(input.timestamp))
  ) {
    throw new Error("Webhook event identity is invalid");
  }
  const immutableInput = {
    ...input,
    data: JSON.parse(stableSerialize(input.data)) as Record<string, unknown>,
  };
  const { enqueueCustomerWebhookWithOutbox } = await import(
    "./cross-store-outbox"
  );
  await enqueueCustomerWebhookWithOutbox(immutableInput);
}

export async function triggerWebhookEvent(
  workspaceId: string,
  eventType: WebhookEventType,
  resourceId: string,
  data: Record<string, unknown>
): Promise<void> {
  const persistedTime =
    data.updated_at ?? data.submitted_at ?? data.timestamp ?? data.created_at;
  const timestamp =
    typeof persistedTime === "string" &&
    Number.isFinite(Date.parse(persistedTime))
      ? persistedTime
      : new Date().toISOString();
  try {
    await queueCustomerWebhookEvent({
      workspaceId,
      eventType,
      resourceId,
      timestamp,
      data,
    });
  } catch (error) {
    webhookLogger.error("webhook.delivery_failed", error, {
      workspaceId,
      eventType,
      resourceId,
      timestamp,
      outcome: "error",
    });
  }
}
