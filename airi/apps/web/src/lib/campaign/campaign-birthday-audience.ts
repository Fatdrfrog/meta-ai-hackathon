import "server-only";

import type { CampaignBirthdayConfig } from "@icecore/scenario-contracts";
import { CAMPAIGN_BIRTHDAY_CONFIG_VERSION } from "@icecore/scenario-contracts";
import { Types } from "mongoose";

import type { BulkCampaignRecipient } from "@/lib/campaign/bulk-campaign-contracts";
import { filterKnownMarketingOptOutRecipients } from "@/lib/campaign/marketing-opt-in";
import { isLeapYear } from "@/lib/customers/customer-birthday";
import connectDB from "@/lib/mongoose";
import Customer, { ensureCustomerBirthdayIndexes } from "@/models/customer";
import {
  findEligibleTelegramSubscriberMap,
  isTelegramPrivateSubscriberChatId,
  normalizeTelegramSubscriberChatId,
} from "@/lib/telegram/subscribers";
import { buildTelegramCompositeChatId } from "@/lib/telegram/chat-id";

import { normalizeLooseString, normalizePhone } from "../customers/shared";
import { getZonedBirthdayDateParts } from "./campaign-birthday-recipient-plan";

const DEFAULT_PAGE_SIZE = 500;
const MAX_PREVIEW_SCAN = 10_000;

type BirthdayCustomerRecord = {
  _id?: unknown;
  displayName?: string | null;
  identities?: Array<{
    type?: string | null;
    channel?: string | null;
    sourceId?: string | null;
    value?: string | null;
    normalizedValue?: string | null;
  }>;
  profileSummary?: {
    contactPoints?: {
      phones?: string[];
    };
  } | null;
  profileDates?: {
    birthday?: {
      month?: number | null;
      day?: number | null;
      year?: number | null;
      raw?: string | null;
    } | null;
  } | null;
};

export type BirthdayAudienceRecipient = BulkCampaignRecipient & {
  customerId: string;
  phone?: string;
  chatId?: string;
  sourceId?: string;
};

type BirthdayAudienceChannel = "whatsapp" | "telegram";

type BirthdayAudienceSelectionParams = {
  channel?: BirthdayAudienceChannel;
  recipientPhones?: string[] | null;
  recipientChatIds?: string[] | null;
  telegramSourceId?: string | null;
};

function normalizeBirthdayAudienceSelection(
  params: BirthdayAudienceSelectionParams
) {
  return {
    channel:
      params.channel === "telegram"
        ? ("telegram" as const)
        : ("whatsapp" as const),
    recipientPhones: Array.isArray(params.recipientPhones)
      ? new Set(
          params.recipientPhones
            .map(normalizePhone)
            .filter((phone): phone is string => Boolean(phone))
        )
      : null,
    recipientChatIds: Array.isArray(params.recipientChatIds)
      ? new Set(
          params.recipientChatIds
            .map(normalizeTelegramSubscriberChatId)
            .filter(isTelegramPrivateSubscriberChatId)
        )
      : null,
    telegramSourceId: params.telegramSourceId?.trim() || "",
  };
}

type BirthdayAudienceSelection = ReturnType<
  typeof normalizeBirthdayAudienceSelection
>;

export type BirthdayAudiencePage = {
  recipients: BirthdayAudienceRecipient[];
  candidateCount: number;
  skippedMarketingOptIn: number;
  nextCursor: string | null;
};

export type BirthdayAudiencePreview = {
  total: number;
  eligibleTotal: number;
  marketingOptInWarningCount: number;
  page: number;
  limit: number;
  items: Array<{
    _id: string;
    recipient: string;
    chat: string;
    birthday: string;
    displayName?: string | null;
  }>;
  birthdayAudience: {
    storedTotal: number;
    scanCapped: boolean;
  };
};

function normalizeBirthdayConfig(value: unknown): CampaignBirthdayConfig {
  const config =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<CampaignBirthdayConfig>)
      : null;
  return {
    version: CAMPAIGN_BIRTHDAY_CONFIG_VERSION,
    leapDayPolicy:
      config?.leapDayPolicy === "feb_28" ? config.leapDayPolicy : "feb_28",
  };
}

function buildBirthdayDateClauses(params: {
  scheduledFor: Date;
  timezone: string;
  config?: unknown;
}) {
  const config = normalizeBirthdayConfig(params.config);
  const local = getZonedBirthdayDateParts({
    date: params.scheduledFor,
    timezone: params.timezone,
  });
  const clauses = [
    {
      "profileDates.birthday.month": local.month,
      "profileDates.birthday.day": local.day,
    },
  ];

  if (
    config.leapDayPolicy === "feb_28" &&
    local.month === 2 &&
    local.day === 28 &&
    !isLeapYear(local.year)
  ) {
    clauses.push({
      "profileDates.birthday.month": 2,
      "profileDates.birthday.day": 29,
    });
  }

  return clauses;
}

