import { Conversation } from "@/models/conversation";
import type { ConversationDocument } from "@/types/models";
import {
  createWhatsAppConversationOwnership,
  buildWhatsAppConversationSourceScopes,
  resolveWhatsAppConversationIdentityCandidates,
  type GetOrCreateWhatsAppConversationParams,
} from "@icecore/airi-runtime/whatsapp-conversation-ownership";
export {
  buildWhatsAppConversationIdentityKey,
  normalizeWhatsAppConversationPhoneCandidate,
  resolveWhatsAppConversationIdentityCandidates,
  type GetOrCreateWhatsAppConversationParams,
} from "@icecore/airi-runtime/whatsapp-conversation-ownership";
const ownership = createWhatsAppConversationOwnership(Conversation);
export function getOrCreateWhatsAppConversation<T = ConversationDocument>(
  params: GetOrCreateWhatsAppConversationParams<T>
) {
  return ownership.getOrCreateWhatsAppConversation(params);
}
type WhatsAppConversationIdentityField = "chat" | "user";

async function findLatestWhatsAppConversationByIdentity(params: {
  workspaceId: string;
  sourceId: string | null;
  candidateIds: string[];
  field: WhatsAppConversationIdentityField;
}) {
  return ownership.findLegacyWhatsAppConversation<ConversationDocument>(params);
}

export async function findExistingWhatsAppConversationByIdentity(params: {
  workspaceId: string;
  sourceId?: string | null;
  candidateIds: string[];
}) {
  const candidateIds = Array.from(
    new Set(params.candidateIds.map(value => String(value || "").trim()))
  ).filter(Boolean);
  if (candidateIds.length === 0) return null;

  for (const sourceId of buildWhatsAppConversationSourceScopes(
    params.sourceId
  )) {
    const owner =
      await ownership.findOwnedWhatsAppConversation<ConversationDocument>({
        workspaceId: params.workspaceId,
        sourceId,
        chatId: candidateIds[0],
        candidateIds,
      });
    if (owner) return owner;
    for (const field of ["chat", "user"] as const) {
      const matched = await findLatestWhatsAppConversationByIdentity({
        workspaceId: params.workspaceId,
        sourceId,
        candidateIds,
        field,
      });
      if (matched) return matched;
    }
  }

  return null;
}

export async function findExistingWhatsAppConversationForRecipient(params: {
  workspaceId: string;
  sourceId?: string | null;
  recipient: string;
}) {
  return findExistingWhatsAppConversationByIdentity({
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
    candidateIds: resolveWhatsAppConversationIdentityCandidates(
      params.recipient
    ),
  });
}
