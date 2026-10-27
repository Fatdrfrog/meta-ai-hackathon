import "server-only";

import type {
  BulkCampaignRecipient,
  RegisteredBusinessPhonesAudiencePreviewRow,
  RegisteredBusinessPhonesAudienceSummary,
} from "@/lib/campaign/bulk-campaign-contracts";
import connectDB from "@/lib/mongoose";
import Customer from "@/models/customer";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";
import { normalizeEmail, normalizeLooseString, normalizePhone } from "./shared";

const REGISTRATION_FOLLOW_UP_TAG = "registration_follow_up";
const REGISTERED_BUSINESS_TAG = "registered_business";
const REGISTERED_BUSINESS_STAGE = "registered_business";
const DEFAULT_AUDIENCE_LIMIT = 10_000;
const DEFAULT_PREVIEW_LIMIT = 100;

type CustomerIdentityInput = {
  type: string;
  channel: string;
  sourceId?: string | null;
  value: string;
  normalizedValue: string;
  label?: string | null;
  linkedAt?: Date;
  linkedBy?: string | null;
  linkMethod?: "system" | "backfill" | "manual" | "suggested" | "rule";
  linkConfidence?: number | null;
};

type RegistrationContactCustomer = {
  _id?: unknown;
  status?: string;
  displayName?: string | null;
  seedKeys?: string[];
  identities?: CustomerIdentityInput[];
  profileSummary?: {
    channels?: string[];
    tags?: string[];
    contactPoints?: {
      emails?: string[];
      phones?: string[];
      usernames?: string[];
      visitorIds?: string[];
      whatsappUserIds?: string[];
      whatsappParentUserIds?: string[];
    };
    conversationCount?: number;
    [key: string]: unknown;
  } | null;
  currentFunnelStage?: string | null;
  lastInteractionAt?: Date | null;
  save?: () => Promise<unknown>;
};

export type UpsertRegisteredBusinessPhoneContactParams = {
  senderWorkspaceId: string;
  registeredCompanyId: string;
  registeredWorkspaceId: string;
  registeredWorkspaceName: string;
  userId: string;
  userEmail: string;
  userName?: string | null;
  phone: string;
};

export type UpsertRegisteredBusinessPhoneContactResult =
  | {
      status: "skipped";
      phone: null;
      customerId: null;
    }
  | {
      status: "created" | "updated";
      phone: string;
      customerId: string;
    };

export type RegisteredBusinessPhoneAudience = {
  recipients: BulkCampaignRecipient[];
  total: number;
  complete: boolean;
  truncated: boolean;
};

function normalizeWorkspaceName(value: unknown): string {
  return readTrimmedString(value).replace(/\s+/g, " ");
}

function compactUnique(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map(value => readTrimmedString(value)).filter(Boolean))
  );
}

function getCustomerId(customer: RegistrationContactCustomer): string {
  return String(customer._id || "").trim();
}

function buildSignupSeedKey(params: {
  userId: string;
  registeredWorkspaceId: string;
}): string {
  return `airi_signup:${params.userId}:${params.registeredWorkspaceId}`;
}

export function normalizeRegistrationPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return normalizePhone(value);
}

function buildDisplayName(params: {
  userName?: string | null;
  registeredWorkspaceName?: string | null;
  userEmail?: string | null;
  phone: string;
}): string {
  return (
    normalizeLooseString(params.userName) ||
    normalizeWorkspaceName(params.registeredWorkspaceName) ||
    normalizeLooseString(params.userEmail)?.split("@")[0] ||
    `Registered business ${params.phone.slice(-4)}`
  );
}

function buildRegistrationIdentities(params: {
  phone: string;
  userEmail: string;
  userId: string;
  seedKey: string;
  now: Date;
}): CustomerIdentityInput[] {
  const normalizedEmail = normalizeEmail(params.userEmail);
  return [
    {
      type: "phone",
      channel: "whatsapp",
      value: params.phone,
      normalizedValue: params.phone,
      label: "Registration phone",
      linkedAt: params.now,
      linkedBy: params.userId,
      linkMethod: "system",
      linkConfidence: 1,
    },
    ...(normalizedEmail
      ? [
          {
            type: "email",
            channel: "email",
            value: normalizedEmail,
            normalizedValue: normalizedEmail,
            label: "Registered account email",
            linkedAt: params.now,
            linkedBy: params.userId,
            linkMethod: "system" as const,
            linkConfidence: 1,
          },
        ]
      : []),
    {
      type: "seed_key",
      channel: "airi_signup",
      value: params.seedKey,
      normalizedValue: params.seedKey,
      label: "Airi signup registration",
      linkedAt: params.now,
      linkedBy: params.userId,
      linkMethod: "system",
      linkConfidence: 1,
    },
  ];
}

