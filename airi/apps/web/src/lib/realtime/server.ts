import { createHash } from "node:crypto";
import {
  buildRealtimeChannelName,
  buildRealtimeEvent,
  parseRealtimeChannelName,
  type RealtimeEventEnvelope,
  type RealtimeEventName,
  type RealtimeEventPayload,
} from "@icecore/shared/types/realtime";
import { createLogger } from "@icecore/shared/lib/logger";
import { isDeepStrictEqual } from "node:util";
import { isMongoDuplicateKeyError } from "@icecore/shared/lib/mongo-errors";

type RawPayload = Record<string, unknown>;

type RealtimePubSubConfig = {
  enabled: boolean;
  projectIdEnvName: string;
  topic: string;
};

export type MappedRealtimeEvent = RealtimeEventEnvelope & {
  channel: string;
};

export type ConversationCallUpdatedRealtimePayload = {
  callSessionId: string;
  state: string;
  reason?: string;
};

export type CrmBoardChangedReason =
  | "stage_moved"
  | "owner_changed"
  | "pipeline_saved";

export type CrmBoardChangedRealtimeInput = {
  workspaceId: string;
  reason: CrmBoardChangedReason;
  customerId?: string | null;
  conversationId?: string | null;
  stageKey?: string | null;
  ownerUserId?: string | null;
};

export type CrmBoardChangedRealtimePayload = {
  reason: CrmBoardChangedReason;
  customerId?: string | null;
  stageKey?: string | null;
  ownerUserId?: string | null;
};

/**
 * A product video import moved on, one of its products got its photo, or
 * the owner checked some of its products (review).
 */
export type ProductsChangedRealtimeInput = {
  workspaceId: string;
  importId: string;
  reason: "import" | "products_found" | "photo" | "review";
  productId?: string | null;
};

export type ProductsChangedRealtimePayload = Omit<
  ProductsChangedRealtimeInput,
  "workspaceId"
>;

type LeanConversationWorkspace = {
  workspaceId?: string | null;
};

const DEFAULT_REALTIME_TOPIC = "icecore-realtime-events";
const PROJECT_ID_ENV_NAME = "GCP_PROJECT_ID";
const realtimeServerLogger = createLogger("realtime-server");

export function resolveRealtimePubSubConfig(): RealtimePubSubConfig {
  return {
    enabled: true,
    projectIdEnvName: PROJECT_ID_ENV_NAME,
    topic: DEFAULT_REALTIME_TOPIC,
  };
}

function getString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "toString" in value) {
    const stringValue = String(value);
    return stringValue && stringValue !== "[object Object]"
      ? stringValue
      : null;
  }
  return null;
}

function asPayload(value: unknown): RawPayload {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawPayload)
    : { value };
}

// Message events reach staff and widget browsers, so customer media in them
// is exchanged for signed URLs (top level or under `message`).
async function withSignedMessagePayloadMedia(
  rawPayload: RawPayload
): Promise<RawPayload> {
  const serialized = JSON.stringify(rawPayload);
  if (!serialized.includes("/storage/v1/object/public/")) {
    return rawPayload;
  }
  // Callers may pass Mongoose documents (the Telegram webhook sends its
  // populated message), whose fields exist only through toJSON; a spread copy
  // of one holds its internals instead. The event goes out as JSON anyway.
  const payload = JSON.parse(serialized) as RawPayload;
  const { withCustomerMediaReadUrls } = await import(
    "@/lib/media/customer-media-read-url"
  );
  const nested =
    payload.message &&
    typeof payload.message === "object" &&
    !Array.isArray(payload.message)
      ? (payload.message as RawPayload)
      : null;
  const [signed, signedNested] = await withCustomerMediaReadUrls(
    nested ? [payload, nested] : [payload]
  );
  return nested ? { ...signed, message: signedNested } : signed;
}

function extractMessageId(payload: RawPayload): string | null {
  return (
    getString(payload.messageId) ||
    getString(payload.id) ||
    getString(payload._id) ||
    getString((payload.message as RawPayload | undefined)?._id) ||
    getString((payload.message as RawPayload | undefined)?.id)
  );
}

