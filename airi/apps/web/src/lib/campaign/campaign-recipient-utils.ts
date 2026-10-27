import { createWhatsAppTemplateQuickReplyPayloadFactory } from "@icecore/scenario-contracts";

import type { WhatsAppTemplateSendComponentInput } from "@/lib/whatsapp/templates/message-types";
import { buildWhatsAppTemplateSendComponentsFromTemplate } from "@/lib/whatsapp/templates/message-types";
import { normalizeCampaignVariableFieldKey } from "./campaign-variable-values";
import {
  normalizeWhatsAppPhone,
  parseWhatsAppRecipientTarget,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import { extractTemplateVariablesInOrder } from "@icecore/shared/types/whatsapp";
import { z } from "zod";

const EmailAddressSchema = z.string().email();

export type CampaignAdHocRecipient = {
  phone?: string;
  chatId?: string;
  email?: string;
  name?: string;
  fields?: Record<string, string>;
  variables?: Record<string, string>;
};

export type CampaignSendTemplateComponent = WhatsAppTemplateSendComponentInput;

/**
 * The scenario step's saved template and button ids. Tap payloads name the
 * step's buttons, so a route stays on its button when the approved template
 * orders them differently from the step's copy.
 */
export type CampaignScenarioStepTemplate = {
  components: unknown;
  buttonIds: unknown;
};

export function normalizeCampaignPhone(phone: string): string {
  return normalizeWhatsAppPhone(phone) || "";
}

export function normalizeCampaignEmail(email: unknown): string {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export function isValidCampaignEmailAddress(email: string): boolean {
  return EmailAddressSchema.safeParse(normalizeCampaignEmail(email)).success;
}

export function sortCampaignVariableKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const aIsNumeric = /^\d+$/.test(a);
    const bIsNumeric = /^\d+$/.test(b);
    if (aIsNumeric && bIsNumeric) {
      return Number.parseInt(a, 10) - Number.parseInt(b, 10);
    }
    if (aIsNumeric) return -1;
    if (bIsNumeric) return 1;
    return a.localeCompare(b);
  });
}

export function collectCampaignTemplateVariables(
  templateComponents: WhatsAppComponent[] | undefined
): string[] {
  if (!templateComponents || templateComponents.length === 0) return [];
  const keys = new Set<string>();

  for (const component of templateComponents) {
    if (component.type === "HEADER" && component.text) {
      extractTemplateVariablesInOrder(component.text).forEach(key =>
        keys.add(key)
      );
    }
    if (component.type === "BODY" && component.text) {
      extractTemplateVariablesInOrder(component.text).forEach(key =>
        keys.add(key)
      );
    }
    if (component.type === "BUTTONS") {
      component.buttons?.forEach(button => {
        if (button.type === "URL" && button.url) {
          extractTemplateVariablesInOrder(button.url).forEach(key =>
            keys.add(key)
          );
        }
      });
    }
  }

  return sortCampaignVariableKeys(Array.from(keys));
}

/**
 * The row's own name: its name, or a name, full_name, first_name or
 * customer_name column. Empty when it has none; never the phone or
 * "Customer" that template variables fall back to.
 */
export function resolveCampaignRecipientContactName(
  recipient: CampaignAdHocRecipient
): string {
  const name = recipient.name?.trim();
  if (name) return name;
  const fields = new Map<string, string>(
    Object.entries(recipient.fields || {}).map(([fieldKey, value]) => [
      normalizeCampaignVariableFieldKey(fieldKey),
      value,
    ])
  );
  for (const fieldKey of ["name", "full_name", "first_name", "customer_name"]) {
    const value = fields.get(fieldKey)?.trim();
    if (value) return value;
  }
  return "";
}

export function resolveCampaignRecipientTemplateValue(
  recipient: CampaignAdHocRecipient,
  key: string
): string {
  const fields = recipient.fields || {};
  const normalizedFields = new Map<string, string>(
    Object.entries(fields).map(([fieldKey, value]) => [
      fieldKey.trim().toLowerCase().replace(/\s+/g, "_"),
      value,
    ])
  );

  const getFieldValue = (...fieldKeys: string[]) => {
    for (const fieldKey of fieldKeys) {
      const normalized = fieldKey.trim().toLowerCase().replace(/\s+/g, "_");
      const value = normalizedFields.get(normalized);
      if (value && value.trim().length > 0) return value.trim();
    }
    return "";
  };

  const direct = recipient.variables?.[key]?.trim();
  if (direct) return direct;

  const fromCsvVariable = getFieldValue(
    key,
    `var${key}`,
    `var_${key}`,
    `variable${key}`,
    `variable_${key}`
  );
  if (fromCsvVariable) return fromCsvVariable;

  const name = resolveCampaignRecipientContactName(recipient);
  const phone = (recipient.phone || recipient.chatId || "").trim();

  if (/name/i.test(key) && name) return name;
  if (/(phone|chat|number)/i.test(key) && phone) return phone;
  if (/^\d+$/.test(key)) {
    const numericKey = Number.parseInt(key, 10);
    if (numericKey === 1 && name) return name;
    if (numericKey === 2 && phone) return phone;
  }

  return name || phone || "";
}

