import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import {
  normalizeScenarioWhatsAppServiceMessage,
  resolveWhatsAppFlowProviderId,
  type ScenarioNodeData,
  type ScenarioWhatsAppBodySource,
  type ScenarioWhatsAppServiceMessage,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { readTrimmedString as clean } from "@icecore/shared/lib/value-utils";

export type ScenarioWhatsAppServiceMessageResolution =
  | { status: "canonical"; value: ScenarioWhatsAppServiceMessage }
  | { status: "unsupported_version"; version: number }
  | { status: "invalid" }
  | { status: "not_applicable" };

export type EditableScenarioWhatsAppServiceMessageResolution = Extract<
  ScenarioWhatsAppServiceMessageResolution,
  { status: "canonical" }
>;

function uniqueTexts(values: unknown[]): string[] {
  return Array.from(new Set(values.map(clean).filter(Boolean)));
}

function bodySourceText(body: ScenarioWhatsAppBodySource | null | undefined) {
  if (!body) return "";
  return body.mode === "fixed" ? clean(body.text) : clean(body.instruction);
}

export function resolveScenarioWhatsAppServiceMessage(
  nodeData: ScenarioNodeData
): ScenarioWhatsAppServiceMessageResolution {
  if (nodeData.actionWhatsAppServiceMessage !== undefined) {
    const normalized = normalizeScenarioWhatsAppServiceMessage(
      nodeData.actionWhatsAppServiceMessage
    );
    if (normalized.status === "supported") {
      return { status: "canonical", value: normalized.value };
    }
    if (normalized.status === "unsupported_version") return normalized;
    return { status: "invalid" };
  }

  return { status: "not_applicable" };
}

export function isEditableScenarioWhatsAppServiceMessageResolution(
  resolution: ScenarioWhatsAppServiceMessageResolution
): resolution is EditableScenarioWhatsAppServiceMessageResolution {
  return resolution.status === "canonical";
}

export function getWhatsAppFlowAuthoringTexts(
  flowConfig: WhatsAppFlowConfig | null | undefined
): string[] {
  if (!flowConfig) return [];
  const values: unknown[] = [
    flowConfig.metaFlowName,
    flowConfig.ctaText,
    flowConfig.headerText,
    flowConfig.bodyText,
    flowConfig.footerText,
  ];
  for (const screen of flowConfig.screens || []) {
    values.push(screen.title);
    for (const field of screen.fields || []) {
      values.push(field.label, field.helperText);
      for (const option of field.options || []) {
        values.push(option.title);
      }
    }
  }
  return uniqueTexts(values);
}

export function getScenarioWhatsAppServiceMessageAuthoringTexts(
  value: ScenarioWhatsAppServiceMessage
): string[] {
  const message = value.message;
  const body = bodySourceText("body" in message ? message.body : undefined);
  const values: unknown[] = body ? [body] : [];

  switch (message.kind) {
    case "text":
    case "media":
    case "location_request":
    case "request_contact_info":
      break;
    case "reply_buttons":
      values.push(
        message.header?.kind === "text" ? message.header.text : "",
        message.footerText,
        ...message.options.map(option => option.label)
      );
      break;
    case "list":
      values.push(message.headerText, message.footerText, message.buttonLabel);
      for (const section of message.sections) {
        values.push(section.title);
        for (const row of section.rows) {
          values.push(row.title, row.description);
        }
      }
      break;
    case "cta_url":
      values.push(
        message.header?.kind === "text" ? message.header.text : "",
        message.footerText,
        message.buttonLabel,
        message.urlSource.kind === "signup_link"
          ? message.urlSource.signupLinkName
          : ""
      );
      break;
    case "media_carousel":
      for (const card of message.cards) {
        values.push(card.bodyText);
        if (card.interaction.kind === "url") {
          values.push(card.interaction.buttonLabel);
        } else {
          values.push(...card.interaction.options.map(option => option.label));
        }
      }
      break;
    case "flow":
      values.push(...getWhatsAppFlowAuthoringTexts(message.flowConfig));
      break;
    case "appointment":
      values.push(message.config.eventTitle);
      break;
    case "contacts":
      for (const contact of message.contacts) {
        values.push(
          contact.formattedName,
          contact.firstName,
          contact.lastName,
          contact.company,
          contact.title,
          contact.phone,
          contact.email,
          contact.websiteUrl
        );
      }
      break;
    case "location":
      values.push(message.location.name, message.location.address);
      break;
    case "voice_call":
      values.push(message.buttonLabel);
      break;
    case "commerce": {
      const commerce = message.commerce;
      values.push(
        "bodyText" in commerce ? commerce.bodyText : "",
        "headerText" in commerce ? commerce.headerText : "",
        "footerText" in commerce ? commerce.footerText : ""
      );
      if (commerce.mode === "multi_product") {
        values.push(...commerce.sections.map(section => section.title));
      }
      break;
    }
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }

  return uniqueTexts(values);
}

export function resolveScenarioWhatsAppServiceFlowConfig(
  nodeData: ScenarioNodeData
): WhatsAppFlowConfig | null {
  const resolution = resolveScenarioWhatsAppServiceMessage(nodeData);
  if (!isEditableScenarioWhatsAppServiceMessageResolution(resolution)) {
    return null;
  }
  return resolution.value.message.kind === "flow"
    ? resolution.value.message.flowConfig
    : null;
}

/**
 * Flow metadata used to interpret an inbound WhatsApp Flow response.
 * Service messages and template-linked Flows remain separate authoring
 * surfaces, but response routing needs one fail-closed lookup.
 */
export function resolveScenarioWhatsAppInteractiveFlowConfig(
  nodeData: ScenarioNodeData
): WhatsAppFlowConfig | null {
  return resolveScenarioWhatsAppInteractiveFlowTarget(nodeData)?.config ?? null;
}

export type ScenarioWhatsAppInteractiveFlowTarget = {
  config: WhatsAppFlowConfig;
  owner: "template" | "service_message";
};

export function resolveScenarioWhatsAppInteractiveFlowTarget(
  nodeData: ScenarioNodeData
): ScenarioWhatsAppInteractiveFlowTarget | null {
  const serviceFlowConfig = resolveScenarioWhatsAppServiceFlowConfig(nodeData);
  if (
    serviceFlowConfig ||
    nodeData.actionWhatsAppServiceMessage !== undefined
  ) {
    return serviceFlowConfig
      ? { config: serviceFlowConfig, owner: "service_message" }
      : null;
  }
  const templateFlowConfig =
    resolveScenarioActionTypeFromNodeData(nodeData) === "whatsapp_template"
      ? nodeData.actionFlowConfig
      : null;
  return templateFlowConfig
    ? { config: templateFlowConfig, owner: "template" }
    : null;
}

export function whatsappTemplateAwaitingFlowReply(
  data: ScenarioNodeData
): boolean {
  if (data.kind !== "action") return false;
  const ctaType =
    typeof data.actionReplyCtaType === "string"
      ? data.actionReplyCtaType.trim()
      : "";
  const flowId = resolveWhatsAppFlowProviderId({
    flowConfig: data.actionFlowConfig,
    legacyFlowId: data.actionReplyCtaFlowId,
  });
  if (ctaType === "flow" && flowId) return true;
  return Boolean(flowId);
}

/**
 * The action takes a WhatsApp Flow submission as its reply: a service-message
 * Flow, or a template whose Flow button has a Flow id. The runtime and the
 * builder share this check.
 */
export function scenarioActionAwaitsWhatsAppFlowReply(
  data: ScenarioNodeData
): boolean {
  const interactiveFlowConfig =
    resolveScenarioWhatsAppInteractiveFlowConfig(data);
  const actionType = resolveScenarioActionTypeFromNodeData(data);
  return (
    interactiveFlowConfig !== null ||
    (actionType === "whatsapp_template" &&
      whatsappTemplateAwaitingFlowReply(data))
  );
}

export function buildScenarioWhatsAppInteractiveFlowConfigPatch(
  nodeData: ScenarioNodeData,
  flowConfig: WhatsAppFlowConfig
): Partial<ScenarioNodeData> | null {
  const target = resolveScenarioWhatsAppInteractiveFlowTarget(nodeData);
  if (!target) return null;

  if (target.owner === "template") {
    return { actionFlowConfig: flowConfig };
  }

  const resolution = resolveScenarioWhatsAppServiceMessage(nodeData);
  if (
    resolution.status !== "canonical" ||
    resolution.value.message.kind !== "flow"
  ) {
    return null;
  }

  return buildWhatsAppServiceMessagePatch({
    version: 1,
    message: {
      ...resolution.value.message,
      flowConfig,
    },
  });
}

export type ScenarioWhatsAppServiceMessagePresentation = {
  previewText?: string;
  title?: string;
};

export function projectScenarioWhatsAppServiceMessagePresentation(
  nodeData: ScenarioNodeData
): ScenarioWhatsAppServiceMessagePresentation | null {
  const resolution = resolveScenarioWhatsAppServiceMessage(nodeData);
  if (!isEditableScenarioWhatsAppServiceMessageResolution(resolution)) {
    return null;
  }

  const message = resolution.value.message;
  const body = bodySourceText("body" in message ? message.body : undefined);
  let previewText = body;
  let title = "";

  switch (message.kind) {
    case "media":
      previewText =
        previewText ||
        clean(message.attachment.fileName) ||
        clean(message.attachment.path);
      break;
    case "media_carousel":
      previewText =
        previewText ||
        clean(message.cards[0]?.bodyText) ||
        clean(message.cards[0]?.media.fileName);
      break;
    case "flow":
      title =
        clean(message.flowConfig?.metaFlowName) ||
        resolveWhatsAppFlowProviderId({ flowConfig: message.flowConfig }) ||
        clean(message.flowConfig?.ctaText);
      break;
    case "contacts": {
      const contact = message.contacts[0];
      title =
        clean(contact?.formattedName) ||
        uniqueTexts([contact?.firstName, contact?.lastName]).join(" ") ||
        clean(contact?.company);
      previewText =
        clean(contact?.phone) ||
        clean(contact?.email) ||
        clean(contact?.websiteUrl) ||
        title;
      break;
    }
    case "location": {
      title = clean(message.location.name);
      previewText = clean(message.location.address);
      if (!previewText) {
        const latitude = Number(message.location.latitude);
        const longitude = Number(message.location.longitude);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          previewText = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        }
      }
      break;
    }
    case "commerce":
      title =
        message.commerce.mode === "multi_product"
          ? clean(message.commerce.headerText)
          : "";
      previewText =
        "bodyText" in message.commerce ? clean(message.commerce.bodyText) : "";
      break;
    case "text":
    case "reply_buttons":
    case "list":
    case "cta_url":
    case "appointment":
    case "location_request":
    case "request_contact_info":
    case "voice_call":
      break;
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }

  return {
    ...(previewText ? { previewText } : {}),
    ...(title ? { title } : {}),
  };
}

