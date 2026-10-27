import { readNonEmptyStringOrUndefined as asTrimmedString } from "../value-utils";

export type WhatsAppPrimaryIdType =
  | "wa_id"
  | "user_id"
  | "parent_user_id"
  | "message_from";

export type WhatsAppRecipientKind = "phone" | "bsuid" | "parent_bsuid";

export type WhatsAppRecipientTarget = {
  kind: WhatsAppRecipientKind;
  value: string;
};

export type WhatsAppNormalizedContact = {
  waId?: string;
  userId?: string;
  parentUserId?: string;
  profile: {
    name: string;
    username?: string;
  };
  primaryIdType: WhatsAppPrimaryIdType;
};

type WhatsAppContactInput = {
  waId?: string | null;
  userId?: string | null;
  parentUserId?: string | null;
  profileName?: string | null;
  username?: string | null;
  fallbackFrom?: string | null;
};

type WhatsAppStoredIdentityLike = {
  whatsapp?: {
    waId?: string | null;
    userId?: string | null;
    parentUserId?: string | null;
    username?: string | null;
    profileName?: string | null;
    primaryIdType?: WhatsAppPrimaryIdType | null;
  } | null;
  _id?: unknown;
};

/**
 * Canonical WhatsApp phone digits for identity storage/lookup.
 * Kazakhstan/Russia national trunk `8XXXXXXXXXX` maps to international `7XXXXXXXXXX`
 * so CSV uploads (`870…`) and Meta `wa_id` (`770…`) resolve to one conversation.
 */
export function normalizeWhatsAppPhone(value: unknown): string | undefined {
  const raw = asTrimmedString(value);
  if (!raw) return undefined;
  // Spreadsheet exports protect phone cells such as +770... with one leading
  // apostrophe. Remove only that text marker on otherwise phone-shaped input;
  // formulas, quoted arbitrary text and business-scoped IDs remain unchanged.
  const phoneInput = /^'\+?\d[\d\s().-]*$/.test(raw) ? raw.slice(1) : raw;
  // Accept our legacy phone key and phone formatting, never strip the country
  // prefix from a BSUID into a different (and invalid) phone identity.
  const phone = phoneInput.replace(/^wa_/, "");
  if (!/^\+?[\d\s().-]+$/.test(phone)) return undefined;
  const digits = phone.replace(/\D+/g, "");
  // Keep the existing lower bound and leading-zero compatibility; E.164 phone
  // numbers cannot contain more than fifteen digits.
  if (digits.length < 6 || digits.length > 15) return undefined;
  if (/^8\d{10}$/.test(digits)) {
    return `7${digits.slice(1)}`;
  }
  return digits;
}

/**
 * Identity lookup variants for a phone: canonical international form plus the
 * legacy national `8…` twin so older `wa_87…` conversations still match.
 */
export function listWhatsAppPhoneIdentityVariants(
  value: unknown,
): string[] {
  const canonical = normalizeWhatsAppPhone(value);
  if (!canonical) return [];

  const variants = [canonical];
  if (/^7\d{10}$/.test(canonical)) {
    variants.push(`8${canonical.slice(1)}`);
  }

  const rawDigits = asTrimmedString(value)?.replace(/\D+/g, "");
  if (rawDigits && rawDigits.length >= 6 && !variants.includes(rawDigits)) {
    variants.push(rawDigits);
  }

  return variants;
}

export function normalizeWhatsAppPhoneOrNull(value: unknown): string | null {
  return normalizeWhatsAppPhone(value) || null;
}

export function isWhatsAppPhoneLike(value: unknown): boolean {
  return Boolean(normalizeWhatsAppPhone(value));
}

export function normalizeWhatsAppBsuid(value: unknown): string | undefined {
  return asTrimmedString(value);
}

export function normalizeWhatsAppBsuidOrNull(value: unknown): string | null {
  return normalizeWhatsAppBsuid(value) || null;
}