function extractConversationIdFromPayload(payload: RawPayload): string | null {
  return (
    getString(payload.conversationId) ||
    getString(payload.conversation) ||
    getString((payload.message as RawPayload | undefined)?.conversationId) ||
    getString((payload.message as RawPayload | undefined)?.conversation)
  );
}

function extractRowConversationIdFromPayload(
  payload: RawPayload
): string | null {
  return (
    extractConversationIdFromPayload(payload) ||
    getString(payload._id) ||
    getString(payload.id)
  );
}

function extractWorkspaceIdFromPayload(payload: RawPayload): string | null {
  return (
    getString(payload.workspaceId) ||
    getString((payload.message as RawPayload | undefined)?.workspaceId) ||
    getString((payload.conversation as RawPayload | undefined)?.workspaceId)
  );
}

function extractChannelParts(channel: string): {
  workspaceId?: string;
  conversationId?: string;
  isWorkspaceChannel: boolean;
  isAlertChannel: boolean;
} {
  const tenantMatch = channel.match(/^tenant-(.+)$/);
  if (tenantMatch?.[1]) {
    return {
      workspaceId: tenantMatch[1],
      isWorkspaceChannel: true,
      isAlertChannel: false,
    };
  }

  const alertMatch = channel.match(/^private-(.+)-alerts$/);
  if (alertMatch?.[1]) {
    return {
      workspaceId: alertMatch[1],
      isWorkspaceChannel: true,
      isAlertChannel: true,
    };
  }

  const privateConversationMatch = channel.match(
    /^private-conversation-([A-Fa-f0-9]{24})$/
  );
  if (privateConversationMatch?.[1]) {
    return {
      conversationId: privateConversationMatch[1],
      isWorkspaceChannel: false,
      isAlertChannel: false,
    };
  }

  const widgetConversationMatch = channel.match(
    /^(?:conversation|legacy-widget)-([A-Fa-f0-9]{24})$/
  );
  if (widgetConversationMatch?.[1]) {
    return {
      conversationId: widgetConversationMatch[1],
      isWorkspaceChannel: false,
      isAlertChannel: false,
    };
  }

  return { isWorkspaceChannel: false, isAlertChannel: false };
}

async function resolveWorkspaceIdForConversation(
  conversationId: string
): Promise<string | null> {
  const { default: connectDB } = await import("@/lib/mongoose");
  const { Conversation } = await import("@/models/conversation");
  await connectDB();
  const conversation = (await Conversation.findById(conversationId)
    .select("workspaceId")
    .lean()
    .exec()) as LeanConversationWorkspace | null;
  return getString(conversation?.workspaceId);
}

function mapLegacyEventName(eventName: string): RealtimeEventName {
  if (eventName === "requests.new" || eventName === "requests.update") {
    return "conversation.row.changed";
  }
  if (eventName === "new-message" || eventName === "message.new") {
    return "conversation.message.created";
  }
  if (eventName === "message-updated" || eventName === "message-delivery") {
    return "conversation.message.updated";
  }
  if (eventName === "conversation.note.changed") {
    return "conversation.note.changed";
  }
  if (eventName === "conversation.call.updated") {
    return "conversation.call.updated";
  }
  if (
    eventName === "airi.typing" ||
    eventName === "airi.typing.stop" ||
    eventName === "airi.thinking"
  ) {
    return "airi.typing";
  }
  if (eventName === "airi.suggestion") return "airi.suggestion";
  if (eventName === "airi.suppressed") return "airi.suppressed";
  if (eventName === "airi.handoff") return "airi.handoff";
  if (eventName === "airi.alert" || eventName === "alert") {
    return "alert.created";
  }
  if (eventName === "conversation-updated") {
    return "widget.csat.changed";
  }
  return "conversation.row.changed";
}