function buildBirthdayBaseFilter(params: {
  workspaceId: string;
  channel?: BirthdayAudienceChannel;
  scheduledFor?: Date;
  timezone?: string;
  config?: unknown;
  recipientPhones?: string[] | null;
  recipientChatIds?: string[] | null;
  telegramSourceId?: string | null;
}) {
  const { channel, recipientPhones, recipientChatIds, telegramSourceId } =
    normalizeBirthdayAudienceSelection(params);
  const telegramIdentityValues =
    recipientChatIds &&
    Array.from(recipientChatIds).flatMap(chatId => [
      chatId,
      buildTelegramCompositeChatId(chatId, telegramSourceId),
    ]);
  const identityFilter =
    channel === "telegram"
      ? {
          type: "channel_chat",
          channel: "telegram",
          sourceId: telegramSourceId || "__missing_telegram_source__",
          ...(recipientChatIds
            ? recipientChatIds.size > 0
              ? { normalizedValue: { $in: telegramIdentityValues } }
              : {
                  normalizedValue:
                    "__no_selected_birthday_telegram_recipients__",
                }
            : {}),
        }
      : {
          type: "phone",
          channel: "whatsapp",
          ...(recipientPhones
            ? recipientPhones.size > 0
              ? { normalizedValue: { $in: Array.from(recipientPhones) } }
              : { normalizedValue: "__no_selected_birthday_recipients__" }
            : {}),
        };
  const filter: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    status: "active",
    "profileDates.birthday.month": { $gte: 1, $lte: 12 },
    "profileDates.birthday.day": { $gte: 1, $lte: 31 },
    identities: {
      $elemMatch: identityFilter,
    },
  };

  if (params.scheduledFor) {
    filter.$or = buildBirthdayDateClauses({
      scheduledFor: params.scheduledFor,
      timezone: params.timezone || "UTC",
      config: params.config,
    });
  }

  return filter;
}

function getCustomerId(customer: BirthdayCustomerRecord): string {
  if (customer._id instanceof Types.ObjectId) return customer._id.toHexString();
  return String(customer._id || "").trim();
}

function getCustomerBirthdayLabel(customer: BirthdayCustomerRecord): string {
  const birthday = customer.profileDates?.birthday;
  if (!birthday?.month || !birthday.day) return "";
  const day = String(birthday.day).padStart(2, "0");
  const month = String(birthday.month).padStart(2, "0");
  return birthday.year ? `${birthday.year}-${month}-${day}` : `${month}-${day}`;
}

function getCustomerRecipientIdentifiers(
  customer: BirthdayCustomerRecord,
  selection: BirthdayAudienceSelection
): string[] {
  const identifiers = new Set<string>();
  for (const identity of customer.identities || []) {
    if (selection.channel === "whatsapp") {
      if (identity.type !== "phone" || identity.channel !== "whatsapp")
        continue;
      const phone = normalizePhone(
        identity.normalizedValue || identity.value || ""
      );
      if (
        phone &&
        (!selection.recipientPhones || selection.recipientPhones.has(phone))
      ) {
        identifiers.add(phone);
      }
    } else if (
      selection.telegramSourceId &&
      identity.type === "channel_chat" &&
      identity.channel === "telegram" &&
      String(identity.sourceId || "").trim() === selection.telegramSourceId
    ) {
      const chatId = normalizeTelegramSubscriberChatId(
        identity.normalizedValue || identity.value
      );
      if (
        isTelegramPrivateSubscriberChatId(chatId) &&
        (!selection.recipientChatIds || selection.recipientChatIds.has(chatId))
      ) {
        identifiers.add(chatId);
      }
    }
  }
  return Array.from(identifiers);
}

function collectBirthdayRecipients(
  customers: BirthdayCustomerRecord[],
  selection: BirthdayAudienceSelection
): BirthdayAudienceRecipient[] {
  const byIdentifier = new Map<string, BirthdayAudienceRecipient>();
  for (const customer of customers) {
    for (const identifier of getCustomerRecipientIdentifiers(
      customer,
      selection
    )) {
      if (byIdentifier.has(identifier)) continue;
      const recipient = toBirthdayRecipient(customer, {
        channel: selection.channel,
        telegramSourceId: selection.telegramSourceId,
        identifier,
      });
      if (recipient) byIdentifier.set(identifier, recipient);
    }
  }
  return Array.from(byIdentifier.values());
}

