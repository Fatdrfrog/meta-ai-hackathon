import { WHATSAPP_TEMPLATE_LIMITS } from "@icecore/shared/constants/whatsapp-templates";
import {
  extractTemplateVariablesInOrder,
  type WhatsAppComponent,
} from "@icecore/shared/types/whatsapp";
import type {
  ScenarioGeneratedAsset,
  ScenarioNodeData,
} from "@icecore/scenario-contracts";

function normalizeGeneratedTemplateText(
  value: string,
  maxLength: number
): string {
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized.slice(0, maxLength).trim();
}

function buildTemplateVariableExample(variable: string, index: number): string {
  const normalized = variable.trim().toLowerCase();
  if (
    normalized === "1" ||
    normalized === "name" ||
    normalized === "first_name" ||
    normalized === "customer_name"
  ) {
    return "Customer";
  }
  if (normalized.includes("date")) return "Tuesday";
  if (normalized.includes("time")) return "10:00";
  if (normalized.includes("link") || normalized.includes("url")) {
    return "https://example.com";
  }
  if (normalized.includes("code")) return "12345";
  return ["your booking", "your request", "the offer"][index % 3];
}

function buildBodyComponentExample(
  bodyText: string
): Extract<WhatsAppComponent, { type: "BODY" }>["example"] | undefined {
  const variables = extractTemplateVariablesInOrder(bodyText).slice(
    0,
    WHATSAPP_TEMPLATE_LIMITS.VARIABLES_MAX_COUNT
  );
  if (variables.length === 0) return undefined;

  const allNumeric = variables.every(variable => /^\d+$/.test(variable));
  if (allNumeric) {
    return {
      body_text: [
        variables.map((variable, index) =>
          buildTemplateVariableExample(variable, index)
        ),
      ],
    };
  }

  return {
    body_text_named_params: variables.map((variable, index) => ({
      param_name: variable,
      example: buildTemplateVariableExample(variable, index),
    })),
  };
}

function normalizeGeneratedButtonText(
  value: string | undefined,
  fallback: string
): string {
  return normalizeGeneratedTemplateText(
    value || fallback,
    WHATSAPP_TEMPLATE_LIMITS.BUTTON_TEXT_MAX_LENGTH
  );
}

function normalizeGeneratedTemplateUrl(value: string | undefined):
  | {
      url: string;
      example?: string[];
    }
  | undefined {
  const trimmed = normalizeGeneratedTemplateText(
    value || "",
    WHATSAPP_TEMPLATE_LIMITS.BUTTON_URL_MAX_LENGTH
  );
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    const url = parsed.toString();
    const variables = extractTemplateVariablesInOrder(url);
    return {
      url,
      ...(variables.length > 0
        ? {
            example: [
              url.replace(
                /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,
                (_match, variable: string) =>
                  buildTemplateVariableExample(variable, 0)
              ),
            ],
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function buildGeneratedWhatsAppTemplateButtons(params: {
  ctaType?: ScenarioNodeData["actionReplyCtaType"];
  ctaLabel?: string;
  linkUrl?: string;
  flowId?: string;
}): Extract<WhatsAppComponent, { type: "BUTTONS" }>["buttons"] {
  if (params.ctaType === "link") {
    const normalizedUrl = normalizeGeneratedTemplateUrl(params.linkUrl);
    if (!normalizedUrl) return [];
    return [
      {
        type: "URL",
        text: normalizeGeneratedButtonText(params.ctaLabel, "Open"),
        url: normalizedUrl.url,
        ...(normalizedUrl.example ? { example: normalizedUrl.example } : {}),
      },
    ];
  }

  if (params.ctaType === "flow" && params.flowId) {
    return [
      {
        type: "FLOW",
        text: normalizeGeneratedButtonText(params.ctaLabel, "Open"),
        flow_id: params.flowId,
        flow_action: "navigate",
      },
    ];
  }

  if (params.ctaType === "none" && params.ctaLabel) {
    return [
      {
        type: "QUICK_REPLY",
        text: normalizeGeneratedButtonText(params.ctaLabel, "Reply"),
      },
    ];
  }

  return [];
}

export function buildGeneratedWhatsAppTemplateComponents(params: {
  actionText: string;
  headerAsset?: ScenarioGeneratedAsset;
  headerMediaFormat?: "IMAGE" | "VIDEO" | "DOCUMENT";
  ctaType?: ScenarioNodeData["actionReplyCtaType"];
  ctaLabel?: string;
  linkUrl?: string;
  flowId?: string;
}): WhatsAppComponent[] {
  const bodyText =
    normalizeGeneratedTemplateText(
      params.actionText,
      WHATSAPP_TEMPLATE_LIMITS.BODY_MAX_LENGTH
    ) || "Generated message";
  const bodyExample = buildBodyComponentExample(bodyText);
  const buttons = buildGeneratedWhatsAppTemplateButtons({
    ctaType: params.ctaType,
    ctaLabel: params.ctaLabel,
    linkUrl: params.linkUrl,
    flowId: params.flowId,
  });

  return [
    ...(params.headerAsset?.url && params.headerMediaFormat
      ? [
          {
            type: "HEADER" as const,
            format: params.headerMediaFormat,
            example: {
              header_handle: [params.headerAsset.url],
            },
          },
        ]
      : []),
    {
      type: "BODY" as const,
      text: bodyText,
      ...(bodyExample ? { example: bodyExample } : {}),
    },
    ...(buttons.length > 0
      ? [
          {
            type: "BUTTONS" as const,
            buttons,
          },
        ]
      : []),
  ];
}