function createRealtimeEventId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildEventPayload(input: {
  eventName: string;
  mappedName: RealtimeEventName;
  payload: RawPayload;
  conversationId: string | null;
  messageId: string | null;
}): RealtimeEventPayload {
  const base: RealtimeEventPayload = {
    legacyEvent: input.eventName,
  };

  if (input.conversationId) {
    base.conversationId = input.conversationId;
  }
  if (input.messageId) {
    base.messageId = input.messageId;
  }

  if (input.mappedName === "conversation.row.changed") {
    base.changeType = input.eventName === "requests.new" ? "new" : "updated";
  }

  if (input.mappedName === "conversation.message.updated") {
    base.data = input.payload;
  }

  if (input.mappedName === "conversation.message.created") {
    base.data = input.payload;
  }

  if (input.mappedName === "airi.typing") {
    base.started = input.eventName !== "airi.typing.stop";
    if (typeof input.payload.started === "boolean") {
      base.started = input.payload.started;
    }
    if (typeof input.payload.cooldown === "boolean") {
      base.cooldown = input.payload.cooldown;
    }
    if (input.eventName === "airi.thinking") {
      base.data = input.payload;
    }
  }

  if (
    input.mappedName === "conversation.call.updated" ||
    input.mappedName === "airi.suggestion" ||
    input.mappedName === "airi.suppressed" ||
    input.mappedName === "airi.handoff" ||
    input.mappedName === "alert.created" ||
    input.mappedName === "widget.csat.changed" ||
    input.mappedName === "conversation.note.changed"
  ) {
    base.data = input.payload;
  }

  return base;
}

export async function mapChannelEventToRealtimeEvent(
  channel: string,
  eventName: string,
  rawData: unknown
): Promise<MappedRealtimeEvent> {
  const payload = asPayload(rawData);
  const campaignId = channel.match(/^private-campaign-([A-Za-z0-9_-]+)$/)?.[1];
  if (campaignId && eventName === "message-status-update") {
    const workspaceId = extractWorkspaceIdFromPayload(payload);
    if (!workspaceId) {
      throw new Error(
        "Cannot publish campaign delivery event without workspaceId"
      );
    }
    const eventId = createRealtimeEventId();
    return {
      ...buildRealtimeEvent({
        eventId,
        name: "campaign.delivery.changed",
        workspaceId,
        conversationId: null,
        createdAt: new Date().toISOString(),
        dedupeKey: [
          "campaign.delivery.changed",
          workspaceId,
          campaignId,
          extractMessageId(payload) || eventId,
          getString(payload.status) || "",
          getString(payload.timestamp) || "",
        ].join(":"),
        payload: { campaignId },
      }),
      channel: buildRealtimeChannelName({ kind: "workspace", workspaceId }),
    };
  }
  const parts = extractChannelParts(channel);
  const mappedName =
    parts.isAlertChannel && eventName === "alert"
      ? "alert.created"
      : mapLegacyEventName(eventName);
  const conversationId =
    parts.conversationId ||
    (mappedName === "conversation.row.changed"
      ? extractRowConversationIdFromPayload(payload)
      : extractConversationIdFromPayload(payload));
  const workspaceId =
    parts.workspaceId ||
    extractWorkspaceIdFromPayload(payload) ||
    (conversationId
      ? await resolveWorkspaceIdForConversation(conversationId)
      : null);

  if (!workspaceId) {
    throw new Error(
      `Cannot publish realtime event without workspaceId for ${channel}/${eventName}`
    );
  }

  const targetChannel =
    mappedName === "conversation.row.changed"
      ? buildRealtimeChannelName({ kind: "workspace", workspaceId })
      : conversationId
        ? buildRealtimeChannelName({
            kind: "conversation",
            workspaceId,
            conversationId,
          })
        : buildRealtimeChannelName({ kind: "workspace", workspaceId });
  const createdAt = new Date().toISOString();
  const eventId = createRealtimeEventId();
  const messageId = extractMessageId(payload);
  const dedupeSubject =
    mappedName === "conversation.call.updated"
      ? [
          getString(payload.callSessionId) || eventId,
          getString(payload.state) || "",
          getString(payload.reason) || "",
        ]
          .filter(Boolean)
          .join(":")
      : messageId || eventId;
  const dedupeKey = [
    mappedName,
    workspaceId,
    conversationId || "workspace",
    dedupeSubject,
    eventName,
  ].join(":");

  return {
    ...buildRealtimeEvent({
      eventId,
      name: mappedName,
      workspaceId,
      conversationId,
      createdAt,
      dedupeKey,
      payload: buildEventPayload({
        eventName,
        mappedName,
        payload:
          mappedName === "conversation.message.created" ||
          mappedName === "conversation.message.updated"
            ? await withSignedMessagePayloadMedia(payload)
            : payload,
        conversationId,
        messageId,
      }),
    }),
    channel: targetChannel,
  };
}

