import {
  buildWhatsAppWebhookEventEnvelopes,
  buildWhatsAppWebhookMessageRecoveryEnvelope,
  getWhatsAppWebhookOrderingKey,
  getWhatsAppWebhookProcessorRoutingKey,
} from "@icecore/airi-runtime/whatsapp-webhook-event-envelopes";
import WhatsAppWebhookEvent from "@icecore/airi-runtime/whatsapp-webhook-event-model";
import { attachWhatsAppHistoryImportBinding } from "@icecore/airi-runtime/whatsapp-history-import";
import { normalizeWhatsAppAccountIdentifiers } from "@icecore/shared/lib/whatsapp/account-identifiers";
import { asWhatsAppRecord } from "@icecore/shared/lib/whatsapp/value-utils";
import type { WhatsAppHistorySyncState } from "@icecore/whatsapp/historySyncState";

import { publishWhatsAppWebhookEventToPubSub } from "@/lib/whatsapp/webhook-pubsub";
import { resolveWhatsAppSourceByAccountIdentifiers } from "@/lib/whatsapp/source-resolver";

export {
  buildWhatsAppWebhookEventEnvelopes,
  getWhatsAppWebhookOrderingKey,
  getWhatsAppWebhookProcessorRoutingKey,
};

type EnqueueWhatsAppWebhookEventsResult = {
  received: number;
  persisted: number;
  published: number;
  publishFailures: number;
  eventIds: string[];
  eventIdsTruncated: boolean;
  skippedAlreadyHandled: number;
  duplicateDeliveries: number;
  fields: Record<string, number>;
  itemKinds: Record<string, number>;
  timings: {
    totalMs: number;
    buildEnvelopesMs: number;
    upsertMs: number;
    publishMs: number;
    publishStatusUpdateMs: number;
  };
  events: Array<{
    eventId: string;
    field: string;
    itemKind: string;
    status: string | null;
    duplicateCount: number | null;
    publishAttempts: number | null;
    published: boolean;
    skippedAlreadyHandled: boolean;
  }>;
};

type WhatsAppWebhookPublishStoredResult = {
  eventId: string;
  published: boolean;
  errorMessage?: string | null;
  statusUpdateMs: number;
};

const MAX_LOG_EVENT_SUMMARIES = 20;

type PersistedWebhookEnvelope = ReturnType<
  typeof buildWhatsAppWebhookEventEnvelopes
>[number];

type PersistedWebhookEnvelopeResult = {
  envelope: PersistedWebhookEnvelope;
  eventId: string;
  status: string | null;
  duplicateCount: number | null;
  publishAttempts: number | null;
  published: boolean;
  skippedAlreadyHandled: boolean;
  upsertMs: number;
  publishMs: number;
  publishStatusUpdateMs: number;
};