function mergeTemplateSendComponents(
  requested: WhatsAppTemplateSendComponentInput[] | undefined,
  inferred: WhatsAppTemplateSendComponentInput[] | undefined
): WhatsAppTemplateSendComponentInput[] | undefined {
  const merged: WhatsAppTemplateSendComponentInput[] = [];
  const seen = new Set<string>();

  function keyOf(component: WhatsAppTemplateSendComponentInput): string {
    if (component.type === "button") {
      return `button:${component.sub_type}:${String(component.index)}`;
    }
    return component.type;
  }

  for (const component of [...(requested || []), ...(inferred || [])]) {
    const key = keyOf(component);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(component);
  }

  return merged.length > 0 ? merged : undefined;
}

function hasHeaderMediaParameter(
  components: WhatsAppTemplateSendComponentInput[] | undefined,
  format: "IMAGE" | "VIDEO" | "DOCUMENT"
): boolean {
  return Boolean(
    components?.some(component => {
      if (component.type === "carousel") {
        return component.cards.some(card =>
          hasHeaderMediaParameter(card.components, format)
        );
      }
      if (component.type !== "header") return false;
      return component.parameters.some(parameter => {
          if (format === "IMAGE") {
            return (
              parameter.type === "image" &&
              Boolean(
                parameter.image.link?.trim() || parameter.image.id?.trim()
              )
            );
          }
          if (format === "VIDEO") {
            return (
              parameter.type === "video" &&
              Boolean(
                parameter.video.link?.trim() || parameter.video.id?.trim()
              )
            );
          }
          return (
            parameter.type === "document" &&
            Boolean(
              parameter.document.link?.trim() || parameter.document.id?.trim()
            )
          );
        });
    })
  );
}

/**
 * Same keys as `buildTemplateValueMap` in `/api/conversations/[id]/send-template/route.ts`,
 * for bulk rows without a conversation/chat/user document.
 */
export function buildBulkWhatsAppTemplateValueMap(params: {
  workspaceId: string;
  campaignId?: string | null;
  recipient: CampaignAdHocRecipient;
}): Record<string, string> {
  const phoneRaw = String(params.recipient.phone || "").trim();
  const target = parseWhatsAppRecipientTarget(phoneRaw);
  const digits =
    target?.kind === "phone"
      ? target.value
      : normalizeWhatsAppPhone(phoneRaw.replace(/^wa_/i, "")) ||
        normalizeWhatsAppPhone(phoneRaw) ||
        "";

  const waId = digits;
  const whatsappId = waId;

  const fullName =
    resolveCampaignRecipientTemplateValue(params.recipient, "name") ||
    String(params.recipient.name || "").trim() ||
    "Customer";
  const firstName =
    String(
      params.recipient.variables?.first_name ||
        params.recipient.fields?.first_name ||
        ""
    ).trim() ||
    (() => {
      const [first] = fullName.trim().split(/\s+/).filter(Boolean);
      return first || "";
    })();
  const lastName = String(
    params.recipient.variables?.last_name || params.recipient.fields?.last_name
  ).trim();
  const username = String(
    params.recipient.variables?.username || params.recipient.fields?.username
  ).trim();

  return {
    "1": fullName,
    "2": waId || whatsappId,
    name: fullName,
    full_name: fullName,
    customer_name: fullName,
    first_name: firstName,
    last_name: lastName,
    username,
    title: "",
    phone: waId,
    wa_id: waId,
    whatsapp_id: whatsappId,
    whatsapp_user_id: "",
    whatsapp_parent_user_id: "",
    chat_id: "",
    conversation_id: "",
    channel: "whatsapp",
    preferred_language: "",
    workspace_id: params.workspaceId,
    campaign_id: params.campaignId ? String(params.campaignId) : "",
  };
}

