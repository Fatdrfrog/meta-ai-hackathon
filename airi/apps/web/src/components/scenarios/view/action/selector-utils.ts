"use client";

import { DEFAULT_INSTAGRAM_CONFIG } from "@/lib/scenarios/instagram-reply-config";
import { getWhatsAppTemplateOptionValue } from "@/lib/whatsapp/templates/selection";
import { findMatchingScenarioWhatsAppTemplate } from "@/lib/scenarios/whatsapp-template-selection";
import { buildWhatsAppTemplateButtonIdsPatch } from "@/lib/scenarios/whatsapp-template-button-branches";
import { buildWhatsAppTemplateFormAlignmentPatch } from "@/lib/scenarios/whatsapp-template-flow";
import {
  buildWhatsAppServiceMessagePatch,
  resolveScenarioWhatsAppServiceMessage,
  WHATSAPP_SERVICE_MESSAGE_INCOMPATIBLE_OWNER_CLEAR_PATCH,
} from "@/lib/scenarios/whatsapp-service-message";
import { createDefaultScenarioWhatsAppServiceMessage } from "@icecore/scenario-contracts";
import { createDefaultGenerativeAIActionConfig } from "../../graph/node-palette";
import { resolveScenarioWhatsAppTemplateComponents } from "../scenario-template-utils";
import type {
  ScenarioActionSelectorType,
  ScenarioActionSourceId,
  ScenarioActionSourceOption,
  ScenarioActionType,
  ScenarioNodeData,
  ScenarioWhatsAppTemplate,
} from "../../types";
import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";

const ACTION_SOURCE_LABEL_KEY_BY_ID: Record<ScenarioActionSourceId, string> = {
  whatsapp: "actionSourceWhatsApp",
  instagram: "actionSourceInstagram",
  telegram: "actionSourceTelegram",
  email: "actionSourceEmail",
  web_widget: "actionSourceWebWidget",
  team: "actionSourceTeam",
  airi: "actionSourceAiri",
};

export function resolveActionSelectorTypeForNode(
  nodeData: ScenarioNodeData
): ScenarioActionSelectorType {
  if (nodeData.actionWhatsAppServiceMessage !== undefined) {
    return "whatsapp_service_message";
  }
  const actionType = resolveScenarioActionTypeFromNodeData(nodeData) ?? "reply";
  if (actionType !== "reply") return actionType;
  if (nodeData.actionReplyChannel === "telegram") return "telegram_builder";
  if (nodeData.actionReplyChannel === "instagram") return "instagram_reply";
  if (nodeData.actionReplyChannel === "email") return "email_reply";
  if (nodeData.actionReplyChannel === "web_widget") return "web_widget_reply";
  return Array.isArray(nodeData.actionTelegramQuickReplies)
    ? "telegram_builder"
    : "reply";
}

export function resolveActionSourceIdForSelector(
  selectorType: ScenarioActionSelectorType
): ScenarioActionSourceId {
  if (
    selectorType === "whatsapp_service_message" ||
    selectorType === "whatsapp_template"
  ) {
    return "whatsapp";
  }
  if (selectorType === "instagram_reply") return "instagram";
  if (selectorType === "email_reply") return "email";
  if (selectorType === "web_widget_reply") return "web_widget";
  if (selectorType === "telegram_builder") return "telegram";
  if (selectorType === "assign_human") return "team";
  return "airi";
}

export function resolveDefaultActionSelectorForSource(params: {
  sourceId: ScenarioActionSourceId;
  currentSelectorType: ScenarioActionSelectorType;
}): ScenarioActionSelectorType {
  const { sourceId, currentSelectorType } = params;

  if (sourceId === "whatsapp") {
    return currentSelectorType === "whatsapp_template"
      ? currentSelectorType
      : "whatsapp_service_message";
  }

  if (sourceId === "instagram") return "instagram_reply";
  if (sourceId === "telegram") return "telegram_builder";
  if (sourceId === "email") return "email_reply";
  if (sourceId === "web_widget") return "web_widget_reply";
  if (sourceId === "team") return "assign_human";
  return "reply";
}

/** Prefer WhatsApp builder; else first connected channel; else WhatsApp anyway. */
export function resolvePreferredReplyActionSource(
  connectedActionSources?: readonly ScenarioActionSourceId[] | null
): ScenarioActionSourceId {
  const connected = (connectedActionSources ?? []).filter(
    (source): source is Exclude<ScenarioActionSourceId, "team" | "airi"> =>
      source === "whatsapp" ||
      source === "instagram" ||
      source === "telegram" ||
      source === "email" ||
      source === "web_widget"
  );
  if (connected.includes("whatsapp")) return "whatsapp";
  if (connected[0]) return connected[0];
  return "whatsapp";
}

/** Defaults for the single palette "Reply" action. */
export function resolveDefaultReplyActionPatch(
  connectedActionSources?: readonly ScenarioActionSourceId[] | null
): Partial<ScenarioNodeData> {
  const sourceId = resolvePreferredReplyActionSource(connectedActionSources);
  return buildActionPatchForSelector({
    nodeData: undefined,
    selectorType: resolveDefaultActionSelectorForSource({
      sourceId,
      currentSelectorType: "reply",
    }),
  });
}

