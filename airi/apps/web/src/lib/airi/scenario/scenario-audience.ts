import {
  FUNNEL_SEGMENT_KEYS as CRM_FUNNEL_SEGMENT_KEYS,
  normalizeScenarioActionRunConditions,
  type ScenarioActionRunCondition,
  type FunnelSegmentKey as BaseFunnelSegmentKey,
} from "@icecore/scenario-contracts";
import { getCurrentConversationClassification } from "@icecore/shared/lib/conversation-classification-freshness";
import type { Channel, ConversationDocument } from "@/types/models";

import type { ScenarioRuntimeNode } from "@icecore/airi-runtime/scenario-graph";
import {
  normalizeAudienceDays,
  toStringArray,
} from "@/lib/scenarios/normalization";

// ---------------------------------------------------------------------------
// Segment types & constants
// ---------------------------------------------------------------------------

export type FunnelSegmentKey = BaseFunnelSegmentKey | "other";

const SEGMENT_LABEL_PREFIX = "seg:";
const SEGMENT_LOCK_LABEL = "override:segment_locked";
const FUNNEL_SEGMENT_KEYS = new Set<FunnelSegmentKey>([
  ...CRM_FUNNEL_SEGMENT_KEYS,
  "other",
]);

// ---------------------------------------------------------------------------
// Segment normalization & routing
// ---------------------------------------------------------------------------

export function normalizeSegmentKey(value: unknown): FunnelSegmentKey | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const withoutPrefix = trimmed.startsWith(SEGMENT_LABEL_PREFIX)
    ? trimmed.slice(SEGMENT_LABEL_PREFIX.length)
    : trimmed;
  if (!FUNNEL_SEGMENT_KEYS.has(withoutPrefix as FunnelSegmentKey)) return null;
  return withoutPrefix as FunnelSegmentKey;
}

function getSegmentKeyFromInternalLabels(
  labels: string[]
): FunnelSegmentKey | null {
  for (const label of labels) {
    const normalized = normalizeSegmentKey(label);
    if (normalized) return normalized;
  }
  return null;
}

function hasSegmentLockLabel(labels: string[]): boolean {
  return labels.some(
    label => label.trim().toLowerCase() === SEGMENT_LOCK_LABEL
  );
}

export function resolveConversationSegmentRouting(params: {
  internalLabels?: unknown;
  classificationCategory?: unknown;
}): {
  segmentKey: FunnelSegmentKey;
  source:
    | "override_label"
    | "segment_label"
    | "classification"
    | "fallback_other";
} {
  const internalLabels = toStringArray(params.internalLabels);
  const internalSegment = getSegmentKeyFromInternalLabels(internalLabels);
  const classificationSegment = normalizeSegmentKey(
    params.classificationCategory
  );

  if (hasSegmentLockLabel(internalLabels) && internalSegment) {
    return {
      segmentKey: internalSegment,
      source: "override_label",
    };
  }
  if (internalSegment) {
    return {
      segmentKey: internalSegment,
      source: "segment_label",
    };
  }
  if (classificationSegment) {
    return {
      segmentKey: classificationSegment,
      source: "classification",
    };
  }
  return {
    segmentKey: "other",
    source: "fallback_other",
  };
}

// ---------------------------------------------------------------------------
// Stage labels
// ---------------------------------------------------------------------------

