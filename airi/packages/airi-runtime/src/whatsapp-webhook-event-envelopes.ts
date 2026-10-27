import { createHash } from "node:crypto";
import type { WhatsAppHistoryImportReceipt } from "./whatsapp-history-import";

import { buildWhatsAppWebhookProcessorRoutingKey } from "@icecore/temporal";
import { extractWhatsAppIdentifiersFromWebhookValue } from "@icecore/shared/lib/whatsapp/account-identifiers";
import { isWhatsAppRecoverableMessageContent } from "@icecore/shared/lib/whatsapp/webhook-automation-eligibility";
import { isWhatsAppStandaloneMessageEvent } from "@icecore/shared/lib/whatsapp/message-mutations";
import {
  asWhatsAppRecord as asRecord,
  compactWhatsAppString,
} from "@icecore/shared/lib/whatsapp/value-utils";
import { readArray } from "@icecore/shared/lib/value-utils";

type JsonRecord = Record<string, unknown>;

const ROUTING_PARTITION_HASH_LENGTH = 24;

export type WhatsAppWebhookEventEnvelope = {
  historyImport?: WhatsAppHistoryImportReceipt;
  dedupeKey: string;
  object: string | null;
  field: string;
  itemKind: string;
  workspaceId: string | null;
  sourceId: string | null;
  phoneNumberId: string | null;
  csId: string | null;
  wabaId: string | null;
  messagingAccountId: string | null;
  waacId: string | null;
  orderingKey: string;
  payload: {
    body: JsonRecord;
    rawBody: string;
    originalRawBodyHash: string;
    receivedAt: string;
  };
  historyMetadata: {
    phase: number | null;
    chunkOrder: number | null;
    progress: number | null;
  } | null;
  receivedAt: Date;
};

function asObjectArray(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  return Array.isArray(value) ? value : [value];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function firstCompactString(...values: unknown[]): string | null {
  for (const value of values) {
    const compact = compactWhatsAppString(value);
    if (compact) return compact;
  }
  return null;
}

function getFirstContactIdentity(value: JsonRecord): string | null {
  const contact = asRecord(readArray(value.contacts)[0]);
  return firstCompactString(
    contact.user_id,
    contact.wa_id,
    contact.parent_user_id,
    contact.username,
  );
}

function getChatPartitionIdentity(params: {
  itemKind: string;
  item: JsonRecord;
  value: JsonRecord;
}): string | null {
  const isEcho =
    params.itemKind === "message_echoes" ||
    params.itemKind === "smb_message_echoes";
  return firstCompactString(
    params.item.group_id,
    params.item.groupId,
    isEcho ? params.item.to_user_id : null,
    isEcho ? params.item.to_parent_user_id : null,
    params.item.to,
    params.item.from_user_id,
    params.item.user_id,
    params.item.parent_user_id,
    params.item.from,
    params.item.recipient_id,
    getFirstContactIdentity(params.value),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      return nested;
    }
    return Object.keys(nested as JsonRecord)
      .sort()
      .reduce<JsonRecord>((acc, key) => {
        acc[key] = (nested as JsonRecord)[key];
        return acc;
      }, {});
  });
}

function getEnvelopeMessage(payload: unknown): JsonRecord {
  const body = asRecord(asRecord(payload).body);
  const entry = asRecord(readArray(body.entry)[0]);
  const change = asRecord(readArray(entry.changes)[0]);
  return asRecord(readArray(asRecord(change.value).messages)[0]);
}

/**
 * Keep each verified useful revision immutable. Reopening or replacing the base
 * event would race an existing worker lease and lose either payload provenance
 * or the recovery. The canonical message owner merges these revisions.
 */