export function sameWhatsAppPhone(a: unknown, b: unknown): boolean {
  const normalizedA = normalizeWhatsAppPhone(a);
  const normalizedB = normalizeWhatsAppPhone(b);
  return Boolean(normalizedA && normalizedB && normalizedA === normalizedB);
}

export function sameWhatsAppBsuid(a: unknown, b: unknown): boolean {
  const normalizedA = normalizeWhatsAppBsuid(a);
  const normalizedB = normalizeWhatsAppBsuid(b);
  return Boolean(normalizedA && normalizedB && normalizedA === normalizedB);
}

export function sameWhatsAppIdentifier(a: unknown, b: unknown): boolean {
  const normalizedPhoneA = normalizeWhatsAppPhone(a);
  const normalizedPhoneB = normalizeWhatsAppPhone(b);
  if (normalizedPhoneA || normalizedPhoneB) {
    return Boolean(
      normalizedPhoneA &&
        normalizedPhoneB &&
        normalizedPhoneA === normalizedPhoneB,
    );
  }

  return sameWhatsAppBsuid(a, b);
}

export function buildNormalizedWhatsAppContact(
  input: WhatsAppContactInput,
): WhatsAppNormalizedContact | null {
  const waId = normalizeWhatsAppPhone(input.waId);
  const userId = normalizeWhatsAppBsuid(input.userId);
  const parentUserId = normalizeWhatsAppBsuid(input.parentUserId);
  const fallbackFrom = asTrimmedString(input.fallbackFrom);

  let fallbackWaId: string | undefined;
  let fallbackUserId: string | undefined;

  if (!waId && !userId && !parentUserId && fallbackFrom) {
    const normalizedFallbackPhone = normalizeWhatsAppPhone(fallbackFrom);
    if (normalizedFallbackPhone) {
      fallbackWaId = normalizedFallbackPhone;
    } else {
      fallbackUserId = fallbackFrom;
    }
  }

  const resolvedWaId = waId || fallbackWaId;
  const resolvedUserId = userId || fallbackUserId;

  let primaryIdType: WhatsAppPrimaryIdType | null = null;
  if (waId || fallbackWaId) {
    primaryIdType = waId ? "wa_id" : "message_from";
  } else if (userId || fallbackUserId) {
    primaryIdType = userId ? "user_id" : "message_from";
  } else if (parentUserId) {
    primaryIdType = "parent_user_id";
  }

  if (!primaryIdType) {
    return null;
  }

  const profileName = asTrimmedString(input.profileName) || "Customer";
  const username = asTrimmedString(input.username);

  return {
    waId: resolvedWaId,
    userId: resolvedUserId,
    parentUserId,
    profile: {
      name: profileName,
      ...(username ? { username } : {}),
    },
    primaryIdType,
  };
}

export function getWhatsAppPrimaryIdentifier(
  contact: WhatsAppNormalizedContact | null | undefined,
): string | undefined {
  if (!contact) return undefined;

  switch (contact.primaryIdType) {
    case "wa_id":
      return contact.waId;
    case "user_id":
      return contact.userId;
    case "parent_user_id":
      return contact.parentUserId;
    case "message_from":
      return contact.waId || contact.userId;
    default:
      return undefined;
  }
}

export function buildWhatsAppCanonicalIdFromPhone(waId: string): string {
  return `wa_${waId}`;
}

export function buildWhatsAppCanonicalIdFromBsuid(bsuid: string): string {
  return `wa_bsuid_${bsuid}`;
}

export function buildWhatsAppCanonicalId(
  contact: WhatsAppNormalizedContact | null | undefined,
): string | null {
  if (!contact) return null;
  if (contact.waId) {
    return buildWhatsAppCanonicalIdFromPhone(contact.waId);
  }
  const bsuid = contact.userId || contact.parentUserId;
  if (bsuid) {
    return buildWhatsAppCanonicalIdFromBsuid(bsuid);
  }
  return null;
}

