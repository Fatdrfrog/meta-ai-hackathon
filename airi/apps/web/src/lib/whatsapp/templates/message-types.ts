/**
 * Canonical WhatsApp Cloud API template-message types.
 *
 * Official references:
 * - Template Object:
 *   https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/types/TemplateObject/
 * - Component Object:
 *   https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/types/ComponentObject/
 * - Button Parameter Object:
 *   https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/types/ButtonParameterObject/
 * - Flow reply lifecycle (`flow_token` is returned on completion):
 *   https://developers.facebook.com/docs/whatsapp/flows/guides/implementingyourflowendpoint/
 *
 * Notes:
 * - Meta documents button `index` as a numeric string in the outbound payload.
 * - URL buttons take a text suffix, quick-reply buttons take a payload.
 * - Flow button action parameters are modeled here for our runtime flow-template
 *   support. Meta's public template examples focus on URL/quick_reply buttons,
 *   so we keep this branch narrow and optional.
 */

import {
  buildWhatsAppLocationMessagePayload,
  type WhatsAppLocationMessagePayload,
} from "@/lib/scenarios/whatsapp-location";

import {
  extractTemplateVariablesInOrder,
  type WhatsAppComponent,
} from "@icecore/shared/types/whatsapp";

interface WhatsAppSendResponseMessage {
  id?: string;
  timestamp?: string | number;
  message_status?: string;
}

interface WhatsAppSendResponseErrorData {
  details?: string;
}

interface WhatsAppSendResponseError {
  message?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
  error_user_title?: string;
  error_user_msg?: string;
  error_data?: WhatsAppSendResponseErrorData;
}

export interface WhatsAppSendResponseBody {
  status?: string;
  messages?: WhatsAppSendResponseMessage[];
  error?: WhatsAppSendResponseError;
}

type WhatsAppTemplateLanguageObject = {
  policy?: "deterministic";
  code: string;
};

type WhatsAppTemplateTextParameter = {
  type: "text";
  parameter_name?: string;
  text: string;
};

type WhatsAppTemplateCurrencyParameter = {
  type: "currency";
  currency: {
    fallback_value: string;
    code: string;
    amount_1000: number;
  };
};

type WhatsAppTemplateDateTimeParameter = {
  type: "date_time";
  date_time: {
    fallback_value: string;
  };
};

type WhatsAppTemplateImageParameter = {
  type: "image";
  image: {
    link?: string;
    id?: string;
  };
};

type WhatsAppTemplateDocumentParameter = {
  type: "document";
  document: {
    link?: string;
    id?: string;
    filename?: string;
  };
};

type WhatsAppTemplateVideoParameter = {
  type: "video";
  video: {
    link?: string;
    id?: string;
  };
};

type WhatsAppTemplateLocationParameter = {
  type: "location";
  location: WhatsAppLocationMessagePayload;
};

type WhatsAppTemplateBodyOrHeaderParameter =
  | WhatsAppTemplateTextParameter
  | WhatsAppTemplateCurrencyParameter
  | WhatsAppTemplateDateTimeParameter
  | WhatsAppTemplateImageParameter
  | WhatsAppTemplateDocumentParameter
  | WhatsAppTemplateVideoParameter
  | WhatsAppTemplateLocationParameter;

type WhatsAppTemplateQuickReplyButtonParameter = {
  type: "payload";
  payload: string;
};

type WhatsAppTemplateFlowButtonParameter = {
  type: "action";
  action: {
    flow_token?: string;
    flow_action_data?: Record<string, unknown>;
  };
};

type WhatsAppTemplateButtonParameter =
  | WhatsAppTemplateQuickReplyButtonParameter
  | WhatsAppTemplateTextParameter
  | WhatsAppTemplateFlowButtonParameter;

type WhatsAppTemplateBodyOrHeaderComponentInput = {
  type: "body" | "header";
  parameters: WhatsAppTemplateBodyOrHeaderParameter[];
};

type WhatsAppTemplateQuickReplyButtonComponentInput = {
  type: "button";
  sub_type: "quick_reply";
  index: string | number;
  parameters: WhatsAppTemplateQuickReplyButtonParameter[];
};

