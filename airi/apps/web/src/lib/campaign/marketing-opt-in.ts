import { normalizeCampaignPhone } from "@/lib/campaign/campaign-recipient-utils";
import connectDB from "@/lib/mongoose";
import { resolveWhatsAppConversationIdentityCandidates } from "@/lib/whatsapp/conversation-lookup";
import { WHATSAPP_MARKETING_CONSENT_SOURCES } from "@icecore/whatsapp/marketingConsent";
import { Conversation } from "@/models/conversation";
import { resolveStoredWhatsAppRecipientTarget } from "@icecore/shared/lib/whatsapp/contact-identities";
import type { BulkCampaignRecipient } from "./bulk-campaign-contracts";

const recordedMarketingConsentSources = new Set<string>(
  WHATSAPP_MARKETING_CONSENT_SOURCES
);
const MARKETING_CONSENT_LOOKUP_CHUNK_SIZE = 500;

export type MarketingConsentFilterResult = {
  recipients: BulkCampaignRecipient[];
  skippedRecipients: BulkCampaignRecipient[];
  skippedOptIn: number;
  skippedPhones: string[];
  marketingOptInWarningRecipients: BulkCampaignRecipient[];
  marketingOptInWarningCount: number;
  marketingOptInWarningPhones: string[];
};

type RecordedMarketingConsent = {
  status: boolean;
  updatedAtMs: number | null;
};

type MarketingConsentConversationRow = {
  chat?: unknown;
  user?: unknown;
  whatsapp_opt_in?: {
    source?: string | null;
    status?: boolean | null;
    updatedAt?: Date | string | null;
  };
};

function shouldReplaceRecordedConsent(
  current: RecordedMarketingConsent | undefined,
  candidate: RecordedMarketingConsent
): boolean {
  if (!current) return true;
  if (candidate.updatedAtMs !== null && current.updatedAtMs === null) {
    return true;
  }
  if (candidate.updatedAtMs === null && current.updatedAtMs !== null) {
    return false;
  }
  if (
    candidate.updatedAtMs !== null &&
    current.updatedAtMs !== null &&
    candidate.updatedAtMs !== current.updatedAtMs
  ) {
    return candidate.updatedAtMs > current.updatedAtMs;
  }

  // A withdrawal wins when duplicate records carry the same or no timestamp.
  return current.status === true && candidate.status === false;
}

export async function filterKnownMarketingOptOutRecipients(params: {
  workspaceId: string;
  recipients: BulkCampaignRecipient[];
}): Promise<MarketingConsentFilterResult> {
  const requestedPhones = new Set(
    params.recipients
      .map(recipient => normalizeCampaignPhone(recipient.phone || ""))
      .filter(Boolean)
  );
  if (requestedPhones.size === 0) {
    return {
      recipients: [],
      skippedRecipients: params.recipients,
      skippedOptIn: params.recipients.length,
      skippedPhones: [],
      marketingOptInWarningRecipients: [],
      marketingOptInWarningCount: 0,
      marketingOptInWarningPhones: [],
    };
  }

  await connectDB();
  const conversations: MarketingConsentConversationRow[] = [];
  const requestedPhoneList = Array.from(requestedPhones);
  const identityCandidates = Array.from(
    requestedPhoneList.reduce((candidates, phone) => {
      for (const identity of resolveWhatsAppConversationIdentityCandidates(
        phone
      )) {
        candidates.add(identity);
        if (/^\d+$/.test(identity)) {
          const numeric = Number(identity);
          if (Number.isSafeInteger(numeric)) {
            candidates.add(numeric);
          }
        }
      }
      return candidates;
    }, new Set<string | number>())
  );
  for (
    let offset = 0;
    offset < identityCandidates.length;
    offset += MARKETING_CONSENT_LOOKUP_CHUNK_SIZE
  ) {
    const identityChunk = identityCandidates.slice(
      offset,
      offset + MARKETING_CONSENT_LOOKUP_CHUNK_SIZE
    );
    const phoneIdentityChunk = Array.from(
      new Set(
        identityChunk
          .map(value => String(value).replace(/^wa_/, ""))
          .filter(value => /^\d+$/.test(value))
      )
    );

    const chunkRows = await Conversation.find({
      workspaceId: params.workspaceId,
      channel: "whatsapp",
      $or: [
        { chat: { $in: identityChunk } },
        { user: { $in: identityChunk } },
        { "user._id": { $in: identityChunk } },
        { "user.whatsapp.waId": { $in: phoneIdentityChunk } },
        { "chat.whatsapp.waId": { $in: phoneIdentityChunk } },
      ],
    })
      .select("chat user whatsapp_opt_in")
      .lean<MarketingConsentConversationRow[]>();
    conversations.push(...chunkRows);
  }

  const latestRecordedConsentByPhone = new Map<
    string,
    RecordedMarketingConsent
  >();
  for (const conversation of conversations) {
    const consent = conversation.whatsapp_opt_in;
    if (
      typeof consent?.status !== "boolean" ||
      !recordedMarketingConsentSources.has(consent.source || "")
    ) {
      continue;
    }

    for (const source of [conversation.user, conversation.chat]) {
      const target = resolveStoredWhatsAppRecipientTarget(source);
      if (target?.kind !== "phone") continue;

      const phone = normalizeCampaignPhone(target.value);
      if (!phone || !requestedPhones.has(phone)) continue;

      const parsedUpdatedAt = new Date(consent.updatedAt || "").getTime();
      const candidate: RecordedMarketingConsent = {
        status: consent.status,
        updatedAtMs: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : null,
      };
      const current = latestRecordedConsentByPhone.get(phone);
      if (shouldReplaceRecordedConsent(current, candidate)) {
        latestRecordedConsentByPhone.set(phone, candidate);
      }
    }
  }

  const skippedRecipients: BulkCampaignRecipient[] = [];
  const recipients: BulkCampaignRecipient[] = [];
  for (const recipient of params.recipients) {
    const phone = normalizeCampaignPhone(recipient.phone || "");
    const recordedConsent = phone
      ? latestRecordedConsentByPhone.get(phone)
      : undefined;
    if (!phone || recordedConsent?.status === false) {
      skippedRecipients.push(recipient);
    } else {
      recipients.push(recipient);
    }
  }
  const skippedPhones = Array.from(requestedPhones).filter(
    phone => latestRecordedConsentByPhone.get(phone)?.status === false
  );
  const marketingOptInWarningRecipients = recipients.filter(recipient => {
    const phone = normalizeCampaignPhone(recipient.phone || "");
    return Boolean(
      phone && latestRecordedConsentByPhone.get(phone)?.status !== true
    );
  });
  const marketingOptInWarningPhones = Array.from(requestedPhones).filter(
    phone => !latestRecordedConsentByPhone.has(phone)
  );

  return {
    recipients,
    skippedRecipients,
    skippedOptIn: skippedRecipients.length,
    skippedPhones,
    marketingOptInWarningRecipients,
    marketingOptInWarningCount: marketingOptInWarningRecipients.length,
    marketingOptInWarningPhones,
  };
}
