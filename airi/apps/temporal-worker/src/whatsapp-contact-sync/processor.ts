import * as CustomerModule from "@/models/customer";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { readDefaultExport } from "@icecore/airi-runtime/module-interop";
import connectDB from "@icecore/airi-runtime/mongoose";
import {
  normalizeLooseString,
  normalizePhone,
  readFirstNonEmptyStringField,
  readUniqueStringArray as uniqueStrings,
} from "@icecore/shared/lib/value-utils";
import { asWhatsAppRecord as asRecord } from "@icecore/shared/lib/whatsapp/value-utils";
import {
  buildContactSyncWebhookState,
  type WhatsAppContactSyncState,
} from "@icecore/shared/lib/whatsapp/contact-sync-state";

// The worker runs as ESM and apps/web compiles as CommonJS, so a plain default
// import of a web model is its module wrapper, not the Mongoose model.
const Customer =
  readDefaultExport<typeof CustomerModule.default>(CustomerModule);

type SourceLike = {
  id: string;
  workspace_id: string;
  credentials?: unknown;
};

type ContactSyncAction = "add" | "remove";

type NormalizedContactSyncRecord = {
  action: ContactSyncAction;
  phone?: string;
  userId?: string;
  parentUserId?: string;
  username?: string;
  displayName: string;
};

type CustomerIdentityRecord = {
  type:
    | "seed_key"
    | "channel_user"
    | "channel_chat"
    | "visitor_id"
    | "email"
    | "phone"
    | "username"
    | "whatsapp_user_id"
    | "whatsapp_parent_user_id";
  channel?: string | null;
  sourceId?: string | null;
  value: string;
  normalizedValue: string;
  label?: string | null;
  linkedAt: Date;
  linkedBy?: string | null;
  linkMethod: "system" | "backfill" | "manual" | "suggested" | "rule";
  linkConfidence?: number | null;
};

type ContactPoints = {
  emails?: string[];
  phones?: string[];
  usernames?: string[];
  visitorIds?: string[];
  whatsappUserIds?: string[];
  whatsappParentUserIds?: string[];
};

type ProfileSummary = {
  channels?: string[];
  languages?: string[];
  tags?: string[];
  contactPoints?: ContactPoints;
  lastSentiment?: string | null;
  churnRiskLevel?: string | null;
  estimatedCustomerLtv?: number | null;
  conversationCount?: number;
};

type ExistingCustomer = {
  _id?: unknown;
  workspaceId?: string;
  status?: string;
  displayName?: string | null;
  conversationIds?: unknown[];
  identities?: CustomerIdentityRecord[];
  profileSummary?: ProfileSummary | null;
};

type CustomerModelLike = {
  findOne: (
    filter: Record<string, unknown>,
  ) => Promise<ExistingCustomer | null>;
  create: (doc: Record<string, unknown>) => Promise<unknown>;
  updateOne: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => Promise<unknown>;
};

