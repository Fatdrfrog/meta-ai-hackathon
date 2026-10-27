import { randomUUID } from "node:crypto";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import { getBusinessContext } from "@/lib/classifier/conversation-analysis-context";
import { prepareTextForAnalysis } from "@/lib/classifier/conversation-analysis-helpers";
import type { FollowUpAudienceStatus } from "@/lib/campaign/follow-up-audience-status";
import { matchAllowedOption } from "@/lib/classifier/decision";
import type { WorkspaceTaxonomy } from "@/lib/classifier/taxonomy";
import {
  resolveEffectiveConversationCategory,
  selectCategoryWithSchema,
  type EffectiveCategorySource,
} from "@/lib/classifier/taxonomy-evaluation";
import { getWorkspaceTaxonomy } from "@/lib/classifier/taxonomy-server";
import {
  getConversationDisplayName,
  normalizeLooseString,
  toStringId,
} from "@/lib/customers/shared";
import connectDB from "@/lib/mongoose";
import {
  getCompiledScenarioGraph,
  getPrimaryTriggerNode,
  parseNodes,
} from "@icecore/airi-runtime/scenario-graph";
import {
  normalizeActionType,
  normalizeAudienceDays,
  normalizeFlowConfig,
  normalizeOptionalNodeText,
  toStringArray,
} from "@/lib/scenarios/normalization";
import { normalizeConversationScenarioState } from "@icecore/airi-runtime/scenario-state";
import {
  getScenarioWhatsAppServiceMessageAuthoringTexts,
  getWhatsAppFlowAuthoringTexts,
  isEditableScenarioWhatsAppServiceMessageResolution,
  resolveScenarioWhatsAppServiceMessage,
} from "@/lib/scenarios/whatsapp-service-message";
import { supabaseAdmin } from "@/lib/supabase/admin";
import Chat from "@/models/chat";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import { Scenario } from "@/models/scenario";
import User from "@/models/user";
import type { PopulatedMessage } from "@/types/models";
import type { ScenarioNodeData } from "@icecore/scenario-contracts";
import { buildCacheKey, cache } from "@icecore/shared/lib/cache";
import {
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS,
  buildCurrentConversationClassificationFilter,
  getCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import {
  hasStoredWhatsAppServiceMessage,
  resolveStoredWhatsAppServiceMessagePreview,
} from "@icecore/shared/lib/whatsapp/service-message-preview";
import type { StoredWhatsAppServiceMessagePreview } from "@icecore/shared/types/message-preview";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import mongoose from "mongoose";
import pLimit from "p-limit";
import {
  readUniqueStringArray as uniqueStrings,
  readDate as toDate,
} from "@icecore/shared/lib/value-utils";
import { escapeRegExp } from "@/lib/regex-utils";

const CONVERSATION_BATCH_SIZE = 200;
const MESSAGE_LOOKUP_BATCH_SIZE = 200;
const RECLASSIFICATION_CONCURRENCY = 3;
const SUPABASE_PAGE_SIZE = 1000;
const MIN_MAPPING_SCORE = 4;
const MIN_MAPPING_MARGIN = 1.5;
const PAYMENT_CONFIRMATION_BEFORE_CONVERSION_MS = 7 * 24 * 60 * 60 * 1000;
const PAYMENT_CONFIRMATION_AFTER_CONVERSION_MS = 2 * 24 * 60 * 60 * 1000;

/** Set `FOLLOW_UP_AUDIENCE_FORCE_FULL_LLM=1` to restore legacy LLM for every out-of-taxonomy label match (debug). */
const FOLLOW_UP_AUDIENCE_FORCE_FULL_LLM =
  process.env.FOLLOW_UP_AUDIENCE_FORCE_FULL_LLM === "1";

/** Workspace-wide follow-up audience scan TTL (Redis + in-memory fallback). */
const FOLLOW_UP_AUDIENCE_WORKSPACE_STATE_TTL_SECONDS = 480;
export const FOLLOW_UP_AUDIENCE_WORKSPACE_STATE_CACHE_VERSION = 4 as const;

const FOLLOW_UP_AUDIENCE_SCOPED_REFRESH_LIMIT = Math.min(
  1000,
  Math.max(
    50,
    Number.parseInt(
      process.env.FOLLOW_UP_AUDIENCE_SCOPED_REFRESH_LIMIT || "350",
      10
    ) || 350
  )
);

/** Avoid pathological regex / query payloads from open filters. */
const FOLLOW_UP_AUDIENCE_FILTER_PARAM_MAX_CHARS = 200;

type PurchaseEvidenceType =
  | "manual_conversion"
  | "payment_confirmation_message";

interface FollowUpAudienceSummary {
  totalConversations: number;
  purchasedExcluded: number;
  readyNow: number;
  alreadyInFollowUp: number;
  waitingTimeout: number;
  unmappedBucket: number;
  byCategory: Record<string, number>;
}

interface FollowUpBucketMapping {
  label: string;
  recommendedRootScenarioId: string | null;
  recommendedRootScenarioName: string | null;
  mappingConfidence: number;
  mappingReason: string;
  warning: string | null;
}

interface ConversationFollowUpAnalysisRow {
  conversationId: string;
  channel: string | null;
  chatLabel: string;
  lastMessageAt: string | null;
  effectiveCategory: string;
  categorySource: EffectiveCategorySource;
  categoryConfidence: number;
  categoryEvidence: string | null;
  purchaseAt: string | null;
  purchaseEvidenceType: PurchaseEvidenceType | null;
  status: FollowUpAudienceStatus;
  recommendedRootScenarioId: string | null;
  recommendedRootScenarioName: string | null;
  currentFollowUpScenarioName: string | null;
  readyAt: string | null;
  warnings: string[];
  /** Workspace internal labels on the conversation (for filtering). */
  internalLabels: string[];
  /**
   * Scenario ids used when computing bucket mappings; stored on Mongo projection for fast reads.
   * Omitted in most API responses when serialized from older cache payloads.
   */
  startedScenarioIds?: string[];
}

interface FollowUpAudienceResponse {
  taxonomy: {
    labels: string[];
    version?: string;
    confidenceThreshold?: number;
  };
  summary: FollowUpAudienceSummary;
  bucketMappings: FollowUpBucketMapping[];
  rows: ConversationFollowUpAnalysisRow[];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  refreshScope?: FollowUpAudienceRefreshScope;
}

type FollowUpAudienceQuery = {
  category?: string | null;
  status?: FollowUpAudienceStatus | null;
  channel?: string | null;
  q?: string | null;
  page?: number | null;
  pageSize?: number | null;
  /** Match conversations that include this internal label (exact match after trim). */
  internalLabel?: string | null;
};

interface FollowUpAudienceRefreshScope {
  mode: "filtered";
  scannedConversations: number;
  maxConversations: number;
  truncated: boolean;
  appliedFilters: string[];
}

type LeanConversationRow = {
  _id: mongoose.Types.ObjectId | string;
  workspaceId: string;
  channel?: string | null;
  chat?: unknown;
  user?: unknown;
  sourceId?: string | null;
  rename?: string | null;
  history_summary?: string | null;
  classification?: {
    category?: string | null;
    confidence?: {
      category?: number | null;
    } | null;
  } | null;
  is_classified?: boolean | null;
  classification_revision?: number | null;
  classification_state?: {
    contractVersion?: number | null;
    status?: string | null;
    requestedRevision?: number | null;
    appliedRevision?: number | null;
  } | null;
  classification_meta?: {
    source_revision?: number | null;
    provenance_kind?: string | null;
    analysis_revision_id?: string | null;
  } | null;
  internal_labels?: string[] | null;
  airi_scenario_state?: unknown;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  lastMessageAt?: Date | null;
  estimated_customer_ltv?: number | null;
  revenue_attribution_id?: string | null;
};

export const FOLLOW_UP_AUDIENCE_CONVERSATION_SELECT = [
  "_id",
  "workspaceId",
  "channel",
  "chat",
  "user",
  "sourceId",
  "rename",
  "history_summary",
  "classification",
  ...CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS,
  "internal_labels",
  "airi_scenario_state",
  "createdAt",
  "updatedAt",
  "lastMessageAt",
  "estimated_customer_ltv",
  "revenue_attribution_id",
].join(" ");

export function resolveFollowUpStoredClassification(conversation: unknown): {
  storedCategory: string | null;
  storedConfidence: number | null;
} {
  const classification = getCurrentConversationClassification<{
    category?: unknown;
    confidence?: { category?: unknown } | null;
  }>(conversation);
  const storedCategory =
    typeof classification?.category === "string" &&
    classification.category.trim().length > 0
      ? classification.category.trim()
      : null;
  const categoryConfidence = classification?.confidence?.category;
  const storedConfidence =
    typeof categoryConfidence === "number" &&
    Number.isFinite(categoryConfidence)
      ? categoryConfidence
      : null;

  return { storedCategory, storedConfidence };
}

function conversationNeedsLlmReclassification(
  storedClassification: ReturnType<typeof resolveFollowUpStoredClassification>,
  taxonomy: WorkspaceTaxonomy
): boolean {
  if (FOLLOW_UP_AUDIENCE_FORCE_FULL_LLM) {
    return !taxonomy.labels.some(
      label =>
        normalizeText(label) ===
        normalizeText(storedClassification.storedCategory || "")
    );
  }

  const threshold = taxonomy.confidenceThreshold ?? 0.7;
  const matched = matchAllowedOption(
    storedClassification.storedCategory,
    taxonomy.labels
  );
  if (!matched) {
    return true;
  }
  const conf = storedClassification.storedConfidence;
  if (typeof conf === "number" && Number.isFinite(conf) && conf < threshold) {
    return true;
  }
  return false;
}

type LeanMessageRow = {
  _id: mongoose.Types.ObjectId | string;
  conversation?: mongoose.Types.ObjectId | string | null;
  author?: unknown;
  text?: string | null;
  date?: Date | null;
  direction?: "inbound" | "outbound" | null;
  imageUrl?: string | null;
  imageAnalysis?: string | null;
  audioAnalysis?: string | null;
  videoAnalysis?: string | null;
  mediaType?: string | null;
  attachments?: Array<{ url?: string; contentType?: string }> | null;
  whatsappServiceMessage?: StoredWhatsAppServiceMessagePreview | null;
  whatsappTemplate?: {
    name?: string | null;
    headerText?: string | null;
    bodyText?: string | null;
    footerText?: string | null;
    buttons?: Array<{ text?: string | null }> | null;
  } | null;
  whatsappFlow?: {
    headerText?: string | null;
    bodyText?: string | null;
    footerText?: string | null;
    flowCta?: string | null;
  } | null;
  telegramReplyMarkup?: {
    inlineKeyboard?: Array<Array<{ text?: string | null }>> | null;
  } | null;
};

type LeanChatRow = {
  _id: unknown;
  title?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
};

type LeanUserRow = {
  _id: unknown;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  isBot?: boolean | null;
};

type ActiveScenarioRow = {
  _id: string;
  name: string;
  description?: string | null;
  priority?: number | null;
  segmentKey?: string | null;
  nodes?: unknown;
  edges?: unknown;
};

type ScenarioFamily = {
  rootScenarioId: string;
  rootScenarioName: string;
  rootTriggerNodeId: string | null;
  familyScenarioIds: string[];
  familyScenarioNames: string[];
  timeoutMinutes: number | null;
  inactivityDays: number | null;
  explicitLabels: string[];
  corpus: string;
  isCandidate: boolean;
  exclusionReason: string | null;
};

type BaseConversationAnalysis = {
  conversationId: string;
  channel: string | null;
  chatLabel: string;
  lastMessageAt: string | null;
  effectiveCategory: string;
  categorySource: EffectiveCategorySource;
  categoryConfidence: number;
  categoryEvidence: string | null;
  purchaseAt: string | null;
  purchaseEvidenceType: PurchaseEvidenceType | null;
  warnings: string[];
  startedScenarioIds: string[];
  currentFollowUpScenarioName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  internalLabels: string[];
};

type MappingDecision = {
  rootScenarioId: string | null;
  rootScenarioName: string | null;
  familyScenarioIds: string[];
  mappingConfidence: number;
  mappingReason: string;
  warning: string | null;
};

type FollowUpScenarioFamily = Pick<
  ScenarioFamily,
  | "rootScenarioId"
  | "rootScenarioName"
  | "rootTriggerNodeId"
  | "familyScenarioIds"
  | "timeoutMinutes"
  | "inactivityDays"
>;

export interface FollowUpAudienceWorkspaceState {
  taxonomy: {
    labels: string[];
    version?: string;
    confidenceThreshold?: number;
  };
  summary: FollowUpAudienceSummary;
  bucketMappings: FollowUpBucketMapping[];
  rows: ConversationFollowUpAnalysisRow[];
  familyByRootId: Map<string, FollowUpScenarioFamily>;
  refreshScope?: FollowUpAudienceRefreshScope;
}

type FollowUpAudienceWorkspaceStateCachePayload = {
  v: typeof FOLLOW_UP_AUDIENCE_WORKSPACE_STATE_CACHE_VERSION;
  taxonomy: FollowUpAudienceWorkspaceState["taxonomy"];
  summary: FollowUpAudienceSummary;
  bucketMappings: FollowUpBucketMapping[];
  rows: ConversationFollowUpAnalysisRow[];
  familyByRootId: Record<string, FollowUpScenarioFamily>;
};

function stripStartedScenarioIds(
  row: ConversationFollowUpAnalysisRow
): ConversationFollowUpAnalysisRow {
  const rest = { ...row };
  delete rest.startedScenarioIds;
  return rest;
}

function serializeFollowUpAudienceWorkspaceState(
  state: FollowUpAudienceWorkspaceState
): FollowUpAudienceWorkspaceStateCachePayload {
  return {
    v: FOLLOW_UP_AUDIENCE_WORKSPACE_STATE_CACHE_VERSION,
    taxonomy: state.taxonomy,
    summary: state.summary,
    bucketMappings: state.bucketMappings,
    rows: state.rows.map(row => stripStartedScenarioIds(row)),
    familyByRootId: Object.fromEntries(state.familyByRootId),
  };
}

function parseFollowUpAudienceWorkspaceStateCache(
  raw: unknown
): FollowUpAudienceWorkspaceState | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const payload = raw as Partial<FollowUpAudienceWorkspaceStateCachePayload>;
  if (payload.v !== FOLLOW_UP_AUDIENCE_WORKSPACE_STATE_CACHE_VERSION) {
    return null;
  }
  if (
    !payload.taxonomy ||
    !payload.summary ||
    !Array.isArray(payload.bucketMappings) ||
    !Array.isArray(payload.rows) ||
    !payload.familyByRootId ||
    typeof payload.familyByRootId !== "object"
  ) {
    return null;
  }
  return {
    taxonomy: payload.taxonomy,
    summary: payload.summary,
    bucketMappings: payload.bucketMappings,
    rows: payload.rows,
    familyByRootId: new Map(Object.entries(payload.familyByRootId)),
  };
}

