import type { PopulatedMessage } from "@/types/models";
import {
  getConversationTitle,
  type UnnamedConversationLabels,
} from "@/lib/conversation/display-name";
import type {
  AgentPerformanceScorecard,
  ExtractedEntity,
  InteractionMetrics,
  KeyMoment,
} from "@icecore/shared/types/models";
import { readNonEmptyString } from "@icecore/shared/lib/value-utils";

type RawDate = string | Date | null | undefined;

type AiriScenarioState = {
  lockedScenarioId?: string | null;
  lockedScenarioName?: string | null;
  currentActionNodeId?: string | null;
  pendingConditionNodeId?: string | null;
  pendingSourceActionNodeId?: string | null;
  pendingStartedAt?: RawDate;
  lastMatchedAt?: RawDate;
  startedScenarios?: unknown[];
  completedScenarios?: unknown[];
} | null;

/** The conversation payload fields read by the detail view and its info panel. */
export type ConversationInfoDetails = {
  classification?: {
    summary?: string;
    action?: string;
    priority?: string;
    sentiment?: string;
    tags?: string[];
  };
  classification_error?: string | null;
  channel?: string;
  status?: string;
  business_connection_id?: string | null;
  sourceId?: string | null;
  preferred_language?: string;
  createdAt?: RawDate;
  updatedAt?: RawDate;
  lastMessageAt?: RawDate;
  last_inbound_at?: RawDate;
  last_outbound_at?: RawDate;
  first_inbound_at?: RawDate;
  rename?: string | null;
  subject?: string | null;
  participants?: {
    from?: string[];
    to?: string[];
  };
  user?: {
    _id?: string;
    firstName?: string;
    lastName?: string;
    username?: string;
    avatar_url?: string;
  } | null;
  chat?: {
    _id?: string | number;
    type?: "private" | "group" | "supergroup" | "channel" | string;
    title?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
    sourceId?: string;
    businessConnectionId?: string;
    whatsapp?: {
      waId?: string | null;
      previousWaIds?: string[] | null;
    } | null;
  } | null;
  messages?: PopulatedMessage[];
  message_pagination?: {
    total?: number;
  };
  handled_by_agent?: {
    name: string;
    avatar_url: string | null;
  } | null;
  customerId?: string | { toString(): string } | null;
  customerLinkedAt?: RawDate;
  customerLinkedBy?: string | null;
  customerLinkMethod?:
    | "system"
    | "backfill"
    | "manual"
    | "suggested"
    | "rule"
    | null;
  customer?: {
    _id: string;
    displayName?: string | null;
    currentFunnelStage?: string | null;
    lastInteractionAt?: RawDate;
    profileSummary?: {
      channels?: string[];
      languages?: string[];
      tags?: string[];
      contactPoints?: {
        emails?: string[];
        phones?: string[];
        usernames?: string[];
      };
      conversationCount?: number;
    } | null;
    behavioralProfile?: {
      status?: string;
      summary?: string | null;
      communicationStyle?: string | null;
      decisionStyle?: string | null;
      motivations?: string[];
      objections?: string[];
      trustSignals?: string[];
      urgency?: string | null;
      responseCadence?: string | null;
      recommendedApproach?: string[];
      error?: string | null;
    } | null;
  } | null;
  customer_feature_flags?: {
    customer_identity?: boolean;
    customer_behavioral_profile?: boolean;
  } | null;
  airi_context_memory?: {
    summary?: string | null;
    currentGoal?: string | null;
    unresolvedNeeds?: string[];
    activeSelection?: {
      label?: string | null;
      quotedPriceText?: string | null;
    };
  } | null;
  airi_bot_enabled?: boolean;
  airi_scenarios_enabled?: boolean;
  airi_coach_enabled?: boolean;
  airi_enabled?: boolean;
  airi_handoff_active?: boolean;
  airi_handoff_started_at?: RawDate;
  airi_handoff_reason?: string | null;
  airi_last_suppressed_at?: RawDate;
  airi_last_suppressed_reason?:
    | "manager_recently_replied"
    | "tagged_manager_message"
    | "scenario_handoff"
    | null;
  airi_last_suppressed_manager_user_id?: string | null;
  airi_last_suppressed_message_id?: string | null;
  airi_scenario_state?: AiriScenarioState;
  agent_performance_scorecard?: AgentPerformanceScorecard | null;
  interaction_metrics?: InteractionMetrics | null;
  engagement_metrics?: {
    messageCount?: number;
    inboundCount?: number;
    outboundCount?: number;
  } | null;
  extracted_entities?: ExtractedEntity[];
  key_moments?: KeyMoment[];
  internal_labels?: string[];
  customer_satisfaction_score?: number | null;
  customer_satisfaction_comment?: string | null;
  page_url?: string | null;
  visitor_id?: string | null;
  last_bulk_sent_at?: RawDate;
  whatsapp_opt_in?: {
    status?: boolean | null;
    source?: string | null;
    updatedAt?: RawDate;
  } | null;
  whatsappReferral?: {
    sourceType?: string | null;
    sourceId?: string | null;
    sourceUrl?: string | null;
    campaignId?: string | null;
    campaignName?: string | null;
    adSetId?: string | null;
    adSetName?: string | null;
    headline?: string | null;
    body?: string | null;
    ctwaClid?: string | null;
    ref?: string | null;
    capturedAt?: RawDate;
  } | null;
  external_thread?: {
    provider?: "postmark" | "instagram" | string;
    type?: "comment" | string;
    threadId?: string;
    permalink?: string;
    comment?: {
      id?: string;
      likeCount?: number;
    } | null;
    media?: {
      username?: string;
    } | null;
  } | null;
  followUpAudience?: {
    recommendedRootScenarioName?: string | null;
    currentFollowUpScenarioName?: string | null;
  } | null;
};

