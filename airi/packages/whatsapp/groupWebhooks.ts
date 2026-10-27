import {
  asRecord,
  coerceNonEmptyString,
  type UnknownRecord,
} from "@icecore/shared/lib/value-utils";

export const WHATSAPP_GROUP_WEBHOOK_FIELDS = [
  "group_lifecycle_update",
  "group_participants_update",
  "group_settings_update",
  "group_status_update",
] as const;

export type WhatsAppGroupWebhookField =
  (typeof WHATSAPP_GROUP_WEBHOOK_FIELDS)[number];

export type WhatsAppGroupParticipant = {
  input: string | null;
  waId: string | null;
  userId: string | null;
  parentUserId: string | null;
  username: string | null;
};

export type WhatsAppGroupWebhookEvent = {
  field: WhatsAppGroupWebhookField;
  wabaId: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  groupId: string;
  type: string | null;
  requestId: string | null;
  reason: string | null;
  subject: string | null;
  description: string | null;
  inviteLink: string | null;
  joinApprovalMode: string | null;
  eventAt: Date;
  addedParticipants: WhatsAppGroupParticipant[];
  removedParticipants: WhatsAppGroupParticipant[];
  failedParticipants: WhatsAppGroupParticipant[];
  pendingParticipants: WhatsAppGroupParticipant[];
  rawGroup: UnknownRecord;
};

export function isWhatsAppGroupWebhookField(
  field: string | null | undefined,
): field is WhatsAppGroupWebhookField {
  return WHATSAPP_GROUP_WEBHOOK_FIELDS.includes(
    field as WhatsAppGroupWebhookField,
  );
}

function readString(record: UnknownRecord, key: string): string | null {
  return coerceNonEmptyString(record[key]);
}

function parseGroupTimestamp(value: unknown, fallback: Date): Date {
  const raw = coerceNonEmptyString(value);
  if (!raw) return fallback;

  const numeric = Number.parseInt(raw, 10);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric * 1000);
  }

  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function readMetadata(value: UnknownRecord): UnknownRecord {
  return asRecord(value.metadata);
}

function normalizeParticipant(value: unknown): WhatsAppGroupParticipant | null {
  const record = asRecord(value);
  const input = readString(record, "input");
  const waId = readString(record, "wa_id");
  const userId = readString(record, "user_id");
  const parentUserId = readString(record, "parent_user_id");
  const username = readString(record, "username");

  if (!input && !waId && !userId && !parentUserId && !username) {
    return null;
  }

  return {
    input,
    waId,
    userId,
    parentUserId,
    username,
  };
}

function normalizeParticipants(value: unknown): WhatsAppGroupParticipant[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeParticipant)
    .filter((participant): participant is WhatsAppGroupParticipant =>
      Boolean(participant),
    );
}

function readGroups(value: UnknownRecord): UnknownRecord[] {
  return Array.isArray(value.groups) ? value.groups.map(asRecord) : [];
}

export function normalizeWhatsAppGroupWebhookEvents(params: {
  wabaId?: string | null;
  field: string | null | undefined;
  value: unknown;
  receivedAt?: Date;
}): WhatsAppGroupWebhookEvent[] {
  if (!isWhatsAppGroupWebhookField(params.field)) {
    return [];
  }

  const field = params.field;
  const value = asRecord(params.value);
  const metadata = readMetadata(value);
  const fallbackDate = params.receivedAt ?? new Date();
  const phoneNumberId =
    readString(metadata, "phone_number_id") || readString(metadata, "cs_id");
  const displayPhoneNumber = readString(metadata, "display_phone_number");

  return readGroups(value).flatMap((group) => {
    const groupId = readString(group, "group_id");
    if (!groupId) return [];

    return [
      {
        field,
        wabaId: coerceNonEmptyString(params.wabaId) || null,
        phoneNumberId,
        displayPhoneNumber,
        groupId,
        type: readString(group, "type"),
        requestId: readString(group, "request_id"),
        reason: readString(group, "reason"),
        subject:
          readString(group, "subject") ||
          readString(asRecord(group.group_subject), "text"),
        description: readString(group, "description"),
        inviteLink: readString(group, "invite_link"),
        joinApprovalMode: readString(group, "join_approval_mode"),
        eventAt: parseGroupTimestamp(group.timestamp, fallbackDate),
        addedParticipants: normalizeParticipants(group.added_participants),
        removedParticipants: normalizeParticipants(group.removed_participants),
        failedParticipants: normalizeParticipants(group.failed_participants),
        pendingParticipants: normalizeParticipants(group.pending_participants),
        rawGroup: group,
      },
    ];
  });
}

export function buildWhatsAppGroupChatId(params: {
  sourceId?: string | null;
  phoneNumberId?: string | null;
  groupId: string;
}): string {
  const sourceId = coerceNonEmptyString(params.sourceId) || "unknown-source";
  const phoneNumberId =
    coerceNonEmptyString(params.phoneNumberId) || "unknown-phone";
  return `whatsapp_group_${sourceId}_${phoneNumberId}_${params.groupId}`;
}
