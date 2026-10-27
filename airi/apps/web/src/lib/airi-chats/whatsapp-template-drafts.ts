import { isTemplateHeaderMediaFormat } from "@/lib/whatsapp/templates/header-media-utils";
import { WHATSAPP_TEMPLATE_HEADER_FORMAT_MEDIA_TYPES } from "@/lib/whatsapp/media-types";
import { buildWhatsAppTemplateTextExample } from "@/lib/whatsapp/templates/parameter-format";
import type {
  WhatsAppButtonComponent,
  WhatsAppComponent,
  WhatsAppTemplateCategory,
} from "@icecore/shared/types/whatsapp";
import { isValidTemplateName } from "@icecore/shared/types/whatsapp";
import {
  draftArray,
  draftEnum,
  draftObject,
  draftString,
  type AiriDraftResponseSchema,
} from "@/lib/airi-chats/draft-output";
import { readStringOrEmpty } from "@icecore/shared/lib/value-utils";

export type AiriWhatsAppTemplateDraft = {
  kind: "whatsapp_template";
  name: string;
  language: string;
  category: WhatsAppTemplateCategory;
  components: WhatsAppComponent[];
  rationale?: string;
  missingDetails?: string[];
};

const DEFAULT_TEMPLATE_NAME = "airi_whatsapp_template";
export const AIRI_TEMPLATE_DRAFT_CATEGORIES = [
  "MARKETING",
  "UTILITY",
  "AUTHENTICATION",
] as const satisfies readonly WhatsAppTemplateCategory[];
const VALID_CATEGORIES = new Set<WhatsAppTemplateCategory>(
  AIRI_TEMPLATE_DRAFT_CATEGORIES
);

/** Component, header and button kinds this module's normalizer keeps. */
export const AIRI_TEMPLATE_DRAFT_COMPONENT_TYPES = [
  "HEADER",
  "BODY",
  "FOOTER",
  "BUTTONS",
] as const;
export const AIRI_TEMPLATE_DRAFT_HEADER_FORMATS: readonly string[] = [
  "TEXT",
  ...Object.keys(WHATSAPP_TEMPLATE_HEADER_FORMAT_MEDIA_TYPES),
];
export const AIRI_TEMPLATE_DRAFT_BUTTON_TYPES = [
  "QUICK_REPLY",
  "URL",
  "PHONE_NUMBER",
  "FLOW",
] as const;
const AIRI_TEMPLATE_DRAFT_FLOW_ACTIONS = ["navigate", "data_exchange"] as const;

/**
 * responseSchema of the template draft call: the shape
 * normalizeAiriWhatsAppTemplateDraft keeps. One flat component object (its
 * type says which fields apply) keeps the schema free of unions.
 */
export const AIRI_TEMPLATE_DRAFT_RESPONSE_SCHEMA: AiriDraftResponseSchema =
  draftObject({
    name: draftString(
      "lower_snake_case template name: lowercase letters, digits and underscores"
    ),
    language: draftString("Template language code, e.g. en, ru, kk"),
    category: draftEnum(AIRI_TEMPLATE_DRAFT_CATEGORIES),
    components: draftArray(
      draftObject(
        {
          type: draftEnum(AIRI_TEMPLATE_DRAFT_COMPONENT_TYPES),
          format: draftEnum(
            AIRI_TEMPLATE_DRAFT_HEADER_FORMATS,
            "HEADER only: TEXT, or a media header Airi attaches later"
          ),
          text: draftString(
            "HEADER TEXT up to 60 characters, BODY up to 1024, FOOTER up to 60; WhatsApp placeholders like {{1}}"
          ),
          buttons: draftArray(
            draftObject(
              {
                type: draftEnum(AIRI_TEMPLATE_DRAFT_BUTTON_TYPES),
                text: draftString("Button text, 25 characters or fewer"),
                url: draftString("URL buttons only"),
                phone_number: draftString("PHONE_NUMBER buttons only"),
                flow_id: draftString(
                  "FLOW buttons only: keep an existing Flow id, never invent one"
                ),
                flow_action: draftEnum(AIRI_TEMPLATE_DRAFT_FLOW_ACTIONS),
              },
              ["url", "phone_number", "flow_id", "flow_action"]
            ),
            "BUTTONS only: up to 3 buttons"
          ),
        },
        ["format", "text", "buttons"]
      ),
      "Exactly one BODY; optional HEADER, FOOTER and BUTTONS"
    ),
    rationale: draftString("Why this template fits, up to 240 characters"),
    missingDetails: draftArray(
      draftString(),
      "Details the user still has to supply, up to 5"
    ),
  });

