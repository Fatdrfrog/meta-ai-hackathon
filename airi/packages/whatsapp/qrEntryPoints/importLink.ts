import { WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH } from "@icecore/scenario-contracts";

const MAX_IMPORT_URL_LENGTH = 2_048;
const MAX_PROVIDER_CODE_LENGTH = 256;
const PROVIDER_CODE_PATTERN = /^[A-Za-z0-9_-]+$/;
const DISPLAY_PHONE_SEPARATORS = /^[+0-9 ().-]+$/;
const E164_DIGITS_PATTERN = /^[1-9][0-9]{0,14}$/;

export type WhatsAppQrImportIntent =
  | {
      kind: "provider";
      providerCode: string;
      deepLink: string;
    }
  | {
      kind: "direct";
      displayPhoneNumber: string;
      desiredMessage: string;
    };

export class WhatsAppQrImportLinkError extends Error {
  readonly code = "UNSUPPORTED_WHATSAPP_QR_LINK";

  constructor() {
    super("Unsupported WhatsApp QR link");
    this.name = "WhatsAppQrImportLinkError";
  }
}

function unsupported(): never {
  throw new WhatsAppQrImportLinkError();
}

function normalizeProviderCode(value: string): string {
  if (
    value.length < 1 ||
    value.length > MAX_PROVIDER_CODE_LENGTH ||
    !PROVIDER_CODE_PATTERN.test(value)
  ) {
    unsupported();
  }
  return value;
}

export function normalizeWhatsAppQrDisplayPhoneNumber(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !DISPLAY_PHONE_SEPARATORS.test(value)
  ) {
    throw new TypeError("Invalid WhatsApp source phone number");
  }
  const digits = value.replace(/[^0-9]/g, "");
  if (!E164_DIGITS_PATTERN.test(digits)) {
    throw new TypeError("Invalid WhatsApp source phone number");
  }
  return digits;
}

export function normalizeWhatsAppQrProviderLink(
  value: string
): Extract<WhatsAppQrImportIntent, { kind: "provider" }> {
  if (
    typeof value !== "string" ||
    value.length > MAX_IMPORT_URL_LENGTH ||
    value.trim() !== value
  ) {
    unsupported();
  }
  const match = /^https:\/\/wa\.me\/message\/([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) unsupported();
  const providerCode = normalizeProviderCode(match[1]!);
  return {
    kind: "provider",
    providerCode,
    deepLink: "https://wa.me/message/" + providerCode,
  };
}

export function normalizeWhatsAppQrImportUrl(params: {
  url: string;
  displayPhoneNumber: string;
}): WhatsAppQrImportIntent {
  if (
    typeof params.url !== "string" ||
    params.url.length > MAX_IMPORT_URL_LENGTH ||
    params.url.trim() !== params.url
  ) {
    unsupported();
  }

  if (params.url.startsWith("https://wa.me/message/")) {
    return normalizeWhatsAppQrProviderLink(params.url);
  }
  if (!params.url.startsWith("https://wa.me/")) unsupported();

  let url: URL;
  try {
    url = new URL(params.url);
  } catch {
    unsupported();
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "wa.me" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    unsupported();
  }

  const pathMatch = /^\/([1-9][0-9]{0,14})$/.exec(url.pathname);
  if (!pathMatch) unsupported();
  const displayPhoneNumber = normalizeWhatsAppQrDisplayPhoneNumber(
    params.displayPhoneNumber
  );
  if (pathMatch[1] !== displayPhoneNumber) unsupported();

  const queryEntries = Array.from(url.searchParams.entries());
  if (
    queryEntries.length !== 1 ||
    queryEntries[0]![0] !== "text" ||
    queryEntries[0]![1].trim().length === 0 ||
    queryEntries[0]![1].length > WHATSAPP_QR_MESSAGE_BODY_MAX_LENGTH
  ) {
    unsupported();
  }
  return {
    kind: "direct",
    displayPhoneNumber,
    desiredMessage: queryEntries[0]![1],
  };
}