const pendingFollowUpAudienceWorkspaceState = new Map<
  string,
  Promise<FollowUpAudienceWorkspaceState>
>();

type PaymentConfirmationSignature = {
  signature: string;
  supportCount: number;
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[_/|]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function clampFollowUpAudienceFilterInput(
  value: string | null | undefined,
  maxChars: number
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function readScopedFilterValue(
  value: string | null | undefined
): string | null {
  const trimmed = clampFollowUpAudienceFilterInput(
    value,
    FOLLOW_UP_AUDIENCE_FILTER_PARAM_MAX_CHARS
  );
  if (!trimmed || normalizeText(trimmed) === "all") {
    return null;
  }
  return trimmed;
}

export function buildFollowUpConversationPrefilterMatch(
  workspaceId: string,
  filters?: FollowUpAudienceQuery
): Record<string, unknown> {
  const andClauses: Record<string, unknown>[] = [{ workspaceId }];

  // Status and effective category are derived by the scan itself; filtering them
  // before reclassification can hide rows that would move into the requested bucket.

  const channel = readScopedFilterValue(filters?.channel ?? null);
  if (channel) {
    andClauses.push({
      channel: new RegExp(`^${escapeRegExp(channel)}$`, "i"),
    });
  }

  const internalLabel = readScopedFilterValue(filters?.internalLabel ?? null);
  if (internalLabel) {
    andClauses.push({
      internal_labels: new RegExp(`^${escapeRegExp(internalLabel)}$`, "i"),
    });
  }

  const searchQuery = readScopedFilterValue(filters?.q ?? null);
  if (searchQuery) {
    const searchRegex = new RegExp(escapeRegExp(searchQuery), "i");
    const searchClauses: Record<string, unknown>[] = [
      { sourceId: searchRegex },
      { rename: searchRegex },
      { history_summary: searchRegex },
      {
        $and: [
          { "classification.category": searchRegex },
          buildCurrentConversationClassificationFilter(),
        ],
      },
    ];
    if (mongoose.Types.ObjectId.isValid(searchQuery)) {
      searchClauses.unshift({ _id: new mongoose.Types.ObjectId(searchQuery) });
    }
    andClauses.push({ $or: searchClauses });
  }

  return andClauses.length === 1 ? andClauses[0]! : { $and: andClauses };
}

function listScopedRefreshFilterNames(
  filters?: FollowUpAudienceQuery
): string[] {
  const names: string[] = [];
  if (readScopedFilterValue(filters?.category ?? null)) {
    names.push("category");
  }
  if (filters?.status) {
    names.push("status");
  }
  if (readScopedFilterValue(filters?.channel ?? null)) {
    names.push("channel");
  }
  if (readScopedFilterValue(filters?.q ?? null)) {
    names.push("search");
  }
  if (readScopedFilterValue(filters?.internalLabel ?? null)) {
    names.push("internal label");
  }
  return names;
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      normalizeText(value)
        .split(" ")
        .map(token => token.trim())
        .filter(token => token.length >= 2)
    )
  );
}

