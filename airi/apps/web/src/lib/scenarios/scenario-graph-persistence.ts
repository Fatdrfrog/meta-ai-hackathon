import {
  isProbablyEmail,
  normalizeEmail as normalizeCustomerEmail,
} from "@/lib/customers/shared";
import {
  MAX_WHATSAPP_ACTION_ATTACHMENTS,
  normalizeScenarioActionAttachments,
} from "@/lib/scenarios/action-attachments";
import { canonicalizeScenarioNodeMediaForPersistence } from "@/lib/scenarios/scenario-asset-refs";
import { stripScenarioEditorFields } from "@/lib/scenarios/strip-editor-fields";
import {
  normalizeActionReplyChannelForActionNode,
  normalizeReplyModeForActionNode,
  coerceTelegramQuickRepliesToRows,
} from "@/lib/scenarios/normalization";
import { normalizeInstagramConfig } from "@/lib/scenarios/instagram-reply-config";
import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import {
  migratePersistedScenarioGraph,
  type MigratedScenarioGraph,
} from "@/lib/scenarios/scenario-graph-migrations";
import { WHATSAPP_SERVICE_MESSAGE_INCOMPATIBLE_OWNER_CLEAR_PATCH } from "@/lib/scenarios/whatsapp-service-message";
import {
  MAX_SCENARIO_REPLY_IMAGES,
  MAX_SCENARIO_REPLY_LINKS,
  isScenarioNodeDataKey,
  isScenarioNodeKind,
  normalizeGenerativeAIActionDraft,
  normalizeScenarioActionOutcomes,
  normalizeScenarioActionRunConditions,
  normalizeScenarioMode,
  normalizeScenarioWhatsAppTemplateButtonIds,
  normalizeScenarioWhatsAppTemplateForm,
  type ScenarioActionType,
  type ScenarioMode,
  type ScenarioNodeDataInput,
  type ScenarioReplyCtaType,
} from "@icecore/scenario-contracts";
import {
  isRecord,
  readNonEmptyStringOrUndefined as normalizeNodeText,
} from "@icecore/shared/lib/value-utils";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";

type ScenarioNodeRecord = Record<string, unknown>;

const PERSISTED_WHATSAPP_ACTION_FIELDS = new Set([
  "actionWhatsAppServiceMessage",
  "actionWhatsAppTemplateId",
  "actionWhatsAppTemplateName",
  "actionWhatsAppTemplateLanguage",
  "actionWhatsAppTemplateCategory",
  "actionWhatsAppTemplateComponents",
  "actionWhatsAppTemplateBindings",
  "actionWhatsAppTemplateButtonIds",
  "actionWhatsAppTemplateForm",
]);

const SCENARIO_REPLY_CTA_TYPE_SET = new Set<ScenarioReplyCtaType>([
  "none",
  "link",
  "flow",
]);

function resolveScenarioActionTypeForPersistence(
  nodeData: ScenarioNodeDataInput
): ScenarioActionType | null {
  if (nodeData.actionWhatsAppServiceMessage !== undefined) return "reply";
  const resolved = resolveScenarioActionTypeFromNodeData(nodeData);
  if (resolved) return resolved;

  const explicit =
    typeof nodeData.actionType === "string" ? nodeData.actionType.trim() : "";
  return explicit ? null : "reply";
}

function normalizeReplyCtaLabel(value: unknown): string | undefined {
  const normalized = normalizeNodeText(value);
  if (!normalized) return undefined;
  return normalized.slice(0, 30);
}

function normalizeNodeHttpUrls(value: unknown, maxCount: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
      const next = parsed.toString();
      if (seen.has(next)) continue;
      seen.add(next);
      normalized.push(next);
      if (normalized.length >= maxCount) break;
    } catch {
      continue;
    }
  }
  return normalized;
}

