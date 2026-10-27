import {
  WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION,
  type WhatsAppWebhookProcessEventActivityInput,
} from "@icecore/temporal";
import { buildRawSourcePayload } from "@icecore/shared/lib/raw-source-payload";
import {
  buildWhatsAppCanonicalId,
  getWhatsAppPrimaryIdentifier,
  type WhatsAppNormalizedContact,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import { normalizeWhatsAppMessageId } from "@icecore/shared/lib/whatsapp/message-id";
import { isWhatsAppStandaloneMessageEvent } from "@icecore/shared/lib/whatsapp/message-mutations";
import {
  parseWhatsAppTimestamp,
  type WhatsAppMessage,
  type WhatsAppWebhookBody,
  type WhatsAppWebhookChange,
  type WhatsAppWebhookValue,
} from "@icecore/shared/lib/whatsapp/webhook-payload";
import { resolveWhatsAppMessageContext } from "@icecore/shared/lib/whatsapp/webhook-direction";
import { buildWhatsAppGroupChatId } from "@icecore/whatsapp/groupWebhooks";
import mongoose from "mongoose";
import { loadTemporalWorkerEnv } from "./load-env.js";
import { processStoredWhatsAppWebhookEvent } from "./activities/whatsapp-webhook-processor.js";
import {
  persistReplayWhatsAppMessageAndLink,
  recoverReplayWhatsAppMessageLinkIfExisting,
} from "./replay-whatsapp-message-link.js";
import { buildWhatsAppWebhookReplayablePayloadFilter } from "@icecore/airi-runtime/whatsapp-webhook-event-retention";
import {
  buildWhatsAppNotPlanSkippedReceiptFilter,
  buildWhatsAppPlanSkippedReceiptFilter,
} from "@icecore/airi-runtime/whatsapp-intake-plan-gate";
import {
  claimWhatsAppWebhookEventForReplay,
  runWhatsAppWebhookFastReplay,
} from "./whatsapp-webhook-replay-claim.js";

type ReplayOptions = {
  phoneNumberId?: string | null;
  wabaId?: string | null;
  from: Date;
  to: Date;
  workspaceId?: string | null;
  sourceId?: string | null;
  itemKind?: string | null;
  eventStatus: "dead" | "failed" | "completed" | "processing";
  limit: number;
  execute: boolean;
  preserveReadState: boolean;
  suppressRealtime: boolean;
  progress: boolean;
  forceExit: boolean;
  concurrency: number;
  fastImport: boolean;
  auditAll: boolean;
  missingOnly: boolean;
  planSkipped: boolean;
};

type ReplayModels = {
  WhatsAppWebhookEvent: any;
  Message: any;
  Conversation: any;
  User: any;
  Chat: any;
};

type AuditRow = {
  phoneNumberId: string;
  wabaId: string | null;
  workspaceId: string | null;
  sourceId: string | null;
  sourceName: string | null;
  eventCount: number;
  first: string | null;
  last: string | null;
  itemKinds: Record<string, number>;
  platformMessageIds: string[];
  existingMessageCount: number;
};

type WebhookMessage = {
  id?: string | null;
  type?: string | null;
  from?: string | null;
  from_user_id?: string | null;
  unsupported?: { type?: string | null } | null;
};

type WebhookStatus = {
  id?: string | null;
  status?: string | null;
};

type WebhookValue = {
  messages?: WebhookMessage[];
  message_echoes?: WebhookMessage[];
  smb_message_echoes?: WebhookMessage[];
  statuses?: WebhookStatus[];
  contacts?: Array<{
    wa_id?: string | null;
    user_id?: string | null;
  }>;
};

type ReplayEvent = {
  _id: unknown;
  dedupeKey?: string | null;
  field?: string | null;
  itemKind?: string | null;
  orderingKey?: string | null;
  phoneNumberId?: string | null;
  wabaId?: string | null;
  workspaceId?: string | null;
  sourceId?: string | null;
  status?: string | null;
  firstReceivedAt?: Date | string | null;
  lastReceivedAt?: Date | string | null;
  createdAt?: Date | string | null;
  payload?: {
    body?: {
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: WebhookMessage[];
            message_echoes?: WebhookMessage[];
            smb_message_echoes?: WebhookMessage[];
            statuses?: WebhookStatus[];
            contacts?: Array<{
              wa_id?: string | null;
              user_id?: string | null;
            }>;
          } | null;
        }>;
      }>;
    } | null;
    messages?: WebhookMessage[];
    message_echoes?: WebhookMessage[];
    smb_message_echoes?: WebhookMessage[];
    statuses?: WebhookStatus[];
    contacts?: Array<{
      wa_id?: string | null;
      user_id?: string | null;
    }>;
  } | null;
};

type DirectImportMessageContext = {
  body: WhatsAppWebhookBody | null;
  entry: WhatsAppWebhookBody["entry"][number] | null;
  change: WhatsAppWebhookChange | null;
  value: WhatsAppWebhookValue;
  messageData: WhatsAppMessage;
  containerKey: "messages" | "smb_message_echoes";
};

type WorkspaceDefaults = {
  bot: boolean;
  scenarios: boolean;
  coach: boolean;
};

type DirectImportResolvedContext = {
  userId: string;
  chatId: string;
  conversationId: mongoose.Types.ObjectId;
  businessAuthorId?: string;
};

type DirectImportCache = {
  contexts: Map<string, Promise<DirectImportResolvedContext>>;
};

function printUsage(): never {
  throw new Error(
    [
      "Usage:",
      "  pnpm --filter @icecore/temporal-worker replay:whatsapp-webhook-events -- --audit-all --from=<iso> --to=<iso> [--item-kind=message] [--limit=5000]",
      "  pnpm --filter @icecore/temporal-worker replay:whatsapp-webhook-events -- --phone-number-id=<id> --from=<iso> --to=<iso> [--workspace-id=<id>] [--source-id=<id>] [--item-kind=message] [--limit=500] [--execute] [--no-preserve-read-state]",
      "  pnpm --filter @icecore/temporal-worker replay:whatsapp-webhook-events -- --waba-id=<id> --from=<iso> --to=<iso> [--item-kind=message_template_status_update] [--limit=500] [--execute]",
      "",
      "--audit-all is read-only and lists affected phone/source groups.",
      "--message-only is shorthand for --item-kind=message.",
      "--emit-realtime opts historical replay back into realtime fanout. Realtime is suppressed by default.",
      "--progress logs per-event replay timing.",
      "--force-exit exits after the final summary instead of waiting on best-effort background handles.",
      "--concurrency=<n> processes different contacts in parallel while preserving per-contact event order.",
      "--fast-import restores stored message webhooks directly without running live Airi/realtime/usage orchestration. It skips plan-skipped receipts; replay those with --plan-skipped.",
      "--missing-only filters selected events to those with at least one message ID not yet persisted.",
      "--event-status=<dead|failed|completed|processing> selects which stored webhook events to replay. Default: dead.",
      "--plan-skipped selects completed receipts the company plan gate skipped (implies --event-status=completed). Replay only after the company is unlocked; repeat until eventCount is 0.",
      "Dry-run is the default. --execute restores selected events and suppresses Airi ingress for replayed events.",
    ].join("\n"),
  );
}