export function buildConversationCallUpdatedRealtimeEvent(input: {
  workspaceId: string;
  conversationId: string;
  callSessionId: string;
  state: string;
  reason?: string | null;
  dedupeKeySuffix?: string | null;
  eventId?: string;
  createdAt?: string;
}): MappedRealtimeEvent {
  const channel = buildRealtimeChannelName({
    kind: "conversation",
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
  });
  const createdAt = input.createdAt || new Date().toISOString();
  const eventId = input.eventId || createRealtimeEventId();

  return {
    ...buildRealtimeEvent({
      eventId,
      name: "conversation.call.updated",
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      createdAt,
      dedupeKey: [
        "conversation.call.updated",
        input.workspaceId,
        input.conversationId,
        input.callSessionId,
        input.state,
        input.dedupeKeySuffix || "",
      ]
        .filter(Boolean)
        .join(":"),
      payload: {
        callSessionId: input.callSessionId,
        state: input.state,
        ...(input.reason ? { reason: input.reason } : {}),
      } satisfies ConversationCallUpdatedRealtimePayload,
    }),
    channel,
  };
}

export async function emitConversationCallUpdatedRealtimeEvent(input: {
  workspaceId: string;
  conversationId: string;
  callSessionId: string;
  state: string;
  reason?: string | null;
  dedupeKeySuffix?: string | null;
}): Promise<void> {
  await emitRealtimeEvent(buildConversationCallUpdatedRealtimeEvent(input));
}

export function buildCrmBoardChangedRealtimeEvent(
  input: CrmBoardChangedRealtimeInput & {
    eventId?: string;
    createdAt?: string;
  }
): MappedRealtimeEvent {
  const createdAt = input.createdAt || new Date().toISOString();
  const eventId = input.eventId || createRealtimeEventId();
  const customerId = input.customerId || null;
  const conversationId = input.conversationId || null;

  return {
    ...buildRealtimeEvent({
      eventId,
      name: "crm.board.changed",
      workspaceId: input.workspaceId,
      conversationId,
      createdAt,
      dedupeKey: [
        "crm.board.changed",
        input.workspaceId,
        input.reason,
        customerId || "pipeline",
        eventId,
      ].join(":"),
      payload: {
        reason: input.reason,
        ...(customerId ? { customerId } : {}),
        ...(input.stageKey !== undefined ? { stageKey: input.stageKey } : {}),
        ...(input.ownerUserId !== undefined
          ? { ownerUserId: input.ownerUserId }
          : {}),
      } satisfies CrmBoardChangedRealtimePayload,
    }),
    channel: buildRealtimeChannelName({
      kind: "workspace",
      workspaceId: input.workspaceId,
    }),
  };
}

export async function emitCrmBoardChangedRealtimeEvent(
  input: CrmBoardChangedRealtimeInput
): Promise<void> {
  await emitRealtimeEvent(buildCrmBoardChangedRealtimeEvent(input));
}