type WhatsAppTemplateUrlButtonComponentInput = {
  type: "button";
  sub_type: "url";
  index: string | number;
  parameters: WhatsAppTemplateTextParameter[];
};

type WhatsAppTemplateFlowButtonComponentInput = {
  type: "button";
  sub_type: "flow";
  index: string | number;
  parameters: WhatsAppTemplateFlowButtonParameter[];
};

export type WhatsAppTemplateSendComponentInput =
  | WhatsAppTemplateBodyOrHeaderComponentInput
  | WhatsAppTemplateQuickReplyButtonComponentInput
  | WhatsAppTemplateUrlButtonComponentInput
  | WhatsAppTemplateFlowButtonComponentInput
  | WhatsAppTemplateCarouselComponentInput;

type WhatsAppTemplateCarouselCardSendInput = {
  card_index: number;
  components: Array<
    | WhatsAppTemplateBodyOrHeaderComponentInput
    | WhatsAppTemplateQuickReplyButtonComponentInput
    | WhatsAppTemplateUrlButtonComponentInput
  >;
};

type WhatsAppTemplateCarouselComponentInput = {
  type: "carousel";
  cards: WhatsAppTemplateCarouselCardSendInput[];
};

type WhatsAppTemplateBodyOrHeaderComponent =
  WhatsAppTemplateBodyOrHeaderComponentInput;

type WhatsAppTemplateQuickReplyButtonComponent = {
  type: "button";
  sub_type: "quick_reply";
  index: string;
  parameters: WhatsAppTemplateQuickReplyButtonParameter[];
};

type WhatsAppTemplateUrlButtonComponent = {
  type: "button";
  sub_type: "url";
  index: string;
  parameters: WhatsAppTemplateTextParameter[];
};

type WhatsAppTemplateFlowButtonComponent = {
  type: "button";
  sub_type: "flow";
  index: string;
  parameters: WhatsAppTemplateFlowButtonParameter[];
};

type WhatsAppTemplateSendComponent =
  | WhatsAppTemplateBodyOrHeaderComponent
  | WhatsAppTemplateQuickReplyButtonComponent
  | WhatsAppTemplateUrlButtonComponent
  | WhatsAppTemplateFlowButtonComponent
  | WhatsAppTemplateCarouselComponent;

type WhatsAppTemplateCarouselCardSendComponent = {
  card_index: number;
  components: Array<
    | WhatsAppTemplateBodyOrHeaderComponent
    | WhatsAppTemplateQuickReplyButtonComponent
    | WhatsAppTemplateUrlButtonComponent
  >;
};

type WhatsAppTemplateCarouselComponent = {
  type: "carousel";
  cards: WhatsAppTemplateCarouselCardSendComponent[];
};

type WhatsAppTemplateObject = {
  name: string;
  language: WhatsAppTemplateLanguageObject;
  components?: WhatsAppTemplateSendComponent[];
};

export type WhatsAppTemplateMessagePayload = {
  messaging_product: "whatsapp";
  to: string;
  type: "template";
  template: WhatsAppTemplateObject;
  /**
   * Opaque string (в‰¤512 bytes) Meta echoes back on every status webhook for
   * this message. Used to correlate campaign sends with status updates
   * without a database round-trip.
   * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages#tracking-with-biz-opaque-callback-data
   */
  biz_opaque_callback_data?: string;
  /**
   * Messaging Account ID for Cloud API / Marketing Messages sends.
   * Required by Meta only for specific multi Messaging Account sends.
   */
  messaging_account_id?: string;
  /**
   * Marketing Messages API send-time price adjustment.
   * Only valid on the `/marketing_messages` endpoint.
   */
  per_message_bid_multiplier?: number;
};

type WhatsAppTemplateSendComponentBuildIssue =
  | {
      type: "missing_header_media";
      format: "IMAGE" | "VIDEO" | "DOCUMENT";
    }
  | {
      type: "missing_header_location";
      format: "LOCATION";
    };

type WhatsAppTemplateSendComponentBuildResult = {
  components?: WhatsAppTemplateSendComponentInput[];
  issues: WhatsAppTemplateSendComponentBuildIssue[];
};

