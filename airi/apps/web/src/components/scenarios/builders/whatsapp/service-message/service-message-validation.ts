import type {
  ScenarioWhatsAppServiceMessage,
  ScenarioWhatsAppServiceMessageDiagnostic,
  ScenarioWhatsAppServiceMessageDiagnosticCode,
  ScenarioWhatsAppServiceMessageKind,
} from "@icecore/scenario-contracts";
import {
  validateScenarioWhatsAppServiceMessage,
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
} from "@icecore/scenario-contracts";

/** Locale keys for short field-level validation helpers. */
const DIAGNOSTIC_MESSAGE_KEYS: Partial<
  Record<ScenarioWhatsAppServiceMessageDiagnosticCode, string>
> = {
  body_required: "whatsappServiceValidationBodyRequired",
  body_too_long: "whatsappServiceValidationBodyTooLong",
  button_label_required: "whatsappServiceValidationButtonLabelRequired",
  button_label_too_long: "whatsappServiceValidationButtonLabelTooLong",
  url_invalid: "whatsappServiceValidationUrlInvalid",
  signup_link_required: "whatsappServiceValidationSignupLinkRequired",
  contact_invalid: "whatsappServiceValidationContactInvalid",
  location_coordinates_invalid: "whatsappServiceValidationLocationInvalid",
  flow_invalid: "whatsappServiceValidationFlowInvalid",
  appointment_invalid: "whatsappServiceValidationAppointment",
  commerce_invalid: "whatsappServiceValidationCommerce",
  media_required: "whatsappServiceValidationMediaRequired",
  media_type_invalid: "whatsappServiceValidationMediaTypeInvalid",
  voice_format_invalid: "whatsappServiceValidationVoiceFormatInvalid",
  voice_call_ttl_invalid: "whatsappServiceValidationCallTtl",
  voice_call_payload_too_long: "whatsappServiceValidationListTextTooLong",
  reply_button_count_invalid: "whatsappServiceValidationReplyButtonCount",
  list_section_count_invalid: "whatsappServiceValidationListSections",
  list_row_count_invalid: "whatsappServiceValidationListRows",
  list_section_title_too_long: "whatsappServiceValidationListTextTooLong",
  list_row_title_required: "whatsappServiceValidationListRowTitleRequired",
  list_row_title_too_long: "whatsappServiceValidationListTextTooLong",
  list_row_description_too_long: "whatsappServiceValidationListTextTooLong",
  carousel_card_count_invalid: "whatsappServiceValidationCarouselCardCount",
  carousel_button_shape_mismatch:
    "whatsappServiceValidationCarouselButtonShape",
  header_required: "whatsappServiceValidationHeaderRequired",
  header_too_long: "whatsappServiceValidationHeaderTooLong",
  footer_too_long: "whatsappServiceValidationFooterTooLong",
  prompt_input_key_invalid: "whatsappServiceValidationPromptInputKey",
  prompt_input_prompt_required: "whatsappServiceValidationPromptInputPrompt",
  prompt_input_prompt_too_long:
    "whatsappServiceValidationPromptInputPromptTooLong",
  prompt_input_label_too_long: "whatsappServiceValidationPromptInputLabel",
  prompt_input_key_duplicate: "whatsappServiceValidationPromptInputDuplicate",
  prompt_input_count_invalid: "whatsappServiceValidationPromptInputCount",
  prompt_inputs_kind_unsupported:
    "whatsappServiceValidationPromptInputsKindUnsupported",
  prompt_inputs_require_fixed_body:
    "whatsappServiceValidationPromptInputsRequireFixedBody",
  prompt_input_max_length_invalid:
    "whatsappServiceValidationPromptInputMaxLength",
  prompt_input_choices_invalid: "whatsappServiceValidationPromptInputChoices",
};

export function getServiceMessageValidationDiagnostics(
  value: ScenarioWhatsAppServiceMessage
): ScenarioWhatsAppServiceMessageDiagnostic[] {
  return validateScenarioWhatsAppServiceMessage(value);
}

export function serviceMessageDiagnosticMessageKey(
  code: ScenarioWhatsAppServiceMessageDiagnosticCode
): string {
  return DIAGNOSTIC_MESSAGE_KEYS[code] ?? "whatsappServiceMessageInvalid";
}

/**
 * The `message.body` limit per kind, as `validateScenarioWhatsAppServiceMessage`
 * applies it. Every kind is listed so a new one has to pick its limit here.
 */
const BODY_LIMITS: Record<ScenarioWhatsAppServiceMessageKind, number> = {
  text: WHATSAPP_SERVICE_MESSAGE_LIMITS.body.text,
  list: WHATSAPP_SERVICE_MESSAGE_LIMITS.body.text,
  media: WHATSAPP_SERVICE_MESSAGE_LIMITS.body.mediaCaption,
  reply_buttons: WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
  cta_url: WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
  media_carousel: WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
  flow: WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
  appointment: WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
  location_request: WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
  request_contact_info: WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
  voice_call: WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
  // No `message.body`: commerce text is `commerce.bodyText`.
  contacts: WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
  location: WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive,
  commerce: WHATSAPP_SERVICE_MESSAGE_LIMITS.commerce.body,
};

/** The character limit the contract applies to the body at `fieldKey`. */
function serviceMessageBodyLimit(
  value: ScenarioWhatsAppServiceMessage,
  fieldKey: string
): number {
  const limits = WHATSAPP_SERVICE_MESSAGE_LIMITS;
  if (/^cards\.\d+\.bodyText$/.test(fieldKey)) return limits.carousel.cardBody;
  if (fieldKey === "commerce.bodyText") return limits.commerce.body;
  return BODY_LIMITS[value.message.kind];
}

/** ICU values a diagnostic's message needs, such as the body limit. */
export function serviceMessageDiagnosticMessageValues(
  code: ScenarioWhatsAppServiceMessageDiagnosticCode,
  fieldKey: string,
  value: ScenarioWhatsAppServiceMessage
): Record<string, number> | undefined {
  return code === "body_too_long"
    ? { max: serviceMessageBodyLimit(value, fieldKey) }
    : undefined;
}