function resolveScenarioReplyCtaTypeForPersistence(params: {
  nodeData: ScenarioNodeDataInput;
  normalizedLinkUrls: string[];
  flowId?: string;
}): ScenarioReplyCtaType {
  const explicit =
    typeof params.nodeData.actionReplyCtaType === "string"
      ? params.nodeData.actionReplyCtaType.trim()
      : "";
  const hasLinks = params.normalizedLinkUrls.length > 0;
  const hasFlowId =
    typeof params.flowId === "string" && params.flowId.length > 0;

  if (SCENARIO_REPLY_CTA_TYPE_SET.has(explicit as ScenarioReplyCtaType)) {
    if (explicit === "flow") {
      if (hasFlowId) return "flow";
      if (hasLinks) return "link";
      return "none";
    }
    if (explicit === "link") {
      if (hasLinks) return "link";
      if (hasFlowId) return "flow";
      return "none";
    }
    return "none";
  }

  if (hasFlowId) return "flow";
  if (hasLinks) return "link";
  return "none";
}

function omitHandoffNotifyTargets(cleaned: ScenarioNodeDataInput): void {
  delete cleaned.actionHandoffNotifyEmail;
  delete cleaned.actionHandoffNotifyWhatsapp;
}

function omitReplyOwnerFields(cleaned: ScenarioNodeDataInput): void {
  delete cleaned.actionReplyMode;
  delete cleaned.actionReplyInstruction;
  delete cleaned.actionReplyText;
  delete cleaned.actionReplyChannel;
  delete cleaned.actionTelegramQuickReplies;
  delete cleaned.actionInstagramConfig;
  delete cleaned.actionReplyCtaType;
  delete cleaned.actionReplyCtaLabel;
  delete cleaned.actionReplyCtaFlowId;
  delete cleaned.actionReplyCtaFlowName;
}

function omitWhatsAppTemplateOwnerFields(cleaned: ScenarioNodeDataInput): void {
  delete cleaned.actionWhatsAppTemplateId;
  delete cleaned.actionWhatsAppTemplateName;
  delete cleaned.actionWhatsAppTemplateLanguage;
  delete cleaned.actionWhatsAppTemplateCategory;
  delete cleaned.actionWhatsAppTemplateComponents;
  delete cleaned.actionWhatsAppTemplateBindings;
  delete cleaned.actionWhatsAppTemplateButtonIds;
  delete cleaned.actionWhatsAppTemplateForm;
  delete cleaned.actionFlowConfig;
}

function omitGenerativeAIActionOwnerFields(
  cleaned: ScenarioNodeDataInput
): void {
  delete cleaned.actionGenerativeAIConfig;
}

function normalizeActionRoutingFieldsForPersistence(
  cleaned: ScenarioNodeDataInput,
  rawData: ScenarioNodeDataInput
): void {
  const actionRunConditionsResult = normalizeScenarioActionRunConditions(
    rawData.actionRunConditions
  );
  const actionOutcomesResult = normalizeScenarioActionOutcomes(
    rawData.actionOutcomes
  );

  if (actionRunConditionsResult.status === "supported") {
    cleaned.actionRunConditions = actionRunConditionsResult.value;
  } else if (actionRunConditionsResult.status === "unsupported") {
    cleaned.actionRunConditions = actionRunConditionsResult.raw;
  } else {
    delete cleaned.actionRunConditions;
  }

  if (actionOutcomesResult.status === "supported") {
    cleaned.actionOutcomes = actionOutcomesResult.value;
  } else if (actionOutcomesResult.status === "unsupported") {
    cleaned.actionOutcomes = actionOutcomesResult.raw;
  } else {
    delete cleaned.actionOutcomes;
  }
}

function normalizeWhatsAppTemplateButtonIdsForPersistence(
  cleaned: ScenarioNodeDataInput,
  rawData: ScenarioNodeDataInput
): void {
  const buttonIdsResult = normalizeScenarioWhatsAppTemplateButtonIds(
    rawData.actionWhatsAppTemplateButtonIds
  );
  if (buttonIdsResult.status === "supported") {
    cleaned.actionWhatsAppTemplateButtonIds = buttonIdsResult.value;
  } else if (buttonIdsResult.status === "unsupported") {
    cleaned.actionWhatsAppTemplateButtonIds = buttonIdsResult.raw;
  } else {
    delete cleaned.actionWhatsAppTemplateButtonIds;
  }
}