export function resolveWhatsAppRecipientTarget(
  contact: WhatsAppNormalizedContact | null | undefined,
): WhatsAppRecipientTarget | null {
  if (!contact) return null;
  if (contact.waId) {
    return { kind: "phone", value: contact.waId };
  }
  if (contact.userId) {
    return { kind: "bsuid", value: contact.userId };
  }
  if (contact.parentUserId) {
    return { kind: "parent_bsuid", value: contact.parentUserId };
  }
  return null;
}

export function parseWhatsAppRecipientTarget(
  value: unknown,
): WhatsAppRecipientTarget | null {
  if (
    value &&
    typeof value === "object" &&
    "kind" in value &&
    "value" in value
  ) {
    const kind = asTrimmedString((value as { kind?: unknown }).kind);
    const targetValue = asTrimmedString((value as { value?: unknown }).value);
    if (
      targetValue &&
      (kind === "phone" || kind === "bsuid" || kind === "parent_bsuid")
    ) {
      return { kind, value: targetValue };
    }
  }

  const raw = asTrimmedString(value);
  if (!raw) return null;

  if (raw.startsWith("phone:")) {
    const phone = normalizeWhatsAppPhone(raw.slice("phone:".length));
    return phone ? { kind: "phone", value: phone } : null;
  }

  if (raw.startsWith("bsuid:")) {
    const bsuid = normalizeWhatsAppBsuid(raw.slice("bsuid:".length));
    return bsuid ? { kind: "bsuid", value: bsuid } : null;
  }

  if (raw.startsWith("parent_bsuid:")) {
    const parentBsuid = normalizeWhatsAppBsuid(
      raw.slice("parent_bsuid:".length),
    );
    return parentBsuid ? { kind: "parent_bsuid", value: parentBsuid } : null;
  }

  if (raw.startsWith("wa_parent_bsuid_")) {
    return {
      kind: "parent_bsuid",
      value: raw.slice("wa_parent_bsuid_".length),
    };
  }

  if (raw.startsWith("wa_bsuid_")) {
    return { kind: "bsuid", value: raw.slice("wa_bsuid_".length) };
  }

  if (raw.startsWith("wa_")) {
    const waId = normalizeWhatsAppPhone(raw.slice("wa_".length));
    return waId ? { kind: "phone", value: waId } : null;
  }

  const phone = normalizeWhatsAppPhone(raw);
  if (phone) {
    return { kind: "phone", value: phone };
  }

  return { kind: "bsuid", value: raw };
}

function resolveStoredIdentityTarget(
  value: unknown,
): WhatsAppRecipientTarget | null {
  if (!value || typeof value !== "object") {
    return parseWhatsAppRecipientTarget(value);
  }

  const entity = value as WhatsAppStoredIdentityLike;
  const stored = entity.whatsapp;
  if (stored) {
    const waId = normalizeWhatsAppPhone(stored.waId);
    if (waId) {
      return { kind: "phone", value: waId };
    }
    const userId = normalizeWhatsAppBsuid(stored.userId);
    if (userId) {
      return { kind: "bsuid", value: userId };
    }
    const parentUserId = normalizeWhatsAppBsuid(stored.parentUserId);
    if (parentUserId) {
      return { kind: "parent_bsuid", value: parentUserId };
    }
  }

  if ("_id" in entity) {
    return parseWhatsAppRecipientTarget(entity._id);
  }

  return parseWhatsAppRecipientTarget(value);
}

export function resolveStoredWhatsAppRecipientTarget(
  ...sources: unknown[]
): WhatsAppRecipientTarget | null {
  for (const source of sources) {
    const resolved = resolveStoredIdentityTarget(source);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

export function getWhatsAppLogIdentity(
  contact: WhatsAppNormalizedContact | null | undefined,
): string | undefined {
  if (!contact) return undefined;
  return contact.waId || contact.userId || contact.parentUserId;
}