type WaitingOn = "agent" | "customer" | "closed" | "unknown";
type AutomationStatus = "active" | "pending" | "completed" | "idle";

export type ConversationInfoViewModel = {
  summary: {
    summaryText: string | null;
    nextAction: string | null;
    priority: string | null;
    sentiment: string | null;
    classificationError: string | null;
    internalLabels: string[];
    airiMemory: NonNullable<
      ConversationInfoDetails["airi_context_memory"]
    > | null;
  };
  overview: {
    displayName: string;
    channel: string | null;
    ownerName: string | null;
    ownerAvatarUrl: string | null;
    createdAt: RawDate;
    lastActivityAt: RawDate;
    totalMessages: number;
    language: string | null;
    waitingOn: WaitingOn;
  };
  customer: {
    enabled: boolean;
    behavioralProfileEnabled: boolean;
    customer: ConversationInfoDetails["customer"];
    link: {
      customerId: string | null;
      linkedAt: RawDate;
      linkedBy: string | null;
      method: string | null;
    };
  };
  ai: {
    handoff: {
      active: boolean;
      reason: string | null;
    };
    suppression: {
      reason: string | null;
      suppressedAt: RawDate;
    };
    automation: {
      status: AutomationStatus;
      scenarioName: string | null;
      currentActionNodeId: string | null;
      pendingConditionNodeId: string | null;
      pendingStartedAt: RawDate;
      lastMatchedAt: RawDate;
      startedCount: number;
      completedCount: number;
    };
    agentPerformanceScorecard: AgentPerformanceScorecard | null;
    interactionMetrics: InteractionMetrics | null;
    engagementMetrics: ConversationInfoDetails["engagement_metrics"];
    extractedEntities: ExtractedEntity[];
    keyMoments: KeyMoment[];
    tags: string[];
  };
  source: {
    businessConnectionId: string | null;
    sourceId: string | null;
    chat: ConversationInfoDetails["chat"];
    subject: string | null;
    participants: ConversationInfoDetails["participants"];
    pageUrl: string | null;
    visitorId: string | null;
    firstInboundAt: RawDate;
    lastInboundAt: RawDate;
    lastOutboundAt: RawDate;
    lastBulkSentAt: RawDate;
    whatsappOptIn: ConversationInfoDetails["whatsapp_opt_in"];
    whatsappReferral: ConversationInfoDetails["whatsappReferral"];
    instagramThread: ConversationInfoDetails["external_thread"];
    followUpAudience: ConversationInfoDetails["followUpAudience"];
    csat: {
      score: number | null;
      comment: string | null;
    };
  };
};

export function toDate(value: unknown): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getLatestMessage(
  messages: PopulatedMessage[]
): PopulatedMessage | null {
  if (messages.length === 0) return null;

  return messages.reduce((latest, current) => {
    const latestTime = toDate(latest.date)?.getTime() ?? 0;
    const currentTime = toDate(current.date)?.getTime() ?? 0;
    return currentTime > latestTime ? current : latest;
  });
}

function getWaitingOn(
  status: string | undefined,
  latestMessage: PopulatedMessage | null
): WaitingOn {
  if ((status || "").toLowerCase() === "closed") return "closed";
  if (latestMessage?.direction === "inbound") return "agent";
  if (latestMessage?.direction === "outbound") return "customer";
  return "unknown";
}

function getAutomationStatus(
  scenarioState: AiriScenarioState
): AutomationStatus {
  if (
    scenarioState?.pendingConditionNodeId ||
    scenarioState?.pendingSourceActionNodeId
  ) {
    return "pending";
  }

  if (
    scenarioState?.lockedScenarioId ||
    scenarioState?.lockedScenarioName ||
    scenarioState?.currentActionNodeId
  ) {
    return "active";
  }

  if ((scenarioState?.completedScenarios?.length ?? 0) > 0) {
    return "completed";
  }

  return "idle";
}

function toId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const asString = String(value).trim();
  return asString || null;
}