export const WHATSAPP_SERVICE_MESSAGE_INCOMPATIBLE_OWNER_CLEAR_PATCH = {
  actionInstruction: undefined,
  actionHandoffNotifyEmail: undefined,
  actionHandoffNotifyWhatsapp: undefined,
  actionReplyMode: undefined,
  actionReplyChannel: undefined,
  actionReplyInstruction: undefined,
  actionReplyText: undefined,
  actionReplyTemplate: undefined,
  actionReplyCtaType: undefined,
  actionReplyCtaLabel: undefined,
  actionReplyCtaFlowId: undefined,
  actionReplyCtaFlowName: undefined,
  actionLinkUrls: undefined,
  actionAttachments: undefined,
  actionImageUrls: undefined,
  actionMediaAssets: undefined,
  actionSnippetId: undefined,
  actionSnippetQuestion: undefined,
  actionSnippetAnswer: undefined,
  actionFlowConfig: undefined,
  actionWhatsAppTemplateId: undefined,
  actionWhatsAppTemplateName: undefined,
  actionWhatsAppTemplateLanguage: undefined,
  actionWhatsAppTemplateCategory: undefined,
  actionWhatsAppTemplateComponents: undefined,
  actionWhatsAppTemplateBindings: undefined,
  actionWhatsAppTemplateButtonIds: undefined,
  actionWhatsAppTemplateForm: undefined,
} as Record<string, undefined>;

export function buildWhatsAppServiceMessagePatch(
  next: ScenarioWhatsAppServiceMessage
): Partial<ScenarioNodeData> {
  return {
    actionType: "reply",
    actionWhatsAppServiceMessage: next,
    ...WHATSAPP_SERVICE_MESSAGE_INCOMPATIBLE_OWNER_CLEAR_PATCH,
  };
}

/**
 * Route an existing-Flow picker result to the canonical service-message owner.
 */
export function buildScenarioWhatsAppServiceFlowSelectionPatch(
  nodeData: ScenarioNodeData,
  flowConfig: WhatsAppFlowConfig
): Partial<ScenarioNodeData> | null {
  const resolution = resolveScenarioWhatsAppServiceMessage(nodeData);
  if (
    resolution.status === "canonical" &&
    resolution.value.message.kind === "flow"
  ) {
    return buildWhatsAppServiceMessagePatch({
      version: 1,
      message: {
        ...resolution.value.message,
        flowConfig,
      },
    });
  }

  return null;
}
