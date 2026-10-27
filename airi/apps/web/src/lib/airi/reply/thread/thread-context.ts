import {
  THREAD_CONTEXT_CHAR_LIMIT,
  THREAD_MEMORY_SUMMARY_CHAR_LIMIT,
  truncateToCharBudget,
  truncateTranscriptToCharBudget,
} from "@/lib/airi/shared/token-budget";
import {
  isSubstantiveAgentReplyStructural,
  looksLikeShortEntityReferenceStructural,
  mightBeGenericResumeStructural,
  normalizeComparableText,
  shouldTrackThreadNeedStructural,
  stripAiriPrefix,
} from "@/lib/airi/reply/thread/reply-text-utils";
import { planGoalQuery } from "@/lib/airi/reply/thread/goal-query-planner";
import type {
  TurnFollowUpMode,
  TurnUnderstanding,
} from "@/lib/airi/reply/turn/understand-customer-turn";
import {
  canonicalLanguageCode,
  isSameLanguage,
} from "@/lib/airi/shared/language-utils";
import type { ReplyVisibleMessageTextSource } from "@/lib/media/message-media-utils";
import type { AiriActiveSelection } from "@/lib/airi/reply/selection";

export type ConversationQueryMode = "adaptive" | "last_message_only";

export type ThreadMessage = {
  id: string;
  text: string;
  direction: "inbound" | "outbound";
  date?: Date | string | null;
  source?: ReplyVisibleMessageTextSource;
};

export type AiriContextMemory = {
  version: number;
  summary: string | null;
  currentGoal: string | null;
  unresolvedNeeds: string[];
  resolvedNeeds: string[];
  preferredLanguage: string | null;
  coveredThroughMessageId: string | null;
  coveredMessageCount: number;
  lastGrounding?: {
    sourceKind: "snippet" | "kb" | "mixed" | "none";
    sourceIds: string[];
    intentAnchor: string | null;
    answeredAsks: string[];
    updatedAt?: Date | string | null;
  } | null;
  activeSelection?: AiriActiveSelection;
  updatedAt?: Date | string | null;
};

type ThreadNeed = {
  topic: string;
  normalized: string;
  resolved: boolean;
};

export type ThreadInsights = {
  currentGoal: string;
  unresolvedNeeds: string[];
  resolvedNeeds: string[];
  dominantLanguage: string;
  latestSubstantiveCustomerMessage: string;
  hasUnresolvedNeed: boolean;
};

export type ThreadReplyContext = {
  retrievalQuery: string;
  queryVariants: string[];
  lastMessageQuery: string;
  intentAnchor: string;
  activeGoals: string[];
  openAsks: string[];
  followUpMode: TurnFollowUpMode;
  followUpAnchor?: string;
  coverageHints?: string[];
  lastGrounding?: NonNullable<AiriContextMemory["lastGrounding"]> | null;
  activeSelection?: AiriActiveSelection;
  conversationContext: string;
  conversationWindow: string;
  threadMemorySummary: string;
  recentConversationTail: string;
  historyCompacted?: boolean;
  summaryCoveredThroughMessageId?: string | null;
  summaryCoveredMessageCount?: number;
  dominantLanguage: string;
  hasUnresolvedNeed: boolean;
  currentGoal: string;
  unresolvedNeeds: string[];
  resolvedNeeds: string[];
  turnUnderstanding?: TurnUnderstanding | null;
};

type BuildThreadInsightsParams = {
  messages: ThreadMessage[];
  memory?: AiriContextMemory | null;
  recentCustomerLanguage?: string | null;
  conversationPreferredLanguage?: string | null;
  workspaceLanguage?: string | null;
  latestInboundText?: string | null;
  turnUnderstanding?: TurnUnderstanding | null;
};

type BuildThreadReplyContextParams = BuildThreadInsightsParams & {
  mode?: ConversationQueryMode;
  includeHistoryInContext?: boolean;
  turnUnderstanding?: TurnUnderstanding | null;
  now?: Date;
};