function normalizeWhatsAppTemplateFormForPersistence(
  cleaned: ScenarioNodeDataInput,
  rawData: ScenarioNodeDataInput
): void {
  const formResult = normalizeScenarioWhatsAppTemplateForm(
    rawData.actionWhatsAppTemplateForm
  );
  if (formResult.status === "supported") {
    cleaned.actionWhatsAppTemplateForm = formResult.value;
  } else if (formResult.status === "unsupported") {
    cleaned.actionWhatsAppTemplateForm = formResult.raw;
  } else {
    delete cleaned.actionWhatsAppTemplateForm;
  }
}

function normalizeScenarioNodeDataForPersistence(
  rawData: ScenarioNodeDataInput
): ScenarioNodeDataInput {
  const nodeKind = isScenarioNodeKind(rawData.kind) ? rawData.kind : undefined;
  const stripped = stripScenarioEditorFields(rawData);

  const cleaned: ScenarioNodeRecord = Object.fromEntries(
    Object.entries(stripped).filter(([key]) => {
      if (!isScenarioNodeDataKey(key)) return false;
      if (
        key.startsWith("actionWhatsApp") &&
        !PERSISTED_WHATSAPP_ACTION_FIELDS.has(key)
      ) {
        return false;
      }
      if (key === "source") {
        return false;
      }
      if (
        key === "actionSnippetId" ||
        key === "actionSnippetQuestion" ||
        key === "actionSnippetAnswer" ||
        key === "actionReplyTemplate"
      ) {
        return false;
      }
      return true;
    })
  );

  if (nodeKind) {
    cleaned.kind = nodeKind;
  } else {
    delete cleaned.kind;
  }

  if (cleaned.kind === "action") {
    const hasCanonicalServiceMessage =
      rawData.actionWhatsAppServiceMessage !== undefined;
    const actionType = hasCanonicalServiceMessage
      ? "reply"
      : resolveScenarioActionTypeForPersistence(rawData);
    if (actionType) cleaned.actionType = actionType;
    else delete cleaned.actionType;
    normalizeActionRoutingFieldsForPersistence(cleaned, rawData);
    if (actionType !== "generative_ai") {
      omitGenerativeAIActionOwnerFields(cleaned);
    }

    if (hasCanonicalServiceMessage) {
      cleaned.actionWhatsAppServiceMessage =
        rawData.actionWhatsAppServiceMessage;
      for (const key of Object.keys(
        WHATSAPP_SERVICE_MESSAGE_INCOMPATIBLE_OWNER_CLEAR_PATCH
      )) {
        delete cleaned[key];
      }
    } else if (actionType === "reply") {
      omitWhatsAppTemplateOwnerFields(cleaned);
      delete cleaned.actionWhatsAppServiceMessage;
      const replyMode = normalizeReplyModeForActionNode(rawData);
      const replyText =
        normalizeNodeText(rawData.actionReplyText) ||
        normalizeNodeText(rawData.actionSnippetAnswer) ||
        normalizeNodeText(rawData.actionReplyTemplate);
      const replyInstruction =
        normalizeNodeText(rawData.actionReplyInstruction) ||
        (replyMode === "ai"
          ? normalizeNodeText(rawData.actionInstruction)
          : undefined);

      cleaned.actionReplyMode = replyMode;
      const actionReplyChannel =
        normalizeActionReplyChannelForActionNode(rawData);
      if (actionReplyChannel) cleaned.actionReplyChannel = actionReplyChannel;
      else delete cleaned.actionReplyChannel;
      const instagramConfig =
        actionReplyChannel === "instagram"
          ? rawData.actionInstagramConfig === undefined
            ? undefined
            : normalizeInstagramConfig(rawData.actionInstagramConfig)
          : undefined;
      if (instagramConfig) cleaned.actionInstagramConfig = instagramConfig;
      else delete cleaned.actionInstagramConfig;
      const telegramQuickReplies =
        actionReplyChannel === "telegram"
          ? Array.isArray(rawData.actionTelegramQuickReplies)
            ? coerceTelegramQuickRepliesToRows(
                rawData.actionTelegramQuickReplies
              )
            : undefined
          : undefined;
      if (telegramQuickReplies) {
        cleaned.actionTelegramQuickReplies = telegramQuickReplies;
      } else {
        delete cleaned.actionTelegramQuickReplies;
      }
      if (replyText) cleaned.actionReplyText = replyText;
      else delete cleaned.actionReplyText;
      if (replyInstruction) {
        cleaned.actionReplyInstruction = replyInstruction;
      } else delete cleaned.actionReplyInstruction;
      const normalizedReplyLinkUrls = normalizeNodeHttpUrls(
        rawData.actionLinkUrls,
        MAX_SCENARIO_REPLY_LINKS
      );
      if (normalizedReplyLinkUrls.length > 0) {
        cleaned.actionLinkUrls = normalizedReplyLinkUrls;
      } else {
        delete cleaned.actionLinkUrls;
      }
      const replyCtaFlowId = normalizeNodeText(rawData.actionReplyCtaFlowId);
      const replyCtaType = resolveScenarioReplyCtaTypeForPersistence({
        nodeData: rawData,
        normalizedLinkUrls: normalizedReplyLinkUrls,
        flowId: replyCtaFlowId,
      });
      if (replyCtaType !== "none") cleaned.actionReplyCtaType = replyCtaType;
      else delete cleaned.actionReplyCtaType;
      if (replyCtaType === "flow" && replyCtaFlowId) {
        cleaned.actionReplyCtaFlowId = replyCtaFlowId;
        const replyCtaFlowName = normalizeNodeText(
          rawData.actionReplyCtaFlowName
        );
        if (replyCtaFlowName) cleaned.actionReplyCtaFlowName = replyCtaFlowName;
        else delete cleaned.actionReplyCtaFlowName;
      } else {
        delete cleaned.actionReplyCtaFlowId;
        delete cleaned.actionReplyCtaFlowName;
      }
      const replyCtaLabel = normalizeReplyCtaLabel(rawData.actionReplyCtaLabel);
      if (replyCtaType !== "none" && replyCtaLabel) {
        cleaned.actionReplyCtaLabel = replyCtaLabel;
      } else {
        delete cleaned.actionReplyCtaLabel;
      }
      const isWhatsAppReply =
        normalizeActionReplyChannelForActionNode(rawData) === "whatsapp";
      const maxReplyImageUrls = isWhatsAppReply
        ? MAX_WHATSAPP_ACTION_ATTACHMENTS
        : Array.isArray(rawData.actionMediaAssets)
          ? Math.max(MAX_SCENARIO_REPLY_IMAGES, 10)
          : MAX_SCENARIO_REPLY_IMAGES;
      const normalizedReplyAttachments = normalizeScenarioActionAttachments({
        attachments: rawData.actionAttachments,
        legacyUrls: rawData.actionImageUrls,
        generatedAssets: rawData.actionMediaAssets,
        limit: maxReplyImageUrls,
      });
      const normalizedReplyImageUrls = normalizedReplyAttachments.map(
        attachment => attachment.url
      );
      if (normalizedReplyAttachments.length > 0) {
        cleaned.actionAttachments = normalizedReplyAttachments;
      } else {
        delete cleaned.actionAttachments;
      }
      if (normalizedReplyImageUrls.length > 0) {
        cleaned.actionImageUrls = normalizedReplyImageUrls;
      } else {
        delete cleaned.actionImageUrls;
      }

      delete cleaned.actionInstruction;
      omitHandoffNotifyTargets(cleaned);
    } else if (actionType === "assign_human") {
      omitWhatsAppTemplateOwnerFields(cleaned);
      delete cleaned.actionWhatsAppServiceMessage;
      const handoffInstruction =
        normalizeNodeText(rawData.actionInstruction) ||
        normalizeNodeText(rawData.actionReplyInstruction);
      if (handoffInstruction) cleaned.actionInstruction = handoffInstruction;
      else delete cleaned.actionInstruction;
      const notifyEmailRaw = normalizeNodeText(
        rawData.actionHandoffNotifyEmail
      );
      if (
        notifyEmailRaw &&
        isProbablyEmail(normalizeCustomerEmail(notifyEmailRaw))
      ) {
        cleaned.actionHandoffNotifyEmail =
          normalizeCustomerEmail(notifyEmailRaw);
      } else if (notifyEmailRaw) {
        cleaned.actionHandoffNotifyEmail = rawData.actionHandoffNotifyEmail;
      } else {
        delete cleaned.actionHandoffNotifyEmail;
      }
      const notifyWa = normalizeWhatsAppPhone(
        rawData.actionHandoffNotifyWhatsapp
      );
      if (notifyWa) cleaned.actionHandoffNotifyWhatsapp = notifyWa;
      else if (normalizeNodeText(rawData.actionHandoffNotifyWhatsapp)) {
        cleaned.actionHandoffNotifyWhatsapp =
          rawData.actionHandoffNotifyWhatsapp;
      } else delete cleaned.actionHandoffNotifyWhatsapp;
      omitReplyOwnerFields(cleaned);
    } else if (actionType === "whatsapp_template") {
      normalizeWhatsAppTemplateButtonIdsForPersistence(cleaned, rawData);
      normalizeWhatsAppTemplateFormForPersistence(cleaned, rawData);
      omitHandoffNotifyTargets(cleaned);
      delete cleaned.actionInstruction;
      delete cleaned.actionWhatsAppServiceMessage;
      omitReplyOwnerFields(cleaned);
    } else if (actionType === "generative_ai") {
      omitHandoffNotifyTargets(cleaned);
      omitReplyOwnerFields(cleaned);
      omitWhatsAppTemplateOwnerFields(cleaned);
      delete cleaned.actionInstruction;
      delete cleaned.actionWhatsAppServiceMessage;
      delete cleaned.actionOutcomes;
      const config = normalizeGenerativeAIActionDraft(
        rawData.actionGenerativeAIConfig
      );
      if (config) cleaned.actionGenerativeAIConfig = config;
      else omitGenerativeAIActionOwnerFields(cleaned);
    } else if (actionType === "end_scenario") {
      omitHandoffNotifyTargets(cleaned);
      omitReplyOwnerFields(cleaned);
      omitWhatsAppTemplateOwnerFields(cleaned);
      delete cleaned.actionInstruction;
      delete cleaned.actionWhatsAppServiceMessage;
      delete cleaned.actionOutcomes;
      delete cleaned.actionAttachments;
      delete cleaned.actionImageUrls;
      delete cleaned.actionLinkUrls;
      delete cleaned.actionMediaAssets;
    } else {
      omitHandoffNotifyTargets(cleaned);
      delete cleaned.actionInstruction;
      delete cleaned.actionWhatsAppServiceMessage;
      omitReplyOwnerFields(cleaned);
      omitWhatsAppTemplateOwnerFields(cleaned);
      omitGenerativeAIActionOwnerFields(cleaned);
    }
  }

  return canonicalizeScenarioNodeMediaForPersistence(cleaned);
}

