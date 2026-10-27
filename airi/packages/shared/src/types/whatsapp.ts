/**
 * WhatsApp Business API Template Types
 * Shared across all apps for consistency
 */

import type { WhatsAppFlowActionType } from "./whatsapp-flows";

export type {
  WhatsAppFlowActionPayload,
  WhatsAppFlowActionType,
  WhatsAppFlowAsset,
  WhatsAppFlowCategory,
  WhatsAppFlowCreateRequest,
  WhatsAppFlowDetails,
  WhatsAppFlowHealthStatus,
  WhatsAppFlowMigrateRequest,
  WhatsAppFlowMigrateResponse,
  WhatsAppFlowPreview,
  WhatsAppFlowSendMode,
  WhatsAppFlowStatus,
  WhatsAppFlowUpdateMetadataRequest,
  WhatsAppInteractiveFlowParameters,
  WhatsAppTemplateFlowIdentifier,
  WhatsAppTemplateFlowSendAction,
} from "./whatsapp-flows";

export {
  normalizeWhatsAppFlowActionData,
  normalizeWhatsAppFlowCategories,
  pickWhatsAppInteractiveFlowIdentity,
  pickWhatsAppTemplateFlowIdentifier,
  WHATSAPP_FLOW_ACTIONS,
  WHATSAPP_FLOW_ASSET_NAME,
  WHATSAPP_FLOW_ASSET_TYPE,
  WHATSAPP_FLOW_CATEGORIES,
  WHATSAPP_FLOW_DEFAULT_CATEGORY,
  WHATSAPP_FLOW_DEFAULT_ENTRY_SCREEN,
  WHATSAPP_FLOW_DETAIL_FIELDS,
  WHATSAPP_FLOW_LIMITS,
  WHATSAPP_FLOW_MESSAGE_VERSION,
  WHATSAPP_FLOW_SEND_MODES,
  WHATSAPP_FLOW_STATUSES,
} from "./whatsapp-flows";

// ============================================================================
// TEMPLATE STATUS & CATEGORY
// ============================================================================

export type WhatsAppTemplateStatus =
  | "APPROVED"
  | "PENDING"
  | "REJECTED"
  | "PAUSED"
  | "LIMIT_EXCEEDED";

export type WhatsAppTemplateCategory =
  | "MARKETING"
  | "UTILITY"
  | "AUTHENTICATION";

export type WhatsAppTemplateQuality = "GREEN" | "YELLOW" | "RED";

export type WhatsAppMarketingMessagesBidStrategy = "LOWEST_COST_WITH_BID_CAP";

export interface WhatsAppMarketingMessagesOptimizationSpec {
  bid_amount: number;
  bid_strategy: WhatsAppMarketingMessagesBidStrategy;
}

// ============================================================================
// TEMPLATE COMPONENTS
// ============================================================================

export type WhatsAppHeaderFormat =
  | "TEXT"
  | "IMAGE"
  | "VIDEO"
  | "DOCUMENT"
  | "LOCATION";

export type WhatsAppCarouselCardHeaderFormat = "IMAGE" | "VIDEO";

export type WhatsAppButtonType =
  | "QUICK_REPLY"
  | "URL"
  | "PHONE_NUMBER"
  | "FLOW"
  | "OTP"
  | "REQUEST_CONTACT_INFO";

export type WhatsAppOtpButtonType = "COPY_CODE" | "ONE_TAP" | "ZERO_TAP";

export interface WhatsAppComponentExample {
  header_handle?: string[];
  header_text?: string[];
  header_text_named_params?: Array<{
    param_name?: string;
    example?: string;
  }>;
  body_text?: string[][];
  body_text_named_params?: Array<{
    param_name?: string;
    example?: string;
  }>;
  button_text?: string[];
  button_url?: string[];
  button_phone_number?: string[];
}

export interface WhatsAppHeaderComponent {
  type: "HEADER";
  format: WhatsAppHeaderFormat;
  /** Raw WhatsApp text. Preserve WhatsApp formatting markers such as *bold*. */
  text?: string;
  example?: WhatsAppComponentExample;
}

export interface WhatsAppBodyComponent {
  type: "BODY";
  /** Raw WhatsApp template body text. Preserve *bold*, _italic_, ~strike~, and ```monospace``` markers for Meta. */
  text?: string;
  example?: WhatsAppComponentExample;
  /** Authentication creation uses Meta's preset body instead of custom text. */
  add_security_recommendation?: boolean;
}

