import {
  buildNormalizedWhatsAppContact,
  getWhatsAppPrimaryIdentifier,
  isWhatsAppPhoneLike,
  sameWhatsAppBsuid,
  sameWhatsAppPhone,
  type WhatsAppNormalizedContact,
} from "./contact-identities";
import {
  compactWhatsAppString,
  compactWhatsAppStringOrUndefined,
} from "./value-utils";

interface WhatsAppWebhookMessageLike {
  from?: string;
  to?: string;
  from_user_id?: string;
  from_parent_user_id?: string;
  to_user_id?: string;
  to_parent_user_id?: string;
  group_id?: string;
}

export interface WhatsAppWebhookContactLike {
  wa_id?: string;
  user_id?: string;
  parent_user_id?: string;
  profile?: {
    name?: string;
    username?: string;
    country_code?: string;
  } | null;
}

type WhatsAppDisplayPhoneCredentials = {
  display_phone_number?: string | null;
  displayPhoneNumber?: string | null;
};

type NormalizedWhatsAppWebhookContact = WhatsAppNormalizedContact;

interface ResolveWhatsAppMessageContextParams {
  messageData: WhatsAppWebhookMessageLike;
  contacts?: WhatsAppWebhookContactLike[] | null;
  displayPhoneNumber?: string | null;
}

function matchesContactIdentifier(
  contact: WhatsAppWebhookContactLike | null | undefined,
  identifier?: string | null,
): boolean {
  if (!contact || !identifier) return false;

  if (isWhatsAppPhoneLike(identifier)) {
    return sameWhatsAppPhone(contact.wa_id, identifier);
  }

  return (
    sameWhatsAppBsuid(contact.user_id, identifier) ||
    sameWhatsAppBsuid(contact.parent_user_id, identifier)
  );
}

function getMessageSenderIdentifier(
  messageData: WhatsAppWebhookMessageLike,
): string | null {
  return (
    compactWhatsAppString(messageData.from) ||
    compactWhatsAppString(messageData.from_user_id) ||
    compactWhatsAppString(messageData.from_parent_user_id)
  );
}

function getMessageRecipientIdentifier(
  messageData: WhatsAppWebhookMessageLike,
): string | null {
  return (
    compactWhatsAppString(messageData.to) ||
    compactWhatsAppString(messageData.to_user_id) ||
    compactWhatsAppString(messageData.to_parent_user_id)
  );
}

export function resolveWhatsAppDisplayPhoneNumber(params: {
  metadataDisplayPhoneNumber?: string | null;
  sourceCredentials?: unknown;
}): string | undefined {
  const sourceCredentials =
    params.sourceCredentials &&
    typeof params.sourceCredentials === "object" &&
    !Array.isArray(params.sourceCredentials)
      ? (params.sourceCredentials as WhatsAppDisplayPhoneCredentials)
      : null;

  return (
    compactWhatsAppStringOrUndefined(params.metadataDisplayPhoneNumber) ||
    compactWhatsAppStringOrUndefined(sourceCredentials?.display_phone_number) ||
    compactWhatsAppStringOrUndefined(sourceCredentials?.displayPhoneNumber)
  );
}

export function normalizeWhatsAppWebhookContact(
  contactData: WhatsAppWebhookContactLike | undefined | null,
  fallbackIdentifier?: string | null,
): NormalizedWhatsAppWebhookContact | null {
  return buildNormalizedWhatsAppContact({
    waId: contactData?.wa_id,
    userId: contactData?.user_id,
    parentUserId: contactData?.parent_user_id,
    profileName: contactData?.profile?.name,
    username: contactData?.profile?.username,
    fallbackFrom: fallbackIdentifier,
  });
}

function findMatchingContact(
  contacts: WhatsAppWebhookContactLike[] | null | undefined,
  identifier?: string | null,
): NormalizedWhatsAppWebhookContact | null {
  if (!identifier || !Array.isArray(contacts)) {
    return null;
  }

  const matched = contacts.find((contact) =>
    matchesContactIdentifier(contact, identifier),
  );

  return normalizeWhatsAppWebhookContact(matched, identifier);
}

function isBusinessOriginatedWhatsAppMessage(
  messageData: WhatsAppWebhookMessageLike,
  displayPhoneNumber?: string | null,
): boolean {
  if (!displayPhoneNumber) {
    return false;
  }

  return sameWhatsAppPhone(messageData.from, displayPhoneNumber);
}

export function resolveWhatsAppOutboundRecipientContact(
  params: ResolveWhatsAppMessageContextParams,
): NormalizedWhatsAppWebhookContact | null {
  const { messageData, contacts, displayPhoneNumber } = params;
  const recipientIdentifier = getMessageRecipientIdentifier(messageData);
  const senderIdentifier = getMessageSenderIdentifier(messageData);

  const explicitRecipient = findMatchingContact(contacts, recipientIdentifier);
  if (explicitRecipient) {
    return explicitRecipient;
  }

  const firstNonBusinessContact = (contacts || []).find((contact) => {
    const primaryContact = normalizeWhatsAppWebhookContact(contact);
    const primaryIdentifier = getWhatsAppPrimaryIdentifier(primaryContact);
    if (!primaryIdentifier) return false;
    if (sameWhatsAppPhone(contact.wa_id, displayPhoneNumber)) return false;
    if (matchesContactIdentifier(contact, senderIdentifier)) return false;
    return primaryIdentifier.length > 0;
  });

  const normalizedFirstNonBusiness = normalizeWhatsAppWebhookContact(
    firstNonBusinessContact,
  );
  if (normalizedFirstNonBusiness) {
    return normalizedFirstNonBusiness;
  }

  if (
    recipientIdentifier &&
    !sameWhatsAppPhone(recipientIdentifier, displayPhoneNumber)
  ) {
    return normalizeWhatsAppWebhookContact(null, recipientIdentifier);
  }

  return null;
}

export function resolveWhatsAppMessageContext(
  params: ResolveWhatsAppMessageContextParams,
): {
  direction: "inbound" | "outbound";
  contactData: NormalizedWhatsAppWebhookContact | null;
} {
  const { messageData, contacts, displayPhoneNumber } = params;
  const senderIdentifier = getMessageSenderIdentifier(messageData);

  if (isBusinessOriginatedWhatsAppMessage(messageData, displayPhoneNumber)) {
    return {
      direction: "outbound",
      contactData: resolveWhatsAppOutboundRecipientContact(params),
    };
  }

  return {
    direction: "inbound",
    contactData:
      findMatchingContact(contacts, senderIdentifier) ||
      normalizeWhatsAppWebhookContact(contacts?.[0], senderIdentifier),
  };
}
