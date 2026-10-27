import "server-only";

import type { CampaignBirthdayImportResult } from "@icecore/scenario-contracts";
import { Types } from "mongoose";

import connectDB from "@/lib/mongoose";
import Customer, { ensureCustomerBirthdayIndexes } from "@/models/customer";
import { buildTelegramCompositeChatId } from "@/lib/telegram/chat-id";
import {
  findEligibleTelegramSubscriberMap,
  isTelegramPrivateSubscriberChatId,
  normalizeTelegramSubscriberChatId,
} from "@/lib/telegram/subscribers";

import {
  buildCustomerBirthdayValue,
  isCustomerBirthdayFieldName,
  type NormalizedCustomerBirthday,
} from "./customer-birthday";
import { normalizeLooseString, normalizePhone } from "./shared";
import { withBirthdayWorkspaceTransaction } from "./customer-birthday-transaction";

type BirthdayImportRecipient = {
  phone?: string;
  chatId?: string;
  sourceId?: string | null;
  name?: string;
  birthday?: string;
  fields?: Record<string, string>;
};

type CustomerIdentityInput = {
  type: string;
  channel: string;
  value: string;
  normalizedValue: string;
  sourceId?: string | null;
  label?: string | null;
  linkedAt?: Date;
  linkedBy?: string | null;
  linkMethod?: "system" | "backfill" | "manual" | "suggested" | "rule";
  linkConfidence?: number | null;
};

type BirthdayImportCustomer = {
  _id?: Types.ObjectId;
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
  profileDates?: {
    birthday?: NormalizedCustomerBirthday | null;
  } | null;
  save?: () => Promise<unknown>;
};

const BIRTHDAY_IMPORT_BATCH_SIZE = 500;

export type ImportCustomerBirthdaysResult = CampaignBirthdayImportResult;

function compactUnique(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map(value => normalizeLooseString(value)).filter(Boolean))
  ) as string[];
}

function resolveBirthdayRaw(recipient: BirthdayImportRecipient): unknown {
  if (recipient.birthday) return recipient.birthday;
  for (const [key, value] of Object.entries(recipient.fields || {})) {
    if (isCustomerBirthdayFieldName(key)) return value;
  }
  return "";
}

function mergeIdentities(params: {
  existing?: CustomerIdentityInput[];
  identity: Pick<
    CustomerIdentityInput,
    "type" | "channel" | "sourceId" | "value" | "normalizedValue" | "label"
  >;
  now: Date;
}): CustomerIdentityInput[] {
  const byKey = new Map<string, CustomerIdentityInput>();
  for (const identity of params.existing || []) {
    byKey.set(
      `${identity.type}:${identity.channel}:${identity.sourceId || ""}:${identity.normalizedValue}`,
      identity
    );
  }
  const key = `${params.identity.type}:${params.identity.channel}:${params.identity.sourceId || ""}:${params.identity.normalizedValue}`;
  byKey.set(key, {
    ...byKey.get(key),
    ...params.identity,
    linkedAt: params.now,
    linkMethod: "manual",
    linkConfidence: 1,
  });
  return Array.from(byKey.values());
}

function buildProfileSummary(params: {
  existing?: BirthdayImportCustomer["profileSummary"];
  channel: "whatsapp" | "telegram";
  phone?: string;
}) {
  const existing = params.existing || {};
  const contactPoints = existing.contactPoints || {};
  return {
    ...existing,
    channels: compactUnique([...(existing.channels || []), params.channel]),
    tags: existing.tags || [],
    contactPoints: {
      emails: contactPoints.emails || [],
      phones: compactUnique([...(contactPoints.phones || []), params.phone]),
      usernames: contactPoints.usernames || [],
      visitorIds: contactPoints.visitorIds || [],
      whatsappUserIds: contactPoints.whatsappUserIds || [],
      whatsappParentUserIds: contactPoints.whatsappParentUserIds || [],
    },
    conversationCount: existing.conversationCount || 0,
  };
}

function buildDisplayName(
  recipient: BirthdayImportRecipient,
  identifier: string
) {
  return (
    normalizeLooseString(recipient.name) ||
    normalizeLooseString(recipient.fields?.name) ||
    normalizeLooseString(recipient.fields?.full_name) ||
    normalizeLooseString(recipient.fields?.customer_name) ||
    `Customer ${identifier.slice(-4)}`
  );
}