function readArgValue(argv: string[], index: number, key: string): string {
  const arg = argv[index] || "";
  const equalsPrefix = `${key}=`;
  if (arg.startsWith(equalsPrefix)) {
    return arg.slice(equalsPrefix.length);
  }
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) {
    printUsage();
  }
  return next;
}

function parseRequiredDate(value: string, key: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${key} must be a valid ISO date.`);
  }
  return date;
}

function parsePositiveInt(value: string, key: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return parsed;
}

function parseOptions(argv: string[]): ReplayOptions {
  const options: Partial<ReplayOptions> = {
    execute: false,
    preserveReadState: true,
    suppressRealtime: true,
    progress: false,
    forceExit: false,
    concurrency: 1,
    fastImport: false,
    auditAll: false,
    missingOnly: false,
    planSkipped: false,
    eventStatus: "dead",
    limit: 500,
  };

  let eventStatusSet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--") continue;

    if (arg === "--execute") {
      options.execute = true;
      continue;
    }
    if (arg === "--audit-all") {
      options.auditAll = true;
      options.limit = options.limit === 500 ? 5000 : options.limit;
      continue;
    }
    if (arg === "--message-only") {
      options.itemKind = "message";
      continue;
    }
    if (arg === "--no-preserve-read-state") {
      options.preserveReadState = false;
      continue;
    }
    if (arg === "--emit-realtime") {
      options.suppressRealtime = false;
      continue;
    }
    if (arg === "--progress") {
      options.progress = true;
      continue;
    }
    if (arg === "--force-exit") {
      options.forceExit = true;
      continue;
    }
    if (arg === "--fast-import") {
      options.fastImport = true;
      options.itemKind = options.itemKind || "message";
      continue;
    }
    if (arg === "--missing-only") {
      options.missingOnly = true;
      continue;
    }
    if (arg === "--plan-skipped") {
      options.planSkipped = true;
      continue;
    }
    if (arg === "--concurrency" || arg.startsWith("--concurrency=")) {
      options.concurrency = parsePositiveInt(
        readArgValue(argv, index, "--concurrency"),
        "--concurrency",
      );
      if (arg === "--concurrency") index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
    }

    if (arg === "--phone-number-id" || arg.startsWith("--phone-number-id=")) {
      options.phoneNumberId = readArgValue(argv, index, "--phone-number-id");
      if (arg === "--phone-number-id") index += 1;
      continue;
    }
    if (arg === "--waba-id" || arg.startsWith("--waba-id=")) {
      options.wabaId = readArgValue(argv, index, "--waba-id");
      if (arg === "--waba-id") index += 1;
      continue;
    }
    if (arg === "--workspace-id" || arg.startsWith("--workspace-id=")) {
      options.workspaceId = readArgValue(argv, index, "--workspace-id");
      if (arg === "--workspace-id") index += 1;
      continue;
    }
    if (arg === "--source-id" || arg.startsWith("--source-id=")) {
      options.sourceId = readArgValue(argv, index, "--source-id");
      if (arg === "--source-id") index += 1;
      continue;
    }
    if (arg === "--item-kind" || arg.startsWith("--item-kind=")) {
      options.itemKind = readArgValue(argv, index, "--item-kind");
      if (arg === "--item-kind") index += 1;
      continue;
    }
    if (arg === "--event-status" || arg.startsWith("--event-status=")) {
      const eventStatus = readArgValue(argv, index, "--event-status");
      if (
        eventStatus !== "dead" &&
        eventStatus !== "failed" &&
        eventStatus !== "completed" &&
        eventStatus !== "processing"
      ) {
        throw new Error(
          "--event-status must be dead, failed, completed, or processing.",
        );
      }
      options.eventStatus = eventStatus as ReplayOptions["eventStatus"];
      eventStatusSet = true;
      if (arg === "--event-status") index += 1;
      continue;
    }
    if (arg === "--from" || arg.startsWith("--from=")) {
      options.from = parseRequiredDate(
        readArgValue(argv, index, "--from"),
        "--from",
      );
      if (arg === "--from") index += 1;
      continue;
    }
    if (arg === "--to" || arg.startsWith("--to=")) {
      options.to = parseRequiredDate(readArgValue(argv, index, "--to"), "--to");
      if (arg === "--to") index += 1;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      options.limit = parsePositiveInt(
        readArgValue(argv, index, "--limit"),
        "--limit",
      );
      if (arg === "--limit") index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.from || !options.to) {
    printUsage();
  }
  if (!options.auditAll && !options.phoneNumberId && !options.wabaId) {
    printUsage();
  }
  if (options.auditAll && options.execute) {
    throw new Error(
      "--audit-all is read-only. Execute one phone/source at a time.",
    );
  }
  if (options.from >= options.to) {
    throw new Error("--from must be before --to.");
  }
  if (options.planSkipped) {
    // Plan-skipped receipts are completed. The marker also selects edits,
    // revokes and reactions, which --missing-only would drop, and fast import
    // never selects marked receipts (see buildDeadEventMatch).
    if (eventStatusSet && options.eventStatus !== "completed") {
      throw new Error("--plan-skipped selects completed receipts only.");
    }
    if (options.missingOnly || options.fastImport) {
      throw new Error(
        "--plan-skipped cannot be combined with --missing-only or --fast-import.",
      );
    }
    options.eventStatus = "completed";
  }

  return options as ReplayOptions;
}

function buildDeadEventMatch(options: ReplayOptions) {
  const match: Record<string, unknown> = {
    status: options.eventStatus,
    createdAt: { $gte: options.from, $lt: options.to },
    ...buildWhatsAppWebhookReplayablePayloadFilter(),
    // Only the processor replay restores a plan-skipped receipt and clears its
    // marker; fast import completes edits, revokes, reactions and history
    // children without importing them.
    ...(options.planSkipped
      ? buildWhatsAppPlanSkippedReceiptFilter()
      : options.fastImport
        ? buildWhatsAppNotPlanSkippedReceiptFilter()
        : {}),
  };

  if (options.phoneNumberId) {
    match.phoneNumberId = options.phoneNumberId;
  }
  if (options.wabaId) {
    match.wabaId = options.wabaId;
  }
  if (options.workspaceId) {
    match.workspaceId = { $in: [options.workspaceId, null] };
  }
  if (options.sourceId) {
    match.sourceId = { $in: [options.sourceId, null] };
  }
  if (options.itemKind) {
    match.itemKind = options.itemKind;
  }

  return match;
}

function incrementCount(
  target: Record<string, number>,
  key: string | null | undefined,
) {
  const normalized = key || "unknown";
  target[normalized] = (target[normalized] || 0) + 1;
}

function getSmbEchoMessages<TMessage>(value: {
  smb_message_echoes?: TMessage[] | null;
  message_echoes?: TMessage[] | null;
}): TMessage[] {
  return [...(value.smb_message_echoes || []), ...(value.message_echoes || [])];
}

function collectEventMessageIds(event: ReplayEvent): string[] {
  const ids: string[] = [];
  for (const value of collectWebhookValues(event)) {
    for (const message of value.messages || []) {
      if (message.id && isWhatsAppStandaloneMessageEvent(message)) {
        ids.push(message.id);
      }
    }
    for (const message of getSmbEchoMessages(value)) {
      if (message.id && isWhatsAppStandaloneMessageEvent(message)) {
        ids.push(message.id);
      }
    }
  }
  return ids;
}

function buildWhatsAppMessageIdCandidates(messageIds: string[]): string[] {
  const candidates = new Set<string>();
  for (const messageId of messageIds) {
    if (!messageId) continue;
    candidates.add(messageId);
    candidates.add(normalizeWhatsAppMessageId(messageId));
  }
  return [...candidates];
}

function resolveReplayContactKey(event: ReplayEvent): string {
  for (const value of collectWebhookValues(event)) {
    const message = value.messages?.[0] || getSmbEchoMessages(value)[0];
    const firstContact = value.contacts?.[0];
    const contactWaId = firstContact?.wa_id || "";
    const contactUserId = firstContact?.user_id || "";
    const from = message?.from || message?.from_user_id || "";
    const key = contactWaId || contactUserId || from;
    if (key) return `${event.phoneNumberId || "unknown"}:${key}`;
  }
  return `${event.phoneNumberId || "unknown"}:${String(event._id)}`;
}

function groupReplayEventsByContact(events: ReplayEvent[]): ReplayEvent[][] {
  const groups = new Map<string, ReplayEvent[]>();
  for (const event of events) {
    const key = resolveReplayContactKey(event);
    const group = groups.get(key);
    if (group) {
      group.push(event);
    } else {
      groups.set(key, [event]);
    }
  }
  return [...groups.values()];
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await worker(items[currentIndex] as T);
      }
    }),
  );
}

function collectWebhookValues(event: ReplayEvent): WebhookValue[] {
  const values: WebhookValue[] = [];

  for (const entry of event.payload?.body?.entry || []) {
    for (const change of entry.changes || []) {
      if (change.value) values.push(change.value);
    }
  }

  if (
    event.payload?.messages ||
    event.payload?.message_echoes ||
    event.payload?.smb_message_echoes ||
    event.payload?.statuses
  ) {
    values.push({
      messages: event.payload.messages,
      message_echoes: event.payload.message_echoes,
      smb_message_echoes: event.payload.smb_message_echoes,
      statuses: event.payload.statuses,
      contacts: event.payload.contacts,
    });
  }

  return values;
}

function summarizeEvents(events: ReplayEvent[]) {
  const itemKinds: Record<string, number> = {};
  const messageTypes: Record<string, number> = {};
  const statusTypes: Record<string, number> = {};
  let platformMessageIds = 0;

  for (const event of events) {
    incrementCount(itemKinds, event.itemKind);
    for (const value of collectWebhookValues(event)) {
      for (const message of value.messages || []) {
        incrementCount(messageTypes, message.type);
        if (message.id) platformMessageIds += 1;
      }
      for (const message of getSmbEchoMessages(value)) {
        incrementCount(messageTypes, message.type);
        if (message.id) platformMessageIds += 1;
      }
      for (const status of value.statuses || []) {
        incrementCount(statusTypes, status.status);
      }
    }
  }

  return { itemKinds, messageTypes, statusTypes, platformMessageIds };
}

function collectPersistedMessageIds(message: {
  messageId?: string | null;
  external_ids?: { messageId?: string | null } | null;
}): string[] {
  return [message.messageId, message.external_ids?.messageId]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => [value, normalizeWhatsAppMessageId(value)]);
}

async function filterEventsWithMissingMessages(
  models: ReplayModels,
  events: ReplayEvent[],
): Promise<ReplayEvent[]> {
  const eventMessageIds = Array.from(
    new Set(events.flatMap(collectEventMessageIds)),
  );
  if (eventMessageIds.length === 0) return [];

  const candidates = buildWhatsAppMessageIdCandidates(eventMessageIds);
  const persistedMessages = (await models.Message.find({
    $or: [
      { messageId: { $in: candidates } },
      { "external_ids.messageId": { $in: candidates } },
    ],
  })
    .select("messageId external_ids.messageId")
    .lean()) as Array<{
    messageId?: string | null;
    external_ids?: { messageId?: string | null } | null;
  }>;

  const persistedIds = new Set(
    persistedMessages.flatMap(collectPersistedMessageIds),
  );
  return events.filter((event) =>
    collectEventMessageIds(event).some((messageId) => {
      const normalized = normalizeWhatsAppMessageId(messageId);
      return !persistedIds.has(messageId) && !persistedIds.has(normalized);
    }),
  );
}

function parseDisplayName(name: string | null | undefined): {
  firstName?: string;
  lastName?: string;
  fullName?: string;
} {
  const fullName = typeof name === "string" ? name.trim() : "";
  if (!fullName) return {};
  const [firstName, ...rest] = fullName.split(/\s+/).filter(Boolean);
  return {
    ...(firstName ? { firstName } : {}),
    ...(rest.length > 0 ? { lastName: rest.join(" ") } : {}),
    fullName,
  };
}

function buildWhatsAppIdentity(contact: WhatsAppNormalizedContact) {
  return {
    ...(contact.waId ? { waId: contact.waId } : {}),
    ...(contact.userId ? { userId: contact.userId } : {}),
    ...(contact.parentUserId ? { parentUserId: contact.parentUserId } : {}),
    ...(contact.profile.username ? { username: contact.profile.username } : {}),
    profileName: contact.profile.name,
    primaryIdType: contact.primaryIdType,
  };
}

function isWhatsAppDirectImportMediaType(
  value: WhatsAppMessage["type"],
): value is "image" | "video" | "audio" | "document" | "sticker" | "voice" {
  return ["image", "video", "audio", "document", "sticker", "voice"].includes(
    value,
  );
}

function getDirectImportMediaData(messageData: WhatsAppMessage): {
  mediaType: "image" | "video" | "audio" | "document" | "sticker" | "voice";
  mediaId: string;
  mimeType?: string;
  fileName?: string;
  caption?: string;
} | null {
  if (messageData.type === "unsupported" && messageData.video?.id) {
    return {
      mediaType: "video",
      mediaId: messageData.video.id,
      mimeType: messageData.video.mime_type,
      caption: messageData.video.caption,
    };
  }

  if (!isWhatsAppDirectImportMediaType(messageData.type)) {
    return null;
  }

  const mediaData = messageData[messageData.type];
  if (!mediaData?.id) return null;

  return {
    mediaType: messageData.type,
    mediaId: mediaData.id,
    mimeType: mediaData.mime_type,
    fileName:
      messageData.type === "document"
        ? messageData.document?.filename
        : undefined,
    caption: "caption" in mediaData ? mediaData.caption : undefined,
  };
}

function buildDirectImportMessageText(messageData: WhatsAppMessage): string {
  if (messageData.type === "text" || messageData.type === "edit") {
    return messageData.text?.body || "";
  }
  if (messageData.type === "button") {
    return messageData.button?.text || messageData.button?.payload || "";
  }
  if (messageData.type === "interactive") {
    const interactive = messageData.interactive;
    return (
      interactive?.button_reply?.title ||
      interactive?.list_reply?.title ||
      interactive?.nfm_reply?.body ||
      interactive?.nfm_reply?.response_json ||
      "[WhatsApp interactive reply]"
    );
  }
  if (messageData.type === "location") {
    const location = messageData.location;
    if (!location) return "[Location]";
    return [
      "[Location]",
      location.name,
      location.address,
      `${location.latitude}, ${location.longitude}`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (messageData.type === "contacts") {
    const first = messageData.contacts?.[0];
    const label =
      first?.name?.formatted_name ||
      first?.name?.first_name ||
      first?.phones?.[0]?.phone ||
      "";
    return label ? `[Contact: ${label}]` : "[Contact card]";
  }
  if (messageData.type === "order") {
    const count = messageData.order?.product_items?.reduce(
      (sum, item) => sum + (Number(item.quantity) || 0),
      0,
    );
    return count ? `[WhatsApp order: ${count} items]` : "[WhatsApp order]";
  }
  if (messageData.type === "system") {
    return messageData.system?.body || "[WhatsApp system message]";
  }

  const media = getDirectImportMediaData(messageData);
  if (media) {
    return media.caption || `[${media.mediaType} attachment]`;
  }

  if (messageData.type === "unsupported") {
    const unsupportedType = messageData.unsupported?.type?.trim();
    return unsupportedType
      ? `[Unsupported WhatsApp message: ${unsupportedType}]`
      : "[Unsupported WhatsApp message]";
  }

  return "";
}

function shouldSkipStandaloneDirectImportMessage(
  messageData: WhatsAppMessage,
): boolean {
  return !isWhatsAppStandaloneMessageEvent(messageData);
}

function collectDirectImportMessageContexts(
  event: ReplayEvent,
): DirectImportMessageContext[] {
  const contexts: DirectImportMessageContext[] = [];
  const body = event.payload?.body as WhatsAppWebhookBody | undefined;

  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value) continue;
      for (const messageData of value.messages || []) {
        contexts.push({
          body: body || null,
          entry,
          change,
          value,
          messageData,
          containerKey: "messages",
        });
      }
      for (const messageData of getSmbEchoMessages(value)) {
        contexts.push({
          body: body || null,
          entry,
          change,
          value,
          messageData,
          containerKey: "smb_message_echoes",
        });
      }
    }
  }

  const payload = event.payload as
    | (WhatsAppWebhookValue & { object?: string })
    | undefined;
  if (
    payload?.messages ||
    payload?.message_echoes ||
    payload?.smb_message_echoes
  ) {
    const value = payload as WhatsAppWebhookValue;
    for (const messageData of value.messages || []) {
      contexts.push({
        body: null,
        entry: null,
        change: null,
        value,
        messageData,
        containerKey: "messages",
      });
    }
    for (const messageData of getSmbEchoMessages(value)) {
      contexts.push({
        body: null,
        entry: null,
        change: null,
        value,
        messageData,
        containerKey: "smb_message_echoes",
      });
    }
  }

  return contexts;
}

async function getWorkspaceDefaults(
  workspaceId: string,
  cache: Map<string, Promise<WorkspaceDefaults>>,
): Promise<WorkspaceDefaults> {
  const cached = cache.get(workspaceId);
  if (cached) return cached;

  const promise = mongoose.connection
    .collection("workspaceairisettings")
    .findOne(
      { workspaceId },
      {
        projection: {
          airi_bot_default_enabled: 1,
          airi_scenarios_default_enabled: 1,
          airi_coach_default_enabled: 1,
        },
      },
    )
    .then((settings) => ({
      bot: settings?.airi_bot_default_enabled ?? false,
      scenarios:
        settings?.airi_scenarios_default_enabled ??
        settings?.airi_bot_default_enabled ??
        false,
      coach: settings?.airi_coach_default_enabled ?? true,
    }));

  cache.set(workspaceId, promise);
  return promise;
}

async function ensureDirectImportUserAndChat(params: {
  models: ReplayModels;
  workspaceId: string;
  sourceId: string;
  phoneNumberId: string;
  contactData: WhatsAppNormalizedContact;
  direction: "inbound" | "outbound";
  groupId?: string | null;
  messageText: string;
}): Promise<{ userId: string; chatId: string; businessAuthorId?: string }> {
  const {
    models,
    workspaceId,
    sourceId,
    phoneNumberId,
    contactData,
    direction,
    groupId,
    messageText,
  } = params;
  const customerId = buildWhatsAppCanonicalId(contactData);
  if (!customerId) {
    throw new Error("Unable to resolve canonical WhatsApp identity");
  }

  const identity = buildWhatsAppIdentity(contactData);
  const { firstName, lastName, fullName } = parseDisplayName(
    contactData.profile.name,
  );
  const customerSet: Record<string, unknown> = {
    workspaceId,
    isBot: false,
    whatsapp: identity,
  };
  if (firstName) customerSet.firstName = firstName;
  if (lastName) customerSet.lastName = lastName;
  if (contactData.profile.username) {
    customerSet.username = contactData.profile.username;
  } else if (fullName && !firstName && !lastName) {
    customerSet.username = fullName;
  }

  await models.User.updateOne(
    { _id: customerId },
    { $set: customerSet, $setOnInsert: { _id: customerId } },
    { upsert: true },
  );

  const chatId = groupId
    ? buildWhatsAppGroupChatId({ groupId, phoneNumberId, sourceId })
    : customerId;

  if (groupId) {
    await models.Chat.updateOne(
      { _id: chatId },
      {
        $set: {
          type: "whatsapp",
          sourceId,
          workspaceId,
          whatsappGroup: { groupId, phoneNumberId, sourceId },
        },
        $setOnInsert: {
          _id: chatId,
          title: `WhatsApp group ${groupId.slice(-6)}`,
        },
        $addToSet: { participants: customerId },
      },
      { upsert: true },
    );
  } else {
    const chatSet: Record<string, unknown> = {
      type: "whatsapp",
      sourceId,
      workspaceId,
      whatsapp: identity,
    };
    if (firstName) chatSet.first_name = firstName;
    if (lastName) chatSet.last_name = lastName;
    if (contactData.profile.username) {
      chatSet.username = contactData.profile.username;
    }
    if (fullName) chatSet.title = fullName;

    await models.Chat.updateOne(
      { _id: chatId },
      { $set: chatSet, $setOnInsert: { _id: chatId } },
      { upsert: true },
    );
  }

  let businessAuthorId: string | undefined;
  if (direction === "outbound") {
    const isAiri = /^airi\s*:/i.test(messageText.trim());
    businessAuthorId = isAiri ? "0" : `whatsapp_business_${phoneNumberId}`;
    await models.User.updateOne(
      { _id: businessAuthorId },
      {
        $set: {
          firstName: isAiri ? "Airi" : "Business Account",
          isBot: isAiri,
          workspaceId,
        },
        $setOnInsert: { _id: businessAuthorId },
      },
      { upsert: true },
    );
  }

  return { userId: customerId, chatId, businessAuthorId };
}

async function resolveDirectImportConversation(params: {
  models: ReplayModels;
  workspaceId: string;
  sourceId: string;
  userId: string;
  chatId: string;
  messageDate: Date;
  direction: "inbound" | "outbound";
  groupId?: string | null;
  phoneNumberId: string;
  defaultsCache: Map<string, Promise<WorkspaceDefaults>>;
}): Promise<mongoose.Types.ObjectId> {
  const {
    models,
    workspaceId,
    sourceId,
    userId,
    chatId,
    messageDate,
    groupId,
    phoneNumberId,
    defaultsCache,
  } = params;
  const existing = await models.Conversation.findOne(
    groupId
      ? {
          workspaceId,
          sourceId,
          channel: "whatsapp",
          "whatsappGroup.groupId": groupId,
        }
      : {
          workspaceId,
          sourceId,
          channel: "whatsapp",
          $or: [{ chat: chatId }, { user: userId }],
        },
  )
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .select("_id")
    .lean();

  if (existing?._id) {
    return existing._id as mongoose.Types.ObjectId;
  }

  const defaults = await getWorkspaceDefaults(workspaceId, defaultsCache);
  const conversationId = new mongoose.Types.ObjectId();
  await models.Conversation.collection.insertOne({
    _id: conversationId,
    chat: chatId,
    user: userId,
    messages: [],
    message_count: 0,
    status: "open",
    is_read_by_manager: params.direction === "inbound" ? false : true,
    channel: "whatsapp",
    workspaceId,
    sourceId,
    is_classified: false,
    lastMessageAt: null,
    last_inbound_at: null,
    last_outbound_at: null,
    airi_bot_enabled: defaults.bot,
    airi_scenarios_enabled: defaults.scenarios,
    airi_coach_enabled: defaults.coach,
    ...(groupId ? { whatsappGroup: { groupId, phoneNumberId, sourceId } } : {}),
    createdAt: messageDate,
    updatedAt: messageDate,
  });
  return conversationId;
}

function buildDirectRawSourcePayload(params: {
  context: DirectImportMessageContext;
  sourceId: string;
  phoneNumberId: string;
  direction: "inbound" | "outbound";
  messageDate: Date;
}) {
  const { context, sourceId, phoneNumberId, direction, messageDate } = params;
  if (context.body && context.entry && context.change) {
    const valueRest = { ...context.value } as Record<string, unknown>;
    delete valueRest.messages;
    delete valueRest.message_echoes;
    delete valueRest.smb_message_echoes;
    delete valueRest.history;
    return buildRawSourcePayload({
      provider: "whatsapp",
      eventType: "message",
      capturedAt: messageDate,
      payload: {
        object: context.body.object,
        entry: {
          id: context.entry.id || null,
          changes: [
            {
              field: context.change.field || null,
              value: {
                ...valueRest,
                [context.containerKey]: [context.messageData],
              },
            },
          ],
        },
        sourceId,
        phoneNumberId,
        direction,
      },
    });
  }

  return buildRawSourcePayload({
    provider: "whatsapp",
    eventType: "message",
    capturedAt: messageDate,
    payload: {
      sourceId,
      phoneNumberId,
      direction,
      [context.containerKey]: [context.messageData],
      contacts: context.value.contacts || [],
      metadata: context.value.metadata || null,
    },
  });
}

async function fastImportWhatsAppWebhookEvent(params: {
  models: ReplayModels;
  event: ReplayEvent;
  options: ReplayOptions;
  defaultsCache: Map<string, Promise<WorkspaceDefaults>>;
  directImportCache: DirectImportCache;
}): Promise<{
  status: "completed";
  runtimeCode: string;
  importedMessages: number;
  skippedMessages: number;
}> {
  const { models, event, options, defaultsCache, directImportCache } = params;
  const phoneNumberId = String(
    event.phoneNumberId || options.phoneNumberId || "",
  );
  let workspaceId = String(event.workspaceId || options.workspaceId || "");
  let sourceId = String(event.sourceId || options.sourceId || "");
  if (phoneNumberId && (!workspaceId || !sourceId)) {
    const resolvedSource = await resolveSourceForPhoneNumberId(phoneNumberId);
    workspaceId ||= resolvedSource?.workspaceId || "";
    sourceId ||= resolvedSource?.sourceId || "";
  }
  if (!phoneNumberId || !workspaceId || !sourceId) {
    throw new Error(
      `Webhook event ${String(event._id)} is missing phone/workspace/source metadata.`,
    );
  }

  const contexts = collectDirectImportMessageContexts(event);
  const { appendMessageToConversationById } = await import(
    "@/lib/conversation-messages"
  );
  let importedMessages = 0;
  let skippedMessages = 0;

  for (const context of contexts) {
    const { messageData, value, containerKey } = context;
    if (!messageData?.id) {
      skippedMessages += 1;
      continue;
    }
    if (shouldSkipStandaloneDirectImportMessage(messageData)) {
      skippedMessages += 1;
      continue;
    }

    const normalizedMessageId = normalizeWhatsAppMessageId(messageData.id);
    const messageDate = parseWhatsAppTimestamp(
      messageData.timestamp || String(event.createdAt || Date.now()),
    );
    const groupId =
      typeof messageData.group_id === "string" && messageData.group_id.trim()
        ? messageData.group_id.trim()
        : null;
    const recovered = await recoverReplayWhatsAppMessageLinkIfExisting(
      {
        messageModel: models.Message,
        normalizedMessageId,
        providerMessageId: messageData.id,
        fallbackDate: messageDate,
        fallbackWorkspaceId: workspaceId,
        fallbackSourceId: sourceId,
        ...(groupId
          ? {
              fallbackWhatsappGroup: { groupId, phoneNumberId, sourceId },
            }
          : {}),
      },
      { appendMessage: appendMessageToConversationById },
    );
    if (recovered) {
      skippedMessages += 1;
      continue;
    }

    const displayPhoneNumber = value.metadata?.display_phone_number || null;
    const resolved =
      containerKey === "smb_message_echoes"
        ? {
            direction: "outbound" as const,
            contactData: resolveWhatsAppMessageContext({
              messageData,
              contacts: value.contacts,
              displayPhoneNumber,
            }).contactData,
          }
        : resolveWhatsAppMessageContext({
            messageData,
            contacts: value.contacts,
            displayPhoneNumber,
          });

    const contactData = resolved.contactData;
    if (!contactData || !getWhatsAppPrimaryIdentifier(contactData)) {
      throw new Error(
        `Webhook event ${String(event._id)} message ${messageData.id} has no contact identity.`,
      );
    }

    const messageText = buildDirectImportMessageText(messageData);
    const contextKey = [
      workspaceId,
      sourceId,
      phoneNumberId,
      groupId || buildWhatsAppCanonicalId(contactData),
      resolved.direction,
    ].join(":");
    let resolvedContextPromise = directImportCache.contexts.get(contextKey);
    if (!resolvedContextPromise) {
      resolvedContextPromise = (async () => {
        const { userId, chatId, businessAuthorId } =
          await ensureDirectImportUserAndChat({
            models,
            workspaceId,
            sourceId,
            phoneNumberId,
            contactData,
            direction: resolved.direction,
            groupId,
            messageText,
          });
        const conversationId = await resolveDirectImportConversation({
          models,
          workspaceId,
          sourceId,
          userId,
          chatId,
          messageDate,
          direction: resolved.direction,
          groupId,
          phoneNumberId,
          defaultsCache,
        });
        return { userId, chatId, conversationId, businessAuthorId };
      })();
      directImportCache.contexts.set(contextKey, resolvedContextPromise);
    }
    const { userId, chatId, businessAuthorId, conversationId } =
      await resolvedContextPromise;
    const media = getDirectImportMediaData(messageData);
    const messageObjectId = new mongoose.Types.ObjectId();
    const messageDoc: Record<string, unknown> = {
      _id: messageObjectId,
      messageId: normalizedMessageId,
      chat: chatId,
      author:
        resolved.direction === "outbound"
          ? businessAuthorId || `whatsapp_business_${phoneNumberId}`
          : userId,
      rawSourcePayload: buildDirectRawSourcePayload({
        context,
        sourceId,
        phoneNumberId,
        direction: resolved.direction,
        messageDate,
      }),
      text: messageText,
      date: messageDate,
      workspaceId,
      sourceId,
      conversation: conversationId,
      channel: "whatsapp",
      direction: resolved.direction,
      createdAt: messageDate,
      updatedAt: messageDate,
      ...(resolved.direction === "outbound"
        ? {
            origin: {
              kind: "system",
              sourceId,
            },
          }
        : {}),
    };

    if (media) {
      messageDoc.whatsappMediaId = media.mediaId;
      messageDoc.mediaType = media.mediaType;
      messageDoc.mimeType = media.mimeType;
      messageDoc.fileName = media.fileName;
      messageDoc.imageUrl = `/api/conversations/${encodeURIComponent(
        String(conversationId),
      )}/whatsapp-media/${encodeURIComponent(media.mediaId)}${
        media.fileName ? `?filename=${encodeURIComponent(media.fileName)}` : ""
      }`;
    }

    if (messageData.type === "location" && messageData.location) {
      messageDoc.whatsappLocation = {
        latitude: messageData.location.latitude,
        longitude: messageData.location.longitude,
        name: messageData.location.name || null,
        address: messageData.location.address || null,
        url: messageData.location.url || null,
      };
    }
    if (messageData.type === "contacts" && messageData.contacts?.length) {
      messageDoc.whatsappContacts = messageData.contacts;
    }
    if (groupId) {
      messageDoc.whatsappGroup = {
        groupId,
        phoneNumberId,
        sourceId,
        senderParentUserId: contactData.parentUserId || null,
        senderUserId: contactData.userId || null,
        senderUsername: contactData.profile.username || null,
        senderWaId: contactData.waId || null,
      };
    }

    const { created } = await persistReplayWhatsAppMessageAndLink(
      {
        messageModel: models.Message,
        normalizedMessageId,
        providerMessageId: messageData.id,
        messageDocument: messageDoc as Record<string, unknown> & {
          _id: mongoose.Types.ObjectId;
        },
        fallbackDate: messageDate,
        fallbackWorkspaceId: workspaceId,
        fallbackSourceId: sourceId,
        existingMessageKnownMissing: true,
        ...(groupId
          ? {
              fallbackWhatsappGroup: { groupId, phoneNumberId, sourceId },
            }
          : {}),
      },
      { appendMessage: appendMessageToConversationById },
    );

    if (created) {
      importedMessages += 1;
    } else {
      skippedMessages += 1;
    }
  }

  return {
    status: "completed",
    runtimeCode: "fast_import",
    importedMessages,
    skippedMessages,
  };
}

async function snapshotReadState(models: ReplayModels, options: ReplayOptions) {
  if (!options.workspaceId || !options.sourceId || !options.preserveReadState) {
    return new Set<string>();
  }

  const conversations = (await models.Conversation.find({
    workspaceId: options.workspaceId,
    sourceId: options.sourceId,
    is_read_by_manager: true,
  })
    .select("_id")
    .lean()) as Array<{ _id: unknown }>;

  return new Set(
    conversations.map((conversation: { _id: unknown }) =>
      String(conversation._id),
    ),
  );
}

function buildProcessorInput(
  event: ReplayEvent,
): WhatsAppWebhookProcessEventActivityInput {
  if (!event.dedupeKey || !event.field || !event.orderingKey) {
    throw new Error(
      `Webhook event ${String(event._id)} is missing routing metadata.`,
    );
  }

  const receivedAt =
    event.lastReceivedAt ||
    event.firstReceivedAt ||
    event.createdAt ||
    new Date();

  return {
    contractVersion: WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION,
    eventId: String(event._id),
    dedupeKey: event.dedupeKey,
    field: event.field,
    orderingKey: event.orderingKey,
    receivedAt: new Date(receivedAt).toISOString(),
  };
}

async function restoreReadStateForTouchedMessages(
  models: ReplayModels,
  initiallyReadConversationIds: Set<string>,
  platformMessageIds: string[],
) {
  if (
    initiallyReadConversationIds.size === 0 ||
    platformMessageIds.length === 0
  ) {
    return 0;
  }

  const messageIdCandidates =
    buildWhatsAppMessageIdCandidates(platformMessageIds);
  const messages = (await models.Message.find({
    $or: [
      { messageId: { $in: messageIdCandidates } },
      { "external_ids.messageId": { $in: messageIdCandidates } },
    ],
  })
    .select("conversation")
    .lean()) as Array<{ conversation?: unknown }>;

  const touchedReadConversationIds = [
    ...new Set<string>(
      messages
        .map((message: { conversation?: unknown }) =>
          String(message.conversation || ""),
        )
        .filter((conversationId: string) =>
          initiallyReadConversationIds.has(conversationId),
        ),
    ),
  ];

  if (touchedReadConversationIds.length === 0) return 0;

  const objectIds = touchedReadConversationIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (objectIds.length === 0) return 0;

  const result = await models.Conversation.updateMany(
    {
      _id: { $in: objectIds },
      is_read_by_manager: { $ne: true },
    },
    { $set: { is_read_by_manager: true } },
  );

  return result.modifiedCount || 0;
}

async function loadReplayModels(): Promise<ReplayModels> {
  const { default: WhatsAppWebhookEvent } = await import(
    "@icecore/airi-runtime/whatsapp-webhook-event-model"
  );
  const { default: Message } = await import("@/models/message");
  const { default: User } = await import("@/models/user");
  const { default: Chat } = await import("@/models/chat");
  const conversationModule = (await import(
    "@/models/conversation"
  )) as unknown as {
    Conversation?: unknown;
    default?: { Conversation?: unknown };
  };
  const Conversation =
    conversationModule.Conversation ||
    conversationModule.default?.Conversation ||
    mongoose.models.Conversation;

  if (!Conversation) {
    throw new Error("Conversation model was not registered.");
  }

  return { WhatsAppWebhookEvent, Message, Conversation, User, Chat };
}

async function resolveSourceForPhoneNumberId(phoneNumberId: string) {
  try {
    const { resolveWhatsAppSourceByAccountIdentifiers } = await import(
      "@/lib/whatsapp/source-resolver"
    );
    const source = await resolveWhatsAppSourceByAccountIdentifiers({
      phoneNumberId,
    });
    return source
      ? {
          sourceId: source.id,
          workspaceId: source.workspace_id,
          sourceName: source.name || null,
        }
      : null;
  } catch {
    return null;
  }
}

async function auditDeadWebhookEvents(
  models: ReplayModels,
  options: ReplayOptions,
) {
  let events = (await models.WhatsAppWebhookEvent.find({
    ...buildDeadEventMatch(options),
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(options.limit)
    .select(
      "_id itemKind phoneNumberId wabaId workspaceId sourceId createdAt payload.body.entry.changes.value.messages.id payload.body.entry.changes.value.messages.type payload.body.entry.changes.value.messages.unsupported.type payload.body.entry.changes.value.message_echoes.id payload.body.entry.changes.value.message_echoes.type payload.body.entry.changes.value.message_echoes.unsupported.type payload.body.entry.changes.value.smb_message_echoes.id payload.body.entry.changes.value.smb_message_echoes.type payload.body.entry.changes.value.smb_message_echoes.unsupported.type payload.body.entry.changes.value.statuses.id payload.body.entry.changes.value.statuses.status payload.messages.id payload.messages.type payload.messages.unsupported.type payload.message_echoes.id payload.message_echoes.type payload.message_echoes.unsupported.type payload.smb_message_echoes.id payload.smb_message_echoes.type payload.smb_message_echoes.unsupported.type payload.statuses.id payload.statuses.status",
    )
    .lean()) as ReplayEvent[];

  const byIdentity = new Map<string, AuditRow>();

  for (const event of events) {
    const phoneNumberId = String(event.phoneNumberId || "unknown");
    const wabaId = event.wabaId ? String(event.wabaId) : null;
    const identityKey =
      event.phoneNumberId || event.wabaId || `event:${String(event._id)}`;
    const current: AuditRow = byIdentity.get(String(identityKey)) || {
      phoneNumberId,
      wabaId,
      workspaceId: event.workspaceId || null,
      sourceId: event.sourceId || null,
      sourceName: null,
      eventCount: 0,
      first: null,
      last: null,
      itemKinds: {},
      platformMessageIds: [],
      existingMessageCount: 0,
    };

    current.eventCount += 1;
    incrementCount(current.itemKinds, event.itemKind);
    const createdAt = event.createdAt
      ? new Date(event.createdAt).toISOString()
      : null;
    current.first =
      current.first && createdAt && current.first < createdAt
        ? current.first
        : createdAt;
    current.last =
      current.last && createdAt && current.last > createdAt
        ? current.last
        : createdAt;
    current.platformMessageIds.push(...collectEventMessageIds(event));

    byIdentity.set(String(identityKey), current);
  }

  for (const item of byIdentity.values()) {
    if (item.phoneNumberId !== "unknown") {
      const source = await resolveSourceForPhoneNumberId(item.phoneNumberId);
      if (source) {
        item.sourceId ||= source.sourceId || null;
        item.workspaceId ||= source.workspaceId || null;
        item.sourceName = source.sourceName || null;
      }
    }
    const uniqueIds = [...new Set(item.platformMessageIds)];
    const messageIdCandidates = buildWhatsAppMessageIdCandidates(uniqueIds);
    item.existingMessageCount = uniqueIds.length
      ? await models.Message.countDocuments({
          $or: [
            { messageId: { $in: messageIdCandidates } },
            { "external_ids.messageId": { $in: messageIdCandidates } },
          ],
        })
      : 0;
    item.platformMessageIds = uniqueIds;
  }

  const rows = [...byIdentity.values()].sort(
    (left, right) => right.eventCount - left.eventCount,
  );

  console.log(
    JSON.stringify(
      {
        mode: "audit-all",
        from: options.from.toISOString(),
        to: options.to.toISOString(),
        eventStatus: options.eventStatus,
        itemKind: options.itemKind || null,
        affectedPhoneNumbers: rows.length,
        totalEvents: rows.reduce((sum, row) => sum + row.eventCount, 0),
        rows: rows.map((row) => ({
          phoneNumberId: row.phoneNumberId,
          wabaId: row.wabaId,
          workspaceId: row.workspaceId,
          sourceId: row.sourceId,
          sourceName: row.sourceName,
          eventCount: row.eventCount,
          first: row.first,
          last: row.last,
          itemKinds: row.itemKinds,
          platformMessageIds: row.platformMessageIds.length,
          existingMessageCount: row.existingMessageCount,
          missingMessageIds:
            row.platformMessageIds.length - row.existingMessageCount,
        })),
      },
      null,
      2,
    ),
  );
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  loadTemporalWorkerEnv();
  const { default: connectDB } = await import("@icecore/airi-runtime/mongoose");
  await connectDB();
  const models = await loadReplayModels();

  if (options.auditAll) {
    await auditDeadWebhookEvents(models, options);
    await mongoose.disconnect();
    return;
  }

  const phoneNumberId = options.phoneNumberId || null;
  if (!phoneNumberId && !options.wabaId) {
    throw new Error(
      "--phone-number-id or --waba-id is required unless --audit-all is set.",
    );
  }

  let events = (await models.WhatsAppWebhookEvent.find({
    ...buildDeadEventMatch(options),
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(options.limit)
    .select(
      options.fastImport
        ? "_id dedupeKey field itemKind orderingKey status phoneNumberId wabaId workspaceId sourceId firstReceivedAt lastReceivedAt createdAt payload"
        : "_id dedupeKey field itemKind orderingKey status phoneNumberId wabaId workspaceId sourceId firstReceivedAt lastReceivedAt createdAt payload.body.entry.changes.value.contacts.wa_id payload.body.entry.changes.value.contacts.user_id payload.body.entry.changes.value.messages.id payload.body.entry.changes.value.messages.type payload.body.entry.changes.value.messages.unsupported.type payload.body.entry.changes.value.messages.from payload.body.entry.changes.value.messages.from_user_id payload.body.entry.changes.value.message_echoes.id payload.body.entry.changes.value.message_echoes.type payload.body.entry.changes.value.message_echoes.unsupported.type payload.body.entry.changes.value.message_echoes.from payload.body.entry.changes.value.message_echoes.from_user_id payload.body.entry.changes.value.smb_message_echoes.id payload.body.entry.changes.value.smb_message_echoes.type payload.body.entry.changes.value.smb_message_echoes.unsupported.type payload.body.entry.changes.value.smb_message_echoes.from payload.body.entry.changes.value.smb_message_echoes.from_user_id payload.body.entry.changes.value.statuses.id payload.body.entry.changes.value.statuses.status payload.contacts.wa_id payload.contacts.user_id payload.messages.id payload.messages.type payload.messages.unsupported.type payload.messages.from payload.messages.from_user_id payload.message_echoes.id payload.message_echoes.type payload.message_echoes.unsupported.type payload.message_echoes.from payload.message_echoes.from_user_id payload.smb_message_echoes.id payload.smb_message_echoes.type payload.smb_message_echoes.unsupported.type payload.smb_message_echoes.from payload.smb_message_echoes.from_user_id payload.statuses.id payload.statuses.status",
    )
    .lean()) as ReplayEvent[];

  const scannedEventCount = events.length;
  if (options.missingOnly) {
    events = await filterEventsWithMissingMessages(models, events);
  }

  const summary = summarizeEvents(events);
  const eventGroups = groupReplayEventsByContact(events);
  const platformMessageIds = events.flatMap(collectEventMessageIds);
  const messageIdCandidates =
    buildWhatsAppMessageIdCandidates(platformMessageIds);
  const existingMessageCount = platformMessageIds.length
    ? await models.Message.countDocuments({
        $or: [
          { messageId: { $in: messageIdCandidates } },
          { "external_ids.messageId": { $in: messageIdCandidates } },
        ],
      })
    : 0;

  console.log(
    JSON.stringify(
      {
        mode: options.execute ? "execute" : "dry-run",
        fastImport: options.fastImport,
        suppressAiriIngress: true,
        suppressRealtime: options.suppressRealtime,
        preserveReadState: options.preserveReadState,
        forceExit: options.forceExit,
        eventStatus: options.eventStatus,
        missingOnly: options.missingOnly,
        planSkipped: options.planSkipped,
        phoneNumberId,
        wabaId: options.wabaId || null,
        workspaceId: options.workspaceId || null,
        sourceId: options.sourceId || null,
        itemKind: options.itemKind || null,
        from: options.from.toISOString(),
        to: options.to.toISOString(),
        scannedEventCount,
        eventCount: events.length,
        contactGroups: eventGroups.length,
        concurrency: options.concurrency,
        existingMessageCount,
        ...summary,
      },
      null,
      2,
    ),
  );

  if (!options.execute) {
    await mongoose.disconnect();
    return;
  }

  const initiallyReadConversationIds = await snapshotReadState(models, options);
  const processed = {
    completed: 0,
    failed: 0,
    skipped: 0,
    importedMessages: 0,
    skippedMessages: 0,
    restoredReadState: 0,
  };
  const defaultsCache = new Map<string, Promise<WorkspaceDefaults>>();
  const directImportCache: DirectImportCache = { contexts: new Map() };

  const processReplayEvent = async (event: ReplayEvent) => {
    const eventStartedAt = Date.now();
    try {
      if (!options.fastImport) {
        const reset = await claimWhatsAppWebhookEventForReplay({
          model: models.WhatsAppWebhookEvent,
          eventId: event._id,
          status: options.eventStatus,
        });
        if (reset.status === "skipped") {
          processed.skipped += 1;
          return;
        }
      }

      const result = options.fastImport
        ? await runWhatsAppWebhookFastReplay({
            model: models.WhatsAppWebhookEvent,
            eventId: event._id,
            status: options.eventStatus,
            run: () => fastImportWhatsAppWebhookEvent({
              models,
              event,
              options,
              defaultsCache,
              directImportCache,
            }),
          })
        : await processStoredWhatsAppWebhookEvent(buildProcessorInput(event), {
            suppressAiriIngress: true,
            suppressRealtime: options.suppressRealtime,
          });

      if (result.status === "completed") {
        processed.completed += 1;
      } else {
        processed.skipped += 1;
      }
      if ("importedMessages" in result) {
        processed.importedMessages += result.importedMessages;
        processed.skippedMessages += result.skippedMessages;
      }
      if (options.progress) {
        console.error(
          JSON.stringify({
            eventId: String(event._id),
            itemKind: event.itemKind || null,
            resultStatus: result.status,
            runtimeCode: result.runtimeCode,
            durationMs: Date.now() - eventStartedAt,
          }),
        );
      }
    } catch (error) {
      processed.failed += 1;
      console.error(
        JSON.stringify({
          eventId: String(event._id),
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  await runWithConcurrency(eventGroups, options.concurrency, async (group) => {
    for (const event of group) {
      await processReplayEvent(event);
    }
  });

  processed.restoredReadState = await restoreReadStateForTouchedMessages(
    models,
    initiallyReadConversationIds,
    platformMessageIds,
  );

  console.log(JSON.stringify({ replay: processed }, null, 2));
  await mongoose.disconnect();
  if (options.forceExit) {
    process.exit(0);
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await mongoose.disconnect().catch(() => undefined);
  process.exitCode = 1;
});