function toIsoString(value: Date | string | null | undefined): string | null {
  return toDate(value)?.toISOString() ?? null;
}

function readEntityId(value: unknown): string {
  return toStringId(value) || "";
}

function extractWhatsAppComponentTexts(components: unknown): string[] {
  if (!Array.isArray(components)) {
    return [];
  }

  const texts: string[] = [];
  for (const component of components as WhatsAppComponent[]) {
    if (!component || typeof component !== "object") continue;
    if (component.type === "HEADER" && component.text) {
      texts.push(component.text);
    }
    if (component.type === "BODY" && component.text) {
      texts.push(component.text);
    }
    if (component.type === "FOOTER" && component.text) {
      texts.push(component.text);
    }
    if (component.type === "BUTTONS") {
      for (const button of component.buttons || []) {
        if (typeof button?.text === "string") {
          texts.push(button.text);
        }
        if ("url" in button && typeof button.url === "string") {
          texts.push(button.url);
        }
      }
    }
  }
  return texts;
}

function extractTelegramQuickReplyTexts(nodeData: ScenarioNodeData): string[] {
  const quickReplies = nodeData.actionTelegramQuickReplies;
  if (!Array.isArray(quickReplies)) {
    return [];
  }

  return quickReplies.flatMap(item => {
    if (Array.isArray(item)) {
      return item
        .map(button => (typeof button?.text === "string" ? button.text : ""))
        .filter(Boolean);
    }

    return typeof item?.text === "string" ? [item.text] : [];
  });
}

function extractScenarioTexts(scenario: ActiveScenarioRow): string[] {
  const texts: string[] = [scenario.name, scenario.description || ""];

  for (const node of parseNodes(scenario.nodes)) {
    const data = node.data || {};
    texts.push(
      normalizeOptionalNodeText(data.classificationCategory) || "",
      normalizeOptionalNodeText(data.actionInstruction) || "",
      normalizeOptionalNodeText(data.actionWhatsAppTemplateName) || "",
      normalizeOptionalNodeText(data.linkedScenarioName) || ""
    );
    texts.push(
      ...extractWhatsAppComponentTexts(data.actionWhatsAppTemplateComponents)
    );
    if (data.actionWhatsAppServiceMessage !== undefined) {
      const serviceMessage = resolveScenarioWhatsAppServiceMessage(data);
      if (isEditableScenarioWhatsAppServiceMessageResolution(serviceMessage)) {
        texts.push(
          ...getScenarioWhatsAppServiceMessageAuthoringTexts(
            serviceMessage.value
          )
        );
      }
    } else {
      texts.push(
        normalizeOptionalNodeText(data.actionReplyText) || "",
        normalizeOptionalNodeText(data.actionReplyInstruction) || "",
        normalizeOptionalNodeText(data.actionReplyTemplate) || "",
        normalizeOptionalNodeText(data.actionSnippetQuestion) || "",
        normalizeOptionalNodeText(data.actionSnippetAnswer) || "",
        normalizeOptionalNodeText(data.actionReplyCtaLabel) || "",
        ...getWhatsAppFlowAuthoringTexts(
          normalizeFlowConfig(data.actionFlowConfig)
        )
      );
    }
    texts.push(...extractTelegramQuickReplyTexts(data));
  }

  return texts.filter(Boolean);
}

function scenarioHasOutboundAction(scenario: ActiveScenarioRow): boolean {
  return parseNodes(scenario.nodes).some(node => {
    if (node.data.kind !== "action") return false;
    const actionType = normalizeActionType(node.data);
    return actionType === "reply" || actionType === "whatsapp_template";
  });
}

function extractLinkedScenarioIds(scenario: ActiveScenarioRow): string[] {
  return uniqueStrings(
    parseNodes(scenario.nodes).flatMap(node => {
      if (node.data.kind !== "scenario_link") {
        return [];
      }
      return typeof node.data.linkedScenarioId === "string"
        ? [node.data.linkedScenarioId]
        : [];
    })
  ).filter(linkedScenarioId => linkedScenarioId !== scenario._id);
}

function scoreTokenOverlap(label: string, corpus: string): number {
  const normalizedLabel = normalizeText(label);
  const normalizedCorpus = normalizeText(corpus);
  if (!normalizedLabel || !normalizedCorpus) {
    return 0;
  }

  let score = normalizedCorpus.includes(normalizedLabel) ? 6 : 0;
  const corpusTokens = new Set(tokenize(normalizedCorpus));
  const labelTokens = tokenize(normalizedLabel);
  for (const token of labelTokens) {
    if (corpusTokens.has(token)) {
      score += 1.5;
    }
  }

  if (labelTokens.length >= 2) {
    for (let index = 0; index < labelTokens.length - 1; index += 1) {
      const phrase = `${labelTokens[index]} ${labelTokens[index + 1]}`;
      if (normalizedCorpus.includes(phrase)) {
        score += 2;
      }
    }
  }

  return score;
}

const PAYMENT_TOKENS = [
  "payment",
  "paid",
  "purchase",
  "order",
  "invoice",
  "receipt",
  "оплат",
  "платеж",
  "покуп",
  "заказ",
  "квитан",
  "чек",
  "төлем",
  "сатып",
  "buyurtma",
  "tolov",
  "to lov",
  "chek",
];

const CONFIRMATION_TOKENS = [
  "confirm",
  "confirmed",
  "received",
  "successful",
  "complete",
  "completed",
  "thanks",
  "thank you",
  "подтверж",
  "получ",
  "успеш",
  "спасибо",
  "қабыл",
  "растал",
  "рахмет",
  "tasdiq",
  "olindi",
  "rahmat",
];

const FOLLOW_UP_TOKENS = [
  "follow up",
  "followup",
  "reminder",
  "still interested",
  "checking in",
  "haven t heard",
  "waiting",
  "reply",
  "response",
  "напомин",
  "провер",
  "ждем",
  "ответ",
];

function countKeywordHits(corpus: string, keywords: string[]): number {
  const normalizedCorpus = normalizeText(corpus);
  return keywords.reduce(
    (count, keyword) =>
      normalizedCorpus.includes(normalizeText(keyword)) ? count + 1 : count,
    0
  );
}

function scorePaymentConfirmationText(corpus: string): number {
  const paymentHits = countKeywordHits(corpus, PAYMENT_TOKENS);
  const confirmationHits = countKeywordHits(corpus, CONFIRMATION_TOKENS);
  if (paymentHits === 0) {
    return 0;
  }

  return paymentHits + confirmationHits;
}

function looksLikePaymentFamily(corpus: string): boolean {
  const paymentScore = scorePaymentConfirmationText(corpus);
  const followUpScore = countKeywordHits(corpus, FOLLOW_UP_TOKENS);
  return paymentScore >= 2 && paymentScore > followUpScore;
}