export function buildActionSourceOptions(params: {
  connectedActionSources?: Array<
    "whatsapp" | "instagram" | "telegram" | "web_widget" | "email"
  >;
  selectedSourceId: ScenarioActionSourceId;
  t: (key: string) => string;
}): ScenarioActionSourceOption[] {
  const ids: ScenarioActionSourceId[] = [];
  for (const source of params.connectedActionSources ?? []) {
    if (!ids.includes(source)) ids.push(source);
  }

  if (
    (params.selectedSourceId === "whatsapp" ||
      params.selectedSourceId === "instagram" ||
      params.selectedSourceId === "telegram" ||
      params.selectedSourceId === "email" ||
      params.selectedSourceId === "web_widget") &&
    !ids.includes(params.selectedSourceId)
  ) {
    ids.push(params.selectedSourceId);
  }

  return ids.map(id => ({
    id,
    label: params.t(ACTION_SOURCE_LABEL_KEY_BY_ID[id]),
  }));
}

export function patchAffectsActionBranchOptions(
  patch: Partial<ScenarioNodeData>
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(
      patch,
      "actionWhatsAppTemplateComponents"
    ) ||
    Object.prototype.hasOwnProperty.call(
      patch,
      "actionWhatsAppTemplateButtonIds"
    ) ||
    Object.prototype.hasOwnProperty.call(
      patch,
      "actionWhatsAppServiceMessage"
    ) ||
    Object.prototype.hasOwnProperty.call(patch, "actionFlowConfig") ||
    Object.prototype.hasOwnProperty.call(patch, "actionTelegramQuickReplies") ||
    Object.prototype.hasOwnProperty.call(patch, "actionInstagramConfig")
  );
}

export function buildActionPatchForSelector(params: {
  nodeData: ScenarioNodeData | undefined;
  selectorType: ScenarioActionSelectorType;
}): Partial<ScenarioNodeData> {
  const { nodeData, selectorType } = params;
  if (selectorType === "whatsapp_service_message") {
    const candidateNode: ScenarioNodeData = {
      ...(nodeData ?? { kind: "action" as const }),
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
    };
    const resolved = resolveScenarioWhatsAppServiceMessage(candidateNode);
    const next =
      resolved.status === "canonical"
        ? resolved.value
        : createDefaultScenarioWhatsAppServiceMessage("text");
    return {
      ...buildWhatsAppServiceMessagePatch(next),
      actionGenerativeAIConfig: undefined,
    };
  }
  if (selectorType === "generative_ai") {
    return {
      actionType: "generative_ai",
      actionGenerativeAIConfig: createDefaultGenerativeAIActionConfig(),
      actionWhatsAppServiceMessage: undefined,
      ...WHATSAPP_SERVICE_MESSAGE_INCOMPATIBLE_OWNER_CLEAR_PATCH,
    };
  }
  const isTelegramBuilder = selectorType === "telegram_builder";
  const isInstagramReply = selectorType === "instagram_reply";
  const isEmailReply = selectorType === "email_reply";
  const isWebWidgetReply = selectorType === "web_widget_reply";
  const persistedActionType: ScenarioActionType =
    isTelegramBuilder || isInstagramReply || isEmailReply || isWebWidgetReply
      ? "reply"
      : selectorType;

  return {
    actionType: persistedActionType,
    actionGenerativeAIConfig: undefined,
    actionWhatsAppServiceMessage: undefined,
    ...WHATSAPP_SERVICE_MESSAGE_INCOMPATIBLE_OWNER_CLEAR_PATCH,
    actionReplyMode: persistedActionType === "reply" ? "fixed" : undefined,
    actionReplyChannel: isInstagramReply
      ? "instagram"
      : isTelegramBuilder
        ? "telegram"
        : isEmailReply
          ? "email"
          : isWebWidgetReply
            ? "web_widget"
            : undefined,
    actionTelegramQuickReplies: isTelegramBuilder
      ? (nodeData?.actionTelegramQuickReplies ?? [])
      : undefined,
    actionInstagramConfig: isInstagramReply
      ? (nodeData?.actionInstagramConfig ?? DEFAULT_INSTAGRAM_CONFIG)
      : undefined,
    actionReplyText: nodeData?.actionReplyText,
    actionReplyInstruction: nodeData?.actionReplyInstruction,
    actionReplyCtaType: nodeData?.actionReplyCtaType,
    actionReplyCtaLabel: nodeData?.actionReplyCtaLabel,
    actionReplyCtaFlowId: nodeData?.actionReplyCtaFlowId,
    actionReplyCtaFlowName: nodeData?.actionReplyCtaFlowName,
    actionLinkUrls: nodeData?.actionLinkUrls,
    actionAttachments: nodeData?.actionAttachments,
    actionImageUrls: nodeData?.actionImageUrls,
  };
}

/**
 * How a template pick carries the step's reply-button routes over. The same
 * template in another language keeps them on the same places, as sends do;
 * another template keeps them only on buttons with the same text.
 */