export function buildProductsChangedRealtimeEvent(
  input: ProductsChangedRealtimeInput & {
    eventId?: string;
    createdAt?: string;
  }
): MappedRealtimeEvent {
  const createdAt = input.createdAt || new Date().toISOString();
  const eventId = input.eventId || createRealtimeEventId();
  const productId = input.productId || null;

  return {
    ...buildRealtimeEvent({
      eventId,
      name: "products.changed",
      workspaceId: input.workspaceId,
      conversationId: null,
      createdAt,
      dedupeKey: [
        "products.changed",
        input.workspaceId,
        input.importId,
        input.reason,
        productId || "import",
        eventId,
      ].join(":"),
      payload: {
        importId: input.importId,
        reason: input.reason,
        ...(productId ? { productId } : {}),
      } satisfies ProductsChangedRealtimePayload,
    }),
    channel: buildRealtimeChannelName({
      kind: "workspace",
      workspaceId: input.workspaceId,
    }),
  };
}

export async function emitProductsChangedRealtimeEvent(
  input: ProductsChangedRealtimeInput
): Promise<void> {
  await emitRealtimeEvent(buildProductsChangedRealtimeEvent(input));
}

export function buildConversationClassificationReadyRealtimeEvent(input: {
  analysisRevisionId: string;
  conversationId: string;
  workspaceId: string;
  completedAt: Date;
}): MappedRealtimeEvent {
  const identity = `classification-ready:${input.analysisRevisionId}`;

  return {
    ...buildRealtimeEvent({
      eventId: identity,
      name: "conversation.row.changed",
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      createdAt: input.completedAt.toISOString(),
      dedupeKey: identity,
      payload: {
        legacyEvent: "requests.update",
        conversationId: input.conversationId,
        changeType: "updated",
      },
    }),
    channel: buildRealtimeChannelName({
      kind: "workspace",
      workspaceId: input.workspaceId,
    }),
  };
}

async function persistOutboxEvent(event: MappedRealtimeEvent, immediatelyDue = false) {
  const { default: connectDB } = await import("@/lib/mongoose");
  const { ensureRealtimeEventIndexes, RealtimeEvent } = await import(
    "@/models/realtime-event"
  );
  await connectDB();
  await ensureRealtimeEventIndexes();
  const eventEnvelope: RealtimeEventEnvelope = {
    eventId: event.eventId,
    version: event.version,
    name: event.name,
    workspaceId: event.workspaceId,
    conversationId: event.conversationId ?? null,
    createdAt: event.createdAt,
    dedupeKey: event.dedupeKey,
    payload: event.payload,
  };
  return RealtimeEvent.create({
    eventId: event.eventId,
    version: event.version,
    name: event.name,
    workspaceId: event.workspaceId,
    conversationId: event.conversationId || null,
    channel: event.channel,
    dedupeKey: event.dedupeKey,
    event: eventEnvelope,
    status: "pending",
    ...(immediatelyDue ? { nextAttemptAt: new Date() } : {}),
  });
}

type StoredRealtimeEvent = {
  eventId?: unknown;
  version?: unknown;
  name?: unknown;
  workspaceId?: unknown;
  conversationId?: unknown;
  channel?: unknown;
  dedupeKey?: unknown;
  event?: unknown;
  status?: unknown;
};

function isExactRealtimeOutboxRow(
  stored: StoredRealtimeEvent,
  event: MappedRealtimeEvent
): boolean {
  return (
    stored.eventId === event.eventId &&
    stored.version === event.version &&
    stored.name === event.name &&
    stored.workspaceId === event.workspaceId &&
    (stored.conversationId ?? null) === (event.conversationId ?? null) &&
    stored.channel === event.channel &&
    stored.dedupeKey === event.dedupeKey &&
    ["pending", "replaying", "failed", "published"].includes(
      String(stored.status)
    ) &&
    isDeepStrictEqual(stored.event, {
      eventId: event.eventId,
      version: event.version,
      name: event.name,
      workspaceId: event.workspaceId,
      conversationId: event.conversationId ?? null,
      createdAt: event.createdAt,
      dedupeKey: event.dedupeKey,
      payload: event.payload,
    })
  );
}