export function buildWhatsAppWebhookMessageRecoveryEnvelope(params: {
  incoming: WhatsAppWebhookEventEnvelope;
  storedPayload: unknown;
  storedOrderingKey: unknown;
  providerSignatureVerified: boolean;
}): WhatsAppWebhookEventEnvelope | null {
  const { incoming } = params;
  if (
    !params.providerSignatureVerified ||
    incoming.field !== "messages" ||
    incoming.itemKind !== "message" ||
    params.storedOrderingKey !== incoming.orderingKey
  )
    return null;

  const previous = getEnvelopeMessage(params.storedPayload);
  const next = getEnvelopeMessage(incoming.payload);
  const previousId = compactWhatsAppString(previous.id);
  if (
    !previousId ||
    previousId !== compactWhatsAppString(next.id) ||
    !isWhatsAppStandaloneMessageEvent(previous) ||
    !isWhatsAppRecoverableMessageContent(next)
  )
    return null;

  const previousReferral = asRecord(previous.referral);
  const nextReferral = asRecord(next.referral);
  const addsReferral = Boolean(
    (!compactWhatsAppString(previousReferral.source_id) &&
      compactWhatsAppString(nextReferral.source_id)) ||
      (!compactWhatsAppString(previousReferral.ctwa_clid) &&
        compactWhatsAppString(nextReferral.ctwa_clid)),
  );
  if (isWhatsAppRecoverableMessageContent(previous) && !addsReferral)
    return null;

  // Provider delivery times, envelope/contact ordering and expiring ad-media
  // URLs do not make a new useful variant. Content and attribution do.
  const type = compactWhatsAppString(next.type)!;
  const referral = { ...nextReferral };
  delete referral.image_url;
  delete referral.video_url;
  delete referral.thumbnail_url;
  const revisionHash = sha256(
    stableJson({
      type,
      content: next[type],
      referral,
    }),
  );
  return {
    ...incoming,
    dedupeKey: `${incoming.dedupeKey}:content:${revisionHash}`,
  };
}

function cloneChangeWithValue(
  change: JsonRecord,
  value: JsonRecord,
): JsonRecord {
  return {
    ...change,
    value,
  };
}

function withoutTopLevelSplitItems(value: JsonRecord): JsonRecord {
  const next = { ...value };
  delete next.messages;
  delete next.statuses;
  delete next.calls;
  delete next.message_echoes;
  delete next.smb_message_echoes;
  delete next.errors;
  return next;
}

function buildSingleChangeBody(params: {
  object: string | null;
  entry: JsonRecord;
  change: JsonRecord;
}): JsonRecord {
  return {
    object: params.object,
    entry: [
      {
        ...params.entry,
        changes: [params.change],
      },
    ],
  };
}

function getPhoneNumberId(value: JsonRecord): string | null {
  const metadata = asRecord(value.metadata);
  return (
    compactWhatsAppString(metadata.phone_number_id) ||
    compactWhatsAppString(metadata.cs_id)
  );
}

function getHistoryMetadata(value: JsonRecord): {
  phase: number | null;
  chunkOrder: number | null;
  progress: number | null;
} | null {
  const history = asObjectArray(value.history);
  const rankedHistory = history.map(asRecord).sort((left, right) => Number(asRecord(right.metadata).progress ?? right.progress ?? -1) - Number(asRecord(left.metadata).progress ?? left.progress ?? -1));
  const first = rankedHistory[0] || {};
  const metadata = asRecord(first.metadata);
  if (
    !history.length &&
    !("phase" in value) &&
    !("chunk_order" in value) &&
    !("metadata" in first)
  ) {
    return null;
  }
  const phase = Number(metadata.phase ?? first.phase ?? value.phase);
  const chunkOrder = Number(
    metadata.chunk_order ?? first.chunk_order ?? value.chunk_order,
  );
  const progress = Number(
    metadata.progress ?? first.progress ?? value.progress,
  );
  return {
    phase: Number.isFinite(phase) ? phase : null,
    chunkOrder: Number.isFinite(chunkOrder) ? chunkOrder : null,
    progress: Number.isFinite(progress) ? progress : null,
  };
}

function normalizeDirectEventPayload(body: JsonRecord): JsonRecord {
  const event = compactWhatsAppString(body.event);
  const data = asRecord(body.data);
  if (!event || Object.keys(data).length === 0) return body;

  const wabaId =
    compactWhatsAppString(data.id) || compactWhatsAppString(body.id);
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: wabaId || undefined,
        changes: [
          {
            field: event,
            value: data,
          },
        ],
      },
    ],
  };
}

export function getWhatsAppWebhookOrderingKey(params: {
  sourceId?: string | null;
  phoneNumberId?: string | null;
  waacId?: string | null;
  wabaId?: string | null;
}): string {
  return (
    compactWhatsAppString(params.sourceId) ||
    compactWhatsAppString(params.phoneNumberId) ||
    compactWhatsAppString(params.waacId) ||
    compactWhatsAppString(params.wabaId) ||
    "whatsapp-unknown"
  );
}