function mergeIdentities(
  existing: CustomerIdentityInput[] | undefined,
  incoming: CustomerIdentityInput[]
): CustomerIdentityInput[] {
  const byKey = new Map<string, CustomerIdentityInput>();
  for (const identity of existing || []) {
    byKey.set(
      `${identity.type}:${identity.channel}:${identity.normalizedValue}`,
      identity
    );
  }
  for (const identity of incoming) {
    byKey.set(
      `${identity.type}:${identity.channel}:${identity.normalizedValue}`,
      {
        ...byKey.get(
          `${identity.type}:${identity.channel}:${identity.normalizedValue}`
        ),
        ...identity,
      }
    );
  }
  return Array.from(byKey.values());
}

function buildProfileSummary(params: {
  existing?: RegistrationContactCustomer["profileSummary"];
  phone: string;
  email: string;
}) {
  const existing = params.existing || {};
  const existingContactPoints = existing.contactPoints || {};
  const email = normalizeEmail(params.email);
  return {
    ...existing,
    channels: compactUnique([
      ...(existing.channels || []),
      "whatsapp",
      "email",
    ]),
    tags: compactUnique([
      ...(existing.tags || []),
      REGISTERED_BUSINESS_TAG,
      REGISTRATION_FOLLOW_UP_TAG,
    ]),
    contactPoints: {
      emails: compactUnique([...(existingContactPoints.emails || []), email]),
      phones: compactUnique([
        ...(existingContactPoints.phones || []),
        params.phone,
      ]),
      usernames: existingContactPoints.usernames || [],
      visitorIds: existingContactPoints.visitorIds || [],
      whatsappUserIds: existingContactPoints.whatsappUserIds || [],
      whatsappParentUserIds: existingContactPoints.whatsappParentUserIds || [],
    },
    conversationCount: existing.conversationCount || 0,
  };
}

export async function upsertRegisteredBusinessPhoneContact(
  params: UpsertRegisteredBusinessPhoneContactParams
): Promise<UpsertRegisteredBusinessPhoneContactResult> {
  const phone = normalizeRegistrationPhone(params.phone);
  if (!phone) {
    return { status: "skipped", phone: null, customerId: null };
  }

  await connectDB();

  const now = new Date();
  const seedKey = buildSignupSeedKey({
    userId: params.userId,
    registeredWorkspaceId: params.registeredWorkspaceId,
  });
  const displayName = buildDisplayName({
    userName: params.userName,
    registeredWorkspaceName: params.registeredWorkspaceName,
    userEmail: params.userEmail,
    phone,
  });
  const identities = buildRegistrationIdentities({
    phone,
    userEmail: params.userEmail,
    userId: params.userId,
    seedKey,
    now,
  });
  const profileSummary = buildProfileSummary({
    phone,
    email: params.userEmail,
  });

  const existing = (await Customer.findOne({
    workspaceId: params.senderWorkspaceId,
    identities: {
      $elemMatch: {
        type: "phone",
        channel: "whatsapp",
        normalizedValue: phone,
      },
    },
  })) as RegistrationContactCustomer | null;

  if (!existing) {
    const created = (await Customer.create({
      workspaceId: params.senderWorkspaceId,
      status: "active",
      displayName,
      primaryConversationId: null,
      conversationIds: [],
      seedKeys: [seedKey],
      identities,
      profileSummary,
      currentFunnelStage: REGISTERED_BUSINESS_STAGE,
      lastInteractionAt: now,
    })) as RegistrationContactCustomer;

    return {
      status: "created",
      customerId: getCustomerId(created),
      phone,
    };
  }

  existing.status = "active";
  existing.displayName =
    normalizeLooseString(existing.displayName) || displayName;
  existing.seedKeys = compactUnique([...(existing.seedKeys || []), seedKey]);
  existing.identities = mergeIdentities(existing.identities, identities);
  existing.profileSummary = buildProfileSummary({
    existing: existing.profileSummary,
    phone,
    email: params.userEmail,
  });
  existing.currentFunnelStage =
    existing.currentFunnelStage || REGISTERED_BUSINESS_STAGE;
  existing.lastInteractionAt = now;
  await existing.save?.();

  return {
    status: "updated",
    customerId: getCustomerId(existing),
    phone,
  };
}

function getIdentityValue(
  customer: RegistrationContactCustomer,
  type: string,
  channel: string
): string {
  for (const identity of customer.identities || []) {
    if (identity.type !== type || identity.channel !== channel) continue;
    const value = readTrimmedString(identity.normalizedValue || identity.value);
    if (value) return value;
  }
  return "";
}

