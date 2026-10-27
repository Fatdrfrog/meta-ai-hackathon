/**
 * WhatsApp Flows Graph API + Cloud API send contracts.
 * Source: Meta Flows API and Sending a Flow (updated 2026-06-16).
 */

export const WHATSAPP_FLOW_CATEGORIES = [
  "SIGN_UP",
  "SIGN_IN",
  "APPOINTMENT_BOOKING",
  "LEAD_GENERATION",
  "CONTACT_US",
  "CUSTOMER_SUPPORT",
  "SURVEY",
  "OTHER",
] as const;

export type WhatsAppFlowCategory = (typeof WHATSAPP_FLOW_CATEGORIES)[number];

export const WHATSAPP_FLOW_DEFAULT_CATEGORY: WhatsAppFlowCategory = "OTHER";

export const WHATSAPP_FLOW_STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "DEPRECATED",
  "BLOCKED",
  "THROTTLED",
] as const;

export type WhatsAppFlowStatus = (typeof WHATSAPP_FLOW_STATUSES)[number];

export const WHATSAPP_FLOW_ACTIONS = ["navigate", "data_exchange"] as const;

export type WhatsAppFlowActionType = (typeof WHATSAPP_FLOW_ACTIONS)[number];

export const WHATSAPP_FLOW_SEND_MODES = ["draft", "published"] as const;

export type WhatsAppFlowSendMode = (typeof WHATSAPP_FLOW_SEND_MODES)[number];

export const WHATSAPP_FLOW_MESSAGE_VERSION = "3" as const;

export const WHATSAPP_FLOW_DEFAULT_ENTRY_SCREEN = "FIRST_ENTRY_SCREEN";

export const WHATSAPP_FLOW_DEFAULT_TOKEN = "unused";

export const WHATSAPP_FLOW_ASSET_NAME = "flow.json";

export const WHATSAPP_FLOW_ASSET_TYPE = "FLOW_JSON";

export const WHATSAPP_FLOW_LIMITS = {
  TEMPLATE_BUTTON_TEXT_MAX_LENGTH: 25,
  INTERACTIVE_CTA_MAX_LENGTH: 30,
  HEADER_TEXT_MAX_LENGTH: 60,
  FOOTER_TEXT_MAX_LENGTH: 60,
  BODY_TEXT_MAX_LENGTH: 1024,
  NAME_MAX_LENGTH: 200,
  MIGRATE_MAX_FLOWS: 100,
  JSON_ASSET_MAX_BYTES: 10 * 1024 * 1024,
} as const;

export const WHATSAPP_FLOW_HEALTH_CAN_SEND = [
  "AVAILABLE",
  "LIMITED",
  "BLOCKED",
] as const;

export type WhatsAppFlowHealthCanSend =
  (typeof WHATSAPP_FLOW_HEALTH_CAN_SEND)[number];

const WHATSAPP_FLOW_CATEGORY_SET = new Set<string>(WHATSAPP_FLOW_CATEGORIES);

export function isWhatsAppFlowCategory(
  value: unknown,
): value is WhatsAppFlowCategory {
  return typeof value === "string" && WHATSAPP_FLOW_CATEGORY_SET.has(value);
}

export function normalizeWhatsAppFlowCategories(
  value: unknown,
): WhatsAppFlowCategory[] {
  if (!Array.isArray(value)) return [WHATSAPP_FLOW_DEFAULT_CATEGORY];
  const categories = value.filter(isWhatsAppFlowCategory);
  return categories.length > 0 ? categories : [WHATSAPP_FLOW_DEFAULT_CATEGORY];
}

export type WhatsAppFlowCreateRequest = {
  name: string;
  categories: WhatsAppFlowCategory[];
  flow_json?: string;
  publish?: boolean;
  clone_flow_id?: string;
  endpoint_uri?: string;
};

export type WhatsAppFlowUpdateMetadataRequest = {
  name?: string;
  categories?: WhatsAppFlowCategory[];
  endpoint_uri?: string;
  application_id?: string;
};

export type WhatsAppFlowMigrateRequest = {
  destinationWabaId: string;
  sourceWabaId: string;
  sourceFlowNames?: string[];
};

export type WhatsAppFlowMigratedFlow = {
  source_name: string;
  source_id: string;
  migrated_id: string;
};

export type WhatsAppFlowMigrationFailure = {
  source_name: string;
  error_code?: string;
  error_message?: string;
};

export type WhatsAppFlowMigrateResponse = {
  migrated_flows: WhatsAppFlowMigratedFlow[];
  failed_flows: WhatsAppFlowMigrationFailure[];
};

export type WhatsAppFlowActionPayload = {
  screen?: string;
  data?: Record<string, unknown> | string;
};