function toBirthdayRecipient(
  customer: BirthdayCustomerRecord,
  params: {
    channel: BirthdayAudienceChannel;
    telegramSourceId: string;
    identifier: string;
  }
): BirthdayAudienceRecipient | null {
  const customerId = getCustomerId(customer);
  const telegramSourceId = params.telegramSourceId;
  const phone = params.channel === "whatsapp" ? params.identifier : null;
  const chatId = params.channel === "telegram" ? params.identifier : null;
  const identifier = params.identifier;
  if (!customerId || !identifier) return null;

  const name =
    normalizeLooseString(customer.displayName) ||
    `Customer ${identifier.slice(-4)}`;
  const birthday = customer.profileDates?.birthday || {};
  const birthdayLabel = getCustomerBirthdayLabel(customer);
  const fields = {
    ...(phone ? { phone } : {}),
    ...(chatId ? { chat_id: chatId } : {}),
    name,
    birthday: birthdayLabel,
    birthday_month: birthday.month ? String(birthday.month) : "",
    birthday_day: birthday.day ? String(birthday.day) : "",
    birthday_year: birthday.year ? String(birthday.year) : "",
    source: "birthday",
  };

  return {
    customerId,
    ...(phone ? { phone } : {}),
    ...(chatId ? { chatId, sourceId: telegramSourceId } : {}),
    name,
    fields,
    variables: {
      ...fields,
      recipientName: name,
      full_name: name,
      first_name: name.split(/\s+/).filter(Boolean)[0] || name,
      ...(phone ? { recipientPhone: phone } : {}),
      ...(chatId ? { recipientChatId: chatId, chat_id: chatId } : {}),
    },
  };
}

async function filterBirthdayRecipientsForMarketing(params: {
  workspaceId: string;
  recipients: BirthdayAudienceRecipient[];
  templateCategory?: string | null;
}): Promise<{
  recipients: BirthdayAudienceRecipient[];
  skippedMarketingOptIn: number;
  marketingOptInWarningCount: number;
}> {
  if (String(params.templateCategory || "").toUpperCase() !== "MARKETING") {
    return {
      recipients: params.recipients,
      skippedMarketingOptIn: 0,
      marketingOptInWarningCount: 0,
    };
  }

  const filtered = await filterKnownMarketingOptOutRecipients({
    workspaceId: params.workspaceId,
    recipients: params.recipients,
  });
  const eligiblePhones = new Set(
    filtered.recipients
      .map(recipient => normalizePhone(recipient.phone || ""))
      .filter(Boolean)
  );
  const recipients = params.recipients.filter(recipient =>
    eligiblePhones.has(normalizePhone(recipient.phone || "") || "")
  );

  return {
    recipients,
    skippedMarketingOptIn: filtered.skippedOptIn,
    marketingOptInWarningCount: filtered.marketingOptInWarningCount,
  };
}

async function filterBirthdayRecipientsForChannel(params: {
  workspaceId: string;
  channel: BirthdayAudienceChannel;
  recipients: BirthdayAudienceRecipient[];
  telegramSourceId?: string | null;
  templateCategory?: string | null;
}): Promise<{
  recipients: BirthdayAudienceRecipient[];
  skippedMarketingOptIn: number;
  marketingOptInWarningCount: number;
}> {
  if (params.channel === "whatsapp") {
    return filterBirthdayRecipientsForMarketing(params);
  }

  const sourceId = params.telegramSourceId?.trim() || "";
  if (!sourceId || params.recipients.length === 0) {
    return {
      recipients: [],
      skippedMarketingOptIn: 0,
      marketingOptInWarningCount: 0,
    };
  }
  const eligible = await findEligibleTelegramSubscriberMap({
    workspaceId: params.workspaceId,
    sourceIds: [sourceId],
    chatIds: params.recipients
      .map(recipient => recipient.chatId || "")
      .filter(Boolean),
  });
  return {
    recipients: params.recipients.filter(recipient => {
      const chatId = normalizeTelegramSubscriberChatId(recipient.chatId || "");
      return Boolean(chatId && eligible.has(`${chatId}:${sourceId}`));
    }),
    skippedMarketingOptIn: 0,
    marketingOptInWarningCount: 0,
  };
}