type WhatsAppTemplateButton = Extract<
  WhatsAppComponent,
  { type: "BUTTONS" }
>["buttons"][number];

type ResolveTemplateVariableValueParams = {
  component: WhatsAppComponent;
  buttonIndex?: number;
  cardIndex?: number;
  variable: string;
  variables: string[];
  values: Record<string, string | null | undefined>;
  fallbackText: string;
};

type BuildTemplateSendComponentOptions = {
  templateComponents?: WhatsAppComponent[];
  values?: Record<string, string | null | undefined>;
  fallbackText?: string;
  headerLocation?: WhatsAppLocationMessagePayload;
  createFlowToken?: () => string;
  createFlowActionData?: () => Record<string, unknown> | undefined;
  createQuickReplyPayload?: (params: {
    button: WhatsAppTemplateButton;
    index: number;
    /** Set for a carousel card's button; `index` is then its place in the card. */
    cardIndex?: number;
  }) => string | null | undefined;
  resolveVariableValue?: (
    params: ResolveTemplateVariableValueParams
  ) => string | null | undefined;
};

function normalizeFallbackText(value?: string): string {
  return value && value.trim() ? value : "-";
}

// Built from a string so the Unicode line and paragraph separators stay
// escaped in the source.
const PARAMETER_LINE_BREAK = new RegExp(
  "\\s*[\\r\\n\\t\\v\\f\\u2028\\u2029]\\s*",
  "g"
);

/**
 * Meta rejects text parameters with line breaks, tabs or more than four
 * spaces in a row (#132018), so a value such as a name pasted across lines
 * goes out on one line.
 */
function normalizeParameterText(value: string, fallbackText: string): string {
  const text = String(value ?? "")
    .replace(PARAMETER_LINE_BREAK, " ")
    .replace(/ {5,}/g, " ")
    .trim();
  return text || fallbackText;
}

function normalizePayloadText(value: string, fallbackText: string): string {
  return value && value.trim() ? value : fallbackText;
}

function normalizeBodyOrHeaderParameter(
  parameter: WhatsAppTemplateBodyOrHeaderParameter,
  fallbackText: string
): WhatsAppTemplateBodyOrHeaderParameter {
  if (parameter.type === "location") {
    if (
      typeof parameter.location?.latitude !== "number" ||
      typeof parameter.location?.longitude !== "number"
    ) {
      throw new Error("Invalid WhatsApp template location");
    }
    const location = buildWhatsAppLocationMessagePayload(parameter.location);
    if (!location) throw new Error("Invalid WhatsApp template location");
    return { type: "location", location };
  }

  if (parameter.type === "text") {
    return {
      ...parameter,
      text: normalizeParameterText(parameter.text, fallbackText),
    };
  }

  if (parameter.type === "currency") {
    return {
      ...parameter,
      currency: {
        ...parameter.currency,
        fallback_value: normalizeParameterText(
          parameter.currency.fallback_value,
          fallbackText
        ),
      },
    };
  }

  if (parameter.type === "date_time") {
    return {
      ...parameter,
      date_time: {
        ...parameter.date_time,
        fallback_value: normalizeParameterText(
          parameter.date_time.fallback_value,
          fallbackText
        ),
      },
    };
  }

  return parameter;
}

function normalizeButtonParameter(
  parameter: WhatsAppTemplateButtonParameter,
  fallbackText: string
): WhatsAppTemplateButtonParameter {
  if (parameter.type === "text") {
    return {
      ...parameter,
      text: normalizeParameterText(parameter.text, fallbackText),
    };
  }

  if (parameter.type === "payload") {
    return {
      ...parameter,
      payload: normalizePayloadText(parameter.payload, fallbackText),
    };
  }

  return parameter;
}

function isNamedTemplateVariable(variable: string): boolean {
  const normalized = variable.trim();
  return Boolean(normalized) && !/^\d+$/.test(normalized);
}

