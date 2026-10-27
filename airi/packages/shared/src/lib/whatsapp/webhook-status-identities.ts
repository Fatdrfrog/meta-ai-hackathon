import { compactWhatsAppString } from "./value-utils";
import {
  normalizeWhatsAppWebhookContact,
  type WhatsAppWebhookContactLike,
} from "./webhook-direction";
import {
  isWhatsAppPhoneLike,
  normalizeWhatsAppBsuidOrNull,
  normalizeWhatsAppPhoneOrNull,
  sameWhatsAppIdentifier,
  type WhatsAppNormalizedContact,
} from "./contact-identities";

type WhatsAppStatusIdentityLike = {
  recipient_id?: string | null;
  recipient_user_id?: string | null;
  recipient_parent_user_id?: string | null;
  recipient_type?: string | null;
  recipient_participant_id?: string | null;
  profile?: {
    name?: string;
    username?: string;
  } | null;
};

export type WhatsAppStatusRecipientIdentity = {
  recipientId: string | null;
  recipientWaId: string | null;
  recipientUserId: string | null;
  recipientParentUserId: string | null;
  recipientUsername: string | null;
  contact: WhatsAppNormalizedContact | null;
};

function contactMatchesIdentifier(
  contact: WhatsAppWebhookContactLike | null | undefined,
  identifier: string | null,
): boolean {
  if (!contact || !identifier) return false;
  return (
    sameWhatsAppIdentifier(contact.wa_id, identifier) ||
    sameWhatsAppIdentifier(contact.user_id, identifier) ||
    sameWhatsAppIdentifier(contact.parent_user_id, identifier)
  );
}

export function findWhatsAppWebhookContactByIdentifier(
  contacts: WhatsAppWebhookContactLike[] | null | undefined,
  identifier: string | null,
): WhatsAppWebhookContactLike | null {
  if (!identifier || !Array.isArray(contacts)) {
    return null;
  }
  return (
    contacts.find((contact) => contactMatchesIdentifier(contact, identifier)) ||
    null
  );
}

export function resolveWhatsAppStatusRecipientIdentity(params: {
  status: WhatsAppStatusIdentityLike;
  contacts?: WhatsAppWebhookContactLike[] | null;
}): WhatsAppStatusRecipientIdentity {
  const recipientId = compactWhatsAppString(params.status.recipient_id);
  const recipientUserId = compactWhatsAppString(
    params.status.recipient_user_id,
  );
  const recipientParentUserId = compactWhatsAppString(
    params.status.recipient_parent_user_id,
  );
  const recipientType = compactWhatsAppString(params.status.recipient_type);
  const recipientParticipantId = compactWhatsAppString(
    params.status.recipient_participant_id,
  );
  const isGroupRecipient = recipientType === "group";
  const participantIdentifier = isGroupRecipient
    ? recipientParticipantId
    : null;
  const statusRecipientIdentifier =
    recipientId || recipientUserId || recipientParentUserId;
  const contactLookupIdentifier =
    participantIdentifier || statusRecipientIdentifier;
  const matchedContact =
    findWhatsAppWebhookContactByIdentifier(
      params.contacts,
      participantIdentifier,
    ) ||
    findWhatsAppWebhookContactByIdentifier(params.contacts, recipientId) ||
    findWhatsAppWebhookContactByIdentifier(params.contacts, recipientUserId) ||
    findWhatsAppWebhookContactByIdentifier(
      params.contacts,
      recipientParentUserId,
    );
  const contact = normalizeWhatsAppWebhookContact(
    matchedContact,
    contactLookupIdentifier,
  );
  const resolvedRecipientId = statusRecipientIdentifier || null;
  const resolvedRecipientWaId =
    (participantIdentifier && isWhatsAppPhoneLike(participantIdentifier)
      ? normalizeWhatsAppPhoneOrNull(participantIdentifier)
      : null) ||
    (resolvedRecipientId &&
    !isGroupRecipient &&
    isWhatsAppPhoneLike(resolvedRecipientId)
      ? normalizeWhatsAppPhoneOrNull(resolvedRecipientId)
      : null) ||
    contact?.waId ||
    null;
  const resolvedRecipientUserId =
    recipientUserId ||
    (!resolvedRecipientId ||
    isGroupRecipient ||
    isWhatsAppPhoneLike(resolvedRecipientId)
      ? null
      : normalizeWhatsAppBsuidOrNull(resolvedRecipientId)) ||
    contact?.userId ||
    null;

  return {
    recipientId: resolvedRecipientId,
    recipientWaId: resolvedRecipientWaId,
    recipientUserId: resolvedRecipientUserId,
    recipientParentUserId:
      recipientParentUserId || contact?.parentUserId || null,
    recipientUsername:
      compactWhatsAppString(params.status.profile?.username) ||
      contact?.profile.username ||
      null,
    contact,
  };
}
