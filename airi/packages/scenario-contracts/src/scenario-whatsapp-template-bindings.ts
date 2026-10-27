import {
  extractTemplateVariablesInOrder,
  type WhatsAppComponent,
  type WhatsAppCarouselCardComponent,
} from "./whatsapp-template-types";
import { isScenarioPromptInputKey } from "./scenario-prompt-inputs";
import { isRecord } from "./value-guards";

/** Only data already supplied by the scenario runtime may be selected. */
export const WHATSAPP_TEMPLATE_CONTEXT_KEYS = [
  "first_name",
  "last_name",
  "username",
  "title",
  "full_name",
  "name",
  "customer_name",
  "phone",
  "wa_id",
  "whatsapp_user_id",
  "whatsapp_parent_user_id",
  "whatsapp_id",
  "chat_id",
  "conversation_id",
  "channel",
  "preferred_language",
  "link",
  "cart.recovery_token",
  "cart.recovery_url",
  "cart.total",
  "cart.currency",
  "cart.item_count",
  "cart.items",
] as const;

export type ScenarioWhatsAppTemplateContextKey =
  (typeof WHATSAPP_TEMPLATE_CONTEXT_KEYS)[number];

export type ScenarioWhatsAppTemplateBinding =
  | { source: "literal"; value: string }
  | { source: "context"; key: ScenarioWhatsAppTemplateContextKey }
  | { source: "prompt_input"; key: string };

/** Absence preserves legacy resolution. Presence opts the whole action into explicit binding. */
export type ScenarioWhatsAppTemplateBindings = {
  version: 1;
  parameters: Record<string, ScenarioWhatsAppTemplateBinding>;
};

export type ScenarioWhatsAppTemplateParameter = {
  id: string;
  component: "header" | "body" | "button";
  variable: string;
  buttonIndex?: number;
  cardIndex?: number;
  text: string;
  url?: string;
};

export type ScenarioWhatsAppTemplateBindingIssue = {
  code:
    | "bindings_invalid"
    | "binding_required"
    | "binding_source_invalid"
    | "binding_unknown_parameter"
    | "binding_input_unavailable"
    | "binding_value_missing";
  parameterId?: string;
};

type ParameterIdentity = Pick<
  ScenarioWhatsAppTemplateParameter,
  "component" | "variable" | "buttonIndex" | "cardIndex"
>;

/** Customer data a send can fall back to for a variable it has no value for. */
export type ScenarioWhatsAppTemplateFallbackContextKey = Extract<
  ScenarioWhatsAppTemplateContextKey,
  "customer_name" | "phone" | "conversation_id" | "chat_id" | "link"
>;

/**
 * What a send fills a variable with when the step sets no values of its own
 * and no customer data is named after the variable: {{1}} the customer's
 * name, {{2}} the phone, {{3}} the conversation id; a variable mentioning a
 * name, phone, chat, conversation or link takes that; anything else the
 * customer's name. A send uses "-" when that data is empty.
 */
export function getScenarioWhatsAppTemplateFallbackContextKey(
  variable: string,
): ScenarioWhatsAppTemplateFallbackContextKey {
  const key = variable.trim().toLowerCase();
  if (/^\d+$/.test(key)) {
    const position = Number.parseInt(key, 10);
    if (position === 1) return "customer_name";
    if (position === 2) return "phone";
    if (position === 3) return "conversation_id";
  }
  if (key.includes("name")) return "customer_name";
  if (/(phone|wa_id|whatsapp)/.test(key)) return "phone";
  if (key.includes("chat")) return "chat_id";
  if (key.includes("conversation")) return "conversation_id";
  if (key.includes("link")) return "link";
  return "customer_name";
}

function isWhatsAppTemplateContextKey(
  value: string,
): value is ScenarioWhatsAppTemplateContextKey {
  return (WHATSAPP_TEMPLATE_CONTEXT_KEYS as readonly string[]).includes(value);
}

/**
 * The customer data a step that sets no values of its own fills a variable
 * with: the data the variable is named after ({{first_name}}), else the
 * fallback.
 */
export function getScenarioWhatsAppTemplateDefaultContextKey(
  variable: string,
): ScenarioWhatsAppTemplateContextKey {
  const key = variable.trim().toLowerCase();
  const named = [
    key,
    key.replace(/[\s-]+/g, "_"),
    key.replace(/[\s_-]+/g, ""),
  ].find(isWhatsAppTemplateContextKey);
  return named ?? getScenarioWhatsAppTemplateFallbackContextKey(key);
}

export function getScenarioWhatsAppTemplateParameterId(
  parameter: ParameterIdentity,
): string {
  const prefix =
    parameter.cardIndex === undefined ? "" : `card:${parameter.cardIndex}:`;
  return `${prefix}${parameter.component}:${parameter.component === "button" ? `${parameter.buttonIndex}:` : ""}${parameter.variable}`;
}

