export const WHATSAPP_QR_REFERENCE_CODE_LENGTH = 10;
export const WHATSAPP_QR_FINAL_MESSAGE_MAX_LENGTH = 140;
export const WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH = 120;

const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const REFERENCE_CODE_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/;
const REFERENCE_LINE_PATTERN = /^\[Ref: ([0-9ABCDEFGHJKMNPQRSTVWXYZ]{5})-([0-9ABCDEFGHJKMNPQRSTVWXYZ]{5})\]$/;

export type ExtractedWhatsAppQrReference = {
  rawText: string;
  effectiveText: string;
  referenceCode?: string;
};

export type WhatsAppQrReferenceAllocator = {
  generate?: () => string;
  isAvailable: (referenceCode: string) => boolean | Promise<boolean>;
  maxAttempts?: number;
};

function normalizeReferenceCode(value: string): string {
  const referenceCode = value.toUpperCase();
  if (!REFERENCE_CODE_PATTERN.test(referenceCode)) {
    throw new TypeError("WhatsApp QR references require ten Crockford Base32 characters");
  }
  return referenceCode;
}

function randomReferenceCode(): string {
  const bytes = new Uint8Array(WHATSAPP_QR_REFERENCE_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => CROCKFORD_BASE32_ALPHABET[byte & 31]).join("");
}

export function formatWhatsAppQrReference(referenceCode: string): string {
  const normalized = normalizeReferenceCode(referenceCode);
  return `[Ref: ${normalized.slice(0, 5)}-${normalized.slice(5)}]`;
}

export function parseWhatsAppQrReferenceLine(line: string): string | undefined {
  const match = REFERENCE_LINE_PATTERN.exec(line);
  return match ? `${match[1]}${match[2]}` : undefined;
}

export function extractWhatsAppQrReference(
  rawText: string,
): ExtractedWhatsAppQrReference {
  const lines = rawText.split(/\r\n|\n|\r/);
  const references = lines.flatMap(line => {
    const referenceCode = parseWhatsAppQrReferenceLine(line);
    return referenceCode === undefined ? [] : [referenceCode];
  });
  if (references.length === 0) {
    return { rawText, effectiveText: rawText };
  }
  const effectiveText = lines
    .filter(line => parseWhatsAppQrReferenceLine(line) === undefined)
    .join("\n");
  return {
    rawText,
    effectiveText,
    ...(references.length === 1 ? { referenceCode: references[0]! } : {}),
  };
}

export function formatWhatsAppQrReferenceMessage(
  message: string,
  referenceCode: string,
): string {
  if (message.length > WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH) {
    throw new RangeError("WhatsApp QR message body exceeds 120 characters");
  }
  const finalMessage = message
    ? `${message}\n${formatWhatsAppQrReference(referenceCode)}`
    : formatWhatsAppQrReference(referenceCode);
  if (finalMessage.length > WHATSAPP_QR_FINAL_MESSAGE_MAX_LENGTH) {
    throw new RangeError("WhatsApp QR final message exceeds 140 characters");
  }
  return finalMessage;
}

export async function allocateWhatsAppQrReferenceCode({
  generate = randomReferenceCode,
  isAvailable,
  maxAttempts = 32,
}: WhatsAppQrReferenceAllocator): Promise<string> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("WhatsApp QR reference allocation requires a positive attempt budget");
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const referenceCode = normalizeReferenceCode(generate());
    if (await isAvailable(referenceCode)) return referenceCode;
  }
  throw new Error("WhatsApp QR reference allocation exhausted");
}
