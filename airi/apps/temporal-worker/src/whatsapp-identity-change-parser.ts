import {
  normalizeWhatsAppBsuid,
  normalizeWhatsAppPhone,
} from "@icecore/shared/lib/whatsapp/contact-identities";

export interface WhatsAppSystemMessage {
  body?: string;
  type?: string;
  wa_id?: string;
  new_wa_id?: string;
  user_id?: string;
  customer?: string;
  identity?: string;
}

export interface ParsedNumberChange {
  oldWaId: string;
  newWaId: string;
}

export interface ParsedUserIdChange {
  oldUserId: string;
  newUserId: string;
}

function parseFromBody(body: string | undefined): ParsedNumberChange | null {
  if (!body || typeof body !== "string") return null;
  // Meta-formatted body: "User A changed from +12345678901 to +19876543210".
  const match = body.match(
    /from\s+\+?([0-9][0-9\s-]{4,30})\s+to\s+\+?([0-9][0-9\s-]{4,30})/i,
  );
  if (!match) return null;
  const oldNormalized = normalizeWhatsAppPhone(match[1]);
  const newNormalized = normalizeWhatsAppPhone(match[2]);
  if (!oldNormalized || !newNormalized || oldNormalized === newNormalized) {
    return null;
  }
  return { oldWaId: oldNormalized, newWaId: newNormalized };
}

function parseUserIdFromBody(
  body: string | undefined,
): ParsedUserIdChange | null {
  if (!body || typeof body !== "string") return null;
  const match = body.match(/\bfrom\s+([^\s]+)\s+to\s+([^\s.]+(?:\.[^\s.]+)+)/i);
  if (!match) return null;
  const oldUserId = normalizeWhatsAppBsuid(match[1]);
  const newUserId = normalizeWhatsAppBsuid(match[2]);
  if (!oldUserId || !newUserId || oldUserId === newUserId) {
    return null;
  }
  return { oldUserId, newUserId };
}

export function parseUserChangedNumber(params: {
  messageFrom?: string | null;
  system: WhatsAppSystemMessage | null | undefined;
}): ParsedNumberChange | null {
  const system = params.system || {};
  const from = normalizeWhatsAppPhone(params.messageFrom);
  const sysWaId = normalizeWhatsAppPhone(system.wa_id);
  const sysNewWaId = normalizeWhatsAppPhone(system.new_wa_id);
  const sysCustomer = normalizeWhatsAppPhone(system.customer);

  if (sysNewWaId) {
    const candidatesForOld = [sysCustomer, sysWaId, from].filter(
      (value): value is string => Boolean(value && value !== sysNewWaId),
    );
    if (candidatesForOld.length > 0) {
      return { oldWaId: candidatesForOld[0], newWaId: sysNewWaId };
    }
  }

  const fromBody = parseFromBody(system.body);
  if (fromBody) return fromBody;

  if (from && sysWaId && from !== sysWaId) {
    return { oldWaId: sysWaId, newWaId: from };
  }

  return null;
}

export function parseUserChangedUserId(params: {
  messageFrom?: string | null;
  system: WhatsAppSystemMessage | null | undefined;
}): ParsedUserIdChange | null {
  const system = params.system || {};
  const from = normalizeWhatsAppBsuid(params.messageFrom);
  const sysUserId = normalizeWhatsAppBsuid(system.user_id);
  const sysWaId = normalizeWhatsAppBsuid(system.wa_id);
  const sysCustomer = normalizeWhatsAppBsuid(system.customer);
  const fromBody = parseUserIdFromBody(system.body);

  if (fromBody) {
    return {
      oldUserId: fromBody.oldUserId,
      newUserId: sysUserId || fromBody.newUserId,
    };
  }

  const newUserId = sysUserId || from;
  const oldCandidates = [sysCustomer, sysWaId].filter(
    (value): value is string => Boolean(value && value !== newUserId),
  );
  if (newUserId && oldCandidates.length > 0) {
    return { oldUserId: oldCandidates[0], newUserId };
  }

  return null;
}
