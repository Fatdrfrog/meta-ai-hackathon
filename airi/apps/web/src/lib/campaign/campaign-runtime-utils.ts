import { normalizeString } from "@/lib/scenarios/task-utils";
import {
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
  SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
  isBulkCampaignRootNode,
} from "@icecore/scenario-contracts";
import { isRecord, readStringOrEmpty } from "@icecore/shared/lib/value-utils";
import { parseBirthdayCampaignScheduleConfig } from "./campaign-birthday-schedule";

export type CampaignScheduleType = "weekly" | "relative";
export type CampaignChannel = "whatsapp" | "telegram" | "email";
export type ScheduledCampaignChannel = CampaignChannel;

export type CampaignNodeRecord = {
  id?: unknown;
  data?: Record<string, unknown>;
};

export type CampaignNodeLike = CampaignNodeRecord | null;

export type CampaignEdgeRecord = {
  source?: unknown;
  sourceHandle?: unknown;
  target?: unknown;
  targetHandle?: unknown;
};

export type ResolvedScheduledCampaignNode = {
  nodeId: string;
  data: Record<string, unknown>;
  sourceNodeId?: string;
  sourceNodeData?: Record<string, unknown>;
};

type ResolvedBulkWhatsAppTemplateNode = {
  nodeId: string;
  data: Record<string, unknown>;
  templateName: string;
  templateLanguage: string;
  templateCategory: string;
  templateComponents: unknown[] | null;
};

type ResolvedBulkTelegramReplyNode = {
  nodeId: string;
  data: Record<string, unknown>;
  messageText: string;
};

export function normalizeCampaignScheduleType(
  value: unknown
): CampaignScheduleType {
  return normalizeString(value).toLowerCase() === "relative"
    ? "relative"
    : "weekly";
}

export function resolveCampaignNodeChannel(value: unknown): CampaignChannel {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "email") return "email";
  if (normalized === "telegram") return "telegram";
  return "whatsapp";
}

export function resolveScheduledCampaignNodeChannel(
  value: unknown
): ScheduledCampaignChannel {
  return resolveCampaignNodeChannel(value);
}

export function isWhatsAppMarketingCampaignNode(
  nodeData: Record<string, unknown>
): boolean {
  return (
    resolveCampaignNodeChannel(nodeData.channel) === "whatsapp" &&
    String(nodeData.templateCategory || "") === "MARKETING"
  );
}

export function getIncomingCampaignNodeIds(
  edges: CampaignEdgeRecord[],
  nodeId: string
): string[] {
  return edges
    .filter(edge => String(edge?.target || "") === nodeId)
    .map(edge => String(edge.source || ""))
    .filter(Boolean);
}

function resolveActionTemplateData(
  nodeData: Record<string, unknown>
): Omit<ResolvedBulkWhatsAppTemplateNode, "nodeId" | "data"> | null {
  const generatedTemplateDraft = isRecord(nodeData.generatedTemplateDraft)
    ? nodeData.generatedTemplateDraft
    : null;
  const templateName =
    readStringOrEmpty(nodeData.actionWhatsAppTemplateName, { trim: true }) ||
    readStringOrEmpty(generatedTemplateDraft?.name, { trim: true });
  if (!templateName) return null;

  const actionType = readStringOrEmpty(nodeData.actionType, {
    trim: true,
  }).toLowerCase();
  const source = readStringOrEmpty(nodeData.source, {
    trim: true,
  }).toLowerCase();
  const templateComponents = Array.isArray(
    nodeData.actionWhatsAppTemplateComponents
  )
    ? nodeData.actionWhatsAppTemplateComponents
    : Array.isArray(generatedTemplateDraft?.components)
      ? generatedTemplateDraft.components
      : null;
  const looksLikeTemplate =
    actionType === "whatsapp_template" ||
    source === "whatsapp" ||
    Boolean(templateComponents);
  if (!looksLikeTemplate) return null;

  return {
    templateName,
    templateLanguage:
      readStringOrEmpty(nodeData.actionWhatsAppTemplateLanguage, {
        trim: true,
      }) ||
      readStringOrEmpty(generatedTemplateDraft?.language, { trim: true }) ||
      "en",
    templateCategory:
      readStringOrEmpty(nodeData.actionWhatsAppTemplateCategory, {
        trim: true,
      }) ||
      readStringOrEmpty(nodeData.templateCategory, { trim: true }) ||
      readStringOrEmpty(generatedTemplateDraft?.category, { trim: true }),
    templateComponents,
  };
}