export function buildScenarioFamilies(
  scenarios: ActiveScenarioRow[],
  taxonomyLabels: string[]
): ScenarioFamily[] {
  const scenarioById = new Map(
    scenarios.map(scenario => [scenario._id, scenario])
  );
  const childrenByParent = new Map<string, string[]>();
  const incomingByChild = new Map<string, Set<string>>();

  for (const scenario of scenarios) {
    const linkedScenarioIds = extractLinkedScenarioIds(scenario).filter(
      linkedScenarioId => scenarioById.has(linkedScenarioId)
    );
    childrenByParent.set(scenario._id, linkedScenarioIds);

    for (const childId of linkedScenarioIds) {
      const parents = incomingByChild.get(childId) ?? new Set<string>();
      parents.add(scenario._id);
      incomingByChild.set(childId, parents);
    }
  }

  const roots = scenarios.filter(
    scenario => (incomingByChild.get(scenario._id)?.size || 0) === 0
  );

  const families: ScenarioFamily[] = [];
  for (const root of roots) {
    const queue = [root._id];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const scenarioId = queue.shift();
      if (!scenarioId || visited.has(scenarioId)) continue;
      visited.add(scenarioId);

      for (const childId of childrenByParent.get(scenarioId) || []) {
        if (!visited.has(childId)) {
          queue.push(childId);
        }
      }
    }

    const familyScenarioIds = Array.from(visited);
    const familyScenarios = familyScenarioIds
      .map(scenarioId => scenarioById.get(scenarioId))
      .filter((scenario): scenario is ActiveScenarioRow => Boolean(scenario));
    const graph = getCompiledScenarioGraph(root);
    const triggerNode = getPrimaryTriggerNode(graph);
    const audienceNodes = graph.nodes.filter(
      node =>
        node.data.kind === "logic" && node.data.logicType === "audience_filter"
    );
    const inactivityAudienceNode = audienceNodes.find(
      node =>
        node.data.audienceMode === "last_seen_days" ||
        node.data.audienceMode === "last_seen_greater_than_x_days"
    );
    const inactivityDays = inactivityAudienceNode
      ? normalizeAudienceDays(inactivityAudienceNode.data.audienceLastSeenDays)
      : null;
    const timeoutMinutes = null;
    const explicitLabels = uniqueStrings([
      root.segmentKey || "",
      ...audienceNodes.flatMap(node => {
        if (node.data.audienceMode === "classification") {
          return [node.data.classificationCategory || ""];
        }
        if (node.data.audienceMode === "funnel_stage") {
          return [
            node.data.audienceFunnelStage ||
              node.data.classificationCategory ||
              "",
          ];
        }
        return [];
      }),
    ]).flatMap(candidate => {
      const normalizedCandidate = normalizeText(candidate);
      return taxonomyLabels.filter(
        label => normalizeText(label) === normalizedCandidate
      );
    });
    const familyScenarioNames = familyScenarios.map(scenario => scenario.name);
    const corpus = familyScenarios.flatMap(extractScenarioTexts).join("\n");
    const inactivityTriggered = inactivityDays !== null;
    const hasOutboundAction = familyScenarios.some(scenarioHasOutboundAction);
    const paymentLike = looksLikePaymentFamily(corpus);

    let exclusionReason: string | null = null;
    if (!inactivityTriggered) {
      exclusionReason = "Root is not inactivity-oriented.";
    } else if (!hasOutboundAction) {
      exclusionReason = "Family has no outbound follow-up action.";
    } else if (paymentLike) {
      exclusionReason = "Family looks payment-oriented rather than follow-up.";
    }

    families.push({
      rootScenarioId: root._id,
      rootScenarioName: root.name,
      rootTriggerNodeId: triggerNode?.id || null,
      familyScenarioIds,
      familyScenarioNames,
      timeoutMinutes,
      inactivityDays,
      explicitLabels,
      corpus,
      isCandidate: exclusionReason === null,
      exclusionReason,
    });
  }

  return families;
}

function buildFamilyHistoryCounts(
  rows: BaseConversationAnalysis[],
  families: ScenarioFamily[]
): Map<string, Map<string, number>> {
  const familyByScenarioId = new Map<string, string>();
  for (const family of families) {
    for (const scenarioId of family.familyScenarioIds) {
      familyByScenarioId.set(scenarioId, family.rootScenarioId);
    }
  }

  const history = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const familyIds = new Set<string>();
    for (const scenarioId of row.startedScenarioIds) {
      const rootScenarioId = familyByScenarioId.get(scenarioId);
      if (rootScenarioId) {
        familyIds.add(rootScenarioId);
      }
    }

    if (familyIds.size === 0) continue;

    const categoryHistory =
      history.get(row.effectiveCategory) ?? new Map<string, number>();
    for (const rootScenarioId of familyIds) {
      categoryHistory.set(
        rootScenarioId,
        (categoryHistory.get(rootScenarioId) || 0) + 1
      );
    }
    history.set(row.effectiveCategory, categoryHistory);
  }

  return history;
}

export function chooseBucketMappings(params: {
  taxonomyLabels: string[];
  families: ScenarioFamily[];
  historyCounts: Map<string, Map<string, number>>;
}): FollowUpBucketMapping[] {
  const candidateFamilies = params.families.filter(
    family => family.isCandidate
  );

  return params.taxonomyLabels.map(label => {
    const explicitMatches = candidateFamilies.filter(family =>
      family.explicitLabels.some(
        explicitLabel => normalizeText(explicitLabel) === normalizeText(label)
      )
    );

    const scoredCandidates = candidateFamilies.map(family => {
      const textScore = scoreTokenOverlap(label, family.corpus);
      const historyScore =
        (params.historyCounts.get(label)?.get(family.rootScenarioId) || 0) * 2;
      const explicitScore = explicitMatches.includes(family) ? 100 : 0;
      const totalScore = explicitScore || textScore + historyScore;
      return {
        family,
        historyScore,
        totalScore,
      };
    });

    scoredCandidates.sort((left, right) => right.totalScore - left.totalScore);
    const best = scoredCandidates[0];
    const secondBest = scoredCandidates[1];

    if (!best) {
      return {
        label,
        recommendedRootScenarioId: null,
        recommendedRootScenarioName: null,
        mappingConfidence: 0,
        mappingReason: "No active follow-up scenario roots were discovered.",
        warning:
          "No follow-up candidate roots are available in this workspace.",
      };
    }

    const margin = best.totalScore - (secondBest?.totalScore || 0);
    if (
      best.totalScore < MIN_MAPPING_SCORE ||
      (best.totalScore < 100 && margin < MIN_MAPPING_MARGIN)
    ) {
      return {
        label,
        recommendedRootScenarioId: null,
        recommendedRootScenarioName: null,
        mappingConfidence: 0,
        mappingReason: `Top candidate was ${best.family.rootScenarioName}, but the score was not decisive enough.`,
        warning:
          "Bucket remains unmapped because the best scenario did not clear the confidence threshold.",
      };
    }

    const confidence =
      best.totalScore >= 100
        ? 1
        : Math.min(
            0.99,
            0.45 +
              Math.min(best.totalScore / 12, 0.35) +
              Math.min(margin / 6, 0.19)
          );

    return {
      label,
      recommendedRootScenarioId: best.family.rootScenarioId,
      recommendedRootScenarioName: best.family.rootScenarioName,
      mappingConfidence: confidence,
      mappingReason:
        best.totalScore >= 100
          ? "Explicit category configuration on the scenario root matched this taxonomy label."
          : `Matched by scenario text overlap and historical starts (${best.historyScore > 0 ? "with" : "without"} history support).`,
      warning: null,
    };
  });
}

function computeReadyAt(params: {
  family: ScenarioFamily;
  lastActivityAt?: string | null;
  createdAt?: string | null;
}): string | null {
  const baseDate = toDate(params.lastActivityAt) || toDate(params.createdAt);
  if (!baseDate) {
    return null;
  }

  if (typeof params.family.timeoutMinutes === "number") {
    return new Date(
      baseDate.getTime() + params.family.timeoutMinutes * 60 * 1000
    ).toISOString();
  }

  if (typeof params.family.inactivityDays === "number") {
    return new Date(
      baseDate.getTime() + params.family.inactivityDays * 24 * 60 * 60 * 1000
    ).toISOString();
  }

  return null;
}

export function resolveConversationPurchaseEvidence(params: {
  manualConversionAt?: string | null;
  paymentConfirmationMessageAt?: string | null;
  diagnosticPaymentLogAt?: string | null;
}): {
  purchaseAt: string | null;
  purchaseEvidenceType: PurchaseEvidenceType | null;
} {
  if (params.manualConversionAt) {
    return {
      purchaseAt: params.manualConversionAt,
      purchaseEvidenceType: "manual_conversion",
    };
  }

  if (params.paymentConfirmationMessageAt) {
    return {
      purchaseAt: params.paymentConfirmationMessageAt,
      purchaseEvidenceType: "payment_confirmation_message",
    };
  }

  return {
    purchaseAt: null,
    purchaseEvidenceType: null,
  };
}

