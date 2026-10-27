import {
  WHATSAPP_TEMPLATE_CONTEXT_KEYS,
  type listScenarioWhatsAppTemplateParameters,
  type ScenarioWhatsAppTemplateBinding,
  type ScenarioWhatsAppTemplateBindingIssue,
  type ScenarioWhatsAppTemplateContextKey,
} from "@icecore/scenario-contracts";
import type { TranslateFn } from "../../types";
import { prefixCardLabel } from "./action-node-utils";

export type TemplateBindingPromptInput = {
  key: string;
  label: string;
  prompt: string;
};
export type TemplateBindingParameter = ReturnType<
  typeof listScenarioWhatsAppTemplateParameters
>[number];
/** A binding that reads a value at send time rather than a fixed one. */
export type TemplateBindingSampleSource = Exclude<
  ScenarioWhatsAppTemplateBinding,
  { source: "literal" }
>;

export const TEMPLATE_BINDING_CONTEXT_LABELS: Record<
  ScenarioWhatsAppTemplateContextKey,
  string
> = {
  first_name: "variableFieldFirstName",
  last_name: "variableFieldLastName",
  username: "whatsappTemplateContextUsername",
  title: "whatsappTemplateContextTitle",
  full_name: "variableFieldFullName",
  name: "variableFieldFullName",
  customer_name: "variableFieldFullName",
  phone: "variableFieldPhone",
  wa_id: "variableFieldPhone",
  whatsapp_user_id: "whatsappTemplateContextUserId",
  whatsapp_parent_user_id: "whatsappTemplateContextParentUserId",
  whatsapp_id: "whatsappTemplateContextRecipientId",
  chat_id: "whatsappTemplateContextChatId",
  conversation_id: "whatsappTemplateContextConversationId",
  channel: "variableFieldChannel",
  preferred_language: "variableFieldLanguage",
  link: "whatsappTemplateContextLink",
  "cart.recovery_token": "whatsappTemplateContextCartToken",
  "cart.recovery_url": "whatsappTemplateContextCartUrl",
  "cart.total": "whatsappTemplateContextCartTotal",
  "cart.currency": "whatsappTemplateContextCartCurrency",
  "cart.item_count": "whatsappTemplateContextCartCount",
  "cart.items": "whatsappTemplateContextCartItems",
};
export const TEMPLATE_BINDING_CONTEXT_ALIASES: Partial<
  Record<ScenarioWhatsAppTemplateContextKey, ScenarioWhatsAppTemplateContextKey>
> = {
  full_name: "customer_name",
  name: "customer_name",
  wa_id: "phone",
};
const CONTEXT_OPTIONS = WHATSAPP_TEMPLATE_CONTEXT_KEYS.filter(
  key => !TEMPLATE_BINDING_CONTEXT_ALIASES[key]
);
/** What a merchant usually wants first; IDs and tokens follow under Technical. */
const CUSTOMER_CONTEXT_KEYS: readonly ScenarioWhatsAppTemplateContextKey[] = [
  "first_name",
  "last_name",
  "customer_name",
  "phone",
  "preferred_language",
];
export const TEMPLATE_BINDING_CONTEXT_GROUPS: ReadonlyArray<{
  label: string;
  description?: string;
  keys: readonly ScenarioWhatsAppTemplateContextKey[];
}> = [
  { label: "whatsappTemplateBindingContext", keys: CUSTOMER_CONTEXT_KEYS },
  {
    label: "whatsappTemplateBindingTechnical",
    keys: CONTEXT_OPTIONS.filter(
      key => !CUSTOMER_CONTEXT_KEYS.includes(key) && !key.startsWith("cart.")
    ),
  },
  {
    label: "whatsappTemplateBindingsCartGroup",
    description: "whatsappTemplateBindingsCartHint",
    keys: CONTEXT_OPTIONS.filter(key => key.startsWith("cart.")),
  },
];

export const TEMPLATE_BINDING_ISSUE_MESSAGE_KEYS: Record<
  ScenarioWhatsAppTemplateBindingIssue["code"],
  string
> = {
  bindings_invalid: "whatsappTemplateBindingRequired",
  binding_required: "whatsappTemplateBindingRequired",
  binding_source_invalid: "whatsappTemplateBindingRequired",
  binding_unknown_parameter: "whatsappTemplateBindingRequired",
  binding_value_missing: "whatsappTemplateBindingValueMissing",
  binding_input_unavailable: "whatsappTemplateBindingInputUnavailable",
};

export function formatTemplateBindingParameterLabel(
  parameter: TemplateBindingParameter,
  t: TranslateFn
) {
  const component =
    parameter.component === "button"
      ? t("whatsappTemplateBindingButton", {
          index: (parameter.buttonIndex ?? 0) + 1,
        })
      : t(
          parameter.component === "header"
            ? "whatsappTemplateBindingHeader"
            : "whatsappTemplateBindingBody"
        );
  return prefixCardLabel(
    parameter.cardIndex,
    `${component} · {{${parameter.variable}}}`,
    t
  );
}

export function formatTemplateBindingSourceLabel(
  binding: TemplateBindingSampleSource,
  promptInputs: readonly TemplateBindingPromptInput[],
  t: TranslateFn
) {
  return binding.source === "context"
    ? TEMPLATE_BINDING_CONTEXT_LABELS[binding.key]
      ? t(TEMPLATE_BINDING_CONTEXT_LABELS[binding.key])
      : binding.key
    : promptInputs.find(input => input.key === binding.key)?.label ||
        binding.key;
}