export interface WhatsAppFooterComponent {
  type: "FOOTER";
  /** Raw WhatsApp text. Preserve supported WhatsApp formatting markers when present. */
  text?: string;
  /** Authentication expiry warning, in minutes (1–90). */
  code_expiration_minutes?: number;
}

export interface WhatsAppButtonComponent {
  type: "BUTTONS";
  buttons: Array<
    | {
        type: "QUICK_REPLY";
        text: string;
        example?: string[];
      }
    | {
        type: "URL";
        text: string;
        url: string;
        example?: string[];
      }
    | {
        type: "PHONE_NUMBER";
        text: string;
        phone_number: string;
      }
    | {
        type: "FLOW";
        text: string;
        /** Exactly one of flow_id, flow_name, or flow_json is required. */
        flow_id?: string | number;
        flow_name?: string;
        flow_json?: string;
        flow_action?: WhatsAppFlowActionType;
        navigate_screen?: string;
      }
    | {
        type: "OTP";
        otp_type: WhatsAppOtpButtonType;
        text?: string;
        autofill_text?: string;
        package_name?: string;
        signature_hash?: string;
        supported_apps?: Array<{
          package_name: string;
          signature_hash: string;
        }>;
        zero_tap_terms_accepted?: boolean;
      }
    | {
        type: "REQUEST_CONTACT_INFO";
        text?: string;
      }
  >;
}