function asArray(value: unknown): unknown[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

const LOOSE_STRING_READ_OPTIONS = { normalizeWhitespace: true } as const;

function normalizeAction(value: unknown): ContactSyncAction | null {
  const normalized = normalizeLooseString(value)?.toLowerCase();
  return normalized === "add" || normalized === "remove" ? normalized : null;
}

function normalizeContactRecord(
  raw: unknown,
  parent?: Record<string, unknown>,
): NormalizedContactSyncRecord | null {
  const record = asRecord(raw);
  const contact = asRecord(record.contact);
  const action =
    normalizeAction(record.action) ||
    normalizeAction(record.event) ||
    normalizeAction(record.type) ||
    normalizeAction(parent?.action);
  if (!action) return null;

  const phone =
    normalizePhone(
      readFirstNonEmptyStringField(
        record,
        [
          "contact_phone_number",
          "phone_number",
          "phone",
          "wa_id",
          "waId",
          "number",
        ],
        LOOSE_STRING_READ_OPTIONS,
      ) ||
        readFirstNonEmptyStringField(
          contact,
          [
            "contact_phone_number",
            "phone_number",
            "phone",
            "wa_id",
            "waId",
            "number",
          ],
          LOOSE_STRING_READ_OPTIONS,
        ) ||
        "",
    ) || undefined;
  const userId =
    readFirstNonEmptyStringField(
      record,
      ["user_id", "userId", "whatsapp_user_id", "whatsappUserId"],
      LOOSE_STRING_READ_OPTIONS,
    ) ||
    readFirstNonEmptyStringField(
      contact,
      ["user_id", "userId", "whatsapp_user_id", "whatsappUserId"],
      LOOSE_STRING_READ_OPTIONS,
    ) ||
    undefined;
  const parentUserId =
    readFirstNonEmptyStringField(
      record,
      [
        "parent_user_id",
        "parentUserId",
        "whatsapp_parent_user_id",
        "whatsappParentUserId",
      ],
      LOOSE_STRING_READ_OPTIONS,
    ) ||
    readFirstNonEmptyStringField(
      contact,
      [
        "parent_user_id",
        "parentUserId",
        "whatsapp_parent_user_id",
        "whatsappParentUserId",
      ],
      LOOSE_STRING_READ_OPTIONS,
    ) ||
    undefined;
  const username =
    readFirstNonEmptyStringField(
      record,
      ["username", "contact_username"],
      LOOSE_STRING_READ_OPTIONS,
    ) ||
    readFirstNonEmptyStringField(
      contact,
      ["username", "contact_username"],
      LOOSE_STRING_READ_OPTIONS,
    ) ||
    undefined;
  if (!phone && !userId && !parentUserId && !username) return null;

  const firstName =
    readFirstNonEmptyStringField(
      record,
      ["contact_first_name", "first_name", "firstName"],
      LOOSE_STRING_READ_OPTIONS,
    ) ||
    readFirstNonEmptyStringField(
      contact,
      ["contact_first_name", "first_name", "firstName"],
      LOOSE_STRING_READ_OPTIONS,
    );
  const lastName =
    readFirstNonEmptyStringField(
      record,
      ["contact_last_name", "last_name", "lastName"],
      LOOSE_STRING_READ_OPTIONS,
    ) ||
    readFirstNonEmptyStringField(
      contact,
      ["contact_last_name", "last_name", "lastName"],
      LOOSE_STRING_READ_OPTIONS,
    );
  const fullName =
    readFirstNonEmptyStringField(
      record,
      ["contact_full_name", "full_name", "fullName", "name"],
      LOOSE_STRING_READ_OPTIONS,
    ) ||
    readFirstNonEmptyStringField(
      contact,
      ["contact_full_name", "full_name", "fullName", "name"],
      LOOSE_STRING_READ_OPTIONS,
    ) ||
    uniqueStrings([firstName, lastName]).join(" ");

  return {
    action,
    phone,
    userId,
    parentUserId,
    username,
    displayName: fullName || username || phone || userId || parentUserId || "",
  };
}

function normalizeContactSyncRecords(
  stateSync: unknown,
): NormalizedContactSyncRecord[] {
  return asArray(stateSync).flatMap((item) => {
    const record = asRecord(item);
    const contacts = asArray(record.contacts);
    if (contacts.length > 0) {
      return contacts
        .map((contact) => normalizeContactRecord(contact, record))
        .filter(
          (value): value is NormalizedContactSyncRecord => value !== null,
        );
    }

    if (record.contact) {
      const normalized = normalizeContactRecord(
        {
          ...asRecord(record.contact),
          action: record.action,
        },
        record,
      );
      return normalized ? [normalized] : [];
    }

    const normalized = normalizeContactRecord(record);
    return normalized ? [normalized] : [];
  });
}

function buildPhoneIdentity(params: {
  phone: string;
  sourceId: string;
  linkedAt: Date;
}): CustomerIdentityRecord {
  return {
    type: "phone",
    channel: "whatsapp",
    sourceId: params.sourceId,
    value: params.phone,
    normalizedValue: params.phone,
    label: "WhatsApp Business app contact",
    linkedAt: params.linkedAt,
    linkedBy: null,
    linkMethod: "system",
    linkConfidence: null,
  };
}

function buildContactIdentityRecords(params: {
  contact: NormalizedContactSyncRecord;
  sourceId: string;
  linkedAt: Date;
}): CustomerIdentityRecord[] {
  const identities: CustomerIdentityRecord[] = [];
  if (params.contact.phone) {
    identities.push(
      buildPhoneIdentity({
        phone: params.contact.phone,
        sourceId: params.sourceId,
        linkedAt: params.linkedAt,
      }),
    );
  }

  if (params.contact.userId) {
    identities.push({
      type: "whatsapp_user_id",
      channel: "whatsapp",
      sourceId: params.sourceId,
      value: params.contact.userId,
      normalizedValue: params.contact.userId,
      label: "WhatsApp Business app contact BSUID",
      linkedAt: params.linkedAt,
      linkedBy: null,
      linkMethod: "system",
      linkConfidence: null,
    });
  }

  if (params.contact.parentUserId) {
    identities.push({
      type: "whatsapp_parent_user_id",
      channel: "whatsapp",
      sourceId: params.sourceId,
      value: params.contact.parentUserId,
      normalizedValue: params.contact.parentUserId,
      label: "WhatsApp Business app contact parent BSUID",
      linkedAt: params.linkedAt,
      linkedBy: null,
      linkMethod: "system",
      linkConfidence: null,
    });
  }

  if (params.contact.username) {
    identities.push({
      type: "username",
      channel: "whatsapp",
      sourceId: params.sourceId,
      value: params.contact.username,
      normalizedValue: params.contact.username,
      label: "WhatsApp Business app contact username",
      linkedAt: params.linkedAt,
      linkedBy: null,
      linkMethod: "system",
      linkConfidence: null,
    });
  }

  return identities;
}

function mergeIdentityRecords(
  current: CustomerIdentityRecord[] | undefined,
  next: CustomerIdentityRecord[],
) {
  const merged = new Map<string, CustomerIdentityRecord>();
  for (const identity of [...(current || []), ...next]) {
    const key = [
      identity.type,
      identity.channel || "",
      identity.normalizedValue,
    ].join(":");
    if (!merged.has(key)) {
      merged.set(key, identity);
    }
  }
  return Array.from(merged.values());
}

function mergeProfileSummary(
  existing: ExistingCustomer | null,
  contact: NormalizedContactSyncRecord,
): ProfileSummary {
  const current = existing?.profileSummary || {};
  const contactPoints = current.contactPoints || {};
  const conversationCount =
    Array.isArray(existing?.conversationIds) && existing.conversationIds.length
      ? existing.conversationIds.length
      : current.conversationCount || 0;

  return {
    channels: uniqueStrings([...(current.channels || []), "whatsapp"]),
    languages: current.languages || [],
    tags: current.tags || [],
    contactPoints: {
      emails: current.contactPoints?.emails || [],
      phones: uniqueStrings([...(contactPoints.phones || []), contact.phone]),
      usernames: uniqueStrings([
        ...(contactPoints.usernames || []),
        contact.username,
      ]),
      visitorIds: current.contactPoints?.visitorIds || [],
      whatsappUserIds: uniqueStrings([
        ...(contactPoints.whatsappUserIds || []),
        contact.userId,
      ]),
      whatsappParentUserIds: uniqueStrings([
        ...(contactPoints.whatsappParentUserIds || []),
        contact.parentUserId,
      ]),
    },
    lastSentiment: current.lastSentiment || null,
    churnRiskLevel: current.churnRiskLevel || null,
    estimatedCustomerLtv: current.estimatedCustomerLtv ?? null,
    conversationCount,
  };
}

function contactIdentityFilters(contact: NormalizedContactSyncRecord) {
  const filters: Record<string, unknown>[] = [];
  if (contact.phone) {
    filters.push({
      identities: {
        $elemMatch: {
          type: "phone",
          channel: "whatsapp",
          normalizedValue: contact.phone,
        },
      },
    });
  }

  if (contact.userId) {
    filters.push({
      identities: {
        $elemMatch: {
          type: "whatsapp_user_id",
          channel: "whatsapp",
          normalizedValue: contact.userId,
        },
      },
    });
  }

  if (contact.parentUserId) {
    filters.push({
      identities: {
        $elemMatch: {
          type: "whatsapp_parent_user_id",
          channel: "whatsapp",
          normalizedValue: contact.parentUserId,
        },
      },
    });
  }

  if (contact.username) {
    filters.push({
      identities: {
        $elemMatch: {
          type: "username",
          channel: "whatsapp",
          normalizedValue: contact.username,
        },
      },
    });
  }

  return filters;
}

function contactFilter(
  workspaceId: string,
  contact: NormalizedContactSyncRecord,
): Record<string, unknown> {
  const filters = contactIdentityFilters(contact);
  return {
    workspaceId,
    ...(filters.length === 1 ? filters[0] : { $or: filters }),
  };
}

async function findContactCustomer(
  customerModel: CustomerModelLike,
  workspaceId: string,
  contact: NormalizedContactSyncRecord,
) {
  const filters = contactIdentityFilters(contact);
  if (filters.length === 0) return null;
  return (await customerModel.findOne(
    contactFilter(workspaceId, contact),
  )) as ExistingCustomer | null;
}

async function upsertContactCustomer(params: {
  customerModel: CustomerModelLike;
  workspaceId: string;
  sourceId: string;
  contact: NormalizedContactSyncRecord;
  linkedAt: Date;
}) {
  const existing = await findContactCustomer(
    params.customerModel,
    params.workspaceId,
    params.contact,
  );
  const identities = mergeIdentityRecords(
    existing?.identities,
    buildContactIdentityRecords({
      contact: params.contact,
      sourceId: params.sourceId,
      linkedAt: params.linkedAt,
    }),
  );
  const profileSummary = mergeProfileSummary(existing, params.contact);
  const displayName =
    normalizeLooseString(params.contact.displayName) ||
    normalizeLooseString(existing?.displayName) ||
    params.contact.phone ||
    params.contact.username ||
    params.contact.userId ||
    params.contact.parentUserId ||
    "WhatsApp contact";

  if (existing?._id) {
    await params.customerModel.updateOne(
      { _id: existing._id },
      {
        $set: {
          status: "active",
          displayName,
          identities,
          profileSummary,
        },
      },
    );
    return;
  }

  await params.customerModel.create({
    workspaceId: params.workspaceId,
    status: "active",
    displayName,
    primaryConversationId: null,
    conversationIds: [],
    seedKeys: [],
    identities,
    profileSummary,
    behavioralProfile: null,
    currentFunnelStage: null,
    lastInteractionAt: null,
  });
}

async function archiveContactOnlyCustomer(params: {
  customerModel: CustomerModelLike;
  workspaceId: string;
  contact: NormalizedContactSyncRecord;
}) {
  const existing = await findContactCustomer(
    params.customerModel,
    params.workspaceId,
    params.contact,
  );
  if (!existing?._id) return false;

  const hasLinkedConversations =
    Array.isArray(existing.conversationIds) &&
    existing.conversationIds.length > 0;
  if (hasLinkedConversations) return true;

  await params.customerModel.updateOne(
    { _id: existing._id },
    {
      $set: {
        status: "archived",
      },
    },
  );
  return true;
}

export async function processWhatsAppContactSyncWebhook({
  source,
  stateSync,
  persistCredentials,
  receivedAt = new Date().toISOString(),
  connect = connectDB,
  customerModel = Customer as CustomerModelLike,
}: {
  source: SourceLike;
  phoneNumberId: string;
  stateSync: unknown;
  persistCredentials: (credentials: Record<string, unknown>) => Promise<void>;
  receivedAt?: string;
  connect?: () => Promise<unknown>;
  customerModel?: CustomerModelLike;
}): Promise<{ processedCount: number; skippedCount: number }> {
  await connect();

  const records = normalizeContactSyncRecords(stateSync);
  let processedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let firstFailure: unknown;
  const linkedAt = new Date(receivedAt);

  for (const contact of records) {
    try {
      if (contact.action === "add") {
        await upsertContactCustomer({
          customerModel,
          workspaceId: source.workspace_id,
          sourceId: source.id,
          contact,
          linkedAt,
        });
        processedCount += 1;
        continue;
      }

      const removed = await archiveContactOnlyCustomer({
        customerModel,
        workspaceId: source.workspace_id,
        contact,
      });
      if (removed) {
        processedCount += 1;
      } else {
        skippedCount += 1;
      }
    } catch (error) {
      skippedCount += 1;
      failedCount += 1;
      firstFailure ??= error;
    }
  }

  // One line per webhook: the first error explains the batch, and contact
  // details stay out of the logs.
  if (failedCount > 0) {
    airiWorkerLogger.error(
      "whatsapp.contact_sync.contacts_failed",
      firstFailure,
      {
        workspaceId: source.workspace_id,
        sourceId: source.id,
        failedCount,
        recordCount: records.length,
      },
    );
  }

  const currentCredentials = asRecord(source.credentials);
  const currentContactSync = currentCredentials.contact_sync as
    | WhatsAppContactSyncState
    | undefined;
  const contactSyncState = buildContactSyncWebhookState({
    current: currentContactSync,
    processedCount,
    skippedCount,
    receivedAt,
  });
  await persistCredentials({
    ...currentCredentials,
    contact_sync: contactSyncState,
  });

  return { processedCount, skippedCount };
}
