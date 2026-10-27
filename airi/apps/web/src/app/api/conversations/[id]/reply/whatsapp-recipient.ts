import User from "@/models/user";
import { resolveStoredWhatsAppRecipientTarget } from "@icecore/shared/lib/whatsapp/contact-identities";
import { isRecord } from "@icecore/shared/lib/value-utils";

export type WhatsAppRecipientUser = {
  _id?: unknown;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  whatsapp?: {
    waId?: string | null;
    userId?: string | null;
    parentUserId?: string | null;
    username?: string | null;
    profileName?: string | null;
  } | null;
};

/**
 * Where a manager send for this conversation goes: the customer's stored
 * WhatsApp identity (the populated user, else one lookup), then the chat.
 * Shared by reply, send-template and whatsapp-edit-message.
 */
export async function resolveConversationWhatsAppRecipient(conversation: {
  user?: unknown;
  chat?: unknown;
}) {
  const recipientUser: WhatsAppRecipientUser | null =
    isRecord(conversation.user) && "_id" in conversation.user
      ? (conversation.user as WhatsAppRecipientUser)
      : conversation.user
        ? await User.findById(conversation.user)
            .select("_id firstName lastName username whatsapp")
            .lean<WhatsAppRecipientUser>()
            .catch(() => null)
        : null;

  return {
    recipientUser,
    recipientTarget: resolveStoredWhatsAppRecipientTarget(
      recipientUser,
      conversation.user,
      conversation.chat
    ),
  };
}
