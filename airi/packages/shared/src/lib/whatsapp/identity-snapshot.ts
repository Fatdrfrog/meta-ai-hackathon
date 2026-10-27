import type { WhatsAppNormalizedContact } from "./contact-identities";

export function buildWhatsAppIdentitySnapshot(
  contactData: WhatsAppNormalizedContact,
) {
  return {
    ...(contactData.waId ? { waId: contactData.waId } : {}),
    ...(contactData.userId ? { userId: contactData.userId } : {}),
    ...(contactData.parentUserId
      ? { parentUserId: contactData.parentUserId }
      : {}),
    ...(contactData.profile.username
      ? { username: contactData.profile.username }
      : {}),
    ...(contactData.profile.name
      ? { profileName: contactData.profile.name }
      : {}),
    primaryIdType: contactData.primaryIdType,
  };
}

const WHATSAPP_IDENTITY_SNAPSHOT_FIELDS = [
  "username",
  "profileName",
  "primaryIdType",
] as const;

// Meta may omit a phone or scoped identifier on a later webhook. Absence is
// not a revocation of an established association; explicit identity-change
// events own replacement/retirement of identifiers.

export function buildWhatsAppIdentitySnapshotUpdate(
  contactData: WhatsAppNormalizedContact,
): {
  set: Record<string, unknown>;
  unset: Record<string, "">;
} {
  const snapshot = buildWhatsAppIdentitySnapshot(contactData) as Record<
    string,
    unknown
  >;
  const set = Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => [`whatsapp.${key}`, value]),
  );
  const unset = WHATSAPP_IDENTITY_SNAPSHOT_FIELDS.reduce<Record<string, "">>(
    (acc, key) => {
      if (!(key in snapshot)) {
        acc[`whatsapp.${key}`] = "";
      }
      return acc;
    },
    {},
  );

  return { set, unset };
}