function getCustomerPhone(
  customer: RegistrationContactCustomer
): string | null {
  const identityPhone = normalizeRegistrationPhone(
    getIdentityValue(customer, "phone", "whatsapp")
  );
  if (identityPhone) return identityPhone;
  for (const value of customer.profileSummary?.contactPoints?.phones || []) {
    const phone = normalizeRegistrationPhone(value);
    if (phone) return phone;
  }
  return null;
}

function getCustomerEmail(customer: RegistrationContactCustomer): string {
  const identityEmail = normalizeEmail(
    getIdentityValue(customer, "email", "email")
  );
  if (identityEmail) return identityEmail;
  for (const value of customer.profileSummary?.contactPoints?.emails || []) {
    const email = normalizeEmail(value);
    if (email) return email;
  }
  return "";
}

function toBulkRecipient(
  customer: RegistrationContactCustomer,
  phone: string
): BulkCampaignRecipient {
  const email = getCustomerEmail(customer);
  const name =
    normalizeLooseString(customer.displayName) ||
    (email ? email.split("@")[0] : "") ||
    `Registered business ${phone.slice(-4)}`;
  const fields = {
    phone,
    ...(email ? { email } : {}),
    name,
    source: REGISTRATION_FOLLOW_UP_TAG,
  };
  return {
    phone,
    name,
    fields,
    variables: {
      ...fields,
      recipientName: name,
      full_name: name,
      userName: name,
      recipientPhone: phone,
      userEmail: email,
    },
  };
}

function buildAudienceFilter(selectedPhones?: string[]) {
  const selected = compactUnique(
    (selectedPhones || []).map(phone => normalizeRegistrationPhone(phone))
  );
  const filter: Record<string, unknown> = {
    status: "active",
    "profileSummary.tags": REGISTRATION_FOLLOW_UP_TAG,
    identities: {
      $elemMatch: {
        type: "phone",
        channel: "whatsapp",
      },
    },
  };
  if (selected.length > 0) {
    filter.identities = {
      $elemMatch: {
        type: "phone",
        channel: "whatsapp",
        normalizedValue: { $in: selected },
      },
    };
  }
  return { filter, selected };
}

export async function resolveRegisteredBusinessPhoneAudience(params: {
  workspaceId: string;
  selectedPhones?: string[];
  limit?: number;
}): Promise<RegisteredBusinessPhoneAudience> {
  await connectDB();
  const { filter, selected } = buildAudienceFilter(params.selectedPhones);
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(0, Math.floor(params.limit))
      : DEFAULT_AUDIENCE_LIMIT;
  const selectedSet = new Set(selected);

  const customers = (await Customer.find({
    workspaceId: params.workspaceId,
    ...filter,
  })
    .select("displayName identities profileSummary seedKeys")
    .sort({ lastInteractionAt: -1, createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean()) as RegistrationContactCustomer[];

  const complete = customers.length <= limit;

  const seenPhones = new Set<string>();
  const recipients: BulkCampaignRecipient[] = [];
  for (const customer of customers.slice(0, limit)) {
    const phone = getCustomerPhone(customer);
    if (!phone) continue;
    if (selectedSet.size > 0 && !selectedSet.has(phone)) continue;
    if (seenPhones.has(phone)) continue;
    seenPhones.add(phone);
    recipients.push(toBulkRecipient(customer, phone));
  }

  return {
    total: recipients.length,
    recipients,
    complete,
    truncated: !complete,
  };
}

export async function getRegisteredBusinessPhoneAudienceSummary(params: {
  workspaceId: string;
  previewLimit?: number;
}): Promise<RegisteredBusinessPhonesAudienceSummary> {
  const previewLimit =
    typeof params.previewLimit === "number" &&
    Number.isFinite(params.previewLimit)
      ? Math.max(0, Math.floor(params.previewLimit))
      : DEFAULT_PREVIEW_LIMIT;
  const audience = await resolveRegisteredBusinessPhoneAudience({
    workspaceId: params.workspaceId,
    limit: DEFAULT_AUDIENCE_LIMIT,
  });
  const preview: RegisteredBusinessPhonesAudiencePreviewRow[] =
    audience.recipients.slice(0, previewLimit).map(recipient => ({
      phone: recipient.phone || "",
      name: recipient.name || null,
      email: recipient.variables?.email || recipient.fields?.email || null,
    }));

  return {
    enabled: true,
    total: audience.total,
    preview,
  };
}