export type WhatsAppCarouselCardButton = Extract<
  WhatsAppButtonComponent["buttons"][number],
  { type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER" }
>;

export type WhatsAppCarouselCardComponent =
  | {
      type: "HEADER";
      format: WhatsAppCarouselCardHeaderFormat;
      example?: WhatsAppComponentExample;
    }
  | (WhatsAppBodyComponent & { text: string })
  | {
      type: "BUTTONS";
      buttons: WhatsAppCarouselCardButton[];
    };

export interface WhatsAppCarouselCard {
  components: WhatsAppCarouselCardComponent[];
}

export interface WhatsAppCarouselComponent {
  type: "CAROUSEL";
  cards: WhatsAppCarouselCard[];
}

export type WhatsAppComponent =
  | WhatsAppHeaderComponent
  | WhatsAppBodyComponent
  | WhatsAppFooterComponent
  | WhatsAppButtonComponent
  | WhatsAppCarouselComponent;

// ============================================================================
// TEMPLATE TYPE
// ============================================================================

export interface WhatsAppTemplate {
  id?: string;
  name: string;
  language: string;
  status: WhatsAppTemplateStatus;
  category: WhatsAppTemplateCategory;
  previous_category?: WhatsAppTemplateCategory;
  quality_rating?: WhatsAppTemplateQuality;
  optimization_spec?: WhatsAppMarketingMessagesOptimizationSpec;
  components?: WhatsAppComponent[];
  rejected_reason?: string;
  // Additional metadata from Graph API
  message_send_timestamp?: string;
  message_send_rate_limit?: string;
}

// ============================================================================
// TEMPLATE CREATE/UPDATE PAYLOADS
// ============================================================================

export interface CreateWhatsAppTemplatePayload {
  name: string;
  language: string;
  category: WhatsAppTemplateCategory;
  components: WhatsAppComponent[];
  allow_category_change?: boolean;
  optimization_spec?: WhatsAppMarketingMessagesOptimizationSpec;
}

export interface UpdateWhatsAppTemplatePayload {
  category?: WhatsAppTemplateCategory;
  components?: WhatsAppComponent[];
  allow_category_change?: boolean;
  optimization_spec?: WhatsAppMarketingMessagesOptimizationSpec;
}

// ============================================================================
// CTWA WELCOME MESSAGE SEQUENCES
// ============================================================================

export interface WhatsAppWelcomeMessageSequenceIceBreaker {
  title: string;
}

export interface WhatsAppWelcomeMessageSequencePayload {
  text?: string;
  autofillMessageContent?: string;
  iceBreakers?: WhatsAppWelcomeMessageSequenceIceBreaker[];
}

export interface WhatsAppWelcomeMessageSequence {
  id: string;
  name: string;
  text?: string;
  autofillMessageContent?: string;
  iceBreakers?: WhatsAppWelcomeMessageSequenceIceBreaker[];
  is_used_in_ad?: boolean;
  created_time?: string;
  updated_time?: string;
  sourceId?: string;
  wabaId?: string;
  lastSyncedAt?: string;
}

export interface CreateWhatsAppWelcomeMessageSequencePayload
  extends WhatsAppWelcomeMessageSequencePayload {
  name: string;
}

export interface UpdateWhatsAppWelcomeMessageSequencePayload
  extends WhatsAppWelcomeMessageSequencePayload {
  sequenceId: string;
  name?: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const TEMPLATE_VARIABLE_REGEX = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function sortTemplateVariables(values: Iterable<string>): string[] {
  const unique = Array.from(new Set(values));
  const numeric = unique
    .filter((value) => /^\d+$/.test(value))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const named = unique
    .filter((value) => !/^\d+$/.test(value))
    .sort((a, b) => a.localeCompare(b));
  return [...numeric, ...named];
}

/**
 * Extract variable placeholders from template text
 * Supports both positional (e.g. {{1}}) and named (e.g. {{first_name}}) variables.
 */
export function extractTemplateVariables(text: string): string[] {
  const variables = new Set<string>();
  const matches = text.matchAll(TEMPLATE_VARIABLE_REGEX);
  for (const match of matches) {
    if (match[1]) {
      variables.add(match[1]);
    }
  }
  return sortTemplateVariables(variables);
}

/**
 * Extract variables in the same order they appear in text.
 * Useful when building parameter arrays for send-template APIs.
 */
export function extractTemplateVariablesInOrder(text: string): string[] {
  const variables: string[] = [];
  const seen = new Set<string>();
  const matches = text.matchAll(TEMPLATE_VARIABLE_REGEX);
  for (const match of matches) {
    const key = match[1];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    variables.push(key);
  }
  return variables;
}

/**
 * Get all variables from a template's components
 */
export function getTemplateVariables(template: WhatsAppTemplate): string[] {
  const variables = new Set<string>();

  template.components?.forEach((component) => {
    if (component.type === "HEADER" && component.text) {
      extractTemplateVariables(component.text).forEach((v) => variables.add(v));
    }
    if (component.type === "BODY" && component.text) {
      extractTemplateVariables(component.text).forEach((v) => variables.add(v));
    }
    if (component.type === "BUTTONS") {
      component.buttons?.forEach((button) => {
        if (button.type === "URL" && button.url) {
          extractTemplateVariables(button.url).forEach((v) => variables.add(v));
        }
      });
    }
    if (component.type === "CAROUSEL") {
      component.cards?.forEach((card) => {
        card.components?.forEach((cardComponent) => {
          if (cardComponent.type === "BODY" && cardComponent.text) {
            extractTemplateVariables(cardComponent.text).forEach((v) =>
              variables.add(v),
            );
          }
          if (cardComponent.type === "BUTTONS") {
            cardComponent.buttons?.forEach((button) => {
              if (button.type === "URL" && button.url) {
                extractTemplateVariables(button.url).forEach((v) =>
                  variables.add(v),
                );
              }
            });
          }
        });
      });
    }
  });

  return sortTemplateVariables(variables);
}

/**
 * Validate template name format
 * Template names must be lowercase, alphanumeric, and can contain underscores
 */
export function isValidTemplateName(name: string): boolean {
  return /^[a-z0-9_]+$/.test(name) && name.length >= 1 && name.length <= 512;
}

/**
 * Get component text preview (for display in lists)
 */
export function getTemplatePreview(template: WhatsAppTemplate): string {
  const parts: string[] = [];

  for (const component of template.components || []) {
    if (component.type === "BODY" && component.text) {
      parts.push(component.text);
      continue;
    }
    if (component.type !== "CAROUSEL") continue;
    for (const card of component.cards) {
      for (const cardComponent of card.components) {
        if (cardComponent.type === "BODY" && cardComponent.text) {
          parts.push(cardComponent.text);
        }
      }
    }
  }

  return parts.join(" ").trim();
}

export type GraphApiErrorBody = {
  message?: string;
  error_user_msg?: string;
  error_data?: {
    details?: string;
  };
  code?: number | string;
  type?: string;
};
