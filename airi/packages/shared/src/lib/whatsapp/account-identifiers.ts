import {
  deriveWhatsAppSourceConnectionStatus,
  type WhatsAppSourceConnectionStatus,
} from "./source-state";
import {
  asWhatsAppRecord as asRecord,
  compactWhatsAppStringOrUndefined as compactWhatsAppAccountString,
} from "./value-utils";

export type WhatsAppAccountIdentifiers = {
  phoneNumberId?: string;
  csId?: string;
  wabaId?: string;
  messagingAccountId?: string;
  waacId?: string;
  businessId?: string;
};

type IdentifierInput = Record<string, unknown> | null | undefined;

type WhatsAppAccountRowInput = {
  sourceId: string;
  workspaceId: string;
  companyId?: string | null;
  credentials: IdentifierInput;
  isDefault?: boolean;
};

export type WhatsAppAccountRow = {
  source_id: string;
  workspace_id: string;
  company_id?: string | null;
  account_key: string;
  phone_number_id?: string | null;
  cs_id?: string | null;
  messaging_account_id?: string | null;
  legacy_waba_id?: string | null;
  waac_id?: string | null;
  business_id?: string | null;
  display_phone_number?: string | null;
  verified_name?: string | null;
  is_default?: boolean;
  /** "inactive" marks observed rows that are not bound to a source. */
  connection_status?: WhatsAppSourceConnectionStatus | "inactive";
  raw_credentials?: Record<string, unknown>;
};

export type WhatsAppSourceResolutionFilter = Record<string, string>;

const SENSITIVE_CREDENTIAL_KEY_PARTS = [
  "token",
  "secret",
  "password",
  "pin",
  "key",
];

export { compactWhatsAppAccountString };

function readFirstString(
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = compactWhatsAppAccountString(input[key]);
    if (value) return value;
  }
  return undefined;
}

export function normalizeWhatsAppAccountIdentifiers(
  input: IdentifierInput,
): WhatsAppAccountIdentifiers {
  const record = asRecord(input);
  const csId = readFirstString(record, "cs_id", "csId");
  const phoneNumberId =
    readFirstString(record, "phone_number_id", "phoneNumberId") || csId;
  const wabaId = readFirstString(record, "waba_id", "wabaId");
  const messagingAccountId =
    readFirstString(record, "messaging_account_id", "messagingAccountId") ||
    wabaId;

  return {
    phoneNumberId,
    csId,
    wabaId: wabaId || messagingAccountId,
    messagingAccountId,
    waacId: readFirstString(record, "waac_id", "waacId"),
    businessId: readFirstString(record, "business_id", "businessId"),
  };
}

/** Drop Meta's deprecated `paid_messaging_account_id` alias from stored credentials. */
export function stripDeprecatedWhatsAppCredentialAliases(
  credentials: Record<string, unknown>,
): void {
  delete credentials.paid_messaging_account_id;
  delete credentials.paidMessagingAccountId;
}

export function buildWhatsAppCredentialAccountPatch(
  input: IdentifierInput,
): Record<string, string> {
  const ids = normalizeWhatsAppAccountIdentifiers(input);
  const patch: Record<string, string> = {};

  const phoneNumberId = ids.phoneNumberId || ids.csId;
  if (phoneNumberId) patch.phone_number_id = phoneNumberId;
  if (ids.csId) patch.cs_id = ids.csId;

  const wabaId = ids.wabaId || ids.messagingAccountId;
  const messagingAccountId = ids.messagingAccountId || ids.wabaId;
  if (wabaId) patch.waba_id = wabaId;
  if (messagingAccountId) patch.messaging_account_id = messagingAccountId;

  if (ids.waacId) patch.waac_id = ids.waacId;
  if (ids.businessId) patch.business_id = ids.businessId;

  return patch;
}

export function extractWhatsAppIdentifiersFromWebhookValue(params: {
  entryId?: unknown;
  value?: unknown;
}): WhatsAppAccountIdentifiers {
  const value = asRecord(params.value);
  const metadata = asRecord(value.metadata);
  return normalizeWhatsAppAccountIdentifiers({
    waba_id: params.entryId,
    messaging_account_id:
      metadata.messaging_account_id ?? value.messaging_account_id,
    phone_number_id: metadata.phone_number_id ?? value.phone_number_id,
    cs_id: metadata.cs_id ?? value.cs_id,
    waac_id: metadata.waac_id ?? value.waac_id,
  });
}

export function buildWhatsAppSourceResolutionFilters(
  input: IdentifierInput,
): WhatsAppSourceResolutionFilter[] {
  const ids = normalizeWhatsAppAccountIdentifiers(input);
  const filters: WhatsAppSourceResolutionFilter[] = [];
  const seen = new Set<string>();
  const add = (key: string, value?: string) => {
    if (!value) return;
    const signature = `${key}:${value}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    filters.push({ [key]: value });
  };

  add("credentials->>phone_number_id", ids.phoneNumberId);
  add("credentials->>cs_id", ids.csId);
  add("credentials->>messaging_account_id", ids.messagingAccountId);
  add("credentials->>waba_id", ids.wabaId);
  add("credentials->>waac_id", ids.waacId);

  return filters;
}

function buildAccountKey(params: {
  sourceId: string;
  identifiers: WhatsAppAccountIdentifiers;
}): string {
  const ids = params.identifiers;
  if (ids.phoneNumberId) return `phone:${ids.phoneNumberId}`;
  if (ids.csId) return `cs:${ids.csId}`;
  if (ids.messagingAccountId) return `messaging:${ids.messagingAccountId}`;
  if (ids.wabaId) return `waba:${ids.wabaId}`;
  if (ids.waacId) return `waac:${ids.waacId}`;
  return `source:${params.sourceId}`;
}

function sanitizeWhatsAppAccountRawCredentials(
  credentials: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = Object.fromEntries(
    Object.entries(credentials).filter(([key]) => {
      const normalizedKey = key.toLowerCase();
      return !SENSITIVE_CREDENTIAL_KEY_PARTS.some((part) =>
        normalizedKey.includes(part),
      );
    }),
  );
  stripDeprecatedWhatsAppCredentialAliases(sanitized);
  return sanitized;
}

export function buildWhatsAppAccountRowsForSource(
  params: WhatsAppAccountRowInput,
): WhatsAppAccountRow[] {
  const credentials = asRecord(params.credentials);
  const ids = normalizeWhatsAppAccountIdentifiers(credentials);
  const hasAnyAccountIdentifier = Boolean(
    ids.phoneNumberId ||
      ids.csId ||
      ids.messagingAccountId ||
      ids.wabaId ||
      ids.waacId,
  );

  if (!hasAnyAccountIdentifier) {
    return [];
  }

  return [
    {
      source_id: params.sourceId,
      workspace_id: params.workspaceId,
      company_id: params.companyId || null,
      account_key: buildAccountKey({
        sourceId: params.sourceId,
        identifiers: ids,
      }),
      phone_number_id: ids.phoneNumberId || null,
      cs_id: ids.csId || null,
      messaging_account_id: ids.messagingAccountId || null,
      legacy_waba_id: ids.wabaId || null,
      waac_id: ids.waacId || null,
      business_id: ids.businessId || null,
      display_phone_number:
        compactWhatsAppAccountString(credentials.display_phone_number) || null,
      verified_name:
        compactWhatsAppAccountString(credentials.verified_name) || null,
      is_default: params.isDefault === true,
      connection_status: deriveWhatsAppSourceConnectionStatus(credentials),
      raw_credentials: sanitizeWhatsAppAccountRawCredentials(credentials),
    },
  ];
}