export function buildConversationInfoViewModel({
  details,
  messages,
  messageTotal,
  unnamed,
}: {
  details: ConversationInfoDetails;
  messages?: PopulatedMessage[];
  messageTotal?: number;
  unnamed: UnnamedConversationLabels;
}): ConversationInfoViewModel {
  const timelineMessages = messages ?? details.messages ?? [];
  const latestMessage = getLatestMessage(timelineMessages);
  const totalMessages =
    messageTotal ??
    details.message_pagination?.total ??
    details.engagement_metrics?.messageCount ??
    timelineMessages.length;
  const lastActivityAt =
    details.lastMessageAt ||
    latestMessage?.date ||
    details.updatedAt ||
    details.createdAt;
  const classification = details.classification ?? {};
  const scenarioState = details.airi_scenario_state ?? null;

  return {
    summary: {
      summaryText: readNonEmptyString(classification.summary),
      nextAction: readNonEmptyString(classification.action),
      priority: readNonEmptyString(classification.priority),
      sentiment: readNonEmptyString(classification.sentiment),
      classificationError: readNonEmptyString(details.classification_error),
      internalLabels: Array.isArray(details.internal_labels)
        ? details.internal_labels.filter(Boolean)
        : [],
      airiMemory: details.airi_context_memory ?? null,
    },
    overview: {
      displayName: getConversationTitle(details, unnamed),
      channel: readNonEmptyString(details.channel),
      ownerName: readNonEmptyString(details.handled_by_agent?.name),
      ownerAvatarUrl: readNonEmptyString(details.handled_by_agent?.avatar_url),
      createdAt: details.createdAt ?? null,
      lastActivityAt,
      totalMessages,
      language: readNonEmptyString(details.preferred_language),
      waitingOn: getWaitingOn(details.status, latestMessage),
    },
    customer: {
      enabled: details.customer_feature_flags?.customer_identity !== false,
      behavioralProfileEnabled:
        details.customer_feature_flags?.customer_behavioral_profile !== false,
      customer: details.customer ?? null,
      link: {
        customerId: toId(details.customerId) || toId(details.customer?._id),
        linkedAt: details.customerLinkedAt ?? null,
        linkedBy: readNonEmptyString(details.customerLinkedBy),
        method: readNonEmptyString(details.customerLinkMethod),
      },
    },
    ai: {
      handoff: {
        active: details.airi_handoff_active === true,
        reason: readNonEmptyString(details.airi_handoff_reason),
      },
      suppression: {
        reason: readNonEmptyString(details.airi_last_suppressed_reason),
        suppressedAt: details.airi_last_suppressed_at ?? null,
      },
      automation: {
        status: getAutomationStatus(scenarioState),
        scenarioName: readNonEmptyString(scenarioState?.lockedScenarioName),
        currentActionNodeId: readNonEmptyString(
          scenarioState?.currentActionNodeId
        ),
        pendingConditionNodeId:
          readNonEmptyString(scenarioState?.pendingConditionNodeId) ||
          readNonEmptyString(scenarioState?.pendingSourceActionNodeId),
        pendingStartedAt: scenarioState?.pendingStartedAt ?? null,
        lastMatchedAt: scenarioState?.lastMatchedAt ?? null,
        startedCount: scenarioState?.startedScenarios?.length ?? 0,
        completedCount: scenarioState?.completedScenarios?.length ?? 0,
      },
      agentPerformanceScorecard: details.agent_performance_scorecard ?? null,
      interactionMetrics: details.interaction_metrics ?? null,
      engagementMetrics: details.engagement_metrics ?? null,
      extractedEntities: details.extracted_entities ?? [],
      keyMoments: details.key_moments ?? [],
      tags: classification.tags ?? [],
    },
    source: {
      businessConnectionId:
        readNonEmptyString(details.business_connection_id) ||
        readNonEmptyString(details.chat?.businessConnectionId),
      sourceId:
        readNonEmptyString(details.sourceId) ||
        readNonEmptyString(details.chat?.sourceId),
      chat: details.chat ?? null,
      subject: readNonEmptyString(details.subject),
      participants: details.participants,
      pageUrl: readNonEmptyString(details.page_url),
      visitorId: readNonEmptyString(details.visitor_id),
      firstInboundAt: details.first_inbound_at ?? null,
      lastInboundAt: details.last_inbound_at ?? null,
      lastOutboundAt: details.last_outbound_at ?? null,
      lastBulkSentAt: details.last_bulk_sent_at ?? null,
      whatsappOptIn: details.whatsapp_opt_in ?? null,
      whatsappReferral: details.whatsappReferral ?? null,
      instagramThread: details.external_thread ?? null,
      followUpAudience: details.followUpAudience ?? null,
      csat: {
        score:
          typeof details.customer_satisfaction_score === "number"
            ? details.customer_satisfaction_score
            : null,
        comment: readNonEmptyString(details.customer_satisfaction_comment),
      },
    },
  };
}
