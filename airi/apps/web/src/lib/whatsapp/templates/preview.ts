import type {
  StoredWhatsAppTemplateButtonPreview,
  StoredWhatsAppTemplatePreview,
} from "@icecore/shared/types/message-preview";
import {
  asNullableWhatsAppRecord,
  compactWhatsAppString as asText,
} from "@icecore/shared/lib/whatsapp/value-utils";

function normalizeTemplateButton(
  button: unknown
): StoredWhatsAppTemplateButtonPreview | null {
  const buttonRecord = asNullableWhatsAppRecord(button);
  if (!buttonRecord) return null;

  const rawType = asText(buttonRecord.type)?.toUpperCase() || "QUICK_REPLY";
  if (rawType === "REQUEST_CONTACT_INFO") {
    return {
      type: "request_contact_info",
      text: "Request contact info",
    };
  }

  const text = asText(buttonRecord.text);
  if (!text) return null;

  if (rawType === "URL") {
    return {
      type: "url",
      text,
      value: asText(buttonRecord.url),
    };
  }

  if (rawType === "PHONE_NUMBER") {
    return {
      type: "phone",
      text,
      value: asText(buttonRecord.phone_number),
    };
  }

  if (rawType === "FLOW") {
    const flowAction = asText(buttonRecord.flow_action);
    return {
      type: "flow",
      text,
      flowId: asText(buttonRecord.flow_id),
      flowAction:
        flowAction === "data_exchange" || flowAction === "navigate"
          ? flowAction
          : null,
    };
  }

  return {
    type: "quick_reply",
    text,
  };
}

export function buildStoredWhatsAppTemplatePreview(params: {
  name?: string | null;
  languageCode?: string | null;
  components?: unknown;
}): StoredWhatsAppTemplatePreview | null {
  const preview: StoredWhatsAppTemplatePreview = {
    name: params.name?.trim() || null,
    languageCode: params.languageCode?.trim() || null,
    buttons: [],
  };

  if (Array.isArray(params.components)) {
    for (const component of params.components) {
      const componentRecord = asNullableWhatsAppRecord(component);
      if (!componentRecord) continue;

      const type = asText(componentRecord.type)?.toUpperCase();
      if (!type) continue;

      if (type === "HEADER") {
        const format = asText(componentRecord.format)?.toUpperCase();
        if (format === "TEXT") {
          preview.headerText = asText(componentRecord.text);
        }
        continue;
      }

      if (type === "BODY") {
        preview.bodyText = asText(componentRecord.text);
        continue;
      }

      if (type === "FOOTER") {
        preview.footerText = asText(componentRecord.text);
        continue;
      }

      if (type === "BUTTONS" && Array.isArray(componentRecord.buttons)) {
        preview.buttons = componentRecord.buttons
          .map(button => normalizeTemplateButton(button))
          .filter(
            (
              button
            ): button is NonNullable<
              ReturnType<typeof normalizeTemplateButton>
            > => Boolean(button)
          );
      }
    }
  }

  const hasContent =
    Boolean(preview.name) ||
    Boolean(preview.headerText) ||
    Boolean(preview.bodyText) ||
    Boolean(preview.footerText) ||
    Boolean(preview.buttons && preview.buttons.length > 0);

  return hasContent ? preview : null;
}

export function extractWhatsAppTemplateNameFromText(
  text?: string | null
): string | null {
  if (!text) return null;
  const match = text.match(/^\[Template:\s*([^\]]+)\]/i);
  return match?.[1]?.trim() || null;
}
