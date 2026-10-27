import {
  resolveOwnedScenarioWhatsAppServiceBodyMode,
  type ScenarioActionType,
  type ScenarioNodeDataInput,
  type ScenarioReplyMode,
} from "@icecore/scenario-contracts";

import { readStringOrEmpty } from "@icecore/shared/lib/value-utils";

export function resolveScenarioActionTypeFromNodeData(
  nodeData?: ScenarioNodeDataInput,
): ScenarioActionType | null {
  if (!nodeData) return null;
  if (nodeData.actionWhatsAppServiceMessage !== undefined) return "reply";
  const explicit =
    typeof nodeData.actionType === "string" ? nodeData.actionType.trim() : "";
  if (
    explicit === "reply" ||
    explicit === "whatsapp_template" ||
    explicit === "assign_human" ||
    explicit === "end_scenario" ||
    explicit === "generative_ai"
  ) {
    return explicit;
  }
  if (
    explicit === "instagram_reply" ||
    explicit === "draft_reply" ||
    explicit === "send_reply"
  ) {
    return "reply";
  }

  const source = readStringOrEmpty(nodeData.source, {
    trim: true,
  }).toLowerCase();
  if (source === "airi") return "reply";
  if (source === "whatsapp") return "whatsapp_template";
  if (source === "messaging" || source === "email" || source === "web_widget") {
    return "reply";
  }
  if (source === "team") return "assign_human";

  return null;
}

function normalizeNonEmptyTemplateText(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}

function resolveReplyTemplateTextFromNodeData(
  nodeData?: ScenarioNodeDataInput,
): string {
  if (!nodeData) return "";
  return (
    normalizeNonEmptyTemplateText(nodeData.actionReplyText) ||
    normalizeNonEmptyTemplateText(nodeData.actionReplyTemplate) ||
    normalizeNonEmptyTemplateText(nodeData.actionSnippetAnswer)
  );
}

export function resolveReplyModeFromNodeData(
  nodeData?: ScenarioNodeDataInput,
): ScenarioReplyMode {
  if (!nodeData) return "ai";

  const serviceBodyMode = resolveOwnedScenarioWhatsAppServiceBodyMode(nodeData);
  if (serviceBodyMode) return serviceBodyMode;

  const explicitMode =
    typeof nodeData.actionReplyMode === "string"
      ? nodeData.actionReplyMode.trim()
      : "";
  if (explicitMode === "ai" || explicitMode === "fixed") {
    return explicitMode;
  }

  const explicitType =
    typeof nodeData.actionType === "string" ? nodeData.actionType.trim() : "";
  if (explicitType === "send_reply") return "fixed";
  if (explicitType === "draft_reply") return "ai";

  const source = readStringOrEmpty(nodeData.source, {
    trim: true,
  }).toLowerCase();
  if (source === "messaging") return "fixed";
  if (source === "airi") return "ai";

  const hasFixedContent =
    resolveReplyTemplateTextFromNodeData(nodeData).length > 0;
  return hasFixedContent ? "fixed" : "ai";
}