export function getWhatsAppWebhookProcessorRoutingKey(params: {
  sourceId?: string | null;
  phoneNumberId?: string | null;
  waacId?: string | null;
  wabaId?: string | null;
  itemKind?: string | null;
  partitionIdentity?: string | null;
}): string {
  const baseKey = getWhatsAppWebhookOrderingKey(params);
  const itemKind = compactWhatsAppString(params.itemKind);
  const routedBaseKey = buildWhatsAppWebhookProcessorRoutingKey({
    baseKey,
    itemKind,
  });
  const partitionIdentity = compactWhatsAppString(params.partitionIdentity);
  if (!partitionIdentity) return routedBaseKey;

  const partitionPrefix =
    itemKind && !routedBaseKey.endsWith(`:${itemKind}`)
      ? `${routedBaseKey}:${itemKind}`
      : routedBaseKey;
  const partitionHash = sha256(
    `${baseKey}\u0000${itemKind || "event"}\u0000${partitionIdentity}`,
  ).slice(0, ROUTING_PARTITION_HASH_LENGTH);
  return `${partitionPrefix}:${partitionHash}`;
}

function makeDedupeKey(params: {
  object: string | null;
  wabaId: string | null;
  field: string;
  phoneNumberId: string | null;
  itemKind: string;
  itemId: string | null;
  body: JsonRecord;
}): string {
  const stablePart =
    params.itemId ||
    sha256(
      stableJson({
        object: params.object,
        wabaId: params.wabaId,
        field: params.field,
        phoneNumberId: params.phoneNumberId,
        body: params.body,
      }),
    );
  return [
    "whatsapp",
    params.field || "unknown",
    params.phoneNumberId || params.wabaId || "unknown",
    params.itemKind,
    stablePart,
  ].join(":");
}

function getStatusDedupeItemId(statusRecord: JsonRecord): string | null {
  const id = compactWhatsAppString(statusRecord.id);
  if (!id) return null;
  const status = compactWhatsAppString(statusRecord.status);
  return status ? `${id}:${status}` : id;
}

function getCallDedupeItemId(callRecord: JsonRecord): string | null {
  const id = compactWhatsAppString(callRecord.id);
  if (!id) return null;
  const event = compactWhatsAppString(callRecord.event);
  const status = compactWhatsAppString(callRecord.status);
  return [id, event || status].filter(Boolean).join(":");
}

function getErrorDedupeItemId(errorRecord: JsonRecord): string {
  const code = compactWhatsAppString(errorRecord.code);
  const hash = sha256(stableJson(errorRecord)).slice(0, 16);
  return [code || "unknown", hash].join(":");
}

function getEchoItemKind(field: string, key: string): string {
  if (field === "smb_message_echoes" && key === "message_echoes") {
    return "smb_message_echoes";
  }

  return key;
}

function makeEnvelope(params: {
  object: string | null;
  entry: JsonRecord;
  change: JsonRecord;
  field: string;
  value: JsonRecord;
  originalRawBodyHash: string;
  receivedAt: Date;
  itemKind: string;
  itemId: string | null;
  partitionIdentity?: string | null;
}): WhatsAppWebhookEventEnvelope {
  const ids = extractWhatsAppIdentifiersFromWebhookValue({
    entryId: params.entry.id,
    value: params.value,
  });
  const wabaId = ids.wabaId || null;
  const phoneNumberId = ids.phoneNumberId || getPhoneNumberId(params.value);
  const body = buildSingleChangeBody({
    object: params.object,
    entry: params.entry,
    change: params.change,
  });
  const normalizedRawBody = JSON.stringify(body);
  const orderingKey = getWhatsAppWebhookProcessorRoutingKey({
    phoneNumberId,
    waacId: ids.waacId,
    wabaId,
    itemKind: params.itemKind,
    partitionIdentity: params.partitionIdentity,
  });
  return {
    dedupeKey: makeDedupeKey({
      object: params.object,
      wabaId,
      field: params.field,
      phoneNumberId,
      itemKind: params.itemKind,
      itemId: params.itemId,
      body,
    }),
    object: params.object,
    field: params.field,
    itemKind: params.itemKind,
    workspaceId: null,
    sourceId: null,
    phoneNumberId,
    csId: ids.csId || null,
    wabaId,
    messagingAccountId: ids.messagingAccountId || null,
    waacId: ids.waacId || null,
    orderingKey,
    payload: {
      body,
      rawBody: normalizedRawBody,
      originalRawBodyHash: params.originalRawBodyHash,
      receivedAt: params.receivedAt.toISOString(),
    },
    historyMetadata: getHistoryMetadata(params.value),
    receivedAt: params.receivedAt,
  };
}

