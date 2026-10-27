import { randomUUID } from "node:crypto";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import { captureFunnelEvent } from "@/lib/funnel-analytics";
import { describeScenarioGraphForFunnel } from "@/lib/scenarios/scenario-funnel";
import {
  getWorkspaceAiRequiredDetails,
  isWorkspaceAiPolicyError,
} from "@/lib/ai/workspace-ai-errors";
import { chatCompletionWithFallback, getReasoningTextModel } from "@/lib/ai";
import { extractJsonObject } from "@/lib/ai/json-object";
import {
  buildCanvaTemplateInspirationText,
  normalizeSelectedCanvaTemplates,
} from "@/lib/canva/brand-templates";
import {
  buildCompanyLimitExceededResponse,
  buildCompanyScenarioLimitExceededResponse,
  buildCompanyStudioChatLimitExceededResponse,
  ensureCompanyConversationCapacity,
  ensureCompanyScenarioCapacity,
  ensureCompanyStudioChatCapacity,
  recordCreativeStudioChat,
} from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { normalizeScenarioNodesForPersistence } from "@/lib/scenarios/scenario-graph-persistence";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { serializeScenario } from "@/lib/scenarios/scenario-serialization";
import { CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION } from "@/lib/scenarios/scenario-graph-migrations";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { validateScenarioGraph } from "@/lib/scenarios/graph-validation";
import {
  hasNewLegacyActionRoutingAssignments,
  LEGACY_ACTION_ROUTING_NEW_ASSIGNMENT_FORBIDDEN_CODE,
  LEGACY_ACTION_ROUTING_NEW_ASSIGNMENT_FORBIDDEN_MESSAGE,
} from "@/lib/scenarios/legacy-action-routing";
import {
  buildScenarioGeneratorGraph,
  type ScenarioGeneratorGraphActionPlan,
  type ScenarioGeneratorGraphBranchPlan,
} from "@/lib/scenario-generator/graph-builder";
import { ensureScenarioGeneratedRecipientMessageIndexes } from "@/lib/scenario-generator/generated-send-command";
import {
  buildRecipientCohorts,
  resolveScenarioGeneratorRecipients,
} from "@/lib/scenario-generator/recipients";
import { buildGeneratedWhatsAppTemplateComponents } from "@/lib/scenario-generator/whatsapp-template-drafts";
import { Conversation } from "@/models/conversation";
import { ScenarioGeneratedMediaAsset } from "@/models/scenario-generated-media-asset";
import { ScenarioGeneratedRecipientMessage } from "@/models/scenario-generated-recipient-message";
import { ScenarioGenerationJob } from "@/models/scenario-generation-job";
import { Scenario } from "@/models/scenario";
import {
  DEFAULT_SCENARIO_VIEWPORT,
  SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES,
  SCENARIO_GENERATOR_MAX_LOGICAL_RECIPIENTS,
  SCENARIO_GENERATOR_SOURCE_CONTEXT_MAX_ITEMS,
  normalizeScenarioGeneratorChannels,
  normalizeScenarioGeneratorPresetSeed,
  normalizeScenarioGeneratorSourceContext,
  type ResolvedScenarioGeneratorRecipient,
  type ScenarioCanvasNode,
  type ScenarioGeneratedAsset,
  type ScenarioGeneratorAssetRef,
  type ScenarioGeneratorChannel,
  type ScenarioGeneratorPresetSeed,
  type ScenarioGeneratorRecipient,
  type ScenarioGeneratorSendMode,
  type ScenarioGeneratorSourceContext,
  type ScenarioGeneratorWorkflowKind,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
import {
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
  getCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import { Types, type ClientSession } from "mongoose";
import { NextRequest, NextResponse } from "next/server";

// The graph orchestrator runs on the reasoning tier (Opus), slower than the
// 30 s AI default; pin the duration instead of relying on the platform default.
export const maxDuration = 300;

/** Below maxDuration, leaving room for the scenario and draft writes. */
const ACTION_GRAPH_AI_TIMEOUT_MS = 120_000;

type Params = Promise<{ workspaceId: string }>;

type CreateBody = {
  prompt?: string;
  workflowKind?: ScenarioGeneratorWorkflowKind;
  sendMode?: ScenarioGeneratorSendMode;
  channels?: ScenarioGeneratorChannel[];
  campaignName?: string;
  recipientSourceSummary?: string;
  recipients?: ScenarioGeneratorRecipient[];
  sourceIds?: string[];
  sourceContext?: ScenarioGeneratorSourceContext[];
  assetRefs?: Array<Partial<ScenarioGeneratorAssetRef>>;
  selectedCanvaTemplates?: unknown[];
  presetSeed?: unknown;
};

type ConversationContextForAi = {
  channel: string | null;
  chat: string | null;
  sourceId: string | null;
  historySummary: string | null;
  classificationCategory: string | null;
  classificationSummary: string | null;
  labels: string[];
  lastMessageAt: string | null;
};

const MAX_SCENARIO_GENERATOR_CREATE_SOURCE_SCOPE_ITEMS =
  SCENARIO_GENERATOR_SOURCE_CONTEXT_MAX_ITEMS;
const MAX_SCENARIO_GENERATOR_CREATE_ASSETS = 100;
const MAX_SCENARIO_GENERATOR_CREATE_CANVA_TEMPLATES = 50;
const GENERATED_RECIPIENT_INSERT_CHUNK_SIZE = 500;

function buildScenarioGeneratorCreateLimitResponse(params: {
  code: string;
  label: string;
  limit: number;
  requested: number;
}) {
  return NextResponse.json(
    {
      error: `${params.label} may contain at most ${params.limit} items.`,
      code: params.code,
      limit: params.limit,
      requested: params.requested,
    },
    { status: 400 }
  );
}

function inferAssetKind(
  asset: NonNullable<CreateBody["assetRefs"]>[number]
): "image" | "video" | "audio" | "document" {
  if (
    asset.kind === "image" ||
    asset.kind === "video" ||
    asset.kind === "audio" ||
    asset.kind === "document"
  ) {
    return asset.kind;
  }
  const mime = String(asset.mimeType || "").toLowerCase();
  const url = String(asset.url || asset.fileName || "").toLowerCase();
  if (
    mime.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp)(?:$|[?#])/.test(url)
  ) {
    return "image";
  }
  if (mime.startsWith("video/") || /\.(mp4|webm|mov)(?:$|[?#])/.test(url)) {
    return "video";
  }
  if (mime.startsWith("audio/") || /\.(mp3|wav|m4a|ogg)(?:$|[?#])/.test(url)) {
    return "audio";
  }
  return "document";
}

function normalizeAssetSource(
  source: NonNullable<CreateBody["assetRefs"]>[number]["source"]
): NonNullable<ScenarioGeneratorAssetRef["source"]> {
  return source === "higgsfield" ? "higgsfield" : "uploaded";
}

function inferTemplateHeaderMediaFormat(
  kind: ReturnType<typeof inferAssetKind>
): "IMAGE" | "VIDEO" | "DOCUMENT" | undefined {
  if (kind === "image") return "IMAGE";
  if (kind === "video") return "VIDEO";
  if (kind === "document") return "DOCUMENT";
  return undefined;
}

function buildTemplateName(campaignName: string, nodeId: string): string {
  const base = `${campaignName}-${nodeId}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return base || `generated_${Date.now()}`;
}

function decorateGeneratedActionNodes(params: {
  nodes: ScenarioCanvasNode[];
  channels: Array<"whatsapp" | "telegram" | "email">;
  campaignName: string;
}): ScenarioCanvasNode[] {
  const shouldDraftWhatsAppTemplate = params.channels.includes("whatsapp");

  return params.nodes.map(node => {
    if (node.data.kind !== "action" || node.data.actionType !== "reply") {
      return node;
    }

    const nodeAssets = node.data.actionMediaAssets || [];
    const nodeAssetUrls = Array.from(
      new Set([
        ...(node.data.actionImageUrls || []),
        ...nodeAssets.map(asset => asset.url).filter(Boolean),
      ])
    );
    const headerAsset = nodeAssets.find(asset =>
      ["image", "video", "document"].includes(asset.kind)
    );
    const headerMediaFormat = headerAsset
      ? inferTemplateHeaderMediaFormat(headerAsset.kind)
      : undefined;
    const actionText =
      node.data.actionReplyText ||
      `Generated message for ${node.data.bulkRecipientBranchId || "branch"}`;
    const nextData: ScenarioNodeData = {
      ...node.data,
      actionReplyCtaType: node.data.actionReplyCtaType || "none",
      actionLinkUrls: node.data.actionLinkUrls || [],
      actionImageUrls: nodeAssetUrls,
      actionMediaAssets: nodeAssets,
    };

    if (shouldDraftWhatsAppTemplate) {
      const components = buildGeneratedWhatsAppTemplateComponents({
        actionText,
        headerAsset,
        headerMediaFormat,
        ctaType: nextData.actionReplyCtaType,
        ctaLabel: nextData.actionReplyCtaLabel,
        linkUrl: nextData.actionLinkUrls?.[0],
        flowId: nextData.actionReplyCtaFlowId,
      });
      nextData.actionType = "whatsapp_template";
      nextData.actionWhatsAppTemplateName = buildTemplateName(
        params.campaignName,
        node.id
      );
      nextData.actionWhatsAppTemplateLanguage = "en";
      nextData.actionWhatsAppTemplateComponents = components;
      nextData.generatedTemplateDraft = {
        id: new Types.ObjectId().toString(),
        name: nextData.actionWhatsAppTemplateName,
        language: "en",
        category: "MARKETING",
        status: "draft",
        headerMediaUrl: headerAsset?.url,
        headerMediaFormat,
        components,
      };
    }

    return {
      ...node,
      data: nextData,
    };
  });
}

function asTrimmedString(value: unknown): string {
  if (value == null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value).trim();
  }
  return "";
}

function normalizeUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map(item => asTrimmedString(item)).filter(Boolean))
  );
}

function normalizeStringArray(value: unknown, max = 10): string[] {
  return normalizeUniqueStringArray(value).slice(0, max);
}

function buildSelectedDeliverySourceScope(params: {
  channels: ScenarioGeneratorChannel[];
  sourceIds: string[];
  sourceContext: ScenarioGeneratorSourceContext[];
}): Record<"whatsapp" | "telegram", Set<string>> {
  const selectedSourceIds = new Set(params.sourceIds);
  const scope = {
    whatsapp: new Set<string>(),
    telegram: new Set<string>(),
  };
  for (const source of params.sourceContext) {
    if (source.type !== "whatsapp" && source.type !== "telegram") continue;
    const sourceId = asTrimmedString(source.id);
    if (!sourceId) continue;
    const isExplicitDeliverySource = source.role === "delivery";
    const isSelectedLegacyTypedSource =
      !source.role && selectedSourceIds.has(sourceId);
    if (!isExplicitDeliverySource && !isSelectedLegacyTypedSource) continue;
    scope[source.type].add(sourceId);
  }

  const nonEmailChannels = params.channels.filter(
    (channel): channel is "whatsapp" | "telegram" => channel !== "email"
  );
  if (nonEmailChannels.length === 1 && params.sourceIds.length === 1) {
    const [channel] = nonEmailChannels;
    const hasTypedChannelContext = params.sourceContext.some(
      source => source.type === channel
    );
    if (!hasTypedChannelContext && scope[channel].size === 0) {
      scope[channel].add(params.sourceIds[0]);
    }
  }

  return scope;
}

function resolveGeneratedMessageSourceId(params: {
  channel: ScenarioGeneratorChannel;
  recipientSourceId?: string | null;
  deliverySourceScope: Record<"whatsapp" | "telegram", Set<string>>;
}): string | null {
  if (params.channel === "email") return null;
  const candidates = params.deliverySourceScope[params.channel];
  const recipientSourceId = asTrimmedString(params.recipientSourceId);
  if (recipientSourceId && candidates.has(recipientSourceId)) {
    return recipientSourceId;
  }
  if (candidates.size !== 1) return null;
  return candidates.values().next().value || null;
}

function normalizeExactUrl(value: string): string {
  const trimmed = value.trim().replace(/[)\].,!?;:]+$/g, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function extractExactUrlsFromText(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s<>"']+/gi) || [];
  return matches.map(normalizeExactUrl).filter(Boolean);
}

function buildAllowedScenarioActionUrls(params: {
  prompt: string;
  assets: ScenarioGeneratedAsset[];
  sourceContext: ScenarioGeneratorSourceContext[];
}): Set<string> {
  const urls = new Set<string>();
  for (const url of extractExactUrlsFromText(params.prompt)) {
    urls.add(url);
  }
  for (const asset of params.assets) {
    if (asset.url) urls.add(normalizeExactUrl(asset.url));
  }
  for (const source of params.sourceContext) {
    if (source.label) {
      for (const url of extractExactUrlsFromText(source.label)) {
        urls.add(url);
      }
    }
  }
  urls.delete("");
  return urls;
}

function sanitizeGeneratedActionBranches(params: {
  branches?: ScenarioGeneratorGraphBranchPlan[];
  allowedUrls: Set<string>;
}): ScenarioGeneratorGraphBranchPlan[] | undefined {
  if (!params.branches) return undefined;
  return params.branches.map(branch => ({
    ...branch,
    actions: branch.actions?.map(action => {
      if (action.cta?.type !== "link") return action;
      const ctaUrl = normalizeExactUrl(action.cta.url || "");
      if (ctaUrl && params.allowedUrls.has(ctaUrl)) {
        return {
          ...action,
          cta: {
            ...action.cta,
            url: ctaUrl,
          },
        };
      }
      return {
        ...action,
        cta: {
          type: "none",
          label: action.cta.label,
        },
      };
    }),
  }));
}

function normalizeAiGraphAction(
  value: unknown,
  index: number
): ScenarioGeneratorGraphActionPlan | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const text = asTrimmedString(raw.text || raw.actionReplyText);
  if (!text) return null;
  const rawCta =
    raw.cta && typeof raw.cta === "object"
      ? (raw.cta as Record<string, unknown>)
      : {};
  const ctaTypeRaw = asTrimmedString(rawCta.type).toLowerCase();
  const ctaType =
    ctaTypeRaw === "url"
      ? "link"
      : ctaTypeRaw === "quick_reply" || ctaTypeRaw === "reply"
        ? "quick_reply"
        : ctaTypeRaw === "link" || ctaTypeRaw === "flow"
          ? ctaTypeRaw
          : "none";
  const ctaLabel =
    ctaType === "none"
      ? undefined
      : asTrimmedString(rawCta.label || rawCta.text) || undefined;
  const rawMedia =
    raw.media && typeof raw.media === "object"
      ? (raw.media as Record<string, unknown>)
      : {};

  return {
    id:
      asTrimmedString(raw.id) ||
      asTrimmedString(raw.key) ||
      `action-${index + 1}`,
    label: asTrimmedString(raw.label) || undefined,
    text,
    cta: {
      type: ctaType,
      label: ctaLabel,
      url: ctaType === "link" ? asTrimmedString(rawCta.url) : undefined,
      flowId: ctaType === "flow" ? asTrimmedString(rawCta.flowId) : undefined,
      flowName:
        ctaType === "flow" ? asTrimmedString(rawCta.flowName) : undefined,
    },
    media: {
      assetUrls: normalizeStringArray(
        rawMedia.assetUrls || rawMedia.urls || raw.assetUrls
      ),
      assetIds: normalizeStringArray(rawMedia.assetIds || raw.assetIds),
    },
  };
}

function normalizeAiGraphBranches(
  value: Record<string, unknown>
): ScenarioGeneratorGraphBranchPlan[] {
  const rawBranches = Array.isArray(value.branches) ? value.branches : [];
  const branches: ScenarioGeneratorGraphBranchPlan[] = [];
  for (const branch of rawBranches) {
    if (!branch || typeof branch !== "object") continue;
    const raw = branch as Record<string, unknown>;
    const actions = Array.isArray(raw.actions)
      ? raw.actions
          .map((action, index) => normalizeAiGraphAction(action, index))
          .filter((action): action is ScenarioGeneratorGraphActionPlan =>
            Boolean(action)
          )
          .slice(0, 6)
      : [];
    if (actions.length === 0) continue;
    branches.push({
      cohortId:
        asTrimmedString(raw.cohortId) || asTrimmedString(raw.id) || undefined,
      id: asTrimmedString(raw.id) || undefined,
      label: asTrimmedString(raw.label) || undefined,
      actions,
    });
  }
  return branches.slice(0, 10);
}

async function generateActionBranchesWithAi(params: {
  workspaceId: string;
  prompt: string;
  workflowKind: string;
  sendMode: string;
  channels: ScenarioGeneratorChannel[];
  sourceIds: string[];
  campaignName: string;
  recipientSourceSummary: string;
  cohorts: Array<{ id: string; label: string; count: number }>;
  assets: ScenarioGeneratedAsset[];
  sourceContext: ScenarioGeneratorSourceContext[];
  selectedCanvaTemplates: unknown[];
  presetSeed: ScenarioGeneratorPresetSeed | null;
  conversationContext: ConversationContextForAi[];
}): Promise<ScenarioGeneratorGraphBranchPlan[] | undefined> {
  try {
    const result = await chatCompletionWithFallback({
      model: getReasoningTextModel(),
      resilience: { timeoutMs: ACTION_GRAPH_AI_TIMEOUT_MS },
      messages: [
        {
          role: "system",
          content: [
            "You are the final scenario graph orchestrator for a CRM scenario builder.",
            "You decide how many action nodes each audience branch should contain; do not assume a fixed one-action or two-action pattern.",
            "When preset or conversation context supports it, create richer 2-5 step branches with a coherent sequence such as qualify, answer, offer, recover, and escalate.",
            "Each action text must be near-final customer-visible copy, not a summary, instruction, or placeholder. For WhatsApp templates, use variables only where useful, for example {{1}} for the customer name, and keep the rest of the body concrete.",
            "Use cta.type quick_reply for branchable WhatsApp replies, link for URL buttons, flow only when an existing flow id is known, and none when there should be no button.",
            "Never invent external booking, checkout, or campaign URLs. Use cta.type link only when an exact URL is supplied in the prompt, source context, or asset metadata.",
            "If Google Calendar is connected and no exact booking URL is supplied, draft confirmation/reschedule quick replies and copy that says the team will use calendar availability; do not use Calendly.",
            "Use media only when it is clearly supported by the prompt and only by selecting provided asset urls/ids. Never invent asset URLs.",
            "Every returned action must include text, cta, and media objects.",
            'Return JSON only: {"branches":[{"cohortId":"...","actions":[{"id":"...","label":"...","text":"...","cta":{"type":"none|quick_reply|link|flow","label":"...","url":"...","flowId":"...","flowName":"..."},"media":{"assetUrls":["..."],"assetIds":["..."]}}]}]}',
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            prompt: params.prompt,
            workflowKind: params.workflowKind,
            sendMode: params.sendMode,
            selectedChannels: params.channels,
            selectedSourceIds: params.sourceIds,
            campaignName: params.campaignName,
            recipientSourceSummary: params.recipientSourceSummary,
            cohorts: params.cohorts,
            presetSeed: params.presetSeed,
            sourceContext: params.sourceContext,
            conversationContext: params.conversationContext,
            availableAssets: params.assets.map(asset => ({
              id: asset.id,
              kind: asset.kind,
              source: asset.source,
              url: asset.url,
              mimeType: asset.mimeType || null,
              fileName: asset.fileName || null,
            })),
            selectedCanvaTemplates: params.selectedCanvaTemplates,
          }),
        },
      ],
      temperature: 0.35,
      responseFormat: { type: "json_object" },
      analytics: {
        workspaceId: params.workspaceId,
        operation: "scenario_generator.create.action_graph",
        sourceService: "web",
      },
    });
    const branches = normalizeAiGraphBranches(
      extractJsonObject(result.content)
    ).map((branch, index) => ({
      ...branch,
      cohortId: branch.cohortId || params.cohorts[index]?.id,
    }));
    return branches.length > 0 ? branches : undefined;
  } catch (error) {
    if (isWorkspaceAiPolicyError(error)) throw error;
    return undefined;
  }
}

function buildConversationLookupKeys(
  recipient: ResolvedScenarioGeneratorRecipient
) {
  if (recipient.channel === "whatsapp") {
    return [`wa_${recipient.recipient}`, recipient.recipient];
  }
  return [recipient.recipient];
}

type ConversationContextRecord = {
  _id?: unknown;
  channel?: string;
  chat?: unknown;
  sourceId?: string | null;
  participants?: {
    from?: unknown[];
    to?: unknown[];
  };
  history_summary?: string | null;
  classification?: {
    category?: string | null;
    summary?: string | null;
  };
  internal_labels?: string[];
  lastMessageAt?: unknown;
};

async function loadConversationContext(params: {
  workspaceId: string;
  recipients: ResolvedScenarioGeneratorRecipient[];
  channels?: ScenarioGeneratorChannel[];
  sourceIds?: string[];
}) {
  const whatsappKeys = params.recipients
    .filter(item => item.channel === "whatsapp")
    .flatMap(buildConversationLookupKeys);
  const telegramKeys = params.recipients
    .filter(item => item.channel === "telegram")
    .map(item => item.recipient);
  const emailKeys = params.recipients
    .filter(item => item.channel === "email")
    .map(item => item.recipient);

  const or: Record<string, unknown>[] = [];
  if (whatsappKeys.length > 0) {
    or.push({ channel: "whatsapp", chat: { $in: whatsappKeys } });
  }
  if (telegramKeys.length > 0) {
    or.push({ channel: "telegram", chat: { $in: telegramKeys } });
  }
  if (emailKeys.length > 0) {
    or.push({
      channel: "email",
      $or: [
        { "participants.from": { $in: emailKeys } },
        { "participants.to": { $in: emailKeys } },
      ],
    });
  }

  const selectedFields = `_id channel chat sourceId participants history_summary classification.category classification.summary internal_labels lastMessageAt ${CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT}`;
  const conversations =
    or.length > 0
      ? await Conversation.find({
          workspaceId: params.workspaceId,
          $or: or,
        })
          .sort({ lastMessageAt: -1 })
          .select(selectedFields)
          .lean<ConversationContextRecord[]>()
      : await limitConversationQuery(
          Conversation.find({
            workspaceId: params.workspaceId,
            ...(params.channels && params.channels.length > 0
              ? { channel: { $in: params.channels } }
              : {}),
            ...(params.sourceIds && params.sourceIds.length > 0
              ? { sourceId: { $in: params.sourceIds } }
              : {}),
          }).sort({ lastMessageAt: -1 }),
          30
        )
          .select(selectedFields)
          .lean<ConversationContextRecord[]>();

  const map = new Map<string, ConversationContextRecord>();
  for (const conversation of conversations) {
    let mapped = false;
    if (conversation.channel === "whatsapp") {
      for (const key of buildConversationLookupKeys({
        channel: "whatsapp",
        recipient: String(conversation.chat || "").replace(/^wa_/, ""),
        cohortId: "",
        cohortLabel: "",
      })) {
        if (!map.has(`whatsapp:${key.replace(/^wa_/, "")}`)) {
          map.set(`whatsapp:${key.replace(/^wa_/, "")}`, conversation);
          mapped = true;
        }
      }
    } else if (conversation.channel === "telegram") {
      map.set(`telegram:${String(conversation.chat || "")}`, conversation);
      mapped = true;
    } else if (conversation.channel === "email") {
      const emails = [
        ...(conversation.participants?.from || []),
        ...(conversation.participants?.to || []),
      ].map((email: unknown) =>
        String(email || "")
          .trim()
          .toLowerCase()
      );
      for (const email of emails) {
        if (email && !map.has(`email:${email}`)) {
          map.set(`email:${email}`, conversation);
          mapped = true;
        }
      }
    }
    if (!mapped) {
      map.set(
        `conversation:${String(conversation._id || `${conversation.channel || ""}:${conversation.chat || ""}`)}`,
        conversation
      );
    }
  }
  return map;
}

function limitConversationQuery<T>(query: T, limit: number): T {
  const maybeQuery = query as { limit?: (value: number) => T } | null;
  if (maybeQuery && typeof maybeQuery.limit === "function") {
    return maybeQuery.limit(limit);
  }
  return query;
}

function summarizeConversationContextForAi(
  conversationContext: Map<string, ConversationContextRecord>
): ConversationContextForAi[] {
  const seen = new Set<string>();
  const summaries: ConversationContextForAi[] = [];
  for (const conversation of conversationContext.values()) {
    const key = String(
      conversation._id ||
        `${conversation.channel || ""}:${conversation.chat || ""}`
    );
    if (seen.has(key)) continue;
    seen.add(key);
    const currentClassification = getCurrentConversationClassification<{
      category?: unknown;
      summary?: unknown;
    }>(conversation);
    summaries.push({
      channel: asTrimmedString(conversation.channel) || null,
      chat: asTrimmedString(conversation.chat) || null,
      sourceId: asTrimmedString(conversation.sourceId) || null,
      historySummary: asTrimmedString(conversation.history_summary) || null,
      classificationCategory:
        asTrimmedString(currentClassification?.category) || null,
      classificationSummary:
        asTrimmedString(currentClassification?.summary) || null,
      labels: normalizeStringArray(conversation.internal_labels, 12),
      lastMessageAt: formatConversationDateForAi(conversation.lastMessageAt),
    });
    if (summaries.length >= 12) break;
  }
  return summaries;
}

function formatConversationDateForAi(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function findFirstBranchActionNode(
  nodes: ScenarioCanvasNode[],
  branchId: string
): ScenarioCanvasNode | undefined {
  return nodes.find(
    node =>
      node.data.kind === "action" &&
      node.data.bulkRecipientBranchId === branchId
  );
}

function dedupeRecipientMessageDocs<
  T extends {
    workspaceId: string;
    scenarioId: string;
    nodeId: string;
    recipient: string;
    channel: string;
    sourceId?: string | null;
  },
>(docs: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const doc of docs) {
    const key = JSON.stringify([
      doc.workspaceId,
      doc.scenarioId,
      doc.nodeId,
      doc.recipient,
      doc.channel,
      asTrimmedString(doc.sourceId) || null,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(doc);
  }
  return unique;
}

async function handlePOST(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  const body = (await request.json().catch(() => ({}))) as CreateBody;
  const rawRecipients = Array.isArray(body.recipients) ? body.recipients : [];
  const rawSourceIds = Array.isArray(body.sourceIds) ? body.sourceIds : [];
  const rawSourceContext = Array.isArray(body.sourceContext)
    ? body.sourceContext
    : [];
  const rawAssetRefs = Array.isArray(body.assetRefs) ? body.assetRefs : [];
  const rawSelectedCanvaTemplates = Array.isArray(body.selectedCanvaTemplates)
    ? body.selectedCanvaTemplates
    : [];
  if (rawRecipients.length > SCENARIO_GENERATOR_MAX_LOGICAL_RECIPIENTS) {
    return buildScenarioGeneratorCreateLimitResponse({
      code: "scenario_generator_recipient_limit_exceeded",
      label: "recipients",
      limit: SCENARIO_GENERATOR_MAX_LOGICAL_RECIPIENTS,
      requested: rawRecipients.length,
    });
  }
  if (rawSourceIds.length > MAX_SCENARIO_GENERATOR_CREATE_SOURCE_SCOPE_ITEMS) {
    return buildScenarioGeneratorCreateLimitResponse({
      code: "scenario_generator_source_limit_exceeded",
      label: "sourceIds",
      limit: MAX_SCENARIO_GENERATOR_CREATE_SOURCE_SCOPE_ITEMS,
      requested: rawSourceIds.length,
    });
  }
  if (
    rawSourceContext.length > MAX_SCENARIO_GENERATOR_CREATE_SOURCE_SCOPE_ITEMS
  ) {
    return buildScenarioGeneratorCreateLimitResponse({
      code: "scenario_generator_source_context_limit_exceeded",
      label: "sourceContext",
      limit: MAX_SCENARIO_GENERATOR_CREATE_SOURCE_SCOPE_ITEMS,
      requested: rawSourceContext.length,
    });
  }
  if (rawAssetRefs.length > MAX_SCENARIO_GENERATOR_CREATE_ASSETS) {
    return buildScenarioGeneratorCreateLimitResponse({
      code: "scenario_generator_asset_limit_exceeded",
      label: "assetRefs",
      limit: MAX_SCENARIO_GENERATOR_CREATE_ASSETS,
      requested: rawAssetRefs.length,
    });
  }
  if (
    rawSelectedCanvaTemplates.length >
    MAX_SCENARIO_GENERATOR_CREATE_CANVA_TEMPLATES
  ) {
    return buildScenarioGeneratorCreateLimitResponse({
      code: "scenario_generator_canva_template_limit_exceeded",
      label: "selectedCanvaTemplates",
      limit: MAX_SCENARIO_GENERATOR_CREATE_CANVA_TEMPLATES,
      requested: rawSelectedCanvaTemplates.length,
    });
  }

  const prompt = String(body.prompt || "").trim();
  const selectedCanvaTemplates = normalizeSelectedCanvaTemplates(
    rawSelectedCanvaTemplates
  );
  const canvaTemplateContext = buildCanvaTemplateInspirationText(
    selectedCanvaTemplates
  );
  const promptWithCanvaContext = [prompt, canvaTemplateContext]
    .filter(Boolean)
    .join("\n\n");
  const channels = normalizeScenarioGeneratorChannels(body.channels);
  const sourceIds = normalizeUniqueStringArray(rawSourceIds);
  const sourceContext =
    normalizeScenarioGeneratorSourceContext(rawSourceContext);
  const deliverySourceScope = buildSelectedDeliverySourceScope({
    channels,
    sourceIds,
    sourceContext,
  });
  const presetSeed = normalizeScenarioGeneratorPresetSeed(body.presetSeed);
  const uploadedRecipients = rawRecipients;
  if (!prompt || channels.length === 0) {
    return NextResponse.json(
      { error: "prompt and channels are required" },
      { status: 400 }
    );
  }

  const cohorts = buildRecipientCohorts(uploadedRecipients);
  const resolvedRecipients = resolveScenarioGeneratorRecipients({
    channels,
    recipients: uploadedRecipients,
    cohorts,
  });
  if (resolvedRecipients.length > SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES) {
    return buildScenarioGeneratorCreateLimitResponse({
      code: "scenario_generator_expanded_message_limit_exceeded",
      label: "expanded recipient messages",
      limit: SCENARIO_GENERATOR_MAX_GENERATED_MESSAGES,
      requested: resolvedRecipients.length,
    });
  }

  const capacity = await ensureCompanyConversationCapacity(
    supabaseAdmin,
    workspaceId
  );
  if (!capacity.allowed) {
    return buildCompanyLimitExceededResponse(capacity.limit);
  }

  const scenarioCapacity = await ensureCompanyScenarioCapacity(
    supabaseAdmin,
    workspaceId
  );
  if (!scenarioCapacity.allowed) {
    return buildCompanyScenarioLimitExceededResponse(scenarioCapacity.limit);
  }

  const studioChatCapacity = await ensureCompanyStudioChatCapacity(
    supabaseAdmin,
    workspaceId
  );
  if (!studioChatCapacity.allowed) {
    return buildCompanyStudioChatLimitExceededResponse(
      studioChatCapacity.limit
    );
  }

  await connectDB();

  const workflowKind = body.workflowKind || "bulk_campaign";
  const sendMode = body.sendMode || "immediate";
  const campaignName =
    String(body.campaignName || "").trim() || "Generated scenario";

  const recipientSourceSummary =
    String(body.recipientSourceSummary || "").trim() ||
    `${uploadedRecipients.length} selected recipients`;

  const hasHiggsfieldAssetRefs = rawAssetRefs.some(
    asset => normalizeAssetSource(asset.source) === "higgsfield"
  );
  const job = await ScenarioGenerationJob.create({
    workspaceId,
    status: "planning",
    prompt: promptWithCanvaContext || prompt,
    workflowKind,
    channels,
    sourceIds,
    sendMode,
    assetRefs: rawAssetRefs,
    selectedCanvaTemplates,
    presetSeed,
    mediaProvider: hasHiggsfieldAssetRefs ? "higgsfield" : null,
  });
  await recordCreativeStudioChat(workspaceId, "scenario_create");

  const uploadedAssets: ScenarioGeneratedAsset[] = rawAssetRefs
    .filter(asset => asset.url)
    .map(asset => {
      const kind = inferAssetKind(asset);
      return {
        id: String(asset.id || "").trim() || new Types.ObjectId().toString(),
        kind,
        source: normalizeAssetSource(asset.source),
        url: asset.url as string,
        mimeType: asset.mimeType,
        fileName: asset.fileName,
        status: "complete",
      };
    });
  const conversationContext = await loadConversationContext({
    workspaceId,
    recipients: resolvedRecipients,
    channels,
    sourceIds,
  });
  const conversationContextForAi =
    summarizeConversationContextForAi(conversationContext);
  const generatedBranches = sanitizeGeneratedActionBranches({
    branches: await generateActionBranchesWithAi({
      workspaceId,
      prompt: promptWithCanvaContext || prompt,
      workflowKind,
      sendMode,
      channels,
      sourceIds,
      campaignName,
      recipientSourceSummary,
      cohorts,
      assets: uploadedAssets,
      sourceContext,
      selectedCanvaTemplates,
      presetSeed,
      conversationContext: conversationContextForAi,
    }),
    allowedUrls: buildAllowedScenarioActionUrls({
      prompt: promptWithCanvaContext || prompt,
      assets: uploadedAssets,
      sourceContext,
    }),
  });
  const graph = buildScenarioGeneratorGraph({
    prompt: promptWithCanvaContext || prompt,
    workflowKind,
    sendMode,
    channels,
    campaignName,
    recipientSourceSummary,
    cohorts,
    generatedBranches,
    assets: uploadedAssets,
    presetSeed,
  });
  graph.nodes = decorateGeneratedActionNodes({
    nodes: graph.nodes,
    channels,
    campaignName,
  });
  const root = graph.nodes[0];
  if (root?.data.kind === "bulk" && root.data.bulkRootConfig) {
    root.data.bulkRootConfig.generationJobId = String(job._id);
    root.data.bulkRootConfig.sourceIds = sourceIds;
    root.data.bulkRootConfig.generationStatus = "complete";
  }

  const nodes = normalizeScenarioNodesForPersistence(
    graph.nodes
  ) as ScenarioCanvasNode[];
  if (
    hasNewLegacyActionRoutingAssignments({
      previousNodes: [],
      previousEdges: [],
      nextNodes: nodes,
      nextEdges: graph.edges,
    })
  ) {
    await ScenarioGenerationJob.findByIdAndUpdate(job._id, {
      status: "failed",
      error: LEGACY_ACTION_ROUTING_NEW_ASSIGNMENT_FORBIDDEN_CODE,
    });
    return NextResponse.json(
      {
        error: LEGACY_ACTION_ROUTING_NEW_ASSIGNMENT_FORBIDDEN_MESSAGE,
        code: LEGACY_ACTION_ROUTING_NEW_ASSIGNMENT_FORBIDDEN_CODE,
      },
      { status: 400 }
    );
  }
  const graphValidationError = validateScenarioGraph(
    nodes as Array<{ id: string; data: ScenarioNodeData }>,
    graph.edges,
    { mode: "graph" }
  );
  if (graphValidationError) {
    await ScenarioGenerationJob.findByIdAndUpdate(job._id, {
      status: "failed",
      error: graphValidationError,
    });
    return NextResponse.json(
      { error: "Invalid generated scenario graph", code: graphValidationError },
      { status: 400 }
    );
  }

  const scenarioId = new Types.ObjectId();

  const messageDocs = dedupeRecipientMessageDocs(
    resolvedRecipients.flatMap(recipient => {
      const actionNode = findFirstBranchActionNode(nodes, recipient.cohortId);
      if (!actionNode) return [];
      const conversation = conversationContext.get(
        `${recipient.channel}:${recipient.recipient}`
      );
      const currentClassification = getCurrentConversationClassification<{
        category?: unknown;
      }>(conversation);
      const category =
        asTrimmedString(currentClassification?.category) ||
        recipient.cohortLabel;
      const summary = conversation?.history_summary
        ? ` Context: ${conversation.history_summary}`
        : "";
      const sourceId = resolveGeneratedMessageSourceId({
        channel: recipient.channel,
        recipientSourceId: recipient.sourceId,
        deliverySourceScope,
      });
      return [
        {
          workspaceId,
          scenarioId: scenarioId.toString(),
          generationJobId: String(job._id),
          nodeId: actionNode.id,
          branchId: recipient.cohortId,
          conversationId: conversation?._id ? String(conversation._id) : null,
          channel: recipient.channel,
          recipient: recipient.recipient,
          recipientName: recipient.name || null,
          sourceId,
          recipientEmail:
            recipient.channel === "whatsapp" && recipient.email
              ? recipient.email
              : null,
          taxonomyCategory: category,
          internalLabels: conversation?.internal_labels || [],
          text: `${promptWithCanvaContext || prompt}\n\nFor ${recipient.name || recipient.recipient}: ${category}.${summary}`,
          templateDraftId:
            asTrimmedString(actionNode.data.generatedTemplateDraft?.id) || null,
          mediaAssetIds: normalizeUniqueStringArray(
            actionNode.data.actionMediaAssets?.map(asset => asset.id)
          ),
          sendStatus: "draft",
        },
      ];
    })
  );

  const persistedBulkRoot = nodes.find(node => node.data.kind === "bulk");
  if (
    persistedBulkRoot?.data.kind === "bulk" &&
    persistedBulkRoot.data.bulkRootConfig
  ) {
    persistedBulkRoot.data.bulkRootConfig.generatedRecipientCount =
      messageDocs.length;
  }

  const scenarioDocument = {
    _id: scenarioId,
    workspaceId,
    name: campaignName,
    description: prompt,
    mode: "conversation",
    status: "draft",
    presetId: presetSeed?.id ?? null,
    presetVersion: presetSeed?.version ?? null,
    segmentKey: presetSeed?.segmentKey ?? null,
    graphSchemaVersion: CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION,
    nodes,
    edges: graph.edges,
    viewport: DEFAULT_SCENARIO_VIEWPORT,
    createdBy: access.userId,
    updatedBy: access.userId,
  };

  if (messageDocs.length > 0) {
    await ensureScenarioGeneratedRecipientMessageIndexes();
  }

  const session = (await Scenario.startSession()) as ClientSession;
  let created;
  try {
    created = await session.withTransaction(async () => {
      // Persist recipient drafts before the scenario so a draft write failure
      // cannot run Scenario save hooks (including scenario usage emission).
      for (
        let index = 0;
        index < messageDocs.length;
        index += GENERATED_RECIPIENT_INSERT_CHUNK_SIZE
      ) {
        await ScenarioGeneratedRecipientMessage.insertMany(
          messageDocs.slice(
            index,
            index + GENERATED_RECIPIENT_INSERT_CHUNK_SIZE
          ),
          { ordered: false, session }
        );
      }

      const [createdScenario] = await Scenario.create([scenarioDocument], {
        session,
      });
      if (!createdScenario) {
        throw new Error("Generated scenario transaction created no scenario.");
      }

      return createdScenario;
    });
  } finally {
    await session.endSession();
  }

  if (!created) {
    throw new Error("Generated scenario transaction did not commit.");
  }

  const assetDocs = uploadedAssets.map(asset => ({
    workspaceId,
    scenarioId: scenarioId.toString(),
    jobId: String(job._id),
    branchId: null,
    kind: asset.kind,
    source: asset.source,
    url: asset.url,
    mimeType: asset.mimeType || null,
    fileName: asset.fileName || null,
    status: "complete",
  }));
  // Visual generation is explicit in Creative Assets and requires a customer source.
  // Scenario creation only attaches assets selected by the user.
  if (assetDocs.length > 0) {
    await ScenarioGeneratedMediaAsset.insertMany(assetDocs, { ordered: false });
  }
  const finalJobStatus = "complete";
  await ScenarioGenerationJob.findByIdAndUpdate(job._id, {
    scenarioId: scenarioId.toString(),
    status: finalJobStatus,
  });

  if (
    root?.data.kind === "bulk" &&
    root.data.bulkRootConfig &&
    root.data.bulkRootConfig.generationStatus !== finalJobStatus
  ) {
    const nextNodes = nodes.map(node =>
      node.id === root.id
        ? {
            ...node,
            data: {
              ...node.data,
              bulkRootConfig: {
                ...node.data.bulkRootConfig,
                generationStatus: finalJobStatus,
              },
            },
          }
        : node
    );
    await Scenario.findOneAndUpdate(
      { _id: scenarioId, workspaceId, deletedAt: null },
      {
        graphSchemaVersion: CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION,
        nodes: normalizeScenarioNodesForPersistence(nextNodes),
      }
    );
  }

  console.info("[ScenarioGenerator] scenario_created", {
    workspaceId,
    scenarioId: scenarioId.toString(),
    jobId: String(job._id),
    recipientCount: messageDocs.length,
    mediaAssetCount: assetDocs.length,
  });
  await captureFunnelEvent({
    event: "scenario_created",
    userId: access.userId,
    workspaceId,
    properties: {
      origin: "generator",
      status: typeof created.status === "string" ? created.status : null,
      ...describeScenarioGraphForFunnel(created.nodes),
    },
  });

  return NextResponse.json(
    {
      scenario: serializeScenario(
        created.toObject() as Record<string, unknown>
      ),
      jobId: String(job._id),
      generatedRecipientCount: messageDocs.length,
    },
    { status: 201 }
  );
}

export async function POST(...args: Parameters<typeof handlePOST>) {
  const { workspaceId } = await args[1].params;
  try {
    return await withWorkspaceTextAiAction(
      { workspaceId, actionId: `scenario-create:${randomUUID()}` },
      () => handlePOST(...args)
    );
  } catch (error) {
    const required = getWorkspaceAiRequiredDetails(error);
    if (required) return NextResponse.json(required, { status: 402 });
    throw error;
  }
}