export function normalizeScenarioNodesForPersistence(
  rawNodes: unknown
): unknown[] {
  return normalizeScenarioGraphForPersistence({
    nodes: rawNodes,
    edges: [],
  }).nodes;
}

export function normalizeScenarioModeForPersistence(
  mode: unknown,
  nodes: readonly unknown[]
): ScenarioMode {
  const normalizedMode = normalizeScenarioMode(mode);
  if (normalizedMode !== "bulk_campaign") return normalizedMode;

  let hasTrigger = false;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const data = (node as { data?: { kind?: unknown } }).data;
    // Bulk roots also serve generated conversation workflows. Their mode is
    // intentional, and incomplete drafts without a root retain their mode.
    if (data?.kind === "bulk") return normalizedMode;
    if (data?.kind === "trigger") hasTrigger = true;
  }

  // A client-message graph must remain eligible for inbound runtime lookup
  // after an operator replaces a former campaign root in the builder.
  return hasTrigger ? "conversation" : normalizedMode;
}

export function normalizeScenarioGraphForPersistence(
  raw: unknown
): MigratedScenarioGraph {
  const migrated = migratePersistedScenarioGraph(raw);

  return {
    ...migrated,
    nodes: migrated.nodes.map(node => {
      if (!isRecord(node) || !isRecord(node.data)) return node;
      return {
        ...node,
        data: normalizeScenarioNodeDataForPersistence(node.data),
      };
    }),
  };
}