export function resolveConversationStatus(params: {
  row: BaseConversationAnalysis;
  mapping: MappingDecision | null;
  familyByRootId: Map<string, ScenarioFamily>;
  now: Date;
}): Omit<ConversationFollowUpAnalysisRow, "internalLabels"> {
  const mappingWarning = params.mapping?.warning || null;
  const warnings = [...params.row.warnings];
  if (mappingWarning) {
    warnings.push(mappingWarning);
  }

  if (params.row.purchaseEvidenceType) {
    return {
      conversationId: params.row.conversationId,
      channel: params.row.channel,
      chatLabel: params.row.chatLabel,
      lastMessageAt: params.row.lastMessageAt,
      effectiveCategory: params.row.effectiveCategory,
      categorySource: params.row.categorySource,
      categoryConfidence: params.row.categoryConfidence,
      categoryEvidence: params.row.categoryEvidence,
      purchaseAt: params.row.purchaseAt,
      purchaseEvidenceType: params.row.purchaseEvidenceType,
      status: "excluded_purchased",
      recommendedRootScenarioId: params.mapping?.rootScenarioId || null,
      recommendedRootScenarioName: params.mapping?.rootScenarioName || null,
      currentFollowUpScenarioName: params.row.currentFollowUpScenarioName,
      readyAt: null,
      warnings,
    };
  }

  if (!params.mapping?.rootScenarioId) {
    return {
      conversationId: params.row.conversationId,
      channel: params.row.channel,
      chatLabel: params.row.chatLabel,
      lastMessageAt: params.row.lastMessageAt,
      effectiveCategory: params.row.effectiveCategory,
      categorySource: params.row.categorySource,
      categoryConfidence: params.row.categoryConfidence,
      categoryEvidence: params.row.categoryEvidence,
      purchaseAt: params.row.purchaseAt,
      purchaseEvidenceType: null,
      status: "unmapped_bucket",
      recommendedRootScenarioId: null,
      recommendedRootScenarioName: null,
      currentFollowUpScenarioName: params.row.currentFollowUpScenarioName,
      readyAt: null,
      warnings,
    };
  }

  const family = params.familyByRootId.get(params.mapping.rootScenarioId);
  if (!family) {
    warnings.push("Mapped follow-up family could not be resolved.");
    return {
      conversationId: params.row.conversationId,
      channel: params.row.channel,
      chatLabel: params.row.chatLabel,
      lastMessageAt: params.row.lastMessageAt,
      effectiveCategory: params.row.effectiveCategory,
      categorySource: params.row.categorySource,
      categoryConfidence: params.row.categoryConfidence,
      categoryEvidence: params.row.categoryEvidence,
      purchaseAt: params.row.purchaseAt,
      purchaseEvidenceType: null,
      status: "unmapped_bucket",
      recommendedRootScenarioId: params.mapping.rootScenarioId,
      recommendedRootScenarioName: params.mapping.rootScenarioName,
      currentFollowUpScenarioName: params.row.currentFollowUpScenarioName,
      readyAt: null,
      warnings,
    };
  }

  const familyScenarioIds = new Set(family.familyScenarioIds);
  const alreadyStarted = params.row.startedScenarioIds.some(scenarioId =>
    familyScenarioIds.has(scenarioId)
  );
  const readyAt = computeReadyAt({
    family,
    lastActivityAt: params.row.lastMessageAt || params.row.updatedAt,
    createdAt: params.row.createdAt,
  });

  if (alreadyStarted) {
    return {
      conversationId: params.row.conversationId,
      channel: params.row.channel,
      chatLabel: params.row.chatLabel,
      lastMessageAt: params.row.lastMessageAt,
      effectiveCategory: params.row.effectiveCategory,
      categorySource: params.row.categorySource,
      categoryConfidence: params.row.categoryConfidence,
      categoryEvidence: params.row.categoryEvidence,
      purchaseAt: null,
      purchaseEvidenceType: null,
      status: "already_in_follow_up",
      recommendedRootScenarioId: params.mapping.rootScenarioId,
      recommendedRootScenarioName: params.mapping.rootScenarioName,
      currentFollowUpScenarioName:
        params.row.currentFollowUpScenarioName ||
        params.mapping.rootScenarioName,
      readyAt,
      warnings,
    };
  }

  const readyDate = toDate(readyAt);
  const status =
    readyDate && readyDate.getTime() <= params.now.getTime()
      ? "ready_now"
      : "waiting_timeout";

  return {
    conversationId: params.row.conversationId,
    channel: params.row.channel,
    chatLabel: params.row.chatLabel,
    lastMessageAt: params.row.lastMessageAt,
    effectiveCategory: params.row.effectiveCategory,
    categorySource: params.row.categorySource,
    categoryConfidence: params.row.categoryConfidence,
    categoryEvidence: params.row.categoryEvidence,
    purchaseAt: null,
    purchaseEvidenceType: null,
    status,
    recommendedRootScenarioId: params.mapping.rootScenarioId,
    recommendedRootScenarioName: params.mapping.rootScenarioName,
    currentFollowUpScenarioName: null,
    readyAt,
    warnings,
  };
}

export function buildOutboundMessageCorpus(message: LeanMessageRow): string {
  const hasCanonicalServiceMessage = hasStoredWhatsAppServiceMessage(
    message.whatsappServiceMessage
  );
  const serviceMessage = hasCanonicalServiceMessage
    ? resolveStoredWhatsAppServiceMessagePreview(message.whatsappServiceMessage)
    : null;
  const values: string[] = [
    message.text || "",
    ...(serviceMessage?.textParts || []),
    ...(!hasCanonicalServiceMessage
      ? [
          message.whatsappTemplate?.name || "",
          message.whatsappTemplate?.headerText || "",
          message.whatsappTemplate?.bodyText || "",
          message.whatsappTemplate?.footerText || "",
          ...(message.whatsappTemplate?.buttons || []).map(
            button => button.text || ""
          ),
          message.whatsappFlow?.headerText || "",
          message.whatsappFlow?.bodyText || "",
          message.whatsappFlow?.footerText || "",
          message.whatsappFlow?.flowCta || "",
        ]
      : []),
    ...(message.telegramReplyMarkup?.inlineKeyboard || []).flatMap(row =>
      row.map(button => button.text || "")
    ),
  ];

  return values.filter(Boolean).join("\n");
}

export function buildOutboundMessageSignature(
  message: LeanMessageRow
): string | null {
  const hasCanonicalServiceMessage = hasStoredWhatsAppServiceMessage(
    message.whatsappServiceMessage
  );
  if (hasCanonicalServiceMessage) {
    const serviceMessage = resolveStoredWhatsAppServiceMessagePreview(
      message.whatsappServiceMessage
    );
    const kind = normalizeText(serviceMessage.kind);
    const semanticText = normalizeText(serviceMessage.textParts.join(" "));
    return kind && semanticText
      ? `service:${kind}:${semanticText.slice(0, 180)}`
      : null;
  }

  const templateName = normalizeText(message.whatsappTemplate?.name || "");
  if (templateName) {
    return `template:${templateName}`;
  }

  const templateBody = normalizeText(message.whatsappTemplate?.bodyText || "");
  if (templateBody) {
    return `template-body:${templateBody.slice(0, 180)}`;
  }

  const flowBody = normalizeText(message.whatsappFlow?.bodyText || "");
  if (flowBody) {
    return `flow:${flowBody.slice(0, 180)}`;
  }

  const text = normalizeText(message.text || "");
  if (text) {
    return `text:${text.slice(0, 180)}`;
  }

  return null;
}

async function loadManualConversions(
  workspaceId: string
): Promise<Map<string, string>> {
  const conversions = new Map<string, string>();
  let from = 0;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("conversions")
      .select("conversation_id, converted_at")
      .eq("workspace_id", workspaceId)
      .eq("source", "manual")
      .order("converted_at", { ascending: false })
      .range(from, from + SUPABASE_PAGE_SIZE - 1);

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      break;
    }

    for (const row of data) {
      const conversationId =
        typeof row.conversation_id === "string"
          ? row.conversation_id.trim()
          : "";
      const convertedAt =
        typeof row.converted_at === "string" ? row.converted_at.trim() : "";
      if (!conversationId || !convertedAt || conversions.has(conversationId)) {
        continue;
      }
      conversions.set(conversationId, convertedAt);
    }

    if (data.length < SUPABASE_PAGE_SIZE) {
      break;
    }
    from += SUPABASE_PAGE_SIZE;
  }

  return conversions;
}

async function loadOutboundMessagesByConversationIds(
  workspaceId: string,
  conversationIds: string[]
): Promise<Map<string, LeanMessageRow[]>> {
  const byConversationId = new Map<string, LeanMessageRow[]>();
  if (conversationIds.length === 0) {
    return byConversationId;
  }

  for (
    let index = 0;
    index < conversationIds.length;
    index += MESSAGE_LOOKUP_BATCH_SIZE
  ) {
    const batchIds = conversationIds.slice(
      index,
      index + MESSAGE_LOOKUP_BATCH_SIZE
    );
    const messages = await Message.find({
      workspaceId,
      direction: "outbound",
      conversation: { $in: batchIds },
    })
      .select(
        "conversation author text date direction imageUrl imageAnalysis audioAnalysis videoAnalysis mediaType attachments whatsappServiceMessage whatsappTemplate whatsappFlow telegramReplyMarkup"
      )
      .sort({ date: 1 })
      .lean<LeanMessageRow[]>();

    for (const message of messages) {
      const conversationId = readEntityId(message.conversation);
      if (!conversationId) continue;
      const current = byConversationId.get(conversationId) ?? [];
      current.push(message);
      byConversationId.set(conversationId, current);
    }
  }

  return byConversationId;
}

async function derivePaymentConfirmationSignatures(params: {
  workspaceId: string;
  manualConversions: Map<string, string>;
}): Promise<Map<string, PaymentConfirmationSignature>> {
  const conversationIds = Array.from(params.manualConversions.keys());
  const signatures = new Map<string, PaymentConfirmationSignature>();
  if (conversationIds.length === 0) {
    return signatures;
  }

  const outboundMessagesByConversation =
    await loadOutboundMessagesByConversationIds(
      params.workspaceId,
      conversationIds
    );

  for (const conversationId of conversationIds) {
    const convertedAt = toDate(params.manualConversions.get(conversationId));
    if (!convertedAt) continue;

    for (const message of outboundMessagesByConversation.get(conversationId) ||
      []) {
      const messageDate = toDate(message.date);
      if (!messageDate) continue;
      const diffMs = messageDate.getTime() - convertedAt.getTime();
      if (
        diffMs < -PAYMENT_CONFIRMATION_BEFORE_CONVERSION_MS ||
        diffMs > PAYMENT_CONFIRMATION_AFTER_CONVERSION_MS
      ) {
        continue;
      }

      const corpus = buildOutboundMessageCorpus(message);
      if (scorePaymentConfirmationText(corpus) < 2) {
        continue;
      }

      const signature = buildOutboundMessageSignature(message);
      if (!signature) continue;

      const current = signatures.get(signature);
      signatures.set(signature, {
        signature,
        supportCount: (current?.supportCount || 0) + 1,
      });
    }
  }

  return signatures;
}