export async function enqueueRealtimeOutboxEvent(
  event: MappedRealtimeEvent
): Promise<void> {
  try {
    await persistOutboxEvent(event);
    return;
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) {
      throw error;
    }
  }

  const { RealtimeEvent } = await import("@/models/realtime-event");
  const stored = (await RealtimeEvent.findOne({ eventId: event.eventId })
    .lean()
    .exec()) as StoredRealtimeEvent | null;
  if (!stored) {
    throw new Error(
      `Realtime outbox duplicate ${event.eventId} is missing after conflict`
    );
  }
  if (!isExactRealtimeOutboxRow(stored, event)) {
    throw new Error(
      `Realtime outbox duplicate ${event.eventId} conflicts with immutable event`
    );
  }
}

/** A receipt retry repairs this intent even when the message already exists.
 * The first saved envelope wins: later hydration/edits must not rewrite history.
 */
export async function enqueueWhatsAppMessageRealtimeEvent(input: {
  workspaceId: string;
  conversationId: string;
  message: Record<string, unknown>;
  recoveryRevision?: string | null;
}): Promise<MappedRealtimeEvent | null> {
  const messageId =
    typeof input.message._id === "string" ? input.message._id : "";
  if (!messageId || !input.workspaceId || !input.conversationId) {
    throw new Error("WhatsApp realtime requires persisted message ownership");
  }
  const event = await mapChannelEventToRealtimeEvent(
    `private-conversation-${input.conversationId}`,
    input.recoveryRevision ? "message-updated" : "new-message",
    {
      ...input.message,
      workspaceId: input.workspaceId,
      ...(input.recoveryRevision ? { messageId } : {}),
    },
  );
  const identity = JSON.stringify([
    input.workspaceId,
    input.conversationId,
    messageId,
    input.recoveryRevision || "created",
  ]);
  event.eventId = `whatsapp-message:${createHash("sha256").update(identity).digest("hex")}`;
  event.dedupeKey = event.eventId;
  try {
    await persistOutboxEvent(event, true);
    return event;
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) throw error;
  }
  const { RealtimeEvent } = await import("@/models/realtime-event");
  const stored = await RealtimeEvent.findOne({ eventId: event.eventId })
    .lean<
      StoredRealtimeEvent & {
        event: RealtimeEventEnvelope;
        status: string;
        channel: string;
      }
    >()
    .exec();
  if (
    !stored ||
    stored.workspaceId !== event.workspaceId ||
    stored.conversationId !== event.conversationId ||
    stored.name !== event.name ||
    stored.channel !== event.channel ||
    stored.dedupeKey !== event.dedupeKey ||
    stored.version !== event.version ||
    stored.event?.version !== event.version ||
    stored.event?.name !== event.name ||
    stored.event?.workspaceId !== event.workspaceId ||
    stored.event?.conversationId !== event.conversationId ||
    stored.event?.dedupeKey !== event.dedupeKey ||
    typeof stored.event?.createdAt !== "string" ||
    stored.event?.eventId !== event.eventId ||
    stored.event?.payload?.messageId !== event.payload.messageId ||
    (stored.event?.payload?.data as Record<string, unknown> | undefined)
      ?._id !== messageId ||
    !["pending", "failed", "replaying", "published"].includes(stored.status)
  ) {
    throw new Error("WhatsApp realtime intent conflicts with stored ownership");
  }
  if (stored.status === "published" || stored.status === "replaying")
    return null;
  return { ...stored.event, channel: stored.channel } as MappedRealtimeEvent;
}

/** Optional acceleration; the outbox replayer owns every error or crash. */
export async function publishPendingRealtimeOutboxEvent(
  event: MappedRealtimeEvent,
): Promise<void> {
  const result = await publishRealtimePubSubEvent(event);
  if (!result.messageId) return;
  const { RealtimeEvent } = await import("@/models/realtime-event");
  await RealtimeEvent.updateOne(
    { eventId: event.eventId, status: { $in: ["pending", "failed"] } },
    {
      $set: {
        status: "published",
        publishedAt: new Date(),
        messageId: result.messageId,
      },
      $inc: { attempts: 1 },
      $unset: { nextAttemptAt: "", lastError: "" },
    },
  );
}

