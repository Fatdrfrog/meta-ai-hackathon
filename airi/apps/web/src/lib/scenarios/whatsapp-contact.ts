import { isProbablyEmail, normalizeEmail } from "@/lib/customers/shared";
import type { ScenarioWhatsAppContactConfig } from "@icecore/scenario-contracts";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import {
  asNullableRecord,
  readNonEmptyStringOrUndefined,
} from "@icecore/shared/lib/value-utils";

const MAX_CONTACT_NAME_LENGTH = 80;
const MAX_CONTACT_TEXT_LENGTH = 120;
const MAX_CONTACT_PHONE_LENGTH = 32;
const MAX_CONTACT_URL_LENGTH = 240;

export type WhatsAppContactMessagePayload = {
  name: {
    formatted_name: string;
    first_name?: string;
    last_name?: string;
  };
  org?: {
    company?: string;
    title?: string;
  };
  phones?: Array<{
    phone: string;
    type?: "WORK";
  }>;
  emails?: Array<{
    email: string;
    type?: "WORK";
  }>;
  urls?: Array<{
    url: string;
    type?: "WORK";
  }>;
};

const cleanText = (value: unknown, maxLength: number) =>
  readNonEmptyStringOrUndefined(value, {
    normalizeWhitespace: true,
    maxLength,
  });

function normalizeContactUrl(value: unknown): string | undefined {
  const raw = cleanText(value, MAX_CONTACT_URL_LENGTH);
  if (!raw) return undefined;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    return parsed.toString().slice(0, MAX_CONTACT_URL_LENGTH);
  } catch {
    return undefined;
  }
}

export function getDefaultWhatsAppContactConfig(): ScenarioWhatsAppContactConfig {
  return { version: 1 };
}

export function getEditableWhatsAppContactConfig(
  value: unknown
): ScenarioWhatsAppContactConfig {
  const record = asNullableRecord(value);
  if (!record) return getDefaultWhatsAppContactConfig();

  return {
    version: 1,
    formattedName: cleanText(
      record.formattedName ?? record.displayName ?? record.name,
      MAX_CONTACT_NAME_LENGTH
    ),
    firstName: cleanText(record.firstName, MAX_CONTACT_NAME_LENGTH),
    lastName: cleanText(record.lastName, MAX_CONTACT_NAME_LENGTH),
    company: cleanText(record.company, MAX_CONTACT_TEXT_LENGTH),
    title: cleanText(record.title, MAX_CONTACT_TEXT_LENGTH),
    phone: cleanText(record.phone, MAX_CONTACT_PHONE_LENGTH),
    email: cleanText(record.email, MAX_CONTACT_TEXT_LENGTH),
    websiteUrl: cleanText(
      record.websiteUrl ?? record.url,
      MAX_CONTACT_URL_LENGTH
    ),
  };
}

export function normalizeWhatsAppContactConfig(
  value: unknown
): ScenarioWhatsAppContactConfig | undefined {
  const draft = getEditableWhatsAppContactConfig(value);
  const formattedName = cleanText(draft.formattedName, MAX_CONTACT_NAME_LENGTH);
  if (!formattedName) return undefined;

  const phone = normalizeWhatsAppPhone(draft.phone) || undefined;
  const emailRaw = cleanText(draft.email, MAX_CONTACT_TEXT_LENGTH);
  const email =
    emailRaw && isProbablyEmail(normalizeEmail(emailRaw))
      ? normalizeEmail(emailRaw)
      : undefined;
  const websiteUrl = normalizeContactUrl(draft.websiteUrl);

  return {
    version: 1,
    formattedName,
    firstName: cleanText(draft.firstName, MAX_CONTACT_NAME_LENGTH),
    lastName: cleanText(draft.lastName, MAX_CONTACT_NAME_LENGTH),
    company: cleanText(draft.company, MAX_CONTACT_TEXT_LENGTH),
    title: cleanText(draft.title, MAX_CONTACT_TEXT_LENGTH),
    phone,
    email,
    websiteUrl,
  };
}

function splitFallbackName(formattedName: string) {
  const parts = formattedName.split(" ").filter(Boolean);
  if (parts.length <= 1) {
    return { firstName: formattedName };
  }
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

export function buildWhatsAppContactMessagePayload(
  value: unknown
): WhatsAppContactMessagePayload | null {
  const config = normalizeWhatsAppContactConfig(value);
  if (!config?.formattedName) return null;

  const fallbackName = splitFallbackName(config.formattedName);
  const company = cleanText(config.company, MAX_CONTACT_TEXT_LENGTH);
  const title = cleanText(config.title, MAX_CONTACT_TEXT_LENGTH);
  const payload: WhatsAppContactMessagePayload = {
    name: {
      formatted_name: config.formattedName,
      first_name:
        cleanText(config.firstName, MAX_CONTACT_NAME_LENGTH) ||
        fallbackName.firstName,
      last_name:
        cleanText(config.lastName, MAX_CONTACT_NAME_LENGTH) ||
        fallbackName.lastName,
    },
  };

  if (company || title) {
    payload.org = {
      ...(company ? { company } : {}),
      ...(title ? { title } : {}),
    };
  }
  if (config.phone) {
    payload.phones = [{ phone: config.phone, type: "WORK" }];
  }
  if (config.email) {
    payload.emails = [{ email: config.email, type: "WORK" }];
  }
  if (config.websiteUrl) {
    payload.urls = [{ url: config.websiteUrl, type: "WORK" }];
  }

  return payload;
}