async function loadConversationBatch(params: {
  baseMatch: Record<string, unknown>;
  cursorId: mongoose.Types.ObjectId | null;
  limit?: number;
}): Promise<LeanConversationRow[]> {
  const query: Record<string, unknown> = { ...params.baseMatch };
  if (params.cursorId) {
    return Conversation.find({
      $and: [params.baseMatch, { _id: { $gt: params.cursorId } }],
    })
      .select(FOLLOW_UP_AUDIENCE_CONVERSATION_SELECT)
      .sort({ _id: 1 })
      .limit(params.limit || CONVERSATION_BATCH_SIZE)
      .lean<LeanConversationRow[]>();
  }

  return Conversation.find(query)
    .select(FOLLOW_UP_AUDIENCE_CONVERSATION_SELECT)
    .sort({ _id: 1 })
    .limit(params.limit || CONVERSATION_BATCH_SIZE)
    .lean<LeanConversationRow[]>();
}

async function loadUsersMap(
  userIds: unknown[]
): Promise<Map<string, LeanUserRow>> {
  const ids = userIds.filter(value => value !== null && value !== undefined);
  const map = new Map<string, LeanUserRow>();
  if (ids.length === 0) {
    return map;
  }

  const users = await User.find({ _id: { $in: ids } })
    .select("_id firstName lastName username isBot")
    .lean<LeanUserRow[]>();
  for (const user of users) {
    const userId = readEntityId(user._id);
    if (userId) {
      map.set(userId, user);
    }
  }
  return map;
}

async function loadChatsMap(
  chatIds: unknown[]
): Promise<Map<string, LeanChatRow>> {
  const ids = chatIds.filter(value => value !== null && value !== undefined);
  const map = new Map<string, LeanChatRow>();
  if (ids.length === 0) {
    return map;
  }

  const chats = await Chat.find({ _id: { $in: ids } })
    .select("_id title first_name last_name username")
    .lean<LeanChatRow[]>();
  for (const chat of chats) {
    const chatId = readEntityId(chat._id);
    if (chatId) {
      map.set(chatId, chat);
    }
  }
  return map;
}

async function loadMessagesForReclassification(
  conversationIds: string[]
): Promise<Map<string, PopulatedMessage[]>> {
  const grouped = new Map<string, LeanMessageRow[]>();
  if (conversationIds.length === 0) {
    return new Map();
  }

  const messages = await Message.find({
    conversation: { $in: conversationIds },
  })
    .select(
      "_id conversation author text date direction imageUrl imageAnalysis audioAnalysis videoAnalysis mediaType attachments"
    )
    .sort({ date: 1 })
    .lean<LeanMessageRow[]>();

  const authorIds = uniqueStrings(
    messages.map(message => readEntityId(message.author))
  );
  const users = await loadUsersMap(authorIds);

  for (const message of messages) {
    const conversationId = readEntityId(message.conversation);
    if (!conversationId) continue;
    const current = grouped.get(conversationId) ?? [];
    current.push(message);
    grouped.set(conversationId, current);
  }

  return new Map(
    Array.from(grouped.entries()).map(([conversationId, rows]) => [
      conversationId,
      rows.map(
        row =>
          ({
            _id: row._id,
            text: row.text || "",
            date: row.date || new Date(),
            direction: row.direction || "inbound",
            imageUrl: row.imageUrl || undefined,
            imageAnalysis: row.imageAnalysis || undefined,
            audioAnalysis: row.audioAnalysis || undefined,
            videoAnalysis: row.videoAnalysis || undefined,
            mediaType: row.mediaType || undefined,
            attachments: row.attachments || undefined,
            author: users.get(readEntityId(row.author)) || {
              _id: readEntityId(row.author),
              firstName:
                row.direction === "outbound" ? "Business Account" : "Customer",
              isBot: false,
            },
          }) as unknown as PopulatedMessage
      ),
    ])
  );
}

function resolveStartedScenarioIds(
  state: ReturnType<typeof normalizeConversationScenarioState>
): string[] {
  const started = toStringArray(
    state?.startedScenarios?.map(item => item.scenarioId)
  );
  const completed = toStringArray(
    state?.completedScenarios?.map(item => item.scenarioId)
  );
  return uniqueStrings([...started, ...completed]);
}

function resolveCurrentFollowUpScenarioName(params: {
  state: ReturnType<typeof normalizeConversationScenarioState>;
  familyScenarioIds: Set<string>;
  scenarioNameById: Map<string, string>;
}): string | null {
  const lockedScenarioId = params.state?.lockedScenarioId || "";
  if (lockedScenarioId && params.familyScenarioIds.has(lockedScenarioId)) {
    return (
      params.state?.lockedScenarioName ||
      params.scenarioNameById.get(lockedScenarioId) ||
      null
    );
  }

  const startedOrCompleted = [
    ...(params.state?.startedScenarios || []).map(item => ({
      scenarioId: item.scenarioId,
      scenarioName: item.scenarioName || null,
      at: item.startedAt,
    })),
    ...(params.state?.completedScenarios || []).map(item => ({
      scenarioId: item.scenarioId,
      scenarioName: item.scenarioName || null,
      at: item.completedAt,
    })),
  ]
    .filter(item => params.familyScenarioIds.has(item.scenarioId))
    .sort((left, right) => {
      const leftTime = toDate(left.at)?.getTime() || 0;
      const rightTime = toDate(right.at)?.getTime() || 0;
      return rightTime - leftTime;
    })[0];

  if (!startedOrCompleted) {
    return null;
  }

  return (
    startedOrCompleted.scenarioName ||
    params.scenarioNameById.get(startedOrCompleted.scenarioId) ||
    null
  );
}

function matchesSearchQuery(
  row: ConversationFollowUpAnalysisRow,
  query: string
): boolean {
  if (!query) {
    return true;
  }

  const haystack = normalizeText(
    [
      row.conversationId,
      row.channel || "",
      row.chatLabel,
      row.effectiveCategory,
      row.recommendedRootScenarioName || "",
      row.currentFollowUpScenarioName || "",
      row.categoryEvidence || "",
      row.warnings.join(" "),
    ].join(" ")
  );
  return haystack.includes(normalizeText(query));
}

function matchesRequestedChannel(
  row: ConversationFollowUpAnalysisRow,
  requestedChannel: string | null
): boolean {
  if (!requestedChannel) {
    return true;
  }

  return normalizeText(row.channel || "") === normalizeText(requestedChannel);
}

export function filterFollowUpAudienceRows(params: {
  rows: ConversationFollowUpAnalysisRow[];
  filters?: FollowUpAudienceQuery;
}): ConversationFollowUpAnalysisRow[] {
  const requestedCategory =
    typeof params.filters?.category === "string" &&
    params.filters.category.trim().length > 0
      ? params.filters.category.trim()
      : null;
  const requestedStatus = params.filters?.status || null;
  const requestedChannel =
    typeof params.filters?.channel === "string" &&
    params.filters.channel.trim().length > 0
      ? params.filters.channel.trim()
      : null;
  const searchQuery =
    typeof params.filters?.q === "string" ? params.filters.q.trim() : "";
  const requestedInternalLabel =
    typeof params.filters?.internalLabel === "string" &&
    params.filters.internalLabel.trim().length > 0
      ? params.filters.internalLabel.trim()
      : null;

  return params.rows.filter(row => {
    if (
      requestedCategory &&
      normalizeText(row.effectiveCategory) !== normalizeText(requestedCategory)
    ) {
      return false;
    }
    if (requestedStatus && row.status !== requestedStatus) {
      return false;
    }
    if (!matchesRequestedChannel(row, requestedChannel)) {
      return false;
    }
    if (!matchesSearchQuery(row, searchQuery)) {
      return false;
    }
    if (requestedInternalLabel) {
      const want = normalizeText(requestedInternalLabel);
      const labels = row.internalLabels || [];
      if (!labels.some(label => normalizeText(label) === want)) {
        return false;
      }
    }
    return true;
  });
}