export function listScenarioWhatsAppTemplateParameters(
  components: readonly WhatsAppComponent[] | undefined,
): ScenarioWhatsAppTemplateParameter[] {
  return hasParameterSchema(components)
    ? collectTemplateParameters(components)
    : [];
}

function collectTemplateParameters(
  components: readonly WhatsAppComponent[],
): ScenarioWhatsAppTemplateParameter[] {
  const parameters: ScenarioWhatsAppTemplateParameter[] = [];
  const add = (
    identity: Omit<ParameterIdentity, "variable">,
    text: string,
    url?: string,
  ) => {
    for (const variable of extractTemplateVariablesInOrder(url ?? text)) {
      const parameter = {
        ...identity,
        variable,
        text,
        ...(url ? { url } : {}),
      };
      parameters.push({
        ...parameter,
        id: getScenarioWhatsAppTemplateParameterId(parameter),
      });
    }
  };
  const visit = (
    component: WhatsAppComponent | WhatsAppCarouselCardComponent,
    cardIndex?: number,
  ) => {
    const card = cardIndex === undefined ? {} : { cardIndex };
    if (component.type === "HEADER" && component.format === "TEXT") {
      add({ ...card, component: "header" }, component.text ?? "");
    } else if (component.type === "BODY") {
      add({ ...card, component: "body" }, component.text ?? "");
    } else if (component.type === "BUTTONS") {
      component.buttons.forEach((button, buttonIndex) => {
        if (button.type === "URL") {
          add(
            { ...card, component: "button", buttonIndex },
            button.text,
            button.url,
          );
        }
      });
    } else if (component.type === "CAROUSEL") {
      component.cards.forEach((entry, index) =>
        entry.components.forEach((item) => visit(item, index)),
      );
    }
  };
  components.forEach((component) => visit(component));
  return parameters;
}

const CONTEXT_KEYS = new Set<string>(WHATSAPP_TEMPLATE_CONTEXT_KEYS);
const MAX_BINDING_TEXT_LENGTH = 32768;

