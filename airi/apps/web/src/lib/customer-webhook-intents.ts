import { stripWhatsAppMessageIdPrefix } from "@icecore/shared/lib/whatsapp/message-id";
import type { DispatchWebhookEventInput } from "./webhooks";

type MessageFact = {
  _id?: unknown;
  workspaceId?: string | null;
  conversation?: unknown;
  channel?: string | null;
  direction?: string | null;
  messageId?: string | null;
  date?: Date | null;
  text?: string | null;
  mediaType?: string | null;
  origin?: { sourceId?: string | null } | null;
  rawSourcePayload?: { eventType?: string | null } | null;
  temporalDispatch?: { state?: string | null } | null;
};

function referenceId(value: unknown): string {
  const id =
    value && typeof value === "object" && "_id" in value
      ? (value as { _id: unknown })._id
      : value;
  return String(id);
}

/** Called before save so the fact and recovery marker commit in the same Mongo write. */
export function buildCustomerMessageWebhookIntent(
  message: MessageFact,
  sourceId?: string | null
): DispatchWebhookEventInput | null {
  if (
    message.channel !== "whatsapp" ||
    !message.workspaceId ||
    !message.conversation ||
    !message.messageId ||
    !message._id ||
    !["inbound", "outbound"].includes(message.direction || "") ||
    !(message.date instanceof Date) ||
    !Number.isFinite(message.date.getTime()) ||
    message.rawSourcePayload?.eventType?.startsWith("history_") ||
    (message.temporalDispatch?.state &&
      message.temporalDispatch.state !== "sent")
  )
    return null;
  return {
    workspaceId: message.workspaceId,
    eventType:
      message.direction === "inbound" ? "message.received" : "message.sent",
    resourceId: message.messageId,
    timestamp: message.date.toISOString(),
    data: {
      message_id: referenceId(message._id),
      provider_message_id: stripWhatsAppMessageIdPrefix(message.messageId),
      conversation_id: referenceId(message.conversation),
      source_id: sourceId || message.origin?.sourceId || null,
      direction: message.direction,
      text: message.text || "",
      media_type: message.mediaType || null,
      channel: "whatsapp",
      timestamp: message.date.toISOString(),
    },
  };
}

export function buildCustomerStatusWebhookIntent(event: {
  workspaceId?: string | null;
  messageId?: string | null;
  status?: string | null;
  eventAt?: Date | null;
  conversationId?: unknown;
  messageObjectId?: unknown;
  sourceId?: string | null;
  errorCode?: number | null;
}): DispatchWebhookEventInput | null {
  if (
    !event.workspaceId ||
    !event.messageId ||
    !["sent", "delivered", "read", "failed"].includes(event.status || "") ||
    !(event.eventAt instanceof Date) ||
    !Number.isFinite(event.eventAt.getTime())
  )
    return null;
  const timestamp = event.eventAt.toISOString();
  return {
    workspaceId: event.workspaceId,
    eventType: "message.status_updated",
    resourceId: `${event.messageId}:${event.status}:${timestamp}`,
    timestamp,
    data: {
      provider_message_id: stripWhatsAppMessageIdPrefix(event.messageId),
      message_id: event.messageObjectId
        ? referenceId(event.messageObjectId)
        : null,
      conversation_id: event.conversationId
        ? referenceId(event.conversationId)
        : null,
      source_id: event.sourceId || null,
      channel: "whatsapp",
      status: event.status,
      timestamp,
      ...(event.errorCode != null ? { error_code: event.errorCode } : {}),
    },
  };
}

/** Rows read per collection per run; unsubscribed facts are cleared in bulk. */
export const CUSTOMER_WEBHOOK_INTENT_SCAN_LIMIT = 1_000;

type PendingIntentRow = {
  _id: unknown;
  workspaceId?: string | null;
  customerWebhookIntent?: unknown;
};

type ListSubscribedEventTypes = (
  workspaceIds: string[]
) => Promise<ReadonlyMap<string, ReadonlySet<string>>>;

function pendingIntent(row: PendingIntentRow) {
  const intent = row.customerWebhookIntent as
    | DispatchWebhookEventInput
    | undefined;
  return intent && row.workspaceId === intent.workspaceId ? intent : null;
}

function clearIntentFilter(
  row: PendingIntentRow,
  intent: DispatchWebhookEventInput
) {
  return {
    _id: row._id,
    workspaceId: intent.workspaceId,
    "customerWebhookIntent.resourceId": intent.resourceId,
    "customerWebhookIntent.timestamp": intent.timestamp,
  };
}

/**
 * The existing outbox drain recovers saves whose caller crashed before admission.
 * A fact whose workspace has no active subscription for its event would snapshot
 * no subscribers in the outbox, so its marker is cleared without an outbox row.
 */