/** A grounding this old no longer anchors follow-ups: the chat has moved on. */
export const LAST_GROUNDING_ANCHOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The last grounding while it is recent enough to anchor this turn. Stored
 * memory keeps it either way; only planning, the model's context and
 * retrieval pinning stop treating an old topic as the current one.
 */
export function readAnchorableLastGrounding(
  lastGrounding: AiriContextMemory["lastGrounding"],
  now: Date = new Date()
): NonNullable<AiriContextMemory["lastGrounding"]> | null {
  if (!lastGrounding?.updatedAt) return null;
  const updatedAt = new Date(lastGrounding.updatedAt).getTime();
  if (Number.isNaN(updatedAt)) return null;
  return now.getTime() - updatedAt <= LAST_GROUNDING_ANCHOR_MAX_AGE_MS
    ? lastGrounding
    : null;
}

function latestThreadMessageDate(messages: ThreadMessage[]): Date | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index]!.date;
    const date = value ? new Date(value) : null;
    if (date && !Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/** Untrimmed length of a window; compaction compares this, not the trimmed one. */
export function measureThreadWindow(
  context: Pick<
    ThreadReplyContext,
    "threadMemorySummary" | "recentConversationTail"
  >
): number {
  return [context.threadMemorySummary, context.recentConversationTail]
    .filter(Boolean)
    .join("\n\n").length;
}

/**
 * Fits memory and raw turns into the window; when they don't fit, the
 * oldest turns go first and memory keeps at most a third of the space.
 */
function joinThreadWindow(memoryBlock: string, recentWindow: string): string {
  const joined = [memoryBlock, recentWindow].filter(Boolean).join("\n\n");
  if (joined.length <= THREAD_CONTEXT_CHAR_LIMIT) return joined;
  const memoryReserve = memoryBlock
    ? Math.min(
        memoryBlock.length + 2,
        Math.floor(THREAD_CONTEXT_CHAR_LIMIT / 3)
      )
    : 0;
  const recent = truncateTranscriptToCharBudget(
    recentWindow,
    THREAD_CONTEXT_CHAR_LIMIT - memoryReserve
  );
  const memoryBudget = THREAD_CONTEXT_CHAR_LIMIT - recent.length - 2;
  const memory =
    memoryBlock && memoryBudget > 0
      ? truncateToCharBudget(memoryBlock, memoryBudget)
      : "";
  return [memory, recent].filter(Boolean).join("\n\n");
}

function normalizeThreadMessageText(text: string): string {
  return stripAiriPrefix(text).replace(/\s+/g, " ").trim();
}

function renderThreadMessage(message: ThreadMessage): string {
  const role = message.direction === "outbound" ? "AGENT" : "CUSTOMER";
  const timestamp =
    message.date instanceof Date
      ? message.date.toISOString()
      : typeof message.date === "string" && message.date
        ? new Date(message.date).toISOString()
        : "";
  return `${timestamp} [${role}] ${normalizeThreadMessageText(message.text)}`.trim();
}

function extractTopic(text: string): string {
  const normalized = normalizeThreadMessageText(text);
  if (normalized.length <= 110) return normalized;
  const firstSentenceEnd = normalized.search(/[.!?]\s/u);
  if (firstSentenceEnd > 0 && firstSentenceEnd < 110) {
    return normalized.slice(0, firstSentenceEnd + 1).trim();
  }
  return `${normalized.slice(0, 107).trim()}...`;
}

function dedupeTopics(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeComparableText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value.trim());
  }
  return result;
}

function shouldTrackInboundForNeeds(
  text: string,
  isLatest: boolean,
  turnUnderstanding?: TurnUnderstanding | null
): boolean {
  if (isLatest && turnUnderstanding?.threadScaffold) {
    return turnUnderstanding.threadScaffold.trackThreadNeed;
  }
  return shouldTrackThreadNeedStructural(text);
}

function isGenericResumeMessage(
  text: string,
  isLatest: boolean,
  turnUnderstanding?: TurnUnderstanding | null
): boolean {
  if (
    isLatest &&
    turnUnderstanding?.threadScaffold?.genericResumeContinuation
  ) {
    return true;
  }
  return mightBeGenericResumeStructural(text);
}

