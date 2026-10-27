export const WHATSAPP_QR_PLACEMENT_NAME_SEARCH_MAX_LENGTH = 512;

const UUID_V1_TO_V5_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeWhatsAppQrPlacementNameSearch(value: unknown): string {
  const normalized =
    typeof value === "string"
      ? value
          .normalize("NFKC")
          .replace(/\p{White_Space}+/gu, " ")
          .trim()
          .toLowerCase()
      : "";
  if (!normalized) {
    throw new Error("WhatsApp QR placement name search key is required");
  }
  if (normalized.length > WHATSAPP_QR_PLACEMENT_NAME_SEARCH_MAX_LENGTH) {
    throw new Error("WhatsApp QR placement name search key is too long");
  }
  return normalized;
}

export function unicodePrefixSuccessor(prefix: string): string | undefined {
  const scalars = Array.from(prefix, scalar => scalar.codePointAt(0)!);
  for (let index = scalars.length - 1; index >= 0; index -= 1) {
    if (scalars[index] < 0x10ffff) {
      scalars[index] += 1;
      return String.fromCodePoint(...scalars.slice(0, index + 1));
    }
  }
  return undefined;
}

export function normalizeWhatsAppQrEntryPointUuid(
  value: unknown
): string | undefined {
  if (typeof value !== "string" || !UUID_V1_TO_V5_PATTERN.test(value)) {
    return undefined;
  }
  return value.toLowerCase();
}