function splitChange(params: {
  object: string | null;
  entry: JsonRecord;
  change: JsonRecord;
  originalRawBodyHash: string;
  receivedAt: Date;
}): WhatsAppWebhookEventEnvelope[] {
  const field = compactWhatsAppString(params.change.field) || "unknown";
  const value = asRecord(params.change.value);
  const envelopes: WhatsAppWebhookEventEnvelope[] = [];

  // A history chunk is its own durable expansion manifest. Splitting top-level
  // messages here would copy its nested history into every sibling envelope.
  if (field === "history" || "history" in value) {
    return [makeEnvelope({ ...params, field: "history", value, itemKind: "history", itemId: null })];
  }

  const messages = readArray(value.messages);
  for (const message of messages) {
    const messageRecord = asRecord(message);
    const nextValue = {
      ...withoutTopLevelSplitItems(value),
      messages: [messageRecord],
    };
    envelopes.push(
      makeEnvelope({
        ...params,
        field,
        value: nextValue,
        change: cloneChangeWithValue(params.change, nextValue),
        itemKind: "message",
        itemId: compactWhatsAppString(messageRecord.id),
        partitionIdentity: getChatPartitionIdentity({
          itemKind: "message",
          item: messageRecord,
          value,
        }),
      }),
    );
  }

  const statuses = readArray(value.statuses);
  for (const status of statuses) {
    const statusRecord = asRecord(status);
    const nextValue = {
      ...withoutTopLevelSplitItems(value),
      statuses: [statusRecord],
    };
    envelopes.push(
      makeEnvelope({
        ...params,
        field,
        value: nextValue,
        change: cloneChangeWithValue(params.change, nextValue),
        itemKind: "status",
        itemId: getStatusDedupeItemId(statusRecord),
        partitionIdentity: compactWhatsAppString(statusRecord.id),
      }),
    );
  }

  const errors = readArray(value.errors);
  for (const error of errors) {
    const errorRecord = asRecord(error);
    const nextValue = {
      ...withoutTopLevelSplitItems(value),
      errors: [errorRecord],
    };
    envelopes.push(
      makeEnvelope({
        ...params,
        field,
        value: nextValue,
        change: cloneChangeWithValue(params.change, nextValue),
        itemKind: "error",
        itemId: getErrorDedupeItemId(errorRecord),
      }),
    );
  }

  const calls = readArray(value.calls);
  for (const call of calls) {
    const callRecord = asRecord(call);
    const nextValue = {
      ...withoutTopLevelSplitItems(value),
      calls: [callRecord],
    };
    envelopes.push(
      makeEnvelope({
        ...params,
        field,
        value: nextValue,
        change: cloneChangeWithValue(params.change, nextValue),
        itemKind: "call",
        itemId: getCallDedupeItemId(callRecord),
        partitionIdentity: compactWhatsAppString(callRecord.id),
      }),
    );
  }

  for (const key of ["message_echoes", "smb_message_echoes"]) {
    for (const echo of readArray(value[key])) {
      const echoRecord = asRecord(echo);
      const itemKind = getEchoItemKind(field, key);
      const nextValue = {
        ...withoutTopLevelSplitItems(value),
        [key]: [echoRecord],
      };
      envelopes.push(
        makeEnvelope({
          ...params,
          field,
          value: nextValue,
          change: cloneChangeWithValue(params.change, nextValue),
          itemKind,
          itemId: compactWhatsAppString(echoRecord.id),
          partitionIdentity: getChatPartitionIdentity({
            itemKind,
            item: echoRecord,
            value,
          }),
        }),
      );
    }
  }

  if (envelopes.length > 0) {
    return envelopes;
  }

  return [
    makeEnvelope({
      ...params,
      field,
      value,
      itemKind: field,
      itemId: null,
    }),
  ];
}

export function buildWhatsAppWebhookEventEnvelopes(params: {
  body: unknown;
  rawBody: string;
  receivedAt?: Date;
}): WhatsAppWebhookEventEnvelope[] {
  const body = normalizeDirectEventPayload(asRecord(params.body));
  const object = compactWhatsAppString(body.object);
  const receivedAt = params.receivedAt || new Date();
  const originalRawBodyHash = sha256(params.rawBody);

  return readArray(body.entry).flatMap((entryValue) => {
    const entry = asRecord(entryValue);
    return readArray(entry.changes).flatMap((changeValue) =>
      splitChange({
        object,
        entry,
        change: asRecord(changeValue),
        originalRawBodyHash,
        receivedAt,
      }),
    );
  });
}