function buildNeeds(
  messages: ThreadMessage[],
  turnUnderstanding?: TurnUnderstanding | null
): ThreadNeed[] {
  const needs: ThreadNeed[] = [];
  const lastInboundIndex = messages.reduce(
    (last, m, i) => (m.direction === "inbound" ? i : last),
    -1
  );
  const substantiveInboundIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(entry => {
      if (entry.message.direction !== "inbound") return false;
      const isLatestInbound = entry.index === lastInboundIndex;
      return shouldTrackInboundForNeeds(
        entry.message.text,
        isLatestInbound,
        turnUnderstanding
      );
    });

  for (let i = 0; i < substantiveInboundIndexes.length; i += 1) {
    const { message, index } = substantiveInboundIndexes[i];
    const isLatestInbound = index === lastInboundIndex;
    const nextInboundIndex =
      substantiveInboundIndexes[i + 1]?.index ?? messages.length;
    const agentReplies = messages
      .slice(index + 1, nextInboundIndex)
      .filter(
        candidate =>
          candidate.direction === "outbound" &&
          normalizeThreadMessageText(candidate.text).length > 0
      );
    const resolved = agentReplies.some(reply => {
      const normalized = normalizeThreadMessageText(reply.text);
      if (!normalized) return false;
      return isSubstantiveAgentReplyStructural(normalized);
    });

    const previousNeed = needs[needs.length - 1];
    const topic =
      isGenericResumeMessage(
        message.text,
        isLatestInbound,
        turnUnderstanding
      ) && previousNeed
        ? previousNeed.topic
        : extractTopic(message.text);
    needs.push({
      topic,
      normalized: normalizeComparableText(topic),
      resolved,
    });
  }

  return needs.filter(need => Boolean(need.normalized));
}

function resolveDominantLanguage(params: BuildThreadInsightsParams): string {
  const recentCustomerLanguage = canonicalLanguageCode(
    params.recentCustomerLanguage
  );
  const conversationPreferredLanguage = canonicalLanguageCode(
    params.conversationPreferredLanguage
  );
  const workspaceLanguage = canonicalLanguageCode(params.workspaceLanguage);
  const storedMemoryLanguage = canonicalLanguageCode(
    params.memory?.preferredLanguage
  );

  if (recentCustomerLanguage) {
    return recentCustomerLanguage;
  }
  if (conversationPreferredLanguage) {
    return conversationPreferredLanguage;
  }
  if (
    storedMemoryLanguage &&
    (!recentCustomerLanguage ||
      isSameLanguage(storedMemoryLanguage, recentCustomerLanguage))
  ) {
    return storedMemoryLanguage;
  }
  if (workspaceLanguage) {
    return workspaceLanguage;
  }

  return "en";
}