export function buildCampaignWhatsappRecipientPayload(params: {
  workspaceId: string;
  campaignId?: string | null;
  scenarioId?: string | null;
  scenarioNodeId?: string | null;
  /** Without it, tap payloads carry the sent template's positions. */
  scenarioStepTemplate?: CampaignScenarioStepTemplate | null;
  recipient: CampaignAdHocRecipient;
  sourceId?: string | null;
  templateName?: string | null;
  templateComponents: WhatsAppComponent[] | undefined;
  requiredTemplateVariables: string[];
  strictRequiredTemplateVariables?: boolean;
}): {
  recipientValues: Record<string, string>;
  components: CampaignSendTemplateComponent[] | undefined;
  missingRequired: string[];
  headerMediaMissing?: { format: "IMAGE" | "VIDEO" | "DOCUMENT" };
} {
  const baseMap = buildBulkWhatsAppTemplateValueMap({
    workspaceId: params.workspaceId,
    campaignId: params.campaignId,
    recipient: params.recipient,
  });

  const recipientValues: Record<string, string> = {
    ...baseMap,
    ...(params.recipient.variables || {}),
  };

  if (params.requiredTemplateVariables.length > 0) {
    params.requiredTemplateVariables.forEach(key => {
      const explicit = recipientValues[key]?.trim();
      if (explicit) return;
      const normalizedKey = key.trim().toLowerCase().replace(/\s+/g, "_");
      const explicitField = Object.entries(params.recipient.fields || {}).find(
        ([fieldKey]) =>
          fieldKey.trim().toLowerCase().replace(/\s+/g, "_") === normalizedKey
      )?.[1];
      const fallback = params.strictRequiredTemplateVariables
        ? String(
            explicitField ||
              (/^[12]$/.test(key)
                ? resolveCampaignRecipientTemplateValue(params.recipient, key)
                : "")
          ).trim()
        : resolveCampaignRecipientTemplateValue(params.recipient, key);
      if (fallback) recipientValues[key] = fallback;
    });
  }

  const missingRequired = params.requiredTemplateVariables.filter(
    key => !recipientValues[key] || !recipientValues[key].trim()
  );

  if (Object.keys(recipientValues).length === 0) {
    return {
      recipientValues,
      components: undefined,
      missingRequired,
    };
  }

  const scenarioId = params.scenarioId?.trim() || "";
  const scenarioNodeId = params.scenarioNodeId?.trim() || "";

  const inferred = buildWhatsAppTemplateSendComponentsFromTemplate({
    templateComponents: params.templateComponents,
    values: recipientValues,
    ...(scenarioNodeId
      ? {
          createQuickReplyPayload:
            createWhatsAppTemplateQuickReplyPayloadFactory({
              actionNodeId: scenarioNodeId,
              sentComponents: params.templateComponents,
              stepComponents: params.scenarioStepTemplate?.components,
              stepButtonIds: params.scenarioStepTemplate?.buttonIds,
            }),
        }
      : {}),
    ...(scenarioId && scenarioNodeId
      ? {
          createFlowToken: () => `bulk:${scenarioId}:${scenarioNodeId}`,
        }
      : {}),
  });

  const merged = mergeTemplateSendComponents(undefined, inferred.components);

  const missingHeaderMedia = inferred.issues.find(
    issue => issue.type === "missing_header_media"
  );
  if (
    missingHeaderMedia &&
    !hasHeaderMediaParameter(merged, missingHeaderMedia.format)
  ) {
    return {
      recipientValues,
      components: undefined,
      missingRequired,
      headerMediaMissing: { format: missingHeaderMedia.format },
    };
  }

  if (merged && merged.length > 0) {
    return {
      recipientValues,
      components: merged,
      missingRequired,
    };
  }

  if (
    !params.templateComponents?.length &&
    Object.keys(recipientValues).length > 0
  ) {
    const sortedKeys = sortCampaignVariableKeys(Object.keys(recipientValues));
    return {
      recipientValues,
      components: [
        {
          type: "body" as const,
          parameters: sortedKeys.map(key => ({
            type: "text" as const,
            text: recipientValues[key],
          })),
        },
      ],
      missingRequired,
    };
  }

  return {
    recipientValues,
    components: undefined,
    missingRequired,
  };
}

export function personalizeCampaignTelegramMessage(
  template: string,
  variables?: Record<string, string>
): string {
  if (!variables || Object.keys(variables).length === 0) {
    return template;
  }

  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => variables[key] || `{{${key}}}`
  );
}

export function buildCampaignEmailTemplateModel(params: {
  templateModel?: Record<string, string>;
  recipientEmail: string;
  recipientVariables?: Record<string, string>;
}) {
  const model: Record<string, string> = {
    ...(params.templateModel || {}),
    ...(params.recipientVariables || {}),
    recipientEmail: params.recipientEmail,
  };
  if (!model.recipientName && params.recipientVariables?.name) {
    model.recipientName = params.recipientVariables.name;
  }
  return model;
}