export async function reconcileCustomerWebhookIntents(params: {
  enqueue: (input: DispatchWebhookEventInput) => Promise<void>;
  limit: number;
  deadlineAtMs?: number;
  listSubscribedEventTypes?: ListSubscribedEventTypes;
}): Promise<{ admitted: number; skipped: number; hasMore: boolean }> {
  const result = { admitted: 0, skipped: 0, hasMore: false };
  const deadlineAtMs = params.deadlineAtMs ?? Infinity;
  if (Date.now() >= deadlineAtMs) return { ...result, hasMore: true };
  const [
    { default: Message },
    { default: MessageDeliveryEvent },
    { Conversation },
  ] = await Promise.all([
    import("@/models/message"),
    import("@/models/message-delivery-event"),
    import("@/models/conversation"),
  ]);
  const limit = Math.max(1, Math.min(100, params.limit));
  const scanLimit = Math.max(limit, CUSTOMER_WEBHOOK_INTENT_SCAN_LIMIT);
  const scanned = await Promise.all(
    [Message, MessageDeliveryEvent].map(async model => ({
      model,
      rows: (await model
        .find({ customerWebhookIntent: { $exists: true } })
        .sort({ "customerWebhookIntent.timestamp": 1, _id: 1 })
        .limit(scanLimit + 1)
        .select("_id workspaceId +customerWebhookIntent")
        .lean()) as PendingIntentRow[],
    }))
  );
  result.hasMore = scanned.some(({ rows }) => rows.length > scanLimit);

  const workspaceIds = [
    ...new Set(
      scanned.flatMap(({ rows }) =>
        rows.flatMap(row => {
          const intent = pendingIntent(row);
          return intent ? [intent.workspaceId] : [];
        })
      )
    ),
  ];
  // Keyed by lowercase id: the uuid column matched any letter case before.
  let subscribed: Map<string, ReadonlySet<string>> | null = null;
  if (workspaceIds.length > 0) {
    try {
      const listSubscribedEventTypes =
        params.listSubscribedEventTypes ||
        (await import("./webhooks")).listActiveWebhookEventTypes;
      const listed = await listSubscribedEventTypes(workspaceIds);
      subscribed = new Map();
      for (const [workspaceId, events] of listed) {
        const key = workspaceId.toLowerCase();
        subscribed.set(
          key,
          new Set([...(subscribed.get(key) || []), ...events])
        );
      }
    } catch {
      // Unknown subscriptions keep the outbox path, which snapshots them itself.
      subscribed = null;
    }
  }
  const isUnsubscribed = (row: PendingIntentRow) => {
    const intent = pendingIntent(row);
    return Boolean(
      subscribed &&
        intent &&
        !subscribed.get(intent.workspaceId.toLowerCase())?.has(intent.eventType)
    );
  };

  const queues = scanned.map(({ model, rows }) => {
    const page = rows.slice(0, scanLimit);
    const deliverable = page.filter(row => !isUnsubscribed(row));
    if (deliverable.length > limit) result.hasMore = true;
    return {
      model,
      unsubscribed: page.filter(isUnsubscribed),
      rows: deliverable.slice(0, limit),
    };
  });
  const clearUnsubscribed = Promise.all(
    queues.map(async ({ model, unsubscribed }) => {
      if (unsubscribed.length === 0) return;
      try {
        const cleared = await model.bulkWrite(
          unsubscribed.map(row => ({
            updateOne: {
              filter: clearIntentFilter(row, pendingIntent(row)!),
              update: { $unset: { customerWebhookIntent: 1 } },
            },
          })),
          { ordered: false }
        );
        result.skipped += cleared.modifiedCount;
        if (cleared.modifiedCount !== unsubscribed.length)
          result.hasMore = true;
      } catch {
        // Markers stay; the next run clears them.
        result.hasMore = true;
      }
    })
  );
  // Share one bounded pool, alternating collections so a message backlog cannot
  // consume every admission slot before status recovery starts.
  const candidates = Array.from({ length: limit }, (_, index) =>
    queues.flatMap(({ model, rows }) => {
      const row = rows[index];
      return row ? [{ model, row }] : [];
    })
  ).flat();
  // A slow scan must not starve subscribed facts run after run: when it used
  // up the budget, each worker still admits one fact before stopping.
  const scanOverranDeadline = Date.now() >= deadlineAtMs;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(8, candidates.length) },
    async () => {
      let taken = 0;
      while (cursor < candidates.length) {
        if (
          Date.now() >= deadlineAtMs &&
          !(scanOverranDeadline && taken === 0)
        ) {
          result.hasMore = true;
          return;
        }
        taken += 1;
        const { model, row } = candidates[cursor]!;
        cursor += 1;
        const intent = pendingIntent(row);
        if (!intent) {
          result.hasMore = true;
          continue;
        }
        try {
          if (!intent.data.source_id && intent.data.conversation_id) {
            const conversation = await Conversation.findOne({
              _id: intent.data.conversation_id,
              workspaceId: intent.workspaceId,
              channel: "whatsapp",
            })
              .select("sourceId")
              .lean<{ sourceId?: string | null }>();
            if (conversation?.sourceId)
              intent.data = {
                ...intent.data,
                source_id: conversation.sourceId,
              };
          }
          await params.enqueue(intent);
          const cleared = await model.updateOne(
            clearIntentFilter(row, intent),
            { $unset: { customerWebhookIntent: 1 } }
          );
          if (cleared.modifiedCount === 1) result.admitted += 1;
          else result.hasMore = true;
        } catch {
          // Keep the recovery marker; one failed fact must not block its peers.
          result.hasMore = true;
        }
      }
    }
  );
  await Promise.all([clearUnsubscribed, ...workers]);
  return result;
}