async function persistAndPublishWhatsAppWebhookEnvelope(
  envelope: PersistedWebhookEnvelope,
  providerSignatureVerified: boolean,
  allowRecovery = true
): Promise<PersistedWebhookEnvelopeResult> {
  const upsertStartedAt = Date.now();
  const event = await WhatsAppWebhookEvent.findOneAndUpdate(
    { dedupeKey: envelope.dedupeKey },
    {
      $setOnInsert: {
        provider: "whatsapp",
        dedupeKey: envelope.dedupeKey,
        object: envelope.object,
        field: envelope.field,
        itemKind: envelope.itemKind,
        workspaceId: envelope.workspaceId,
        sourceId: envelope.sourceId,
        phoneNumberId: envelope.phoneNumberId,
        csId: envelope.csId,
        wabaId: envelope.wabaId,
        messagingAccountId: envelope.messagingAccountId,
        waacId: envelope.waacId,
        orderingKey: envelope.orderingKey,
        payload: envelope.payload,
        // Bind provenance to the original stored body, never a duplicate or a
        // claim inside the webhook JSON. Legacy events remain unverified.
        providerSignatureVerified,
        originalPayloadHash: envelope.payload.originalRawBodyHash,
        historyMetadata: envelope.historyMetadata,
        ...(envelope.historyImport
          ? { historyImport: envelope.historyImport }
          : {}),
        status: "received",
        firstReceivedAt: envelope.receivedAt,
        nextRetryAt: new Date(),
      },
      $set: {
        lastReceivedAt: envelope.receivedAt,
      },
      $inc: { duplicateCount: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const upsertMs = Date.now() - upsertStartedAt;

  const recovery = allowRecovery
    ? buildWhatsAppWebhookMessageRecoveryEnvelope({
        incoming: envelope,
        storedPayload: event.payload,
        storedOrderingKey: event.orderingKey,
        providerSignatureVerified,
      })
    : null;
  if (recovery) {
    const result = await persistAndPublishWhatsAppWebhookEnvelope(
      recovery,
      providerSignatureVerified,
      false
    );
    return { ...result, upsertMs: result.upsertMs + upsertMs };
  }

  const eventId = String(event._id);
  const status = String(event.status || "") || null;
  const duplicateCount =
    typeof event.duplicateCount === "number" ? event.duplicateCount : null;
  const publishAttempts =
    typeof event.publishAttempts === "number" ? event.publishAttempts : null;

  if (
    ["published", "queued", "processing", "completed", "dead"].includes(
      status || ""
    ) ||
    Number(event.nextRetryAt) > Date.now()
  ) {
    return {
      envelope,
      eventId,
      status,
      duplicateCount,
      publishAttempts,
      published: false,
      skippedAlreadyHandled: true,
      upsertMs,
      publishMs: 0,
      publishStatusUpdateMs: 0,
    };
  }

  const publishStartedAt = Date.now();
  const publishResult = await publishStoredWhatsAppWebhookEvent({
    eventId,
    dedupeKey: envelope.dedupeKey,
    field: envelope.field,
    itemKind: envelope.itemKind,
    orderingKey: envelope.orderingKey,
    receivedAt: envelope.receivedAt,
    observedState: {
      status,
      nextRetryAt: event.nextRetryAt ?? null,
      processingStartedAt: event.processingStartedAt ?? null,
      processingLeaseId: event.processingLeaseId ?? null,
    },
  });

  return {
    envelope,
    eventId,
    status,
    duplicateCount,
    publishAttempts,
    published: publishResult.published,
    skippedAlreadyHandled: false,
    upsertMs,
    publishMs: Date.now() - publishStartedAt,
    publishStatusUpdateMs: publishResult.statusUpdateMs,
  };
}

/** Resolve only history chunks and coalesce lookups within this delivery. Other
 * webhook lanes retain their existing ingress cost and identity. */
async function bindHistoryImportSessions(
  envelopes: PersistedWebhookEnvelope[]
): Promise<PersistedWebhookEnvelope[]> {
  const sources = new Map<
    string,
    ReturnType<typeof resolveWhatsAppSourceByAccountIdentifiers>
  >();
  return Promise.all(
    envelopes.map(async envelope => {
      if (envelope.field !== "history") return envelope;
      const phoneNumberId = envelope.phoneNumberId || envelope.csId;
      if (!phoneNumberId)
        throw new Error("History webhook source phone is missing");
      const key = JSON.stringify([phoneNumberId, envelope.wabaId]);
      let resolution = sources.get(key);
      if (!resolution) {
        resolution = resolveWhatsAppSourceByAccountIdentifiers({
          phoneNumberId,
          csId: envelope.csId || undefined,
          wabaId: envelope.wabaId || undefined,
          messagingAccountId: envelope.messagingAccountId || undefined,
          waacId: envelope.waacId || undefined,
          bypassCache: true,
        });
        sources.set(key, resolution);
      }
      const source = await resolution;
      const credentials = asWhatsAppRecord(source?.credentials);
      const identifiers = normalizeWhatsAppAccountIdentifiers(credentials);
      if (
        !source?.id ||
        !source.workspace_id ||
        identifiers.phoneNumberId !== phoneNumberId ||
        (envelope.wabaId &&
          identifiers.wabaId &&
          envelope.wabaId !== identifiers.wabaId)
      ) {
        throw new Error(
          "History webhook source binding is unavailable or changed"
        );
      }
      const history = credentials.history_sync as
        | WhatsAppHistorySyncState
        | undefined;
      // Existing companies are never enrolled by an incoming webhook.
      if (!history?.session_id) return envelope;
      // Meta sends history only after our request. Do not assign a delivery
      // arriving before the durable claim to this new connection session.
      // The handler supersedes unbound receipts for session-bound sources.
      if (!history.request_attempt_id) return envelope;
      if (
        !history.session_started_at ||
        !Number.isFinite(Date.parse(history.session_started_at))
      ) {
        throw new Error("History webhook source session is invalid");
      }
      return attachWhatsAppHistoryImportBinding(envelope, {
        capacityPolicyVersion: history.import_policy_version,
        sessionId: history.session_id,
        sessionStartedAt: history.session_started_at,
        rangeDays:
          typeof history.range_days === "number" &&
          Number.isFinite(history.range_days)
            ? Math.min(180, Math.max(1, Math.floor(history.range_days)))
            : 180,
        workspaceId: source.workspace_id,
        sourceId: source.id,
        phoneNumberId,
        wabaId: identifiers.wabaId || null,
      });
    })
  );
}

export async function enqueueWhatsAppWebhookEvents(params: {
  body: unknown;
  rawBody: string;
  providerSignatureVerified?: boolean;
  receivedAt?: Date;
}): Promise<EnqueueWhatsAppWebhookEventsResult> {
  const startedAt = Date.now();
  const timings = {
    totalMs: 0,
    buildEnvelopesMs: 0,
    upsertMs: 0,
    publishMs: 0,
    publishStatusUpdateMs: 0,
  };

  const buildStartedAt = Date.now();
  const envelopes = await bindHistoryImportSessions(
    buildWhatsAppWebhookEventEnvelopes(params)
  );
  timings.buildEnvelopesMs = Date.now() - buildStartedAt;
  const results: Array<PersistedWebhookEnvelopeResult | undefined> = new Array(
    envelopes.length
  );
  const lanes = new Map<
    string,
    Array<{ envelope: PersistedWebhookEnvelope; index: number }>
  >();

  for (const [index, envelope] of envelopes.entries()) {
    const lane = lanes.get(envelope.orderingKey);
    const item = { envelope, index };
    if (lane) {
      lane.push(item);
    } else {
      lanes.set(envelope.orderingKey, [item]);
    }
  }

  await Promise.all(
    [...lanes.values()].map(async lane => {
      for (const { envelope, index } of lane) {
        results[index] = await persistAndPublishWhatsAppWebhookEnvelope(
          envelope,
          params.providerSignatureVerified === true
        );
      }
    })
  );

  const eventIds: string[] = [];
  const events: EnqueueWhatsAppWebhookEventsResult["events"] = [];
  const fields: Record<string, number> = {};
  const itemKinds: Record<string, number> = {};
  let published = 0;
  let publishFailures = 0;
  let skippedAlreadyHandled = 0;
  let duplicateDeliveries = 0;

  for (const result of results) {
    if (!result) continue;
    const { envelope } = result;
    fields[envelope.field] = (fields[envelope.field] || 0) + 1;
    itemKinds[envelope.itemKind] = (itemKinds[envelope.itemKind] || 0) + 1;
    timings.upsertMs += result.upsertMs;
    timings.publishMs += result.publishMs;
    timings.publishStatusUpdateMs += result.publishStatusUpdateMs;

    if (result.duplicateCount && result.duplicateCount > 1) {
      duplicateDeliveries += result.duplicateCount - 1;
    }
    eventIds.push(result.eventId);
    if (result.skippedAlreadyHandled) {
      skippedAlreadyHandled += 1;
      if (events.length < MAX_LOG_EVENT_SUMMARIES) {
        events.push({
          eventId: result.eventId,
          field: envelope.field,
          itemKind: envelope.itemKind,
          status: result.status,
          duplicateCount: result.duplicateCount,
          publishAttempts: result.publishAttempts,
          published: false,
          skippedAlreadyHandled: true,
        });
      }
      continue;
    }
    if (result.published) {
      published += 1;
    } else {
      publishFailures += 1;
    }
    if (events.length < MAX_LOG_EVENT_SUMMARIES) {
      events.push({
        eventId: result.eventId,
        field: envelope.field,
        itemKind: envelope.itemKind,
        status: result.status,
        duplicateCount: result.duplicateCount,
        publishAttempts: result.publishAttempts,
        published: result.published,
        skippedAlreadyHandled: false,
      });
    }
  }

  timings.totalMs = Date.now() - startedAt;

  return {
    received: envelopes.length,
    persisted: eventIds.length,
    published,
    publishFailures,
    eventIds,
    eventIdsTruncated: eventIds.length > MAX_LOG_EVENT_SUMMARIES,
    skippedAlreadyHandled,
    duplicateDeliveries,
    fields,
    itemKinds,
    timings,
    events,
  };
}

export async function publishStoredWhatsAppWebhookEvent(params: {
  eventId: string;
  dedupeKey: string;
  field: string;
  itemKind?: string | null;
  orderingKey: string;
  receivedAt: Date | string;
  observedState: Record<
    "status" | "nextRetryAt" | "processingStartedAt" | "processingLeaseId",
    unknown
  >;
}): Promise<WhatsAppWebhookPublishStoredResult> {
  const receivedAt =
    params.receivedAt instanceof Date
      ? params.receivedAt.toISOString()
      : params.receivedAt;
  // A consumer can finish or defer before Pub/Sub acknowledges publication.
  const updateFilter = { _id: params.eventId, ...params.observedState };
  let statusUpdateMs = 0;
  const publishResult = await publishWhatsAppWebhookEventToPubSub({
    eventId: params.eventId,
    dedupeKey: params.dedupeKey,
    field: params.field,
    itemKind: params.itemKind || null,
    orderingKey: params.orderingKey,
    receivedAt,
  });

  if (publishResult.ok) {
    const statusUpdateStartedAt = Date.now();
    await WhatsAppWebhookEvent.updateOne(
      updateFilter,
      {
        $set: {
          status: "published",
          publishedAt: new Date(),
          pubsubMessageId: publishResult.messageId || null,
          lastError: null,
        },
        $inc: { publishAttempts: 1 },
      }
    );
    statusUpdateMs = Date.now() - statusUpdateStartedAt;
    return { eventId: params.eventId, published: true, statusUpdateMs };
  }

  const statusUpdateStartedAt = Date.now();
  await WhatsAppWebhookEvent.updateOne(
    updateFilter,
    {
      $set: {
        status: "received",
        lastError: publishResult.errorMessage || "Pub/Sub publish failed",
        nextRetryAt: new Date(Date.now() + 60_000),
      },
      $inc: { publishAttempts: 1 },
    }
  );
  statusUpdateMs = Date.now() - statusUpdateStartedAt;
  return {
    eventId: params.eventId,
    published: false,
    statusUpdateMs,
    errorMessage: publishResult.errorMessage || "Pub/Sub publish failed",
  };
}