export function isBirthdayBulkCampaignNode(node: CampaignNodeLike): boolean {
  const nodeData = node?.data;
  if (
    !isRecord(nodeData) ||
    readStringOrEmpty(nodeData.kind, { trim: true }) !== "bulk"
  ) {
    return false;
  }

  const bulkRootConfig = isRecord(nodeData.bulkRootConfig)
    ? nodeData.bulkRootConfig
    : null;
  return (
    readStringOrEmpty(bulkRootConfig?.recipientAudienceSource, {
      trim: true,
    }) === SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE
  );
}

/** A builder bulk-campaign root whose audience is customer birthdays. */
export function isBuilderBirthdayCampaignRoot(node: CampaignNodeLike): boolean {
  return isBulkCampaignRootNode(node) && isBirthdayBulkCampaignNode(node);
}

/**
 * The only builder root that gets a Temporal schedule: a birthday root whose
 * stored config is the daily v2 recurrence the builder writes. A missing or
 * legacy config never falls back to the weekly default.
 */
export function isSchedulableBuilderBirthdayRoot(
  node: CampaignNodeLike
): boolean {
  if (!isBuilderBirthdayCampaignRoot(node)) return false;
  const bulkRootConfig = node?.data?.bulkRootConfig;
  const rawScheduleConfig = isRecord(bulkRootConfig)
    ? bulkRootConfig.scheduleConfig
    : null;
  // The builder editor shows a stored config only when its mode is exactly
  // "recurring" (otherwise its own daily default), while the v2 parse reads
  // any non-"once" mode as recurring; never fire at a time it doesn't show.
  if (!isRecord(rawScheduleConfig) || rawScheduleConfig.mode !== "recurring") {
    return false;
  }
  const scheduleConfig = parseBirthdayCampaignScheduleConfig(rawScheduleConfig);
  return (
    scheduleConfig?.mode === "recurring" &&
    scheduleConfig.recurrence.kind === "daily"
  );
}

export function resolveBulkRootPrimaryWhatsAppTemplateNode(params: {
  bulkNode: CampaignNodeLike;
  nodes: CampaignNodeRecord[];
  edges: CampaignEdgeRecord[];
}): ResolvedBulkWhatsAppTemplateNode | null {
  const bulkNodeId = normalizeString(params.bulkNode?.id);
  if (!bulkNodeId) return null;

  for (const edge of params.edges) {
    if (normalizeString(edge.source) !== bulkNodeId) continue;
    if (
      normalizeString(edge.sourceHandle) !==
      BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID
    ) {
      continue;
    }

    const targetNodeId = normalizeString(edge.target);
    const targetNode = params.nodes.find(
      node => normalizeString(node?.id) === targetNodeId
    );
    const targetData = targetNode?.data;
    if (!targetNodeId || !isRecord(targetData)) continue;
    if (readStringOrEmpty(targetData.kind, { trim: true }) !== "action")
      continue;

    const templateData = resolveActionTemplateData(targetData);
    if (!templateData) continue;

    return {
      nodeId: targetNodeId,
      data: targetData,
      ...templateData,
    };
  }

  return null;
}

export function resolveBulkRootPrimaryTelegramReplyNode(params: {
  bulkNode: CampaignNodeLike;
  nodes: CampaignNodeRecord[];
  edges: CampaignEdgeRecord[];
}): ResolvedBulkTelegramReplyNode | null {
  const bulkNodeId = normalizeString(params.bulkNode?.id);
  if (!bulkNodeId) return null;

  for (const edge of params.edges) {
    if (normalizeString(edge.source) !== bulkNodeId) continue;
    if (
      normalizeString(edge.sourceHandle) !==
      BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID
    ) {
      continue;
    }

    const targetNodeId = normalizeString(edge.target);
    const targetNode = params.nodes.find(
      node => normalizeString(node?.id) === targetNodeId
    );
    const targetData = targetNode?.data;
    if (!targetNodeId || !isRecord(targetData)) continue;
    if (readStringOrEmpty(targetData.kind, { trim: true }) !== "action")
      continue;
    if (
      readStringOrEmpty(targetData.actionType, { trim: true }).toLowerCase() !==
        "reply" ||
      readStringOrEmpty(targetData.actionReplyChannel, {
        trim: true,
      }).toLowerCase() !== "telegram" ||
      readStringOrEmpty(targetData.actionReplyMode, {
        trim: true,
      }).toLowerCase() === "ai"
    ) {
      continue;
    }

    const messageText = readStringOrEmpty(targetData.actionReplyText, {
      trim: true,
    });
    if (!messageText) continue;
    return { nodeId: targetNodeId, data: targetData, messageText };
  }

  return null;
}