export async function enqueueConversationClassificationReadyRealtimeEvent(input: {
  analysisRevisionId: string;
  conversationId: string;
  workspaceId: string;
  completedAt: Date;
}): Promise<void> {
  await enqueueRealtimeOutboxEvent(
    buildConversationClassificationReadyRealtimeEvent(input)
  );
}

function buildRealtimePublishLogContext(
  event: MappedRealtimeEvent,
  context: Record<string, unknown> = {}
): Record<string, unknown> {
  const channel = parseRealtimeChannelName(event.channel);
  return {
    eventId: event.eventId,
    eventName: event.name,
    legacyEvent:
      typeof event.payload.legacyEvent === "string"
        ? event.payload.legacyEvent
        : null,
    workspaceId: event.workspaceId,
    conversationId: event.conversationId || null,
    channelKind: channel.kind,
    channelWorkspaceId: channel.workspaceId,
    channelConversationId: channel.conversationId,
    ...context,
  };
}

export async function publishRealtimePubSubEvent(event: MappedRealtimeEvent) {
  const config = resolveRealtimePubSubConfig();
  if (!config.enabled) {
    return { ok: true, messageId: null };
  }

  const { publishGooglePubSubJsonMessage } = await import(
    "@/lib/google/pubsub-json-publisher"
  );
  return publishGooglePubSubJsonMessage({
    projectIdEnvName: config.projectIdEnvName,
    topic: config.topic,
    orderingKey: `${event.workspaceId}:${event.conversationId || "workspace"}`,
    message: {
      channel: event.channel,
      event,
    },
    attributes: {
      workspaceId: event.workspaceId,
      conversationId: event.conversationId || "",
      eventName: event.name,
    },
  });
}

export async function emitRealtimeEvent(
  event: MappedRealtimeEvent
): Promise<void> {
  const startedAt = Date.now();
  let outbox: Awaited<ReturnType<typeof persistOutboxEvent>> | null = null;
  let persistMs: number | null = null;
  let publishMs: number | null = null;
  let markOutboxMs: number | null = null;
  let pubsubMessageId: string | null = null;

  try {
    const persistStartedAt = Date.now();
    outbox = await persistOutboxEvent(event);
    persistMs = Date.now() - persistStartedAt;

    const publishStartedAt = Date.now();
    const publishResult = await publishRealtimePubSubEvent(event);
    publishMs = Date.now() - publishStartedAt;
    pubsubMessageId = publishResult.messageId || null;

    const markStartedAt = Date.now();
    await outbox.updateOne({
      $set: {
        status: "published",
        publishedAt: new Date(),
        messageId: pubsubMessageId,
      },
      $inc: { attempts: 1 },
    });
    markOutboxMs = Date.now() - markStartedAt;

    realtimeServerLogger.info(
      "realtime.event_published",
      buildRealtimePublishLogContext(event, {
        note: "published",
        outcome: "success",
        durationMs: Date.now() - startedAt,
        persistMs,
        publishMs,
        markOutboxMs,
        outboxId: outbox._id?.toString?.() || null,
        pubsubMessageId,
      })
    );
  } catch (error) {
    if (outbox) {
      const markStartedAt = Date.now();
      await outbox.updateOne({
        $set: {
          status: "failed",
          lastError: error instanceof Error ? error.message : String(error),
        },
        $inc: { attempts: 1 },
      });
      markOutboxMs = Date.now() - markStartedAt;
    }

    realtimeServerLogger.error(
      "realtime.event_publish_failed",
      error,
      buildRealtimePublishLogContext(event, {
        note: outbox ? "publish_failed" : "persist_failed",
        outcome: "error",
        durationMs: Date.now() - startedAt,
        persistMs,
        publishMs,
        markOutboxMs,
        outboxId: outbox?._id?.toString?.() || null,
        pubsubMessageId,
      })
    );
    throw error;
  }
}

export async function triggerRealtimeEvent(
  channel: string,
  eventName: string,
  data: unknown
): Promise<void> {
  const event = await mapChannelEventToRealtimeEvent(channel, eventName, data);
  await emitRealtimeEvent(event);
}

export const realtime = {
  trigger: triggerRealtimeEvent,
};