const compactText = (value: unknown, maxLength = 1024) =>
  readStringOrEmpty(value, { normalizeWhitespace: true, maxLength });

function normalizeTemplateName(value: unknown): string {
  const raw = compactText(value, 512)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
  if (raw && isValidTemplateName(raw)) return raw;
  return DEFAULT_TEMPLATE_NAME;
}

function normalizeLanguage(value: unknown, fallbackLanguage = "en"): string {
  const raw = compactText(value, 16).replace(/[^A-Za-z0-9_]/g, "_");
  return raw || fallbackLanguage;
}

function normalizeCategory(value: unknown): WhatsAppTemplateCategory {
  const category = compactText(value, 32).toUpperCase();
  return VALID_CATEGORIES.has(category as WhatsAppTemplateCategory)
    ? (category as WhatsAppTemplateCategory)
    : "MARKETING";
}

function sampleVariable(variable: string): string {
  return `${variable}_example`;
}

function normalizeHeaderComponent(value: Record<string, unknown>) {
  const format = compactText(value.format, 16).toUpperCase();
  if (format === "TEXT") {
    const text = compactText(value.text, 60);
    if (!text) return null;
    const example = buildWhatsAppTemplateTextExample({
      text,
      kind: "header",
      sample: sampleVariable,
    });
    return {
      type: "HEADER" as const,
      format: "TEXT" as const,
      text,
      ...(example ? { example } : {}),
    };
  }
  if (!isTemplateHeaderMediaFormat(format)) return null;

  const example =
    value.example && typeof value.example === "object"
      ? (value.example as Record<string, unknown>)
      : null;
  const headerHandle = Array.isArray(example?.header_handle)
    ? compactText(example.header_handle[0], 2048)
    : "";

  return {
    type: "HEADER" as const,
    format,
    ...(headerHandle ? { example: { header_handle: [headerHandle] } } : {}),
  };
}

function normalizeBodyComponent(value: Record<string, unknown>) {
  const text = compactText(value.text, 1024);
  if (!text) return null;
  const example = buildWhatsAppTemplateTextExample({
    text,
    kind: "body",
    sample: sampleVariable,
  });
  return {
    type: "BODY" as const,
    text,
    ...(example ? { example } : {}),
  };
}

function normalizeFooterComponent(value: Record<string, unknown>) {
  const text = compactText(value.text, 60);
  if (!text) return null;
  return {
    type: "FOOTER" as const,
    text,
  };
}

function normalizeButton(button: unknown) {
  if (!button || typeof button !== "object") return null;
  const record = button as Record<string, unknown>;
  const type = compactText(record.type, 32).toUpperCase();
  const text = compactText(record.text, 25);
  if (!text) return null;

  if (type === "URL" || type === "LINK" || (!type && compactText(record.url))) {
    const url = compactText(record.url, 2048);
    if (!url) return null;
    return { type: "URL" as const, text, url };
  }
  if (type === "PHONE_NUMBER") {
    const phoneNumber = compactText(
      record.phone_number ?? record.phoneNumber,
      32
    );
    if (!phoneNumber) return null;
    return { type: "PHONE_NUMBER" as const, text, phone_number: phoneNumber };
  }
  if (type === "FLOW") {
    const flowId = compactText(record.flow_id ?? record.flowId, 128);
    if (!flowId) return null;
    const flowAction = compactText(record.flow_action ?? record.flowAction, 32);
    return {
      type: "FLOW" as const,
      text,
      flow_id: flowId,
      ...(flowAction === "data_exchange" || flowAction === "navigate"
        ? { flow_action: flowAction }
        : {}),
    };
  }
  return !type || type === "QUICK_REPLY"
    ? { type: "QUICK_REPLY" as const, text }
    : null;
}

function normalizeButtonsComponent(value: Record<string, unknown>) {
  const buttons = Array.isArray(value.buttons)
    ? value.buttons.map(normalizeButton).filter(Boolean).slice(0, 3)
    : [];
  if (buttons.length === 0) return null;
  return {
    type: "BUTTONS" as const,
    buttons: buttons as WhatsAppButtonComponent["buttons"],
  };
}

function normalizeComponent(component: unknown): WhatsAppComponent | null {
  if (!component || typeof component !== "object") return null;
  const record = component as Record<string, unknown>;
  const type = compactText(record.type, 32).toUpperCase();
  if (type === "HEADER") return normalizeHeaderComponent(record);
  if (type === "BODY") return normalizeBodyComponent(record);
  if (type === "FOOTER") return normalizeFooterComponent(record);
  if (type === "BUTTONS") return normalizeButtonsComponent(record);
  return null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = compactText(value);
    if (text) return text;
  }
  return "";
}