function buildTextParameter(
  variable: string,
  text: string
): WhatsAppTemplateTextParameter {
  return {
    type: "text",
    ...(isNamedTemplateVariable(variable)
      ? { parameter_name: variable.trim() }
      : {}),
    text,
  };
}

function normalizeTemplateSendComponent(
  component: WhatsAppTemplateSendComponentInput,
  fallbackText: string
): WhatsAppTemplateSendComponent {
  if (component.type === "button") {
    return {
      ...component,
      index: String(component.index),
      parameters: component.parameters.map(parameter =>
        normalizeButtonParameter(parameter, fallbackText)
      ),
    } as WhatsAppTemplateSendComponent;
  }

  if (component.type === "carousel") {
    return {
      type: "carousel",
      cards: component.cards.map(card => ({
        card_index: card.card_index,
        components: card.components.map(cardComponent =>
          normalizeTemplateSendComponent(cardComponent, fallbackText)
        ) as WhatsAppTemplateCarouselCardSendComponent["components"],
      })),
    };
  }

  return {
    ...component,
    parameters: component.parameters.map(parameter =>
      normalizeBodyOrHeaderParameter(parameter, fallbackText)
    ),
  };
}

function normalizeLookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function resolveTemplateVariableValue(
  variable: string,
  values: Record<string, string | null | undefined>,
  fallbackText: string
): string {
  const normalized = variable.trim();
  if (!normalized) return fallbackText;

  const candidates = [
    normalized,
    normalized.toLowerCase(),
    normalizeLookupKey(normalized),
    normalizeLookupKey(normalized).replace(/_/g, ""),
  ];

  for (const candidate of candidates) {
    const value = values[candidate];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  if (/^\d+$/.test(normalized)) {
    const numeric = Number.parseInt(normalized, 10);
    if (numeric === 1) {
      return (
        values.full_name ||
        values.customer_name ||
        values.name ||
        values.first_name ||
        fallbackText
      );
    }
    if (numeric === 2) {
      return values.phone || values.wa_id || values.whatsapp_id || fallbackText;
    }
  }

  const lower = normalized.toLowerCase();
  if (lower.includes("name")) {
    return (
      values.full_name ||
      values.customer_name ||
      values.name ||
      values.first_name ||
      fallbackText
    );
  }
  if (/(phone|wa_id|whatsapp)/.test(lower)) {
    return values.phone || values.wa_id || values.whatsapp_id || fallbackText;
  }
  if (lower.includes("link")) {
    return values.link || values.link1 || fallbackText;
  }

  return fallbackText;
}

function resolveTemplateComponentVariableValue(params: {
  options: BuildTemplateSendComponentOptions;
  component: WhatsAppComponent;
  buttonIndex?: number;
  cardIndex?: number;
  variable: string;
  variables: string[];
  values: Record<string, string | null | undefined>;
  fallbackText: string;
}): string {
  const custom = params.options.resolveVariableValue?.({
    component: params.component,
    buttonIndex: params.buttonIndex,
    cardIndex: params.cardIndex,
    variable: params.variable,
    variables: params.variables,
    values: params.values,
    fallbackText: params.fallbackText,
  });

  if (typeof custom === "string") {
    return custom;
  }

  return resolveTemplateVariableValue(
    params.variable,
    params.values,
    params.fallbackText
  );
}

function firstHttpUrl(values: unknown): string | undefined {
  if (!Array.isArray(values)) return undefined;

  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.toString();
      }
    } catch {
      // Ignore non-URL Meta media handles.
    }
  }

  return undefined;
}

function mediaFilenameFromUrl(link: string): string | undefined {
  try {
    const parsed = new URL(link);
    const filename = parsed.pathname.split("/").filter(Boolean).at(-1);
    return filename || undefined;
  } catch {
    return undefined;
  }
}

function buildHeaderMediaParameter(component: {
  format?: string;
  example?: { header_handle?: string[] };
}): WhatsAppTemplateBodyOrHeaderParameter | null {
  const link = firstHttpUrl(component.example?.header_handle);
  if (!link) return null;

  if (component.format === "IMAGE") {
    return {
      type: "image",
      image: { link },
    };
  }

  if (component.format === "VIDEO") {
    return {
      type: "video",
      video: { link },
    };
  }

  if (component.format === "DOCUMENT") {
    return {
      type: "document",
      document: {
        link,
        filename: mediaFilenameFromUrl(link),
      },
    };
  }

  return null;
}