export async function findBirthdayAudiencePage(params: {
  workspaceId: string;
  channel?: BirthdayAudienceChannel;
  scheduledFor: Date;
  timezone: string;
  birthdayConfig?: unknown;
  templateCategory?: string | null;
  recipientPhones?: string[] | null;
  recipientChatIds?: string[] | null;
  telegramSourceId?: string | null;
  afterId?: string | null;
  limit?: number;
  /** Server-runtime seam: the complete occurrence owns WhatsApp policy once. */
  deferMarketingPolicy?: boolean;
}): Promise<BirthdayAudiencePage> {
  await connectDB();
  await ensureCustomerBirthdayIndexes().catch(error => {
    console.warn("[Campaign birthday audience] Index ensure failed", error);
  });

  const channel = params.channel === "telegram" ? "telegram" : "whatsapp";
  const pageSize = Math.max(
    1,
    Math.min(1000, Math.floor(params.limit || DEFAULT_PAGE_SIZE))
  );
  const filter = buildBirthdayBaseFilter({
    workspaceId: params.workspaceId,
    channel,
    scheduledFor: params.scheduledFor,
    timezone: params.timezone,
    config: params.birthdayConfig,
    recipientPhones: params.recipientPhones,
    recipientChatIds: params.recipientChatIds,
    telegramSourceId: params.telegramSourceId,
  });
  if (params.afterId && Types.ObjectId.isValid(params.afterId)) {
    filter._id = { $gt: new Types.ObjectId(params.afterId) };
  }

  const customers = (await Customer.find(filter)
    .sort({ _id: 1 })
    .limit(pageSize)
    .select("displayName identities profileSummary profileDates")
    .lean()) as BirthdayCustomerRecord[];

  const candidates = collectBirthdayRecipients(
    customers,
    normalizeBirthdayAudienceSelection(params)
  );
  const marketing =
    channel === "whatsapp" && params.deferMarketingPolicy === true
      ? { recipients: candidates, skippedMarketingOptIn: 0 }
      : await filterBirthdayRecipientsForChannel({
          workspaceId: params.workspaceId,
          channel,
          recipients: candidates,
          templateCategory: params.templateCategory,
          telegramSourceId: params.telegramSourceId,
        });
  const lastId =
    customers.length > 0 ? getCustomerId(customers[customers.length - 1]) : "";

  return {
    recipients: marketing.recipients,
    candidateCount: candidates.length,
    skippedMarketingOptIn: marketing.skippedMarketingOptIn,
    nextCursor: customers.length >= pageSize && lastId ? lastId : null,
  };
}

export async function buildBirthdayAudiencePreview(params: {
  workspaceId: string;
  channel?: BirthdayAudienceChannel;
  scheduledFor: Date;
  timezone: string;
  birthdayConfig?: unknown;
  templateCategory?: string | null;
  recipientPhones?: string[] | null;
  recipientChatIds?: string[] | null;
  telegramSourceId?: string | null;
  page?: number;
  limit?: number;
}): Promise<BirthdayAudiencePreview> {
  await connectDB();
  const channel = params.channel === "telegram" ? "telegram" : "whatsapp";
  const page = Math.max(1, Math.floor(params.page || 1));
  const limit = Math.max(1, Math.min(50, Math.floor(params.limit || 20)));
  const birthdayFilter = buildBirthdayBaseFilter({
    workspaceId: params.workspaceId,
    channel,
    scheduledFor: params.scheduledFor,
    timezone: params.timezone,
    config: params.birthdayConfig,
    recipientPhones: params.recipientPhones,
    recipientChatIds: params.recipientChatIds,
    telegramSourceId: params.telegramSourceId,
  });
  const storedFilter = buildBirthdayBaseFilter({
    workspaceId: params.workspaceId,
    channel,
    recipientPhones: params.recipientPhones,
    recipientChatIds: params.recipientChatIds,
    telegramSourceId: params.telegramSourceId,
  });

  const [storedTotal, matchingCustomerCount, scannedCustomers] =
    await Promise.all([
      Customer.countDocuments(storedFilter),
      Customer.countDocuments(birthdayFilter),
      Customer.find(birthdayFilter)
        .sort({ _id: 1 })
        .limit(MAX_PREVIEW_SCAN)
        .select("displayName identities profileSummary profileDates")
        .lean<BirthdayCustomerRecord[]>(),
    ]);

  const scannedRecipients = collectBirthdayRecipients(
    scannedCustomers,
    normalizeBirthdayAudienceSelection(params)
  );
  const marketing = await filterBirthdayRecipientsForChannel({
    workspaceId: params.workspaceId,
    channel,
    recipients: scannedRecipients,
    templateCategory: params.templateCategory,
    telegramSourceId: params.telegramSourceId,
  });

  const customersById = new Map(
    scannedCustomers.map(customer => [getCustomerId(customer), customer])
  );
  const items = marketing.recipients
    .slice((page - 1) * limit, page * limit)
    .map(recipient => {
      const customer = customersById.get(recipient.customerId);
      if (!customer) return null;
      const identifier = recipient.phone || recipient.chatId;
      if (!identifier) return null;
      return {
        _id: recipient.customerId,
        recipient: identifier,
        chat: identifier,
        birthday: getCustomerBirthdayLabel(customer),
        displayName: normalizeLooseString(customer.displayName),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return {
    total: scannedRecipients.length,
    eligibleTotal: marketing.recipients.length,
    marketingOptInWarningCount: marketing.marketingOptInWarningCount,
    page,
    limit,
    items,
    birthdayAudience: {
      storedTotal,
      scanCapped: matchingCustomerCount > MAX_PREVIEW_SCAN,
    },
  };
}