function normalizeComponents(
  value: Record<string, unknown>
): WhatsAppComponent[] {
  const components = Array.isArray(value.components)
    ? value.components.map(normalizeComponent).filter(Boolean)
    : [];
  const hasBody = components.some(component => component?.type === "BODY");
  if (!hasBody) {
    const bodyText = firstString(value.bodyText, value.body, value.message);
    if (bodyText) {
      const bodyComponent = normalizeBodyComponent({ text: bodyText });
      if (bodyComponent) components.unshift(bodyComponent);
    }
  }

  if (!components.some(component => component?.type === "BUTTONS")) {
    const rawButtons = Array.isArray(value.buttons) ? value.buttons : [];
    const buttonsComponent = normalizeButtonsComponent({ buttons: rawButtons });
    if (buttonsComponent) components.push(buttonsComponent);
  }

  return components.filter(Boolean) as WhatsAppComponent[];
}

function normalizeStringList(
  value: unknown,
  maxItems = 5
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(item => compactText(item, 160)).filter(Boolean);
  return items.length > 0 ? items.slice(0, maxItems) : undefined;
}

export function normalizeAiriWhatsAppTemplateDraft(
  value: unknown,
  fallback?: {
    language?: string;
    name?: string;
    bodyText?: string;
  }
): AiriWhatsAppTemplateDraft | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const components = normalizeComponents(record);
  if (!components.some(component => component.type === "BODY")) {
    const bodyComponent = normalizeBodyComponent({
      text:
        fallback?.bodyText ||
        "Hi {{1}}, thanks for your interest. Reply to this message and we will help you choose the best next step.",
    });
    if (bodyComponent) components.unshift(bodyComponent);
  }
  if (components.length === 0) return null;

  return {
    kind: "whatsapp_template",
    name: normalizeTemplateName(record.name ?? fallback?.name),
    language: normalizeLanguage(record.language, fallback?.language || "en"),
    category: normalizeCategory(record.category),
    components,
    rationale: compactText(record.rationale, 240) || undefined,
    missingDetails: normalizeStringList(record.missingDetails),
  };
}

/**
 * A generated template draft, or null when the model wrote no BODY: the
 * normalizer's placeholder body is never saved as generated copy.
 */
export function normalizeGeneratedAiriWhatsAppTemplateDraft(
  value: unknown,
  options: { language?: string } = {}
): AiriWhatsAppTemplateDraft | null {
  if (!value || typeof value !== "object") return null;
  const hasBody = normalizeComponents(value as Record<string, unknown>).some(
    component => component.type === "BODY"
  );
  if (!hasBody) return null;
  return normalizeAiriWhatsAppTemplateDraft(value, {
    language: options.language,
  });
}

/**
 * An edit of an open template keeps its header media. The draft schema has
 * no field for the sample handle (an uploaded or generated asset is not the
 * model's to write), so a generated media HEADER always comes back without
 * one: it takes the active header's handle when the format is unchanged. A
 * changed format (or a header that became media) stays without a handle, so
 * an IMAGE header still gets a generated image.
 */
export function preserveActiveTemplateHeaderMedia(
  generated: AiriWhatsAppTemplateDraft,
  active: AiriWhatsAppTemplateDraft | null | undefined
): AiriWhatsAppTemplateDraft {
  const activeHeader = active?.components.find(
    component => component.type === "HEADER"
  );
  const activeHandle =
    activeHeader?.type === "HEADER" &&
    isTemplateHeaderMediaFormat(activeHeader.format)
      ? activeHeader.example?.header_handle?.[0]
      : undefined;
  if (
    !activeHeader ||
    activeHeader.type !== "HEADER" ||
    typeof activeHandle !== "string" ||
    !activeHandle.trim()
  ) {
    return generated;
  }
  let changed = false;
  const components = generated.components.map(component => {
    if (
      component.type !== "HEADER" ||
      component.format !== activeHeader.format ||
      component.example?.header_handle?.[0]
    ) {
      return component;
    }
    changed = true;
    return {
      ...component,
      example: { ...component.example, header_handle: [activeHandle] },
    };
  });
  return changed ? { ...generated, components } : generated;
}

export function isAiriWhatsAppTemplateDraft(
  value: unknown
): value is AiriWhatsAppTemplateDraft {
  return normalizeAiriWhatsAppTemplateDraft(value) !== null;
}