export function resolveWhatsAppTemplatePickMatch(
  nodeData: Pick<ScenarioNodeData, "actionWhatsAppTemplateName"> | undefined,
  templateName: string | undefined
): "byIndex" | "textOnly" {
  return templateName && nodeData?.actionWhatsAppTemplateName === templateName
    ? "byIndex"
    : "textOnly";
}

/**
 * Points the step at a template. Reply buttons keep their ids by the rule of
 * resolveWhatsAppTemplatePickMatch, so branch sync keeps their routes and
 * removes the others. Form data the template can't send is dropped, by the
 * rule of buildWhatsAppTemplateFormAlignmentPatch; Undo on the pick brings
 * it back.
 */
export function buildActionWhatsAppTemplateSelectionPatch(params: {
  nodeData: ScenarioNodeData | undefined;
  templateValue: string;
  whatsAppTemplates: ScenarioWhatsAppTemplate[];
}): Partial<ScenarioNodeData> | null {
  const { nodeData: current, whatsAppTemplates } = params;
  const template = whatsAppTemplates.find(
    item => getWhatsAppTemplateOptionValue(item) === params.templateValue
  );
  if (!template) return null;
  const sameTemplate =
    current?.actionWhatsAppTemplateName === template.name &&
    current.actionWhatsAppTemplateLanguage === template.language &&
    (!current.actionWhatsAppTemplateId ||
      current.actionWhatsAppTemplateId === template.id);
  return {
    actionReplyText: undefined,
    generatedTemplateDraft: undefined,
    actionWhatsAppTemplateId: template.id,
    actionWhatsAppTemplateName: template.name,
    actionWhatsAppTemplateLanguage: template.language,
    actionWhatsAppTemplateCategory: template.category,
    actionWhatsAppTemplateComponents: template.components,
    ...buildWhatsAppTemplateButtonIdsPatch({
      previous: {
        actionWhatsAppTemplateComponents:
          resolveScenarioWhatsAppTemplateComponents({
            nodeData: current,
            whatsAppTemplates,
          }),
        actionWhatsAppTemplateButtonIds:
          current?.actionWhatsAppTemplateButtonIds,
      },
      components: template.components,
      match: resolveWhatsAppTemplatePickMatch(current, template.name),
    }),
    ...buildWhatsAppTemplateFormAlignmentPatch(current, template.components),
    ...(current?.actionWhatsAppTemplateBindings && !sameTemplate
      ? { actionWhatsAppTemplateBindings: { version: 1, parameters: {} } }
      : {}),
  };
}

function findActionTemplateOption(
  nodeData: ScenarioNodeData,
  whatsAppTemplates: ScenarioWhatsAppTemplate[]
): ScenarioWhatsAppTemplate | undefined {
  const match = findMatchingScenarioWhatsAppTemplate({
    nodeData,
    whatsAppTemplates,
  });
  if (match) return match;
  // Display a named selection that delegates language choice to the runtime.
  // This projection never writes a language back into the document.
  if (!nodeData.actionWhatsAppTemplateLanguage?.trim()) {
    return whatsAppTemplates.find(
      template =>
        template.name.trim() === nodeData.actionWhatsAppTemplateName?.trim()
    );
  }
  return undefined;
}

export function resolveActionTemplateOptions(params: {
  nodeData: ScenarioNodeData;
  whatsAppTemplates: ScenarioWhatsAppTemplate[];
}): ScenarioWhatsAppTemplate[] {
  const { nodeData, whatsAppTemplates } = params;
  const selectedTemplateName =
    nodeData.actionWhatsAppTemplateName?.trim() || "";
  const selectedTemplateLanguage =
    nodeData.actionWhatsAppTemplateLanguage?.trim() || "";
  const selectedTemplateId = nodeData.actionWhatsAppTemplateId?.trim() || "";

  if (!selectedTemplateName) {
    return whatsAppTemplates;
  }

  if (findActionTemplateOption(nodeData, whatsAppTemplates)) {
    return whatsAppTemplates;
  }

  return [
    {
      id: selectedTemplateId || undefined,
      name: selectedTemplateName,
      language: selectedTemplateLanguage,
      components: undefined,
    },
    ...whatsAppTemplates,
  ];
}

export function resolveActionTemplateValue(params: {
  nodeData: ScenarioNodeData;
  actionTemplates: ScenarioWhatsAppTemplate[];
}): string {
  const { nodeData, actionTemplates } = params;
  const matchingTemplate = findActionTemplateOption(nodeData, actionTemplates);
  if (matchingTemplate) return getWhatsAppTemplateOptionValue(matchingTemplate);
  const selectedTemplateName =
    nodeData.actionWhatsAppTemplateName?.trim() || "";
  const selectedTemplateLanguage =
    nodeData.actionWhatsAppTemplateLanguage?.trim() || "";

  if (selectedTemplateName) {
    return getWhatsAppTemplateOptionValue({
      name: selectedTemplateName,
      language: selectedTemplateLanguage,
    });
  }

  if (nodeData.actionWhatsAppTemplateId?.trim()) return "";

  const firstTemplate = actionTemplates[0];
  return firstTemplate ? getWhatsAppTemplateOptionValue(firstTemplate) : "";
}