export function getStageLabelFromInternalLabels(
  labels: unknown
): string | null {
  for (const label of toStringArray(labels)) {
    const normalized = label.trim().toLowerCase();
    if (!normalized.startsWith("stage:")) continue;
    const stage = normalized.slice("stage:".length).trim();
    if (stage) return stage;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conversation helpers
// ---------------------------------------------------------------------------

export function getConversationChatValue(chat: unknown): string | null {
  if (chat === null || chat === undefined) return null;
  if (typeof chat === "string" || typeof chat === "number") return String(chat);
  if (typeof chat !== "object") return null;
  const chatObject = chat as Record<string, unknown>;
  if (chatObject._id !== null && chatObject._id !== undefined) {
    return String(chatObject._id);
  }
  return null;
}

export function getConversationCustomerKey(
  conversation: ConversationDocument
): string | null {
  const conversationAny = conversation as ConversationDocument & {
    chat?: unknown;
    channel?: string;
  };
  const chatValue = getConversationChatValue(conversationAny.chat);
  const channel = conversationAny.channel;
  if (!chatValue || !channel) return null;
  return `${channel}:${chatValue}`;
}

export type ConversationCustomerFactsInput = {
  classification?: { category?: string | null } | null;
  internal_labels?: string[] | null;
  history_summary?: string | null;
  estimated_customer_ltv?: number | null;
  revenue_attribution_id?: string | null;
};

type CurrentConversationClassification = {
  category?: string | null;
};

export function resolveConversationCustomerFacts(
  conversation: ConversationCustomerFactsInput
): {
  classificationCategory: string | null;
  hasPurchaseHistory: boolean;
  isNewCustomer: boolean;
} {
  return resolveConversationCustomerFactsFromCurrentClassification(
    conversation,
    getCurrentConversationClassification<CurrentConversationClassification>(
      conversation
    )
  );
}

function resolveConversationCustomerFactsFromCurrentClassification(
  conversation: ConversationCustomerFactsInput,
  currentClassification: CurrentConversationClassification | undefined
): {
  classificationCategory: string | null;
  hasPurchaseHistory: boolean;
  isNewCustomer: boolean;
} {
  const classificationCategory =
    typeof currentClassification?.category === "string" &&
    currentClassification.category.trim().length > 0
      ? currentClassification.category
      : null;
  const hasPurchaseHistory =
    (typeof conversation.estimated_customer_ltv === "number" &&
      conversation.estimated_customer_ltv > 0) ||
    (typeof conversation.revenue_attribution_id === "string" &&
      conversation.revenue_attribution_id.trim().length > 0);

  const hasClassification = classificationCategory !== null;
  const hasInternalLabels =
    Array.isArray(conversation.internal_labels) &&
    conversation.internal_labels.length > 0;
  const hasHistorySummary =
    typeof conversation.history_summary === "string" &&
    conversation.history_summary.trim().length > 0;

  return {
    classificationCategory,
    hasPurchaseHistory,
    isNewCustomer:
      !hasClassification &&
      !hasInternalLabels &&
      !hasHistorySummary &&
      !hasPurchaseHistory,
  };
}

type ConversationAudienceFacts = ConversationDocument & {
  classification?: { category?: string };
  internal_labels?: string[];
  estimated_customer_ltv?: number | null;
  revenue_attribution_id?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  lastMessageAt?: Date | string | null;
};

type ResolvedConversationAudienceFacts = {
  conversation: ConversationAudienceFacts;
  currentClassification: CurrentConversationClassification | undefined;
};

function resolveConversationAudienceFacts(
  conversation: ConversationDocument
): ResolvedConversationAudienceFacts {
  return {
    conversation: conversation as ConversationAudienceFacts,
    currentClassification:
      getCurrentConversationClassification<CurrentConversationClassification>(
        conversation
      ),
  };
}

function conversationMatchesClassification(
  conversation: ConversationAudienceFacts,
  currentClassification: CurrentConversationClassification | undefined,
  expectedCategory: unknown
): boolean {
  const expectedSegmentKey = normalizeSegmentKey(expectedCategory);
  if (expectedSegmentKey) {
    const segmentRouting = resolveConversationSegmentRouting({
      internalLabels: conversation.internal_labels,
      classificationCategory: currentClassification?.category || null,
    });
    return segmentRouting.segmentKey === expectedSegmentKey;
  }

  return (
    Boolean(expectedCategory) &&
    expectedCategory === currentClassification?.category
  );
}

function conversationHasInternalLabel(
  conversation: ConversationAudienceFacts,
  expectedLabel: unknown
): boolean {
  const internalLabels = toStringArray(conversation.internal_labels);
  return (
    typeof expectedLabel === "string" &&
    Boolean(expectedLabel) &&
    internalLabels.includes(expectedLabel)
  );
}

function conversationMatchesSpecificCustomers(
  conversation: ConversationDocument,
  customerIds: unknown
): boolean {
  const allowedCustomerIds = toStringArray(customerIds);
  if (allowedCustomerIds.length === 0) return true;

  const conversationId = String(conversation._id);
  const customerKey = getConversationCustomerKey(conversation);
  return allowedCustomerIds.some(
    item =>
      item === conversationId || Boolean(customerKey && item === customerKey)
  );
}

function conversationHasPurchaseHistory(
  conversation: ConversationAudienceFacts,
  currentClassification: CurrentConversationClassification | undefined
): boolean {
  return resolveConversationCustomerFactsFromCurrentClassification(
    conversation,
    currentClassification
  ).hasPurchaseHistory;
}

function conversationMatchesFunnelStage(
  conversation: ConversationAudienceFacts,
  currentClassification: CurrentConversationClassification | undefined,
  expectedStage: unknown,
  fallbackStage?: unknown
): boolean {
  const expectedSegment =
    normalizeSegmentKey(expectedStage) || normalizeSegmentKey(fallbackStage);
  if (!expectedSegment) return false;

  const manualStage = normalizeSegmentKey(
    getStageLabelFromInternalLabels(conversation.internal_labels)
  );
  if (manualStage) return manualStage === expectedSegment;

  const routed = resolveConversationSegmentRouting({
    internalLabels: conversation.internal_labels,
    classificationCategory: currentClassification?.category || null,
  });
  return routed.segmentKey === expectedSegment;
}

function conversationMatchesLastSeenDays(
  conversation: ConversationAudienceFacts,
  minimumDays: unknown
): boolean {
  const minDays = normalizeAudienceDays(minimumDays);
  if (!minDays) return false;

  const lastSeenRaw =
    conversation.lastMessageAt ||
    conversation.updatedAt ||
    conversation.createdAt;
  const lastSeenAt = lastSeenRaw ? new Date(lastSeenRaw) : null;
  if (!lastSeenAt || Number.isNaN(lastSeenAt.getTime())) return false;

  const elapsedMs = Date.now() - lastSeenAt.getTime();
  const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);
  return elapsedDays >= minDays;
}

function conversationMatchesActionRunConditionWithFacts(
  condition: ScenarioActionRunCondition,
  facts: ResolvedConversationAudienceFacts
): boolean {
  const { conversation, currentClassification } = facts;
  switch (condition.type) {
    case "classification":
      return conversationMatchesClassification(
        conversation,
        currentClassification,
        condition.category
      );
    case "internal_label":
      return conversationHasInternalLabel(conversation, condition.label);
    case "specific_customers":
      return conversationMatchesSpecificCustomers(
        facts.conversation,
        condition.customerIds
      );
    case "has_purchase_history":
      return conversationHasPurchaseHistory(
        conversation,
        currentClassification
      );
    case "funnel_stage":
      return conversationMatchesFunnelStage(
        conversation,
        currentClassification,
        condition.stage
      );
    case "last_seen_days":
      return conversationMatchesLastSeenDays(
        conversation,
        condition.minimumDays
      );
  }
}

export function actionPassesRunConditions(
  node: ScenarioRuntimeNode,
  conversation: ConversationDocument
): boolean {
  return actionPassesRunConditionsWithFacts(
    node,
    resolveConversationAudienceFacts(conversation)
  );
}

function actionPassesRunConditionsWithFacts(
  node: ScenarioRuntimeNode,
  facts: ResolvedConversationAudienceFacts
): boolean {
  if (node.data.kind !== "action") return true;

  const normalized = normalizeScenarioActionRunConditions(
    node.data.actionRunConditions
  );
  if (normalized.status === "absent") return true;
  if (normalized.status === "unsupported") return false;

  return normalized.value.conditions.every(condition =>
    conversationMatchesActionRunConditionWithFacts(condition, facts)
  );
}

// ---------------------------------------------------------------------------
// Audience filtering
// ---------------------------------------------------------------------------

export function hasConfiguredAudienceFilter(
  node: ScenarioRuntimeNode
): boolean {
  const mode = node.data.audienceMode;
  if (!mode || mode === "all") return false;
  if (mode === "classification")
    return Boolean(node.data.classificationCategory);
  if (mode === "internalLabel") return Boolean(node.data.internalLabel);
  if (mode === "specificCustomers") {
    return toStringArray(node.data.customerIds).length > 0;
  }
  if (mode === "has_purchase_history") return true;
  if (mode === "funnel_stage") {
    return Boolean(
      normalizeSegmentKey(node.data.audienceFunnelStage) ||
        normalizeSegmentKey(node.data.classificationCategory)
    );
  }
  if (mode === "last_seen_greater_than_x_days" || mode === "last_seen_days") {
    return Boolean(normalizeAudienceDays(node.data.audienceLastSeenDays));
  }
  return false;
}

export function matchesAudienceFilter(
  node: ScenarioRuntimeNode,
  conversation: ConversationDocument
): boolean {
  return matchesAudienceFilterWithFacts(
    node,
    resolveConversationAudienceFacts(conversation)
  );
}

function matchesAudienceFilterWithFacts(
  node: ScenarioRuntimeNode,
  facts: ResolvedConversationAudienceFacts
): boolean {
  const mode = node.data.audienceMode;
  if (!mode || mode === "all") return true;

  const { conversation, currentClassification } = facts;

  if (mode === "classification") {
    return conversationMatchesClassification(
      conversation,
      currentClassification,
      node.data.classificationCategory
    );
  }

  if (mode === "internalLabel") {
    return conversationHasInternalLabel(conversation, node.data.internalLabel);
  }

  if (mode === "specificCustomers") {
    return conversationMatchesSpecificCustomers(
      conversation,
      node.data.customerIds
    );
  }

  if (mode === "has_purchase_history") {
    return conversationHasPurchaseHistory(conversation, currentClassification);
  }

  if (mode === "funnel_stage") {
    return conversationMatchesFunnelStage(
      conversation,
      currentClassification,
      node.data.audienceFunnelStage,
      node.data.classificationCategory
    );
  }

  if (mode === "last_seen_greater_than_x_days" || mode === "last_seen_days") {
    return conversationMatchesLastSeenDays(
      conversation,
      node.data.audienceLastSeenDays
    );
  }

  return true;
}

export function nodePassesFlowFilters(
  node: ScenarioRuntimeNode,
  conversation: ConversationDocument,
  _channel: Channel
): boolean {
  const facts = resolveConversationAudienceFacts(conversation);
  if (
    hasConfiguredAudienceFilter(node) &&
    !matchesAudienceFilterWithFacts(node, facts)
  ) {
    return false;
  }

  return actionPassesRunConditionsWithFacts(node, facts);
}