function serializeMemoryComparableText(
  memory?: AiriContextMemory | null
): string {
  if (!memory) return "";
  return normalizeComparableText(
    [
      memory.summary || "",
      memory.currentGoal || "",
      memory.lastGrounding?.intentAnchor || "",
      memory.activeSelection?.label || "",
      memory.activeSelection?.quotedPriceText || "",
      ...(memory.lastGrounding?.answeredAsks || []),
      ...(memory.unresolvedNeeds || []),
      ...(memory.resolvedNeeds || []),
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function findRecentEntityReference(
  messages: ThreadMessage[],
  latestInboundText?: string | null
): string {
  const latestComparable = normalizeComparableText(latestInboundText || "");

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.direction !== "inbound") continue;

    const normalized = normalizeThreadMessageText(message.text);
    if (!normalized) continue;

    const comparable = normalizeComparableText(normalized);
    if (!comparable || comparable === latestComparable) continue;

    if (looksLikeShortEntityReferenceStructural(normalized)) {
      return normalized;
    }
  }

  return "";
}

function shouldUseStoredMemorySummary(params: {
  memory?: AiriContextMemory | null;
  messages: ThreadMessage[];
  insights: ThreadInsights;
  latestInboundText?: string | null;
}): boolean {
  const summary = params.memory?.summary?.trim();
  if (!summary) return false;
  if (
    params.memory?.preferredLanguage &&
    params.insights.dominantLanguage &&
    !isSameLanguage(
      params.memory.preferredLanguage,
      params.insights.dominantLanguage
    )
  ) {
    return false;
  }

  const hasRecentSubstantiveInbound = params.messages.some(
    message =>
      message.direction === "inbound" &&
      shouldTrackThreadNeedStructural(message.text)
  );
  if (!hasRecentSubstantiveInbound) return true;

  const memoryComparable = serializeMemoryComparableText(params.memory);
  const liveGoal = normalizeComparableText(params.insights.currentGoal);
  const storedGoal = normalizeComparableText(params.memory?.currentGoal || "");
  if (
    liveGoal &&
    storedGoal &&
    liveGoal !== storedGoal &&
    !liveGoal.includes(storedGoal) &&
    !storedGoal.includes(liveGoal)
  ) {
    return false;
  }

  const recentEntityReference = findRecentEntityReference(
    params.messages,
    params.latestInboundText
  );
  if (recentEntityReference) {
    const recentEntityComparable = normalizeComparableText(
      recentEntityReference
    );
    if (
      recentEntityComparable &&
      !memoryComparable.includes(recentEntityComparable)
    ) {
      return false;
    }
  }

  return true;
}

function buildMemoryBlock(params: {
  memory?: AiriContextMemory | null;
  lastGrounding: AiriContextMemory["lastGrounding"];
  insights: ThreadInsights;
  messages: ThreadMessage[];
  latestInboundText?: string | null;
}): string {
  const lines: string[] = [];
  if (
    shouldUseStoredMemorySummary({
      memory: params.memory,
      messages: params.messages,
      insights: params.insights,
      latestInboundText: params.latestInboundText,
    })
  ) {
    lines.push(
      `THREAD MEMORY SUMMARY:\n${truncateToCharBudget(
        params.memory?.summary || "",
        THREAD_MEMORY_SUMMARY_CHAR_LIMIT
      )}`
    );
  }
  if (params.lastGrounding?.intentAnchor) {
    lines.push(
      `Last grounded topic: ${truncateToCharBudget(
        params.lastGrounding.intentAnchor,
        180
      )}`
    );
  }
  if (params.memory?.activeSelection?.label) {
    const priceText = params.memory.activeSelection.quotedPriceText
      ? ` @ ${params.memory.activeSelection.quotedPriceText}`
      : "";
    lines.push(
      `Locked selection: ${truncateToCharBudget(
        `${params.memory.activeSelection.label}${priceText}`,
        180
      )}`
    );
  }
  if (params.insights.currentGoal) {
    lines.push(`Current goal: ${params.insights.currentGoal}`);
  }
  if (params.insights.unresolvedNeeds.length) {
    lines.push(`Open needs: ${params.insights.unresolvedNeeds.join("; ")}`);
  }
  if (params.insights.resolvedNeeds.length) {
    lines.push(
      `Already addressed: ${params.insights.resolvedNeeds.join("; ")}`
    );
  }
  return lines.join("\n");
}

export function renderThreadMessages(messages: ThreadMessage[]): string {
  return messages.map(renderThreadMessage).join("\n");
}

export function buildThreadInsights(
  params: BuildThreadInsightsParams
): ThreadInsights {
  const needs = buildNeeds(params.messages, params.turnUnderstanding);
  const unresolvedNeeds = dedupeTopics(
    needs.filter(need => !need.resolved).map(need => need.topic)
  );
  const resolvedNeeds = dedupeTopics(
    needs.filter(need => need.resolved).map(need => need.topic)
  ).filter(
    topic =>
      !unresolvedNeeds.some(
        unresolved =>
          normalizeComparableText(unresolved) === normalizeComparableText(topic)
      )
  );

  const lastInboundIndex = params.messages.reduce(
    (last, m, i) => (m.direction === "inbound" ? i : last),
    -1
  );
  let latestSubstantiveCustomerMessage = "";
  for (let i = params.messages.length - 1; i >= 0; i -= 1) {
    const message = params.messages[i];
    if (message.direction !== "inbound") continue;
    const isLatestInbound = i === lastInboundIndex;
    if (
      shouldTrackInboundForNeeds(
        message.text,
        isLatestInbound,
        params.turnUnderstanding
      )
    ) {
      latestSubstantiveCustomerMessage = message.text.trim();
      break;
    }
  }

  const currentGoal =
    unresolvedNeeds[unresolvedNeeds.length - 1] ||
    latestSubstantiveCustomerMessage ||
    params.memory?.currentGoal ||
    "";

  const latestInboundTrimmed = (params.latestInboundText || "").trim();
  const provisionalConversational =
    Boolean(latestInboundTrimmed) &&
    !shouldTrackThreadNeedStructural(latestInboundTrimmed);
  const hasUnresolvedNeed =
    unresolvedNeeds.length > 0 ||
    (Boolean(currentGoal) &&
      (Boolean(
        params.turnUnderstanding?.threadScaffold?.conversationalFollowup
      ) ||
        (!params.turnUnderstanding && provisionalConversational)));

  return {
    currentGoal,
    unresolvedNeeds,
    resolvedNeeds,
    dominantLanguage: resolveDominantLanguage(params),
    latestSubstantiveCustomerMessage,
    hasUnresolvedNeed,
  };
}

export function buildThreadReplyContext(
  params: BuildThreadReplyContextParams
): ThreadReplyContext {
  const mode = params.mode ?? "adaptive";
  const latestMessage = normalizeThreadMessageText(
    params.latestInboundText || ""
  );
  const insights = buildThreadInsights(params);
  // Measured from the latest turn, so replays and delayed turns age alike.
  const lastGrounding = readAnchorableLastGrounding(
    params.memory?.lastGrounding,
    params.now ?? latestThreadMessageDate(params.messages) ?? new Date()
  );
  const memoryBlock = buildMemoryBlock({
    memory: params.memory,
    lastGrounding,
    insights,
    messages: params.messages,
    latestInboundText: params.latestInboundText,
  });
  const recentWindow = renderThreadMessages(params.messages);
  const conversationWindow = joinThreadWindow(memoryBlock, recentWindow);
  const currentGoal = insights.currentGoal;
  const hasUnresolvedNeed = insights.hasUnresolvedNeed;
  const recentEntityReference = findRecentEntityReference(
    params.messages,
    params.latestInboundText
  );
  const goalQueryPlan = planGoalQuery({
    mode,
    latestMessage,
    currentGoal,
    unresolvedNeeds: insights.unresolvedNeeds,
    latestSubstantiveCustomerMessage: insights.latestSubstantiveCustomerMessage,
    recentEntityReference,
    lastGroundingAnchor: lastGrounding?.intentAnchor || null,
    turnUnderstanding: params.turnUnderstanding,
  });

  const conversationContext =
    params.includeHistoryInContext === false
      ? truncateToCharBudget(memoryBlock, THREAD_CONTEXT_CHAR_LIMIT)
      : conversationWindow;

  return {
    retrievalQuery: goalQueryPlan.retrievalQuery,
    queryVariants: goalQueryPlan.queryVariants,
    lastMessageQuery: latestMessage.slice(0, 400),
    intentAnchor: goalQueryPlan.intentAnchor,
    activeGoals: goalQueryPlan.activeGoals,
    openAsks: goalQueryPlan.openAsks,
    followUpMode: goalQueryPlan.followUpMode,
    followUpAnchor: goalQueryPlan.followUpAnchor,
    coverageHints: goalQueryPlan.coverageHints,
    lastGrounding,
    activeSelection: params.memory?.activeSelection || null,
    conversationContext,
    conversationWindow,
    threadMemorySummary: memoryBlock,
    recentConversationTail: recentWindow,
    historyCompacted: Boolean(params.memory?.summary),
    summaryCoveredThroughMessageId:
      params.memory?.coveredThroughMessageId || null,
    summaryCoveredMessageCount: params.memory?.coveredMessageCount || 0,
    dominantLanguage: insights.dominantLanguage,
    hasUnresolvedNeed,
    currentGoal,
    unresolvedNeeds: insights.unresolvedNeeds,
    resolvedNeeds: insights.resolvedNeeds,
    turnUnderstanding: params.turnUnderstanding || null,
  };
}