export function resolveScheduledCampaignNode(params: {
  node: CampaignNodeLike;
  nodes?: CampaignNodeRecord[];
  edges?: CampaignEdgeRecord[];
}): ResolvedScheduledCampaignNode | null {
  const nodeId = normalizeString(params.node?.id);
  const nodeData = params.node?.data || {};
  if (!nodeId) return null;

  if (!isBirthdayBulkCampaignNode(params.node)) {
    return {
      nodeId,
      data: nodeData,
    };
  }

  const bulkRootConfig = isRecord(nodeData.bulkRootConfig)
    ? nodeData.bulkRootConfig
    : {};
  const telegramReplyNode = resolveBulkRootPrimaryTelegramReplyNode({
    bulkNode: params.node,
    nodes: Array.isArray(params.nodes) ? params.nodes : [],
    edges: Array.isArray(params.edges) ? params.edges : [],
  });
  if (telegramReplyNode) {
    return {
      nodeId,
      sourceNodeId: telegramReplyNode.nodeId,
      sourceNodeData: telegramReplyNode.data,
      data: {
        ...nodeData,
        ...telegramReplyNode.data,
        channel: "telegram",
        targetingMode: "dynamic",
        audienceFilter: "birthday",
        scheduleConfig: bulkRootConfig.scheduleConfig,
        birthdayConfig: bulkRootConfig.birthdayConfig,
        uploadedRecipients: bulkRootConfig.uploadedRecipients,
        telegramSourceId: bulkRootConfig.telegramSubscriberSourceId,
        messageText: telegramReplyNode.messageText,
      },
    };
  }
  const templateNode = resolveBulkRootPrimaryWhatsAppTemplateNode({
    bulkNode: params.node,
    nodes: Array.isArray(params.nodes) ? params.nodes : [],
    edges: Array.isArray(params.edges) ? params.edges : [],
  });
  if (!templateNode) return null;

  return {
    nodeId,
    sourceNodeId: templateNode.nodeId,
    sourceNodeData: templateNode.data,
    data: {
      ...nodeData,
      ...templateNode.data,
      channel: "whatsapp",
      targetingMode: "dynamic",
      audienceFilter: "birthday",
      scheduleConfig: bulkRootConfig.scheduleConfig,
      birthdayConfig: bulkRootConfig.birthdayConfig,
      uploadedRecipients: bulkRootConfig.uploadedRecipients,
      templateName: templateNode.templateName,
      templateLanguage: templateNode.templateLanguage,
      templateCategory: templateNode.templateCategory,
      templateComponents: templateNode.templateComponents,
    },
  };
}

export function buildCampaignTemplateComponentsFromNode(
  nodeData: Record<string, unknown>
) {
  const customComponents = nodeData.templateComponents;
  if (Array.isArray(customComponents) && customComponents.length > 0) {
    return customComponents;
  }

  const templateVariables = nodeData.templateVariables;
  if (
    !templateVariables ||
    typeof templateVariables !== "object" ||
    Array.isArray(templateVariables)
  ) {
    return null;
  }

  const entries = Object.entries(templateVariables as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({
      key,
      value: String(value),
    }))
    .sort((a, b) => {
      const numA = Number.parseInt(a.key, 10);
      const numB = Number.parseInt(b.key, 10);
      if (Number.isNaN(numA) || Number.isNaN(numB)) {
        return a.key.localeCompare(b.key);
      }
      return numA - numB;
    });

  if (entries.length === 0) return null;

  return [
    {
      type: "body",
      parameters: entries.map(entry => ({
        type: "text",
        text: entry.value,
      })),
    },
  ];
}