export function summarizeFollowUpAudienceRows(params: {
  rows: ConversationFollowUpAnalysisRow[];
  taxonomyLabels: string[];
}): FollowUpAudienceSummary {
  return params.rows.reduce<FollowUpAudienceSummary>(
    (accumulator, row) => {
      accumulator.totalConversations += 1;
      accumulator.byCategory[row.effectiveCategory] =
        (accumulator.byCategory[row.effectiveCategory] || 0) + 1;

      if (row.status === "excluded_purchased") {
        accumulator.purchasedExcluded += 1;
      } else if (row.status === "ready_now") {
        accumulator.readyNow += 1;
      } else if (row.status === "already_in_follow_up") {
        accumulator.alreadyInFollowUp += 1;
      } else if (row.status === "waiting_timeout") {
        accumulator.waitingTimeout += 1;
      } else if (row.status === "unmapped_bucket") {
        accumulator.unmappedBucket += 1;
      }

      return accumulator;
    },
    {
      totalConversations: 0,
      purchasedExcluded: 0,
      readyNow: 0,
      alreadyInFollowUp: 0,
      waitingTimeout: 0,
      unmappedBucket: 0,
      byCategory: Object.fromEntries(
        params.taxonomyLabels.map(label => [label, 0])
      ),
    }
  );
}

function toCursorObjectId(value: unknown): mongoose.Types.ObjectId | null {
  if (value instanceof mongoose.Types.ObjectId) {
    return value;
  }

  const stringValue = readEntityId(value);
  if (mongoose.Types.ObjectId.isValid(stringValue)) {
    return new mongoose.Types.ObjectId(stringValue);
  }

  return null;
}

type ComputeFollowUpAudienceWorkspaceStateOptions = {
  conversationFilters?: FollowUpAudienceQuery;
  maxConversations?: number | null;
};

async function computeFollowUpAudienceWorkspaceState(
  workspaceId: string,
  options?: ComputeFollowUpAudienceWorkspaceStateOptions
): Promise<FollowUpAudienceWorkspaceState> {
  await connectDB();

  const [taxonomy, scenarios, manualConversions] = await Promise.all([
    getWorkspaceTaxonomy(workspaceId),
    Scenario.find({
      workspaceId,
      status: "active",
      mode: "conversation",
    })
      .select("_id name description priority segmentKey nodes edges")
      .lean<ActiveScenarioRow[]>(),
    loadManualConversions(workspaceId),
  ]);

  const scenarioNameById = new Map(
    scenarios.map(scenario => [scenario._id, scenario.name])
  );
  const families = buildScenarioFamilies(scenarios, taxonomy.labels);
  const familyByRootId = new Map(
    families.map(family => [family.rootScenarioId, family])
  );
  const paymentConfirmationSignatures =
    await derivePaymentConfirmationSignatures({
      workspaceId,
      manualConversions,
    });

  const sourceContextCache = new Map<string, string>();
  const rows: BaseConversationAnalysis[] = [];
  const reclassifyLimit = pLimit(RECLASSIFICATION_CONCURRENCY);
  const baseConversationMatch = buildFollowUpConversationPrefilterMatch(
    workspaceId,
    options?.conversationFilters
  );
  const maxConversations =
    typeof options?.maxConversations === "number" &&
    options.maxConversations > 0
      ? options.maxConversations
      : null;
  const appliedRefreshFilters = listScopedRefreshFilterNames(
    options?.conversationFilters
  );
  const scannedConversationLimit =
    maxConversations && appliedRefreshFilters.length > 0
      ? maxConversations
      : null;
  let scannedConversations = 0;
  let refreshScopeTruncated = false;
  let cursorId: mongoose.Types.ObjectId | null = null;

  while (true) {
    const remaining =
      scannedConversationLimit !== null
        ? scannedConversationLimit - scannedConversations
        : CONVERSATION_BATCH_SIZE;
    if (remaining <= 0) {
      refreshScopeTruncated = true;
      break;
    }
    const batchLimit = Math.min(CONVERSATION_BATCH_SIZE, remaining);
    const batch = await loadConversationBatch({
      baseMatch: baseConversationMatch,
      cursorId,
      limit: batchLimit,
    });
    if (batch.length === 0) {
      break;
    }
    scannedConversations += batch.length;

    const batchIds = batch.map(item => readEntityId(item._id));
    const chatIds = uniqueStrings(batch.map(item => readEntityId(item.chat)));
    const userIds = uniqueStrings(batch.map(item => readEntityId(item.user)));
    const [chatsMap, usersMap, outboundMessagesByConversation] =
      await Promise.all([
        loadChatsMap(chatIds),
        loadUsersMap(userIds),
        paymentConfirmationSignatures.size > 0
          ? loadOutboundMessagesByConversationIds(workspaceId, batchIds)
          : Promise.resolve(new Map<string, LeanMessageRow[]>()),
      ]);

    const effectiveCategoryMap = new Map<
      string,
      Awaited<ReturnType<typeof resolveEffectiveConversationCategory>>
    >();
    const storedClassificationByConversationId = new Map(
      batch.map(conversation => [
        readEntityId(conversation._id),
        resolveFollowUpStoredClassification(conversation),
      ])
    );
    const conversationsToReclassify = batch.filter(conversation => {
      const conversationId = readEntityId(conversation._id);
      const storedClassification = storedClassificationByConversationId.get(
        conversationId
      ) || {
        storedCategory: null,
        storedConfidence: null,
      };
      return conversationNeedsLlmReclassification(
        storedClassification,
        taxonomy
      );
    });
    const conversationIdsToReclassify = new Set(
      conversationsToReclassify.map(conversation =>
        readEntityId(conversation._id)
      )
    );

    const reclassificationMessages = await loadMessagesForReclassification(
      conversationsToReclassify.map(conversation =>
        readEntityId(conversation._id)
      )
    );

    await Promise.all(
      batch
        .filter(
          conversation =>
            !effectiveCategoryMap.has(readEntityId(conversation._id))
        )
        .map(conversation =>
          reclassifyLimit(async () => {
            const conversationId = readEntityId(conversation._id);
            const storedClassification =
              storedClassificationByConversationId.get(conversationId) || {
                storedCategory: null,
                storedConfidence: null,
              };
            const shouldReclassify =
              conversationIdsToReclassify.has(conversationId);
            const result = await resolveEffectiveConversationCategory({
              taxonomy,
              storedCategory: storedClassification.storedCategory,
              storedConfidence: storedClassification.storedConfidence,
              evaluateCategory: shouldReclassify
                ? async () => {
                    const sourceId =
                      typeof conversation.sourceId === "string"
                        ? conversation.sourceId.trim()
                        : "";
                    let businessContext =
                      sourceContextCache.get(sourceId) || null;
                    if (!businessContext) {
                      const sourceContext = sourceId
                        ? await getBusinessContext(sourceId)
                        : { businessContext: "customer support" };
                      businessContext =
                        sourceContext.businessContext || "customer support";
                      sourceContextCache.set(sourceId, businessContext);
                    }

                    const messages =
                      reclassificationMessages.get(conversationId) || [];
                    const prepared = prepareTextForAnalysis(
                      messages,
                      conversation.history_summary || undefined,
                      null
                    );

                    return withWorkspaceTextAiAction(
                      {
                        workspaceId,
                        actionId: `audience-classification:${randomUUID()}`,
                      },
                      () =>
                        selectCategoryWithSchema({
                          businessContext,
                          textForAnalysis: prepared.text,
                          taxonomy,
                          existingCategory: storedClassification.storedCategory,
                        })
                    );
                  }
                : null,
            });

            effectiveCategoryMap.set(conversationId, result);
          })
        )
    );

    for (const conversation of batch) {
      const conversationId = readEntityId(conversation._id);
      const effectiveCategory = effectiveCategoryMap.get(conversationId);
      if (!effectiveCategory) {
        continue;
      }

      const outboundMessages =
        outboundMessagesByConversation.get(conversationId) || [];
      let paymentConfirmationMessageAt: string | null = null;
      for (const message of outboundMessages) {
        const signature = buildOutboundMessageSignature(message);
        if (!signature || !paymentConfirmationSignatures.has(signature)) {
          continue;
        }

        paymentConfirmationMessageAt = toIsoString(message.date);
        break;
      }

      const purchaseEvidence = resolveConversationPurchaseEvidence({
        manualConversionAt: manualConversions.get(conversationId) || null,
        paymentConfirmationMessageAt,
      });

      const state = normalizeConversationScenarioState(
        conversation.airi_scenario_state
      );
      const startedScenarioIds = resolveStartedScenarioIds(state);
      const familyScenarioIds = new Set(startedScenarioIds);
      const currentFollowUpScenarioName = resolveCurrentFollowUpScenarioName({
        state,
        familyScenarioIds,
        scenarioNameById,
      });
      const chat = chatsMap.get(readEntityId(conversation.chat)) || null;
      const user = usersMap.get(readEntityId(conversation.user)) || null;

      rows.push({
        conversationId,
        channel:
          typeof conversation.channel === "string"
            ? conversation.channel
            : null,
        // Audience rows always need a label; a nameless chat keeps its id.
        chatLabel:
          getConversationDisplayName({
            conversation: {
              _id: conversation._id,
              channel: conversation.channel,
              rename: conversation.rename,
            },
            chat,
            user,
          }) ||
          `${normalizeLooseString(conversation.channel) || "unknown"}:${conversationId}`,
        lastMessageAt: toIsoString(conversation.lastMessageAt),
        effectiveCategory: effectiveCategory.effectiveCategory,
        categorySource: effectiveCategory.categorySource,
        categoryConfidence: effectiveCategory.categoryConfidence,
        categoryEvidence: effectiveCategory.categoryEvidence,
        purchaseAt: purchaseEvidence.purchaseAt,
        purchaseEvidenceType: purchaseEvidence.purchaseEvidenceType,
        warnings: [...effectiveCategory.warnings],
        startedScenarioIds,
        currentFollowUpScenarioName,
        createdAt: toIsoString(conversation.createdAt),
        updatedAt: toIsoString(conversation.updatedAt),
        internalLabels: uniqueStrings(
          Array.isArray(conversation.internal_labels)
            ? conversation.internal_labels.map(entry =>
                String(entry ?? "").trim()
              )
            : []
        ),
      });
    }

    cursorId = toCursorObjectId(batch[batch.length - 1]?._id);

    if (
      scannedConversationLimit !== null &&
      scannedConversations >= scannedConversationLimit &&
      batch.length === batchLimit
    ) {
      refreshScopeTruncated = Boolean(
        cursorId &&
          (await Conversation.exists({
            $and: [baseConversationMatch, { _id: { $gt: cursorId } }],
          }))
      );
      break;
    }
  }

  const historyCounts = buildFamilyHistoryCounts(rows, families);
  const bucketMappings = chooseBucketMappings({
    taxonomyLabels: taxonomy.labels,
    families,
    historyCounts,
  });
  const mappingByLabel = new Map<string, MappingDecision>(
    bucketMappings.map(mapping => [
      mapping.label,
      {
        rootScenarioId: mapping.recommendedRootScenarioId,
        rootScenarioName: mapping.recommendedRootScenarioName,
        familyScenarioIds:
          mapping.recommendedRootScenarioId &&
          familyByRootId.has(mapping.recommendedRootScenarioId)
            ? familyByRootId.get(mapping.recommendedRootScenarioId)
                ?.familyScenarioIds || []
            : [],
        mappingConfidence: mapping.mappingConfidence,
        mappingReason: mapping.mappingReason,
        warning: mapping.warning,
      },
    ])
  );

  const resolvedRows = rows.map(row => ({
    ...resolveConversationStatus({
      row,
      mapping: mappingByLabel.get(row.effectiveCategory) || null,
      familyByRootId,
      now: new Date(),
    }),
    internalLabels: row.internalLabels,
    startedScenarioIds: row.startedScenarioIds,
  }));

  const summary = resolvedRows.reduce<FollowUpAudienceSummary>(
    (accumulator, row) => {
      accumulator.totalConversations += 1;
      accumulator.byCategory[row.effectiveCategory] =
        (accumulator.byCategory[row.effectiveCategory] || 0) + 1;

      if (row.status === "excluded_purchased") {
        accumulator.purchasedExcluded += 1;
      } else if (row.status === "ready_now") {
        accumulator.readyNow += 1;
      } else if (row.status === "already_in_follow_up") {
        accumulator.alreadyInFollowUp += 1;
      } else if (row.status === "waiting_timeout") {
        accumulator.waitingTimeout += 1;
      } else if (row.status === "unmapped_bucket") {
        accumulator.unmappedBucket += 1;
      }

      return accumulator;
    },
    {
      totalConversations: 0,
      purchasedExcluded: 0,
      readyNow: 0,
      alreadyInFollowUp: 0,
      waitingTimeout: 0,
      unmappedBucket: 0,
      byCategory: Object.fromEntries(taxonomy.labels.map(label => [label, 0])),
    }
  );

  return {
    taxonomy: {
      labels: taxonomy.labels,
      version: taxonomy.version,
      confidenceThreshold: taxonomy.confidenceThreshold,
    },
    summary,
    bucketMappings,
    rows: resolvedRows,
    familyByRootId,
    refreshScope:
      appliedRefreshFilters.length > 0 && scannedConversationLimit !== null
        ? {
            mode: "filtered",
            scannedConversations,
            maxConversations: scannedConversationLimit,
            truncated: refreshScopeTruncated,
            appliedFilters: appliedRefreshFilters,
          }
        : undefined,
  };
}