/** Check only the fields traversed here; Meta's full authoring schema lives in the template editor. */
function hasParameterSchema(
  components: unknown,
): components is readonly WhatsAppComponent[] {
  const validComponent = (component: unknown, inCard = false): boolean => {
    if (!isRecord(component) || typeof component.type !== "string")
      return false;
    if (
      component.type === "BODY" ||
      (component.type === "HEADER" && component.format === "TEXT")
    ) {
      return typeof component.text === "string";
    }
    if (component.type === "BUTTONS") {
      return (
        Array.isArray(component.buttons) &&
        component.buttons.every(
          (button) =>
            isRecord(button) &&
            typeof button.type === "string" &&
            (button.type !== "URL" ||
              (typeof button.url === "string" &&
                typeof button.text === "string")),
        )
      );
    }
    if (component.type === "CAROUSEL") {
      return (
        !inCard &&
        Array.isArray(component.cards) &&
        component.cards.every(
          (card) =>
            isRecord(card) &&
            Array.isArray(card.components) &&
            card.components.every((item) => validComponent(item, true)),
        )
      );
    }
    return true;
  };
  return (
    Array.isArray(components) &&
    components.every((component) => validComponent(component))
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function readBinding(value: unknown): ScenarioWhatsAppTemplateBinding | null {
  if (!isRecord(value)) return null;
  if (value.source === "literal") {
    return hasOnlyKeys(value, ["source", "value"]) &&
      typeof value.value === "string" &&
      value.value.length <= MAX_BINDING_TEXT_LENGTH
      ? (value as ScenarioWhatsAppTemplateBinding)
      : null;
  }
  if (value.source === "context") {
    return hasOnlyKeys(value, ["source", "key"]) &&
      typeof value.key === "string" &&
      CONTEXT_KEYS.has(value.key)
      ? (value as ScenarioWhatsAppTemplateBinding)
      : null;
  }
  if (value.source === "prompt_input") {
    return hasOnlyKeys(value, ["source", "key"]) &&
      typeof value.key === "string" &&
      isScenarioPromptInputKey(value.key)
      ? (value as ScenarioWhatsAppTemplateBinding)
      : null;
  }
  return null;
}

type BindingValidationInput = {
  components?: readonly WhatsAppComponent[];
  bindings: unknown;
  availablePromptInputKeys?: readonly string[];
};

/** Validate once and retain the parsed entries for runtime resolution. */
function readValidatedBindings(input: BindingValidationInput) {
  const issues: ScenarioWhatsAppTemplateBindingIssue[] = [];
  const entries: Array<[string, ScenarioWhatsAppTemplateBinding]> = [];
  const result = { entries, issues };
  if (input.bindings === undefined) return result;
  const config = input.bindings;
  if (
    !isRecord(config) ||
    config.version !== 1 ||
    !hasOnlyKeys(config, ["version", "parameters"]) ||
    !isRecord(config.parameters) ||
    Object.keys(config.parameters).length > 256 ||
    !hasParameterSchema(input.components) ||
    !input.components?.length
  ) {
    issues.push({ code: "bindings_invalid" });
    return result;
  }
  const parameters = collectTemplateParameters(input.components);
  const parameterIds = new Set(parameters.map((parameter) => parameter.id));
  for (const key of Object.keys(config.parameters)) {
    if (!parameterIds.has(key))
      issues.push({ code: "binding_unknown_parameter", parameterId: key });
  }
  for (const parameter of parameters) {
    const parameterId = parameter.id;
    if (!Object.hasOwn(config.parameters, parameterId)) {
      issues.push({ code: "binding_required", parameterId });
      continue;
    }
    const binding = readBinding(config.parameters[parameterId]);
    if (!binding) {
      issues.push({ code: "binding_source_invalid", parameterId });
    } else if (binding.source === "literal" && !binding.value.trim()) {
      issues.push({ code: "binding_value_missing", parameterId });
    } else if (
      binding.source === "prompt_input" &&
      input.availablePromptInputKeys &&
      !input.availablePromptInputKeys.includes(binding.key)
    ) {
      issues.push({ code: "binding_input_unavailable", parameterId });
    } else {
      entries.push([parameterId, binding]);
    }
  }
  return result;
}

export function validateScenarioWhatsAppTemplateBindings(
  input: BindingValidationInput,
): ScenarioWhatsAppTemplateBindingIssue[] {
  return readValidatedBindings(input).issues;
}

type BindingValues = Readonly<Record<string, string | null | undefined>>;

/** Exact own-key lookup only: never infer, interpolate or fall back to another field. */
export function resolveScenarioWhatsAppTemplateBindings(
  input: BindingValidationInput & {
    values?: BindingValues;
    promptInputs?: BindingValues;
  },
): {
  values: Record<string, string>;
  issues: ScenarioWhatsAppTemplateBindingIssue[];
} {
  const { entries, issues } = readValidatedBindings(input);
  const values: Record<string, string> = {};
  const missingValues = new Set<string>();
  for (const [parameterId, binding] of entries) {
    if (missingValues.has(parameterId)) continue;
    const context =
      binding.source === "prompt_input" ? input.promptInputs : input.values;
    const value =
      binding.source === "literal"
        ? binding.value
        : context && Object.hasOwn(context, binding.key)
          ? context[binding.key]
          : undefined;
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > MAX_BINDING_TEXT_LENGTH
    ) {
      issues.push({ code: "binding_value_missing", parameterId });
      missingValues.add(parameterId);
    } else {
      values[parameterId] = value;
    }
  }
  return { values, issues };
}

/** Preview shares the exact slot identities used for outbound components. Missing values stay visible. */
export function renderScenarioWhatsAppTemplateBindingPreview(
  components: readonly WhatsAppComponent[],
  values: Readonly<Record<string, string>>,
): WhatsAppComponent[] {
  if (!hasParameterSchema(components)) return [];
  const replace = (
    text: string,
    identity: Omit<ParameterIdentity, "variable">,
  ) =>
    text.replace(
      /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,
      (placeholder, variable: string) => {
        const id = getScenarioWhatsAppTemplateParameterId({
          ...identity,
          variable,
        });
        return Object.hasOwn(values, id) ? values[id]! : placeholder;
      },
    );
  const visit = <T extends WhatsAppComponent | WhatsAppCarouselCardComponent>(
    component: T,
    cardIndex?: number,
  ): T => {
    const card = cardIndex === undefined ? {} : { cardIndex };
    if (component.type === "HEADER" && component.format === "TEXT") {
      return {
        ...component,
        text: replace(component.text ?? "", { ...card, component: "header" }),
      };
    }
    if (component.type === "BODY" && component.text !== undefined) {
      return {
        ...component,
        text: replace(component.text, { ...card, component: "body" }),
      };
    }
    if (component.type === "BUTTONS") {
      return {
        ...component,
        buttons: component.buttons.map((button, buttonIndex) =>
          button.type === "URL"
            ? {
                ...button,
                url: replace(button.url, {
                  ...card,
                  component: "button",
                  buttonIndex,
                }),
              }
            : { ...button },
        ),
      };
    }
    if (component.type === "CAROUSEL") {
      return {
        ...component,
        cards: component.cards.map((entry, index) => ({
          ...entry,
          components: entry.components.map((item) => visit(item, index)),
        })),
      };
    }
    return { ...component };
  };
  return components.map((component) => visit(component));
}
