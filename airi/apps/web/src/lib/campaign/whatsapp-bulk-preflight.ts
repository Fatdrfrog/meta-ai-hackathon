import { normalizeCampaignPhone } from "@/lib/campaign/campaign-recipient-utils";
import { META_MESSAGING_WINDOW_MS } from "@/lib/messaging-window-utils";
import connectDB from "@/lib/mongoose";
import { resolveWhatsAppConversationIdentityCandidates } from "@/lib/whatsapp/conversation-lookup";
import { Conversation } from "@/models/conversation";
import { resolveStoredWhatsAppRecipientTarget } from "@icecore/shared/lib/whatsapp/contact-identities";

const WHATSAPP_HISTORY_LOOKUP_CHUNK_SIZE = 500;

type WhatsAppConversationIdentityRow = {
  chat?: unknown;
  user?: unknown;
  last_inbound_at?: unknown;
};

export type WhatsAppConversationHistoryEligibility = {
  eligiblePhones: string[];
  skippedPhones: string[];
};

export type WhatsAppServiceWindowEligibility = {
  eligiblePhones: string[];
  skippedPhones: string[];
  windowExpiresAtByPhone: Record<string, string>;
};

function normalizeRequestedPhones(phones: string[]): string[] {
  return Array.from(
    new Set(phones.map(normalizeCampaignPhone).filter(Boolean))
  );
}

function resolveConversationPhone(
  conversation: WhatsAppConversationIdentityRow,
  requestedPhoneSet: Set<string>
): string | null {
  for (const identity of [conversation.chat, conversation.user]) {
    const target = resolveStoredWhatsAppRecipientTarget(identity);
    if (target?.kind !== "phone") continue;
    const phone = normalizeCampaignPhone(target.value);
    if (phone && requestedPhoneSet.has(phone)) return phone;
  }
  return null;
}

async function findWhatsAppConversations(params: {
  workspaceId: string;
  sourceId: string;
  requestedPhones: string[];
  select: string;
}): Promise<WhatsAppConversationIdentityRow[]> {
  const identityCandidates = Array.from(
    new Set(
      params.requestedPhones.flatMap(phone =>
        resolveWhatsAppConversationIdentityCandidates(phone)
      )
    )
  );
  const conversations: WhatsAppConversationIdentityRow[] = [];

  await connectDB();
  for (
    let offset = 0;
    offset < identityCandidates.length;
    offset += WHATSAPP_HISTORY_LOOKUP_CHUNK_SIZE
  ) {
    const candidateChunk = identityCandidates.slice(
      offset,
      offset + WHATSAPP_HISTORY_LOOKUP_CHUNK_SIZE
    );
    const rows = await Conversation.find({
      workspaceId: params.workspaceId,
      channel: "whatsapp",
      sourceId: params.sourceId,
      $or: [
        { chat: { $in: candidateChunk } },
        { user: { $in: candidateChunk } },
      ],
    })
      .select(params.select)
      .lean<WhatsAppConversationIdentityRow[]>();
    conversations.push(...rows);
  }

  return conversations;
}

export async function resolveWhatsAppConversationHistoryEligibility(params: {
  workspaceId: string;
  sourceId: string;
  phones: string[];
}): Promise<WhatsAppConversationHistoryEligibility> {
  const requestedPhones = normalizeRequestedPhones(params.phones);
  if (requestedPhones.length === 0) {
    return { eligiblePhones: [], skippedPhones: [] };
  }

  const sourceId = params.sourceId.trim();
  if (!sourceId) {
    return { eligiblePhones: [], skippedPhones: requestedPhones };
  }

  const requestedPhoneSet = new Set(requestedPhones);
  const foundPhones = new Set<string>();
  const conversations = await findWhatsAppConversations({
    workspaceId: params.workspaceId,
    sourceId,
    requestedPhones,
    select: "chat user",
  });

  for (const conversation of conversations) {
    const phone = resolveConversationPhone(conversation, requestedPhoneSet);
    if (phone) foundPhones.add(phone);
  }

  return {
    eligiblePhones: requestedPhones.filter(phone => foundPhones.has(phone)),
    skippedPhones: requestedPhones.filter(phone => !foundPhones.has(phone)),
  };
}

export async function resolveWhatsAppServiceWindowEligibility(params: {
  workspaceId: string;
  sourceId: string;
  phones: string[];
  now?: Date;
}): Promise<WhatsAppServiceWindowEligibility> {
  const requestedPhones = normalizeRequestedPhones(params.phones);
  const emptyResult = {
    eligiblePhones: [],
    skippedPhones: requestedPhones,
    windowExpiresAtByPhone: {},
  };
  if (requestedPhones.length === 0) return emptyResult;

  const sourceId = params.sourceId.trim();
  if (!sourceId) return emptyResult;

  const nowMs = (params.now || new Date()).getTime();
  const requestedPhoneSet = new Set(requestedPhones);
  const latestInboundByPhone = new Map<string, number>();
  const conversations = await findWhatsAppConversations({
    workspaceId: params.workspaceId,
    sourceId,
    requestedPhones,
    select: "chat user last_inbound_at",
  });

  for (const conversation of conversations) {
    const phone = resolveConversationPhone(conversation, requestedPhoneSet);
    if (!phone) continue;
    const inboundMs = new Date(
      conversation.last_inbound_at as string | number | Date
    ).getTime();
    if (!Number.isFinite(inboundMs)) continue;
    const previousInboundMs = latestInboundByPhone.get(phone) || 0;
    if (inboundMs > previousInboundMs) {
      latestInboundByPhone.set(phone, inboundMs);
    }
  }

  const windowExpiresAtByPhone: Record<string, string> = {};
  const eligiblePhones = requestedPhones.filter(phone => {
    const inboundMs = latestInboundByPhone.get(phone);
    if (!inboundMs) return false;
    const expiresAtMs = inboundMs + META_MESSAGING_WINDOW_MS;
    if (expiresAtMs <= nowMs) return false;
    windowExpiresAtByPhone[phone] = new Date(expiresAtMs).toISOString();
    return true;
  });
  const eligiblePhoneSet = new Set(eligiblePhones);

  return {
    eligiblePhones,
    skippedPhones: requestedPhones.filter(
      phone => !eligiblePhoneSet.has(phone)
    ),
    windowExpiresAtByPhone,
  };
}