export async function importCustomerBirthdays(params: {
  workspaceId: string;
  recipients: BirthdayImportRecipient[];
  channel?: "whatsapp" | "telegram";
  sourceId?: string | null;
  now?: Date;
}): Promise<ImportCustomerBirthdaysResult> {
  const now = params.now || new Date();
  const channel = params.channel === "telegram" ? "telegram" : "whatsapp";
  const telegramSourceId = params.sourceId?.trim() || "";
  if (channel === "telegram" && !telegramSourceId) {
    throw new Error("Telegram source is required for birthday imports");
  }
  const result: ImportCustomerBirthdaysResult = {
    total: params.recipients.length,
    imported: 0,
    updated: 0,
    skippedMissingPhone: 0,
    skippedMissingChatId: 0,
    skippedIneligibleTelegramSubscriber: 0,
    skippedMissingBirthday: 0,
    skippedInvalidBirthday: 0,
  };

  if (params.recipients.length === 0) {
    return result;
  }

  await connectDB();
  await ensureCustomerBirthdayIndexes().catch(error => {
    console.warn("[Customer birthday import] Index ensure failed", error);
  });

  const telegramChatIds =
    channel === "telegram"
      ? Array.from(
          new Set(
            params.recipients
              .map(recipient =>
                normalizeTelegramSubscriberChatId(recipient.chatId)
              )
              .filter(isTelegramPrivateSubscriberChatId)
          )
        )
      : [];
  const eligibleTelegramSubscribers =
    channel === "telegram"
      ? await findEligibleTelegramSubscriberMap({
          workspaceId: params.workspaceId,
          sourceIds: [telegramSourceId],
          chatIds: telegramChatIds,
        })
      : new Map();

  const prepared: Array<{
    recipient: BirthdayImportRecipient;
    identifier: string;
    identity: CustomerIdentityInput;
    seedKey: string;
    birthday: NormalizedCustomerBirthday;
  }> = [];
  for (const recipient of params.recipients) {
    const phone = normalizePhone(recipient.phone || "");
    const chatId = normalizeTelegramSubscriberChatId(recipient.chatId);
    if (channel === "whatsapp" && !phone) {
      result.skippedMissingPhone += 1;
      continue;
    }
    if (
      channel === "telegram" &&
      (!chatId || !isTelegramPrivateSubscriberChatId(chatId))
    ) {
      result.skippedMissingChatId += 1;
      continue;
    }
    if (
      channel === "telegram" &&
      !eligibleTelegramSubscribers.has(`${chatId}:${telegramSourceId}`)
    ) {
      result.skippedIneligibleTelegramSubscriber += 1;
      continue;
    }

    const birthdayRaw = resolveBirthdayRaw(recipient);
    if (!birthdayRaw) {
      result.skippedMissingBirthday += 1;
      continue;
    }

    const birthday = buildCustomerBirthdayValue({
      value: birthdayRaw,
      source: "csv",
      now,
    });
    if (!birthday) {
      result.skippedInvalidBirthday += 1;
      continue;
    }

    const identifier = channel === "telegram" ? chatId : phone;
    if (!identifier) continue;
    const identity: CustomerIdentityInput =
      channel === "telegram"
        ? {
            type: "channel_chat",
            channel,
            sourceId: telegramSourceId,
            value: identifier,
            normalizedValue: identifier,
            label: "Birthday import Telegram chat",
          }
        : {
            type: "phone",
            channel,
            sourceId: null,
            value: identifier,
            normalizedValue: identifier,
            label: "Birthday import phone",
          };
    const seedKey =
      channel === "telegram"
        ? `birthday_import:telegram:${telegramSourceId}:${identifier}`
        : `birthday_import:${identifier}`;
    prepared.push({ recipient, identifier, identity, seedKey, birthday });
  }

  if (prepared.length === 0) return result;
  let persistedResult = { ...result };
  // Bound transaction lifetime as well as customer round trips. Committed
  // batches survive a later failure and a retry merges them through the same
  // canonical identity lookup; the workspace fence prevents duplicate creates.
  for (
    let offset = 0;
    offset < prepared.length;
    offset += BIRTHDAY_IMPORT_BATCH_SIZE
  ) {
    const batch = prepared.slice(offset, offset + BIRTHDAY_IMPORT_BATCH_SIZE);
    persistedResult = await withBirthdayWorkspaceTransaction(
      params.workspaceId,
      async session => {
        // Mongo may repeat this batch, so counters advance only after its commit.
        const batchResult = { ...persistedResult };
        const identifiers = new Set(batch.map(row => row.identifier));
        const customers = await Customer.find({
          workspaceId: params.workspaceId,
          identities: {
            $elemMatch:
              channel === "telegram"
                ? {
                    type: "channel_chat",
                    channel,
                    sourceId: telegramSourceId,
                    normalizedValue: {
                      $in: Array.from(identifiers).flatMap(identifier => [
                        identifier,
                        buildTelegramCompositeChatId(
                          identifier,
                          telegramSourceId
                        ),
                      ]),
                    },
                  }
                : {
                    type: "phone",
                    channel,
                    normalizedValue: { $in: Array.from(identifiers) },
                  },
          },
        })
          .session(session)
          .sort({ _id: 1 })
          .lean<BirthdayImportCustomer[]>();
        const byIdentifier = new Map<string, BirthdayImportCustomer>();
        for (const customer of customers) {
          for (const identity of customer.identities || []) {
            if (
              identity.channel !== channel ||
              identity.type !==
                (channel === "telegram" ? "channel_chat" : "phone")
            )
              continue;
            if (
              channel === "telegram" &&
              identity.sourceId !== telegramSourceId
            )
              continue;
            const identifier =
              channel === "telegram"
                ? normalizeTelegramSubscriberChatId(
                    identity.normalizedValue || identity.value
                  )
                : normalizePhone(identity.normalizedValue || identity.value);
            if (
              identifier &&
              identifiers.has(identifier) &&
              !byIdentifier.has(identifier)
            ) {
              byIdentifier.set(identifier, customer);
            }
          }
        }
        const changed = new Map<
          string,
          { customer: BirthdayImportCustomer; isNew: boolean }
        >();
        for (const {
          recipient,
          identifier,
          identity,
          seedKey,
          birthday,
        } of batch) {
          const existing = byIdentifier.get(identifier);
          if (!existing) {
            const customer = {
              _id: new Types.ObjectId(),
              workspaceId: params.workspaceId,
              status: "active",
              displayName: buildDisplayName(recipient, identifier),
              primaryConversationId: null,
              conversationIds: [],
              seedKeys: [seedKey],
              identities: mergeIdentities({ identity, now }),
              profileSummary: buildProfileSummary({
                channel,
                ...(channel === "whatsapp" ? { phone: identifier } : {}),
              }),
              profileDates: { birthday },
              currentFunnelStage: null,
              lastInteractionAt: null,
            };
            byIdentifier.set(identifier, customer);
            changed.set(String(customer._id), { customer, isNew: true });
            batchResult.imported += 1;
            continue;
          }

          existing.status = "active";
          existing.displayName =
            normalizeLooseString(existing.displayName) ||
            buildDisplayName(recipient, identifier);
          existing.seedKeys = compactUnique([
            ...(existing.seedKeys || []),
            seedKey,
          ]);
          existing.identities = mergeIdentities({
            existing: existing.identities,
            identity,
            now,
          });
          existing.profileSummary = buildProfileSummary({
            existing: existing.profileSummary,
            channel,
            ...(channel === "whatsapp" ? { phone: identifier } : {}),
          });
          existing.profileDates = {
            ...(existing.profileDates || {}),
            birthday,
          };
          if (!existing._id)
            throw new Error("Birthday import customer has no identity");
          if (!changed.has(String(existing._id))) {
            changed.set(String(existing._id), {
              customer: existing,
              isNew: false,
            });
          }
          batchResult.updated += 1;
        }
        await Customer.bulkWrite(
          Array.from(changed.values()).map(({ customer, isNew }) =>
            isNew
              ? { insertOne: { document: new Customer(customer).toObject() } }
              : {
                  updateOne: {
                    filter: {
                      _id: customer._id,
                      workspaceId: params.workspaceId,
                    },
                    update: {
                      $set: {
                        status: customer.status,
                        displayName: customer.displayName,
                        seedKeys: customer.seedKeys,
                        identities: customer.identities,
                        profileSummary: customer.profileSummary,
                        profileDates: customer.profileDates,
                      },
                    },
                  },
                }
          ),
          { ordered: true, session }
        );

        return batchResult;
      }
    );
  }
  return persistedResult;
}