export type WhatsAppFlowHealthEntityType =
  | "FLOW"
  | "WABA"
  | "BUSINESS"
  | "APP"
  | "PHONE";

export type WhatsAppFlowHealthEntity = {
  entity_type: WhatsAppFlowHealthEntityType | string;
  id?: string;
  can_send_message?: WhatsAppFlowHealthCanSend;
  additional_info?: string[];
  errors?: Array<{
    error_code?: number;
    error_description?: string;
    possible_solution?: string;
  }>;
};

export type WhatsAppFlowHealthStatus = {
  can_send_message?: WhatsAppFlowHealthCanSend;
  entities?: WhatsAppFlowHealthEntity[];
};

export type WhatsAppFlowPreview = {
  preview_url: string;
  expires_at?: string;
};

export type WhatsAppFlowPreviewQuery = {
  interactive?: boolean;
  flow_token?: string;
  flow_action?: WhatsAppFlowActionType;
  flow_action_payload?: string;
  phone_number?: string;
  debug?: boolean;
};

export type WhatsAppFlowAsset = {
  name: typeof WHATSAPP_FLOW_ASSET_NAME | string;
  asset_type: typeof WHATSAPP_FLOW_ASSET_TYPE | string;
  download_url?: string;
};

export type WhatsAppFlowValidationError = {
  error?: string;
  error_type?: string;
  message?: string;
  line_start?: number;
  line_end?: number;
  column_start?: number;
  column_end?: number;
  pointers?: Array<{
    line_start?: number;
    line_end?: number;
    column_start?: number;
    column_end?: number;
    path?: string;
  }>;
};

export const WHATSAPP_FLOW_DETAIL_FIELDS = [
  "id",
  "name",
  "categories",
  "preview",
  "status",
  "validation_errors",
  "json_version",
  "data_api_version",
  "endpoint_uri",
  "whatsapp_business_account",
  "application",
  "health_status",
] as const;

export type WhatsAppFlowDetails = {
  id: string;
  name?: string;
  status?: WhatsAppFlowStatus;
  categories?: WhatsAppFlowCategory[];
  validation_errors?: WhatsAppFlowValidationError[];
  json_version?: string;
  data_api_version?: string;
  endpoint_uri?: string;
  preview?: WhatsAppFlowPreview;
  whatsapp_business_account?: { id?: string };
  application?: { id?: string };
  health_status?: WhatsAppFlowHealthStatus;
};

export function normalizeWhatsAppFlowActionData(
  value: unknown,
): Record<string, unknown> | undefined {
  let parsed: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    ([, entry]) => entry !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export type WhatsAppInteractiveFlowParameters = {
  flow_message_version: typeof WHATSAPP_FLOW_MESSAGE_VERSION;
  flow_cta: string;
  flow_id?: string;
  flow_name?: string;
  mode?: WhatsAppFlowSendMode;
  flow_token?: string;
  flow_action?: WhatsAppFlowActionType;
  flow_action_payload?: WhatsAppFlowActionPayload;
};

export type WhatsAppTemplateFlowSendAction = {
  flow_token?: string;
  flow_action_data?: Record<string, unknown>;
};

export type WhatsAppTemplateFlowIdentifier =
  | { kind: "flow_id"; flow_id: string }
  | { kind: "flow_name"; flow_name: string }
  | { kind: "flow_json"; flow_json: string };

function compactFlowField(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function pickWhatsAppTemplateFlowIdentifier(button: {
  flow_id?: unknown;
  flow_name?: unknown;
  flow_json?: unknown;
}): WhatsAppTemplateFlowIdentifier | null {
  const flowId = compactFlowField(button.flow_id);
  const flowName = compactFlowField(button.flow_name);
  const flowJson = compactFlowField(button.flow_json);
  const present = [
    flowId ? ({ kind: "flow_id", flow_id: flowId } as const) : null,
    flowName ? ({ kind: "flow_name", flow_name: flowName } as const) : null,
    flowJson ? ({ kind: "flow_json", flow_json: flowJson } as const) : null,
  ].filter((value): value is WhatsAppTemplateFlowIdentifier => value !== null);

  return present.length === 1 && present[0] ? present[0] : null;
}

export function pickWhatsAppInteractiveFlowIdentity(params: {
  flow_id?: unknown;
  flow_name?: unknown;
}):
  | { kind: "flow_id"; flow_id: string }
  | { kind: "flow_name"; flow_name: string }
  | null {
  const flowId = compactFlowField(params.flow_id);
  const flowName = compactFlowField(params.flow_name);
  if (flowId && flowName) return null;
  if (flowId) return { kind: "flow_id", flow_id: flowId };
  if (flowName) return { kind: "flow_name", flow_name: flowName };
  return null;
}