function defaultFlowToken(): string {
  return `flow_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function buildWhatsAppTemplateSendComponentsFromTemplate(
  options: BuildTemplateSendComponentOptions
): WhatsAppTemplateSendComponentBuildResult {
  const templateComponents = options.templateComponents;
  if (!Array.isArray(templateComponents) || templateComponents.length === 0) {
    return { components: undefined, issues: [] };
  }

  const values = options.values || {};
  const fallbackText = normalizeFallbackText(options.fallbackText);
  const createFlowToken = options.createFlowToken || defaultFlowToken;
  const components: WhatsAppTemplateSendComponentInput[] = [];
  const issues: WhatsAppTemplateSendComponentBuildIssue[] = [];

  for (const component of templateComponents) {
    if (component.type === "HEADER") {
      if (component.format === "LOCATION") {
        if (options.headerLocation) {
          components.push({
            type: "header",
            parameters: [
              { type: "location", location: options.headerLocation },
            ],
          });
        } else {
          issues.push({ type: "missing_header_location", format: "LOCATION" });
        }
        continue;
      }
      if (component.format === "TEXT") {
        if (!component.text) continue;
        const variables = extractTemplateVariablesInOrder(component.text);
        if (variables.length === 0) continue;
        components.push({
          type: "header",
          parameters: variables.map(variable =>
            buildTextParameter(
              variable,
              resolveTemplateComponentVariableValue({
                options,
                component,
                variable,
                variables,
                values,
                fallbackText,
              })
            )
          ),
        });
        continue;
      }

      if (
        component.format === "IMAGE" ||
        component.format === "VIDEO" ||
        component.format === "DOCUMENT"
      ) {
        const mediaParameter = buildHeaderMediaParameter(component);
        if (mediaParameter) {
          components.push({
            type: "header",
            parameters: [mediaParameter],
          });
        } else {
          issues.push({
            type: "missing_header_media",
            format: component.format,
          });
        }
      }
      continue;
    }

    if (component.type === "BODY") {
      const variables = extractTemplateVariablesInOrder(component.text || "");
      if (variables.length === 0) continue;
      components.push({
        type: "body",
        parameters: variables.map(variable =>
          buildTextParameter(
            variable,
            resolveTemplateComponentVariableValue({
              options,
              component,
              variable,
              variables,
              values,
              fallbackText,
            })
          )
        ),
      });
      continue;
    }

    if (component.type === "BUTTONS") {
      component.buttons?.forEach((button, index) => {
        if (button.type === "QUICK_REPLY") {
          const payload = options.createQuickReplyPayload?.({
            button,
            index,
          });
          if (payload && payload.trim()) {
            components.push({
              type: "button",
              sub_type: "quick_reply",
              index,
              parameters: [
                {
                  type: "payload" as const,
                  payload,
                },
              ],
            });
          }
          return;
        }

        if (button.type === "FLOW") {
          const flowActionData = options.createFlowActionData?.();
          components.push({
            type: "button",
            sub_type: "flow",
            index,
            parameters: [
              {
                type: "action" as const,
                action: {
                  flow_token: createFlowToken(),
                  ...(flowActionData
                    ? { flow_action_data: flowActionData }
                    : {}),
                },
              },
            ],
          });
          return;
        }

        if (button.type === "OTP" && button.otp_type === "COPY_CODE") {
          const bodyComponent = options.templateComponents?.find(
            candidate => candidate.type === "BODY"
          );
          const variables =
            bodyComponent?.type === "BODY"
              ? extractTemplateVariablesInOrder(bodyComponent.text || "")
              : [];
          const variable = variables[0] || "1";
          components.push({
            type: "button",
            sub_type: "url",
            index,
            parameters: [
              buildTextParameter(
                variable,
                resolveTemplateComponentVariableValue({
                  options,
                  component: bodyComponent || {
                    type: "BODY",
                    text: "{{1}}",
                  },
                  variable,
                  variables: variables.length > 0 ? variables : [variable],
                  values,
                  fallbackText,
                })
              ),
            ],
          });
          return;
        }

        if (button.type !== "URL" || !button.url) return;
        const variables = extractTemplateVariablesInOrder(button.url);
        if (variables.length === 0) return;
        components.push({
          type: "button",
          sub_type: "url",
          index,
          parameters: variables.map(variable =>
            buildTextParameter(
              variable,
              resolveTemplateComponentVariableValue({
                options,
                component,
                buttonIndex: index,
                variable,
                variables,
                values,
                fallbackText,
              })
            )
          ),
        });
      });
      continue;
    }

    if (component.type === "CAROUSEL") {
      const cards: WhatsAppTemplateCarouselCardSendInput[] = [];
      component.cards.forEach((card, cardIndex) => {
        const cardComponents: WhatsAppTemplateCarouselCardSendInput["components"] =
          [];
        for (const cardComponent of card.components) {
          if (cardComponent.type === "HEADER") {
            const mediaParameter = buildHeaderMediaParameter(cardComponent);
            if (mediaParameter) {
              cardComponents.push({
                type: "header",
                parameters: [mediaParameter],
              });
            } else {
              issues.push({
                type: "missing_header_media",
                format: cardComponent.format,
              });
            }
            continue;
          }

          if (cardComponent.type === "BODY") {
            const variables = extractTemplateVariablesInOrder(
              cardComponent.text
            );
            if (variables.length === 0) continue;
            cardComponents.push({
              type: "body",
              parameters: variables.map(variable =>
                buildTextParameter(
                  variable,
                  resolveTemplateComponentVariableValue({
                    options,
                    component: {
                      type: "BODY",
                      text: cardComponent.text,
                    },
                    cardIndex,
                    variable,
                    variables,
                    values,
                    fallbackText,
                  })
                )
              ),
            });
            continue;
          }

          if (cardComponent.type !== "BUTTONS") continue;
          cardComponent.buttons.forEach((button, index) => {
            if (button.type === "QUICK_REPLY") {
              const payload = options.createQuickReplyPayload?.({
                button: {
                  type: "QUICK_REPLY",
                  text: button.text,
                },
                index,
                cardIndex,
              });
              if (payload && payload.trim()) {
                cardComponents.push({
                  type: "button",
                  sub_type: "quick_reply",
                  index,
                  parameters: [
                    {
                      type: "payload" as const,
                      payload,
                    },
                  ],
                });
              }
              return;
            }

            if (button.type !== "URL" || !button.url) return;
            const variables = extractTemplateVariablesInOrder(button.url);
            if (variables.length === 0) return;
            cardComponents.push({
              type: "button",
              sub_type: "url",
              index,
              parameters: variables.map(variable =>
                buildTextParameter(
                  variable,
                  resolveTemplateComponentVariableValue({
                    options,
                    component: {
                      type: "BUTTONS",
                      buttons: [
                        { type: "URL", text: button.text, url: button.url },
                      ],
                    },
                    cardIndex,
                    buttonIndex: index,
                    variable,
                    variables,
                    values,
                    fallbackText,
                  })
                )
              ),
            });
          });
        }

        if (cardComponents.length > 0) {
          cards.push({
            card_index: cardIndex,
            components: cardComponents,
          });
        }
      });
      if (cards.length > 0) {
        components.push({
          type: "carousel",
          cards,
        });
      }
    }
  }

  const normalizedComponents = normalizeWhatsAppTemplateSendComponents(
    components,
    { fallbackText }
  );

  return {
    components: normalizedComponents,
    issues,
  };
}

export function normalizeWhatsAppTemplateSendComponents(
  components?: WhatsAppTemplateSendComponentInput[],
  options?: { fallbackText?: string }
): WhatsAppTemplateSendComponent[] | undefined {
  if (!components || components.length === 0) {
    return undefined;
  }

  const fallbackText = normalizeFallbackText(options?.fallbackText);
  return components.map(component =>
    normalizeTemplateSendComponent(component, fallbackText)
  );
}
