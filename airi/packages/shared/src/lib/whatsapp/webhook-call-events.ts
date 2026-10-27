import {
  normalizeWhatsAppBsuidOrNull,
  normalizeWhatsAppPhoneOrNull,
  type WhatsAppNormalizedContact,
} from "./contact-identities";
import { compactWhatsAppString } from "./value-utils";
import {
  normalizeWhatsAppWebhookContact,
  type WhatsAppWebhookContactLike,
} from "./webhook-direction";
import {
  findWhatsAppWebhookContactByIdentifier,
  resolveWhatsAppStatusRecipientIdentity,
} from "./webhook-status-identities";

type WhatsAppCallWebhookError = {
  code?: number | string | null;
  title?: string | null;
  message?: string | null;
  details?: string | null;
  error_data?: {
    details?: string | null;
  } | null;
};

type WhatsAppCallWebhookCall = {
  id?: string | null;
  event?: string | null;
  direction?: string | null;
  from?: string | null;
  to?: string | null;
  from_user_id?: string | null;
  from_parent_user_id?: string | null;
  to_user_id?: string | null;
  to_parent_user_id?: string | null;
  timestamp?: string | null;
  status?: string | null;
  biz_opaque_callback_data?: string | null;
  session?: {
    sdp_type?: string | null;
    sdp?: string | null;
  } | null;
  duration?: string | number | null;
  errors?: WhatsAppCallWebhookError[] | null;
};

type WhatsAppCallWebhookStatus = {
  id?: string | null;
  type?: string | null;
  status?: string | null;
  timestamp?: string | null;
  recipient_id?: string | null;
  recipient_user_id?: string | null;
  recipient_parent_user_id?: string | null;
  recipient_type?: string | null;
  recipient_participant_id?: string | null;
  biz_opaque_callback_data?: string | null;
  profile?: {
    name?: string;
    username?: string;
  } | null;
  duration?: string | number | null;
  errors?: WhatsAppCallWebhookError[] | null;
};

export type WhatsAppCallWebhookEvent = {
  kind: "call" | "status";
  callId: string | null;
  event: string | null;
  status: string | null;
  direction: string | null;
  from: string | null;
  to: string | null;
  fromUserId: string | null;
  fromParentUserId: string | null;
  toUserId: string | null;
  toParentUserId: string | null;
  recipientId: string | null;
  recipientUserId: string | null;
  recipientParentUserId: string | null;
  contactUserId: string | null;
  contactParentUserId: string | null;
  contactWaId: string | null;
  contactName: string | null;
  contactUsername: string | null;
  countryCode: string | null;
  timestamp: string | null;
  wabaId: string | null;
  phoneNumberId: string | null;
  bizOpaqueCallbackData: string | null;
  sessionSdpType: string | null;
  sessionSdp: string | null;
  durationSeconds: number | null;
  errorCode: number | null;
  errorMessage: string | null;
  rawEvent: WhatsAppCallWebhookCall | WhatsAppCallWebhookStatus;
};

type WhatsAppCallWebhookContactLike = WhatsAppWebhookContactLike & {
  profile?:
    | (WhatsAppWebhookContactLike["profile"] & {
        country_code?: string;
      })
    | null;
};

function countryCodeFromContact(
  contact: WhatsAppCallWebhookContactLike | null | undefined,
): string | null {
  return compactWhatsAppString(contact?.profile?.country_code);
}

function buildCallContact(params: {
  call: WhatsAppCallWebhookCall;
  contacts?: WhatsAppCallWebhookContactLike[] | null;
}): {
  contact: WhatsAppNormalizedContact | null;
  countryCode: string | null;
} {
  const identifiers = [
    compactWhatsAppString(params.call.from_user_id),
    compactWhatsAppString(params.call.from_parent_user_id),
    compactWhatsAppString(params.call.from),
    compactWhatsAppString(params.call.to_user_id),
    compactWhatsAppString(params.call.to_parent_user_id),
    compactWhatsAppString(params.call.to),
  ];
  const matchedContact =
    identifiers
      .map((identifier) =>
        findWhatsAppWebhookContactByIdentifier(params.contacts, identifier),
      )
      .find(Boolean) || null;
  const fallbackIdentifier = identifiers.find(Boolean) || null;

  return {
    contact: normalizeWhatsAppWebhookContact(
      matchedContact,
      fallbackIdentifier,
    ),
    countryCode: countryCodeFromContact(matchedContact),
  };
}

function buildContactFields(params: {
  contact: WhatsAppNormalizedContact | null;
  countryCode?: string | null;
}): {
  contactUserId: string | null;
  contactParentUserId: string | null;
  contactWaId: string | null;
  contactName: string | null;
  contactUsername: string | null;
  countryCode: string | null;
} {
  return {
    contactUserId: params.contact?.userId || null,
    contactParentUserId: params.contact?.parentUserId || null,
    contactWaId: params.contact?.waId || null,
    contactName: params.contact?.profile.name || null,
    contactUsername: params.contact?.profile.username || null,
    countryCode: params.countryCode || null,
  };
}

function normalizeDurationSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
  }
  return null;
}

function extractCallErrorFields(
  errors: WhatsAppCallWebhookError[] | null | undefined,
): {
  errorCode: number | null;
  errorMessage: string | null;
} {
  const error = Array.isArray(errors) ? errors[0] : null;
  if (!error) {
    return { errorCode: null, errorMessage: null };
  }

  const parsedCode =
    typeof error.code === "number"
      ? error.code
      : typeof error.code === "string"
        ? Number.parseInt(error.code, 10)
        : Number.NaN;
  return {
    errorCode: Number.isFinite(parsedCode) ? parsedCode : null,
    errorMessage:
      compactWhatsAppString(error.message) ||
      compactWhatsAppString(error.title) ||
      compactWhatsAppString(error.details) ||
      compactWhatsAppString(error.error_data?.details),
  };
}

export function extractWhatsAppCallWebhookEvents(params: {
  wabaId?: string | null;
  phoneNumberId?: string | null;
  contacts?: WhatsAppCallWebhookContactLike[] | null;
  calls?: WhatsAppCallWebhookCall[] | null;
  statuses?: WhatsAppCallWebhookStatus[] | null;
}): WhatsAppCallWebhookEvent[] {
  const events: WhatsAppCallWebhookEvent[] = [];
  const wabaId = compactWhatsAppString(params.wabaId);
  const phoneNumberId = compactWhatsAppString(params.phoneNumberId);

  for (const call of params.calls || []) {
    const { contact, countryCode } = buildCallContact({
      call,
      contacts: params.contacts,
    });
    const errorFields = extractCallErrorFields(call.errors);
    events.push({
      kind: "call",
      callId: compactWhatsAppString(call.id),
      event: compactWhatsAppString(call.event),
      status: compactWhatsAppString(call.status),
      direction: compactWhatsAppString(call.direction),
      from: normalizeWhatsAppPhoneOrNull(call.from),
      to: normalizeWhatsAppPhoneOrNull(call.to),
      fromUserId: normalizeWhatsAppBsuidOrNull(call.from_user_id),
      fromParentUserId: normalizeWhatsAppBsuidOrNull(call.from_parent_user_id),
      toUserId: normalizeWhatsAppBsuidOrNull(call.to_user_id),
      toParentUserId: normalizeWhatsAppBsuidOrNull(call.to_parent_user_id),
      recipientId: null,
      recipientUserId: null,
      recipientParentUserId: null,
      ...buildContactFields({ contact, countryCode }),
      timestamp: compactWhatsAppString(call.timestamp),
      wabaId,
      phoneNumberId,
      bizOpaqueCallbackData: compactWhatsAppString(
        call.biz_opaque_callback_data,
      ),
      sessionSdpType: compactWhatsAppString(call.session?.sdp_type),
      sessionSdp: compactWhatsAppString(call.session?.sdp),
      durationSeconds: normalizeDurationSeconds(call.duration),
      errorCode: errorFields.errorCode,
      errorMessage: errorFields.errorMessage,
      rawEvent: call,
    });
  }

  for (const status of params.statuses || []) {
    const identity = resolveWhatsAppStatusRecipientIdentity({
      status,
      contacts: params.contacts,
    });
    const matchedContact = findWhatsAppWebhookContactByIdentifier(
      params.contacts,
      identity.recipientId,
    );
    const errorFields = extractCallErrorFields(status.errors);
    events.push({
      kind: "status",
      callId: compactWhatsAppString(status.id),
      event: null,
      status: compactWhatsAppString(status.status),
      direction: null,
      from: null,
      to: null,
      fromUserId: null,
      fromParentUserId: null,
      toUserId: null,
      toParentUserId: null,
      recipientId: identity.recipientId,
      recipientUserId: identity.recipientUserId,
      recipientParentUserId: identity.recipientParentUserId,
      ...buildContactFields({
        contact: identity.contact,
        countryCode: countryCodeFromContact(matchedContact),
      }),
      timestamp: compactWhatsAppString(status.timestamp),
      wabaId,
      phoneNumberId,
      bizOpaqueCallbackData: compactWhatsAppString(
        status.biz_opaque_callback_data,
      ),
      sessionSdpType: null,
      sessionSdp: null,
      durationSeconds: normalizeDurationSeconds(status.duration),
      errorCode: errorFields.errorCode,
      errorMessage: errorFields.errorMessage,
      rawEvent: status,
    });
  }

  return events;
}