type GetFollowUpAudienceWorkspaceStateOptions = {
  bypassCache?: boolean;
  assumeCacheMiss?: boolean;
};

export async function getFollowUpAudienceWorkspaceState(
  workspaceId: string,
  options?: GetFollowUpAudienceWorkspaceStateOptions
): Promise<FollowUpAudienceWorkspaceState> {
  if (options?.bypassCache) {
    return computeFollowUpAudienceWorkspaceState(workspaceId);
  }

  const cacheKey = buildCacheKey("follow-up-audience:workspace-state", [
    workspaceId,
  ]);

  if (!options?.assumeCacheMiss) {
    const cachedRaw = await cache.get<unknown>(cacheKey);
    const fromCache = parseFollowUpAudienceWorkspaceStateCache(cachedRaw);
    if (fromCache) {
      return fromCache;
    }
  }

  const inflight = pendingFollowUpAudienceWorkspaceState.get(workspaceId);
  if (inflight) {
    return inflight;
  }

  const promise = (async () => {
    try {
      const state = await computeFollowUpAudienceWorkspaceState(workspaceId);
      await cache.set(
        cacheKey,
        serializeFollowUpAudienceWorkspaceState(state),
        FOLLOW_UP_AUDIENCE_WORKSPACE_STATE_TTL_SECONDS
      );
      return state;
    } finally {
      pendingFollowUpAudienceWorkspaceState.delete(workspaceId);
    }
  })();

  pendingFollowUpAudienceWorkspaceState.set(workspaceId, promise);
  return promise;
}

function buildPaginatedFollowUpAudienceResponse(params: {
  state: FollowUpAudienceWorkspaceState;
  filters?: FollowUpAudienceQuery;
  page: number;
  pageSize: number;
}): FollowUpAudienceResponse {
  const filteredRows = filterFollowUpAudienceRows({
    rows: params.state.rows,
    filters: params.filters,
  });
  const filteredSummary = summarizeFollowUpAudienceRows({
    rows: filteredRows,
    taxonomyLabels: params.state.taxonomy.labels,
  });
  const totalRows = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / params.pageSize));
  const safePage = Math.min(params.page, totalPages);
  const paginatedRows = filteredRows.slice(
    (safePage - 1) * params.pageSize,
    safePage * params.pageSize
  );
  return {
    taxonomy: params.state.taxonomy,
    summary: filteredSummary,
    bucketMappings: params.state.bucketMappings,
    rows: paginatedRows,
    page: safePage,
    pageSize: params.pageSize,
    totalRows,
    totalPages,
    refreshScope: params.state.refreshScope,
  };
}

export async function getFollowUpAudienceAnalysis(params: {
  workspaceId: string;
  filters?: FollowUpAudienceQuery;
  /** When true, recomputes workspace state (ignores cache). */
  bypassWorkspaceStateCache?: boolean;
}): Promise<FollowUpAudienceResponse> {
  const page = Math.max(1, params.filters?.page || 1);
  const pageSize = Math.min(100, Math.max(1, params.filters?.pageSize || 25));
  const searchQuery =
    typeof params.filters?.q === "string" ? params.filters.q.trim() : "";
  const scopedRefreshFilterNames = listScopedRefreshFilterNames(params.filters);

  if (params.bypassWorkspaceStateCache && scopedRefreshFilterNames.length > 0) {
    const state = await computeFollowUpAudienceWorkspaceState(
      params.workspaceId,
      {
        conversationFilters: params.filters,
        maxConversations: FOLLOW_UP_AUDIENCE_SCOPED_REFRESH_LIMIT,
      }
    );

    return buildPaginatedFollowUpAudienceResponse({
      state,
      filters: params.filters,
      page,
      pageSize,
    });
  }

  if (!params.bypassWorkspaceStateCache && !searchQuery) {
    const cacheKey = buildCacheKey("follow-up-audience:workspace-state", [
      params.workspaceId,
    ]);
    const cachedRaw = await cache.get<unknown>(cacheKey);
    const fromCache = parseFollowUpAudienceWorkspaceStateCache(cachedRaw);
    if (fromCache) {
      return buildPaginatedFollowUpAudienceResponse({
        state: fromCache,
        filters: params.filters,
        page,
        pageSize,
      });
    }
  }

  const state = await getFollowUpAudienceWorkspaceState(params.workspaceId, {
    bypassCache: params.bypassWorkspaceStateCache,
    assumeCacheMiss: !params.bypassWorkspaceStateCache && !searchQuery,
  });

  return buildPaginatedFollowUpAudienceResponse({
    state,
    filters: params.filters,
    page,
    pageSize,
  });
}
