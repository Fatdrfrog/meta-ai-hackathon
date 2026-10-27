import { chatCompletionWithFallback, getLightTextModel } from "@/lib/ai";
import { airiReplyLogger } from "@/lib/airi/reply/runtime/reply-logging";
import { shouldTrackThreadNeedStructural } from "@/lib/airi/reply/thread/reply-text-utils";
import {
  buildThreadInsights,
  buildThreadReplyContext,
  measureThreadWindow,
  renderThreadMessages,
  type AiriContextMemory,
  type ConversationQueryMode,
  type ThreadMessage,
  type ThreadReplyContext,
} from "@/lib/airi/reply/thread/thread-context";
import {
  applyAiriSelectionTransition,
  normalizeAiriActiveSelection,
  type AiriActiveSelection,
} from "@/lib/airi/reply/selection";
import {
  understandCustomerTurn,
  type ScenarioStepAnswerKind,
} from "@/lib/airi/reply/turn/understand-customer-turn";
import {
  getLanguageDisplayName,
  isSameLanguage,
} from "@/lib/airi/shared/language-utils";
import {
  MIN_THREAD_CONTEXT_RECENT_MESSAGES,
  THREAD_CONTEXT_CHAR_LIMIT,
  THREAD_MEMORY_SUMMARY_CHAR_LIMIT,
  truncateToCharBudget,
} from "@/lib/airi/shared/token-budget";
import {
  previewStringArray,
  previewText,
  traceableChain,
} from "@/lib/observability/tracing";
import { resolveReplyVisibleMessageText } from "@/lib/media/message-media-utils";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";

type LoadThreadReplyContextParams = {
  conversationId: string;
  latestInboundText?: string | null;
  quickReplyPayload?: string | null;
  /** Set when a scenario step asked and the customer answered by location or choice. */
  scenarioStepAnswer?: ScenarioStepAnswerKind | null;
  mode?: ConversationQueryMode;
  includeHistoryInContext?: boolean;
  conversationPreferredLanguage?: string | null;
  workspaceLanguage?: string | null;
};

type LeanConversationMemory = {
  preferred_language?: string | null;
  airi_last_customer_language?: string | null;
  airi_context_memory?: Partial<AiriContextMemory> | null;
} | null;

type LeanThreadMessage = {
  _id: unknown;
  text?: string | null;
  audioAnalysis?: string | null;
  videoAnalysis?: string | null;
  mediaType?: string | null;
  direction?: string | null;
  date?: Date | string | null;
};

const THREAD_MESSAGE_SELECT =
  "_id text audioAnalysis videoAnalysis mediaType direction date";

function normalizeLastGrounding(
  value:
    | Partial<NonNullable<AiriContextMemory["lastGrounding"]>>
    | null
    | undefined
): NonNullable<AiriContextMemory["lastGrounding"]> | null {
  if (!value) return null;

  const sourceKind =
    value.sourceKind === "snippet" ||
    value.sourceKind === "kb" ||
    value.sourceKind === "mixed" ||
    value.sourceKind === "none"
      ? value.sourceKind
      : "none";

  return {
    sourceKind,
    sourceIds: Array.isArray(value.sourceIds)
      ? value.sourceIds
          .map(item => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 8)
      : [],
    intentAnchor:
      typeof value.intentAnchor === "string" && value.intentAnchor.trim()
        ? value.intentAnchor.trim()
        : null,
    answeredAsks: Array.isArray(value.answeredAsks)
      ? value.answeredAsks
          .map(item => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 6)
      : [],
    updatedAt: value.updatedAt || null,
  };
}

function selectionsEqual(
  left?: AiriActiveSelection,
  right?: AiriActiveSelection
): boolean {
  const normalizedLeft = normalizeAiriActiveSelection(left);
  const normalizedRight = normalizeAiriActiveSelection(right);
  if (!normalizedLeft && !normalizedRight) return true;
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft.kind === normalizedRight.kind &&
    normalizedLeft.normalizedLabel === normalizedRight.normalizedLabel &&
    normalizedLeft.quotedPriceText === normalizedRight.quotedPriceText &&
    normalizedLeft.quotedPriceAmount === normalizedRight.quotedPriceAmount &&
    normalizedLeft.quotedPriceCurrency ===
      normalizedRight.quotedPriceCurrency &&
    normalizedLeft.sourceKind === normalizedRight.sourceKind &&
    JSON.stringify(normalizedLeft.sourceIds) ===
      JSON.stringify(normalizedRight.sourceIds)
  );
}

function normalizeMemory(
  memory?: Partial<AiriContextMemory> | null
): AiriContextMemory | null {
  if (!memory) return null;
  const summary =
    typeof memory.summary === "string" ? memory.summary.trim() : "";
  const currentGoal =
    typeof memory.currentGoal === "string" ? memory.currentGoal.trim() : "";
  const unresolvedNeeds = Array.isArray(memory.unresolvedNeeds)
    ? memory.unresolvedNeeds
        .map(value => String(value || "").trim())
        .filter(shouldTrackThreadNeedStructural)
    : [];
  const resolvedNeeds = Array.isArray(memory.resolvedNeeds)
    ? memory.resolvedNeeds
        .map(value => String(value || "").trim())
        .filter(shouldTrackThreadNeedStructural)
    : [];

  return {
    version: typeof memory.version === "number" ? memory.version : 1,
    summary: summary || null,
    currentGoal:
      (shouldTrackThreadNeedStructural(currentGoal) ? currentGoal : "") ||
      unresolvedNeeds[unresolvedNeeds.length - 1] ||
      null,
    unresolvedNeeds,
    resolvedNeeds,
    preferredLanguage:
      typeof memory.preferredLanguage === "string" &&
      memory.preferredLanguage.trim()
        ? memory.preferredLanguage.trim()
        : null,
    coveredThroughMessageId:
      typeof memory.coveredThroughMessageId === "string" &&
      memory.coveredThroughMessageId.trim()
        ? memory.coveredThroughMessageId.trim()
        : null,
    coveredMessageCount:
      typeof memory.coveredMessageCount === "number"
        ? Math.max(0, memory.coveredMessageCount)
        : 0,
    lastGrounding: normalizeLastGrounding(memory.lastGrounding),
    activeSelection: normalizeAiriActiveSelection(memory.activeSelection),
    updatedAt: memory.updatedAt || null,
  };
}

function clearStoredSummary(
  memory: AiriContextMemory | null
): AiriContextMemory | null {
  if (!memory?.summary) {
    return memory;
  }

  return {
    ...memory,
    summary: null,
    coveredThroughMessageId: null,
    coveredMessageCount: 0,
  };
}

function mapMessages(rawMessages: LeanThreadMessage[]): ThreadMessage[] {
  return rawMessages
    .map(message => {
      const resolvedText = resolveReplyVisibleMessageText(message);
      return {
        id: String(message._id),
        text: resolvedText.text,
        source: resolvedText.source,
        direction:
          message.direction === "outbound"
            ? ("outbound" as const)
            : ("inbound" as const),
        date: message.date || null,
      };
    })
    .filter(message => message.text.trim().length > 0);
}

function normalizeMessageDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof String
  ) {
    const parsed = new Date(value.valueOf());
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

async function loadAllThreadMessageDocs(
  conversationId: string
): Promise<LeanThreadMessage[]> {
  return Message.find({ conversation: conversationId })
    .sort({ date: 1 })
    .select(THREAD_MESSAGE_SELECT)
    .lean<LeanThreadMessage[]>();
}

async function loadThreadMessageDocsAfterMemoryCursor(params: {
  conversationId: string;
  memory: AiriContextMemory | null;
}): Promise<LeanThreadMessage[] | null> {
  const coveredThroughMessageId =
    typeof params.memory?.coveredThroughMessageId === "string"
      ? params.memory.coveredThroughMessageId.trim()
      : "";
  if (!params.memory?.summary || !coveredThroughMessageId) {
    return null;
  }

  const cursorMessage = await Message.findById(coveredThroughMessageId)
    .select("date")
    .lean<{ _id: unknown; date?: Date | string | null } | null>();
  const cursorDate = normalizeMessageDate(cursorMessage?.date);
  if (!cursorDate) {
    return null;
  }

  const candidateDocs = await Message.find({
    conversation: params.conversationId,
    date: { $gte: cursorDate },
  })
    .sort({ date: 1, _id: 1 })
    .select(THREAD_MESSAGE_SELECT)
    .lean<LeanThreadMessage[]>();
  const cursorIndex = candidateDocs.findIndex(
    message => String(message._id) === coveredThroughMessageId
  );

  return cursorIndex >= 0 ? candidateDocs.slice(cursorIndex + 1) : null;
}

async function loadThreadMessageDocs(params: {
  conversationId: string;
  memory: AiriContextMemory | null;
}): Promise<{
  docs: LeanThreadMessage[];
  loadedAfterMemoryCursor: boolean;
}> {
  const docsAfterCursor = await loadThreadMessageDocsAfterMemoryCursor(params);
  if (docsAfterCursor) {
    return {
      docs: docsAfterCursor,
      loadedAfterMemoryCursor: true,
    };
  }

  return {
    docs: await loadAllThreadMessageDocs(params.conversationId),
    loadedAfterMemoryCursor: false,
  };
}

function buildFallbackMemorySummary(params: {
  currentGoal: string;
  unresolvedNeeds: string[];
  resolvedNeeds: string[];
}): string {
  const lines: string[] = [];
  if (params.currentGoal) {
    lines.push(`Current goal: ${params.currentGoal}`);
  }
  if (params.unresolvedNeeds.length > 0) {
    lines.push(`Open needs: ${params.unresolvedNeeds.join("; ")}`);
  }
  if (params.resolvedNeeds.length > 0) {
    lines.push(`Already addressed: ${params.resolvedNeeds.join("; ")}`);
  }

  if (lines.length === 0) {
    lines.push("Earlier conversation context retained for continuity.");
  }

  return truncateToCharBudget(
    lines.join("\n"),
    THREAD_MEMORY_SUMMARY_CHAR_LIMIT
  );
}

async function summarizeOlderThreadSegment(params: {
  existingMemory: AiriContextMemory | null;
  deltaMessages: ThreadMessage[];
  preferredLanguage: string;
  fallbackSummary: string;
}): Promise<string> {
  const olderConversationBlock = renderThreadMessages(params.deltaMessages);
  if (!olderConversationBlock.trim()) {
    return params.existingMemory?.summary || params.fallbackSummary;
  }

  const existingMemoryBlock = params.existingMemory?.summary
    ? `Existing memory summary:\n${params.existingMemory.summary}`
    : "";
  const languageName = getLanguageDisplayName(params.preferredLanguage || "en");

  try {
    const response = await chatCompletionWithFallback({
      model: getLightTextModel(),
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: [
            `Summarize older customer support conversation history in ${languageName}.`,
            "Preserve the customer's current goal, unresolved requests, and any already provided factual answers.",
            "Be concise, factual, and continuity-oriented.",
            "Do not invent details.",
            "Return plain text only.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            existingMemoryBlock,
            `Older conversation to fold into memory:\n${truncateToCharBudget(olderConversationBlock, 12000)}`,
            "Task: rewrite the thread memory summary so it can be prepended before newer raw messages in future assistant replies.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    });

    const summary = truncateToCharBudget(
      String(response.content || "").trim(),
      THREAD_MEMORY_SUMMARY_CHAR_LIMIT
    );
    return summary || params.fallbackSummary;
  } catch {
    return params.fallbackSummary;
  }
}

async function persistThreadMemory(
  conversationId: string,
  memory: AiriContextMemory
): Promise<void> {
  await Conversation.updateOne(
    { _id: conversationId },
    {
      $set: {
        airi_context_memory: {
          ...memory,
          updatedAt: new Date(),
        },
      },
    }
  );
}

function persistThreadMemoryInBackground(params: {
  conversationId: string;
  memory: AiriContextMemory;
  failureNote: string;
}): void {
  void persistThreadMemory(params.conversationId, params.memory).catch(
    error => {
      airiReplyLogger.warn("airi.reply.thread_memory", {
        conversationId: params.conversationId,
        note: params.failureNote,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  );
}

function refreshThreadMemorySummaryInBackground(params: {
  conversationId: string;
  existingMemory: AiriContextMemory | null;
  initialMemory: AiriContextMemory;
  deltaMessages: ThreadMessage[];
  preferredLanguage: string;
  fallbackSummary: string;
  currentGoal: string;
  unresolvedNeeds: string[];
  resolvedNeeds: string[];
  coveredMessages: ThreadMessage[];
  activeSelection?: AiriActiveSelection;
}): void {
  persistThreadMemoryInBackground({
    conversationId: params.conversationId,
    memory: params.initialMemory,
    failureNote: "persist_thread_memory_failed",
  });

  if (params.deltaMessages.length === 0) {
    return;
  }

  void (async () => {
    const summary = await summarizeOlderThreadSegment({
      existingMemory: params.existingMemory,
      deltaMessages: params.deltaMessages,
      preferredLanguage: params.preferredLanguage,
      fallbackSummary: params.fallbackSummary,
    });

    if (!summary || summary === params.initialMemory.summary) {
      return;
    }

    const refreshedMemory = buildPersistedThreadMemory({
      existingMemory: params.existingMemory,
      summary,
      currentGoal: params.currentGoal,
      unresolvedNeeds: params.unresolvedNeeds,
      resolvedNeeds: params.resolvedNeeds,
      preferredLanguage: params.preferredLanguage,
      coveredMessages: params.coveredMessages,
      activeSelection:
        normalizeAiriActiveSelection(params.activeSelection) ||
        params.initialMemory.activeSelection ||
        null,
    });

    await persistThreadMemory(params.conversationId, refreshedMemory);
  })().catch(error => {
    airiReplyLogger.warn("airi.reply.thread_memory", {
      conversationId: params.conversationId,
      note: "refresh_thread_memory_summary_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  });
}

function hasTopicDrift(previousTopic: string, nextTopic: string): boolean {
  if (!previousTopic || !nextTopic) return false;
  const previousNormalized = previousTopic.trim().toLowerCase();
  const nextNormalized = nextTopic.trim().toLowerCase();
  if (!previousNormalized || !nextNormalized) return false;
  return (
    previousNormalized !== nextNormalized &&
    !previousNormalized.includes(nextNormalized) &&
    !nextNormalized.includes(previousNormalized)
  );
}

function shouldRefreshStoredMemory(params: {
  existingMemory: AiriContextMemory;
  retainedMessages: ThreadMessage[];
  existingContext: ThreadReplyContext;
}): boolean {
  if (params.retainedMessages.length === 0) return false;

  const substantiveInboundCount = params.retainedMessages.filter(
    message => message.direction === "inbound" && message.text.trim().length > 0
  ).length;

  if (substantiveInboundCount >= 2) {
    return true;
  }

  if (
    params.retainedMessages.length >=
    MIN_THREAD_CONTEXT_RECENT_MESSAGES + 2
  ) {
    return true;
  }

  const liveAnchor =
    params.existingContext.followUpAnchor ||
    params.existingContext.intentAnchor ||
    params.existingContext.activeGoals[0] ||
    "";
  const storedAnchor =
    params.existingMemory.lastGrounding?.intentAnchor ||
    params.existingMemory.currentGoal ||
    "";

  if (hasTopicDrift(storedAnchor, liveAnchor)) {
    return true;
  }

  const liveGoal =
    params.existingContext.currentGoal ||
    params.existingContext.activeGoals[0] ||
    "";
  if (hasTopicDrift(params.existingMemory.currentGoal || "", liveGoal)) {
    return true;
  }

  return false;
}

function buildPersistedThreadMemory(params: {
  existingMemory: AiriContextMemory | null;
  summary: string;
  currentGoal: string;
  unresolvedNeeds: string[];
  resolvedNeeds: string[];
  preferredLanguage: string;
  coveredMessages: ThreadMessage[];
  activeSelection?: AiriActiveSelection;
}): AiriContextMemory {
  const explicitSelectionProvided = Object.prototype.hasOwnProperty.call(
    params,
    "activeSelection"
  );
  const normalizedActiveSelection = normalizeAiriActiveSelection(
    params.activeSelection
  );

  return {
    version: 2,
    summary: params.summary,
    currentGoal: params.currentGoal || null,
    unresolvedNeeds: params.unresolvedNeeds.slice(-5),
    resolvedNeeds: params.resolvedNeeds.slice(-5),
    preferredLanguage: params.preferredLanguage,
    coveredThroughMessageId:
      params.coveredMessages[params.coveredMessages.length - 1]?.id || null,
    coveredMessageCount: params.coveredMessages.length,
    lastGrounding: params.existingMemory?.lastGrounding || null,
    activeSelection: explicitSelectionProvided
      ? normalizedActiveSelection
      : params.existingMemory?.activeSelection || null,
    updatedAt: new Date(),
  };
}

function applySelectionTransitionToMemory(params: {
  memory: AiriContextMemory | null;
  turnUnderstanding?: ThreadReplyContext["turnUnderstanding"] | null;
  messages: ThreadMessage[];
  quickReplyPayload?: string | null;
}): AiriContextMemory | null {
  const resolvedSelection = applyAiriSelectionTransition({
    transition: params.turnUnderstanding?.selectionTransition,
    existingSelection: params.memory?.activeSelection || null,
    lastGrounding: params.memory?.lastGrounding,
    messages: params.messages,
    quickReplyPayload: params.quickReplyPayload,
  });

  if (!params.memory) {
    if (!resolvedSelection) return null;
    return {
      version: 2,
      summary: null,
      currentGoal: null,
      unresolvedNeeds: [],
      resolvedNeeds: [],
      preferredLanguage: null,
      coveredThroughMessageId: null,
      coveredMessageCount: 0,
      lastGrounding: null,
      activeSelection: resolvedSelection,
      updatedAt: new Date(),
    };
  }

  if (selectionsEqual(params.memory.activeSelection, resolvedSelection)) {
    return params.memory;
  }

  return {
    ...params.memory,
    version: Math.max(2, params.memory.version || 1),
    activeSelection: resolvedSelection,
    updatedAt: new Date(),
  };
}

function persistMemoryIfChangedInBackground(params: {
  conversationId: string;
  existingMemory: AiriContextMemory | null;
  nextMemory: AiriContextMemory | null;
  failureNote: string;
}): void {
  if (!params.nextMemory) return;
  const changed =
    !params.existingMemory ||
    !selectionsEqual(
      params.existingMemory.activeSelection,
      params.nextMemory.activeSelection
    ) ||
    params.existingMemory.summary !== params.nextMemory.summary ||
    params.existingMemory.currentGoal !== params.nextMemory.currentGoal ||
    params.existingMemory.coveredMessageCount !==
      params.nextMemory.coveredMessageCount;

  if (!changed) return;

  persistThreadMemoryInBackground({
    conversationId: params.conversationId,
    memory: params.nextMemory,
    failureNote: params.failureNote,
  });
}

function withFullRawWindow(
  context: ThreadReplyContext,
  fullRawWindow: string,
  includeHistoryInContext?: boolean
): ThreadReplyContext {
  const conversationContext =
    includeHistoryInContext === false
      ? context.threadMemorySummary
      : fullRawWindow;

  return {
    ...context,
    conversationWindow: fullRawWindow,
    recentConversationTail: fullRawWindow,
    conversationContext,
    historyCompacted: false,
    summaryCoveredThroughMessageId:
      context.summaryCoveredThroughMessageId || null,
    summaryCoveredMessageCount: context.summaryCoveredMessageCount || 0,
  };
}

type CompactionCandidate = {
  retainedMessages: ThreadMessage[];
  coveredMessages: ThreadMessage[];
  memory: AiriContextMemory;
  insights: ReturnType<typeof buildThreadInsights>;
  fallbackSummary: string;
};

function resolveCompactionCandidate(params: {
  messages: ThreadMessage[];
  existingMemory: AiriContextMemory | null;
  recentCustomerLanguage?: string | null;
  conversationPreferredLanguage?: string | null;
  workspaceLanguage?: string | null;
  latestInboundText?: string | null;
  mode?: ConversationQueryMode;
  includeHistoryInContext?: boolean;
}): CompactionCandidate {
  // Start at the longest raw suffix that fits alone; memory then moves the
  // start later until both fit, keeping as many latest turns as possible.
  let firstStart = params.messages.length;
  let suffixChars = 0;
  for (let index = params.messages.length - 1; index >= 1; index -= 1) {
    suffixChars += renderThreadMessages([params.messages[index]!]).length + 1;
    if (suffixChars > THREAD_CONTEXT_CHAR_LIMIT) break;
    firstStart = index;
  }
  for (let start = firstStart; start < params.messages.length; start += 1) {
    const coveredMessages = params.messages.slice(0, start);
    const retainedMessages = params.messages.slice(start);
    const insights = buildThreadInsights({
      messages: coveredMessages,
      memory: params.existingMemory,
      recentCustomerLanguage: params.recentCustomerLanguage,
      conversationPreferredLanguage: params.conversationPreferredLanguage,
      workspaceLanguage: params.workspaceLanguage,
      latestInboundText: params.latestInboundText,
    });
    const fallbackSummary = buildFallbackMemorySummary({
      currentGoal: insights.currentGoal,
      unresolvedNeeds: insights.unresolvedNeeds.slice(-4),
      resolvedNeeds: insights.resolvedNeeds.slice(-4),
    });
    const memoryWithSelection = buildPersistedThreadMemory({
      existingMemory: params.existingMemory,
      summary: fallbackSummary,
      currentGoal: insights.currentGoal,
      unresolvedNeeds: insights.unresolvedNeeds,
      resolvedNeeds: insights.resolvedNeeds,
      preferredLanguage: insights.dominantLanguage,
      coveredMessages,
      activeSelection: params.existingMemory?.activeSelection || null,
    });
    const candidateContext = buildThreadReplyContext({
      messages: retainedMessages,
      memory: memoryWithSelection,
      recentCustomerLanguage: params.recentCustomerLanguage,
      conversationPreferredLanguage: params.conversationPreferredLanguage,
      workspaceLanguage: params.workspaceLanguage,
      latestInboundText: params.latestInboundText,
      mode: params.mode,
      includeHistoryInContext: params.includeHistoryInContext,
    });

    if (measureThreadWindow(candidateContext) <= THREAD_CONTEXT_CHAR_LIMIT) {
      return {
        retainedMessages,
        coveredMessages,
        memory: memoryWithSelection,
        insights,
        fallbackSummary,
      };
    }
  }

  const coveredMessages = params.messages.slice(
    0,
    Math.max(0, params.messages.length - MIN_THREAD_CONTEXT_RECENT_MESSAGES)
  );
  const retainedMessages =
    coveredMessages.length < params.messages.length
      ? params.messages.slice(coveredMessages.length)
      : params.messages.slice(-1);
  const insights = buildThreadInsights({
    messages: coveredMessages,
    memory: params.existingMemory,
    recentCustomerLanguage: params.recentCustomerLanguage,
    conversationPreferredLanguage: params.conversationPreferredLanguage,
    workspaceLanguage: params.workspaceLanguage,
    latestInboundText: params.latestInboundText,
  });
  const fallbackSummary = buildFallbackMemorySummary({
    currentGoal: insights.currentGoal,
    unresolvedNeeds: insights.unresolvedNeeds.slice(-4),
    resolvedNeeds: insights.resolvedNeeds.slice(-4),
  });

  return {
    retainedMessages,
    coveredMessages,
    memory: buildPersistedThreadMemory({
      existingMemory: params.existingMemory,
      summary: fallbackSummary,
      currentGoal: insights.currentGoal,
      unresolvedNeeds: insights.unresolvedNeeds,
      resolvedNeeds: insights.resolvedNeeds,
      preferredLanguage: insights.dominantLanguage,
      coveredMessages,
      activeSelection: params.existingMemory?.activeSelection || null,
    }),
    insights,
    fallbackSummary,
  };
}

/** The agent's message the latest customer turn answers, if one precedes it. */
function findStepQuestion(messages: ThreadMessage[]): string {
  let index = messages.length - 1;
  while (index >= 0 && messages[index]!.direction !== "inbound") index -= 1;
  for (index -= 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.direction === "outbound" && message.text.trim())
      return message.text.trim();
  }
  return "";
}

async function buildThreadReplyContextWithTurnUnderstanding(params: {
  messages: ThreadMessage[];
  memory?: AiriContextMemory | null;
  recentCustomerLanguage?: string | null;
  conversationPreferredLanguage?: string | null;
  workspaceLanguage?: string | null;
  latestInboundText?: string | null;
  quickReplyPayload?: string | null;
  mode?: ConversationQueryMode;
  includeHistoryInContext?: boolean;
  turnUnderstandingWindow?: string;
  scenarioStepAnswer?: ScenarioStepAnswerKind | null;
}): Promise<{
  context: ThreadReplyContext;
  memory: AiriContextMemory | null;
}> {
  const provisionalContext = buildThreadReplyContext(params);
  const stepQuestion = params.scenarioStepAnswer
    ? findStepQuestion(params.messages)
    : "";
  const latestInboundText =
    typeof params.latestInboundText === "string"
      ? params.latestInboundText.trim()
      : "";

  if (!latestInboundText) {
    return {
      context: provisionalContext,
      memory: params.memory || null,
    };
  }

  try {
    const turnUnderstanding = await understandCustomerTurn(
      latestInboundText,
      provisionalContext.dominantLanguage,
      params.turnUnderstandingWindow ||
        provisionalContext.conversationWindow ||
        undefined,
      {
        intentAnchor: provisionalContext.intentAnchor,
        hasUnresolvedNeed: provisionalContext.hasUnresolvedNeed,
        currentGoal: provisionalContext.currentGoal,
        unresolvedNeeds: provisionalContext.unresolvedNeeds,
        lastGrounding: provisionalContext.lastGrounding,
        activeSelection: provisionalContext.activeSelection,
        quickReplyPayload: params.quickReplyPayload,
        scenarioStepAnswer:
          params.scenarioStepAnswer && stepQuestion
            ? { kind: params.scenarioStepAnswer, question: stepQuestion }
            : null,
      }
    );

    const memoryWithSelection = applySelectionTransitionToMemory({
      memory: params.memory || null,
      turnUnderstanding,
      messages: params.messages,
      quickReplyPayload: params.quickReplyPayload,
    });
    const context = buildThreadReplyContext({
      ...params,
      memory: memoryWithSelection,
      turnUnderstanding,
    });
    return {
      context,
      memory: memoryWithSelection,
    };
  } catch {
    return {
      context: provisionalContext,
      memory: params.memory || null,
    };
  }
}

async function loadThreadReplyContextImpl(
  params: LoadThreadReplyContextParams
): Promise<ThreadReplyContext> {
  const conversationDoc = await Conversation.findById(params.conversationId)
    .select(
      "preferred_language airi_last_customer_language airi_context_memory"
    )
    .lean<LeanConversationMemory>();
  const existingMemory = normalizeMemory(conversationDoc?.airi_context_memory);
  const recentCustomerLanguage =
    conversationDoc?.airi_last_customer_language || null;
  const conversationPreferredLanguage =
    params.conversationPreferredLanguage ||
    conversationDoc?.preferred_language ||
    null;
  const messageLoad = await loadThreadMessageDocs({
    conversationId: params.conversationId,
    memory: existingMemory,
  });
  let messages = mapMessages(messageLoad.docs);

  if (messages.length === 0) {
    const emptyResult = await buildThreadReplyContextWithTurnUnderstanding({
      messages: [],
      memory: existingMemory,
      recentCustomerLanguage,
      conversationPreferredLanguage,
      workspaceLanguage: params.workspaceLanguage,
      latestInboundText: params.latestInboundText,
      mode: params.mode,
      includeHistoryInContext: params.includeHistoryInContext,
      quickReplyPayload: params.quickReplyPayload,
      scenarioStepAnswer: params.scenarioStepAnswer,
    });
    persistMemoryIfChangedInBackground({
      conversationId: params.conversationId,
      existingMemory,
      nextMemory: emptyResult.memory,
      failureNote: "persist_active_selection_failed",
    });
    return emptyResult.context;
  }

  if (messageLoad.loadedAfterMemoryCursor && existingMemory?.summary) {
    const retainedMessages = messages;
    const existingContext = buildThreadReplyContext({
      messages: retainedMessages,
      memory: existingMemory,
      recentCustomerLanguage,
      conversationPreferredLanguage,
      workspaceLanguage: params.workspaceLanguage,
      latestInboundText: params.latestInboundText,
      mode: params.mode,
      includeHistoryInContext: params.includeHistoryInContext,
    });
    const hasStaleMemoryLanguage =
      Boolean(existingMemory.preferredLanguage) &&
      Boolean(existingContext.dominantLanguage) &&
      !isSameLanguage(
        existingMemory.preferredLanguage || "",
        existingContext.dominantLanguage
      );
    const shouldRefresh = shouldRefreshStoredMemory({
      existingMemory,
      retainedMessages,
      existingContext,
    });

    if (
      !hasStaleMemoryLanguage &&
      !shouldRefresh &&
      measureThreadWindow(existingContext) <= THREAD_CONTEXT_CHAR_LIMIT
    ) {
      const retainedResult = await buildThreadReplyContextWithTurnUnderstanding(
        {
          messages: retainedMessages,
          memory: existingMemory,
          recentCustomerLanguage,
          conversationPreferredLanguage,
          workspaceLanguage: params.workspaceLanguage,
          latestInboundText: params.latestInboundText,
          mode: params.mode,
          includeHistoryInContext: params.includeHistoryInContext,
          quickReplyPayload: params.quickReplyPayload,
          scenarioStepAnswer: params.scenarioStepAnswer,
        }
      );
      persistMemoryIfChangedInBackground({
        conversationId: params.conversationId,
        existingMemory,
        nextMemory: retainedResult.memory,
        failureNote: "persist_active_selection_failed",
      });
      return retainedResult.context;
    }

    messages = mapMessages(
      await loadAllThreadMessageDocs(params.conversationId)
    );
  }

  const fullRawWindow = renderThreadMessages(messages);
  if (fullRawWindow.length <= THREAD_CONTEXT_CHAR_LIMIT) {
    const liveMemory = clearStoredSummary(existingMemory);
    const fullResult = await buildThreadReplyContextWithTurnUnderstanding({
      messages,
      memory: liveMemory,
      recentCustomerLanguage,
      conversationPreferredLanguage,
      workspaceLanguage: params.workspaceLanguage,
      latestInboundText: params.latestInboundText,
      mode: params.mode,
      includeHistoryInContext: params.includeHistoryInContext,
      quickReplyPayload: params.quickReplyPayload,
      scenarioStepAnswer: params.scenarioStepAnswer,
      turnUnderstandingWindow: fullRawWindow,
    });
    const fullContext = fullResult.context;
    const substantiveInboundCount = messages.filter(
      message =>
        message.direction === "inbound" && message.text.trim().length > 0
    ).length;
    const shouldRefreshCompactMemory =
      existingMemory && existingMemory.summary
        ? shouldRefreshStoredMemory({
            existingMemory,
            retainedMessages: messages.slice(
              existingMemory.coveredMessageCount
            ),
            existingContext: fullContext,
          })
        : false;

    if (
      substantiveInboundCount >= MIN_THREAD_CONTEXT_RECENT_MESSAGES ||
      shouldRefreshCompactMemory
    ) {
      const fallbackSummary = buildFallbackMemorySummary({
        currentGoal: fullContext.currentGoal,
        unresolvedNeeds: fullContext.unresolvedNeeds.slice(-4),
        resolvedNeeds: fullContext.resolvedNeeds.slice(-4),
      });
      const refreshedMemory = buildPersistedThreadMemory({
        existingMemory: fullResult.memory,
        summary: fallbackSummary,
        currentGoal: fullContext.currentGoal,
        unresolvedNeeds: fullContext.unresolvedNeeds,
        resolvedNeeds: fullContext.resolvedNeeds,
        preferredLanguage: fullContext.dominantLanguage,
        coveredMessages: messages,
        activeSelection: fullContext.activeSelection,
      });

      persistThreadMemoryInBackground({
        conversationId: params.conversationId,
        memory: refreshedMemory,
        failureNote: "refresh_compact_memory_failed",
      });
    } else {
      persistMemoryIfChangedInBackground({
        conversationId: params.conversationId,
        existingMemory,
        nextMemory: fullResult.memory,
        failureNote: "persist_active_selection_failed",
      });
    }

    return withFullRawWindow(
      fullContext,
      fullRawWindow,
      params.includeHistoryInContext
    );
  }

  if (existingMemory?.summary && existingMemory.coveredMessageCount > 0) {
    const retainedMessages = messages.slice(existingMemory.coveredMessageCount);
    const existingContext = buildThreadReplyContext({
      messages: retainedMessages,
      memory: existingMemory,
      recentCustomerLanguage,
      conversationPreferredLanguage,
      workspaceLanguage: params.workspaceLanguage,
      latestInboundText: params.latestInboundText,
      mode: params.mode,
      includeHistoryInContext: params.includeHistoryInContext,
    });
    const hasStaleMemoryLanguage =
      Boolean(existingMemory.preferredLanguage) &&
      Boolean(existingContext.dominantLanguage) &&
      !isSameLanguage(
        existingMemory.preferredLanguage || "",
        existingContext.dominantLanguage
      );
    const shouldRefresh = shouldRefreshStoredMemory({
      existingMemory,
      retainedMessages,
      existingContext,
    });

    if (
      !hasStaleMemoryLanguage &&
      !shouldRefresh &&
      measureThreadWindow(existingContext) <= THREAD_CONTEXT_CHAR_LIMIT
    ) {
      const retainedResult = await buildThreadReplyContextWithTurnUnderstanding(
        {
          messages: retainedMessages,
          memory: existingMemory,
          recentCustomerLanguage,
          conversationPreferredLanguage,
          workspaceLanguage: params.workspaceLanguage,
          latestInboundText: params.latestInboundText,
          mode: params.mode,
          includeHistoryInContext: params.includeHistoryInContext,
          quickReplyPayload: params.quickReplyPayload,
          scenarioStepAnswer: params.scenarioStepAnswer,
        }
      );
      persistMemoryIfChangedInBackground({
        conversationId: params.conversationId,
        existingMemory,
        nextMemory: retainedResult.memory,
        failureNote: "persist_active_selection_failed",
      });
      return retainedResult.context;
    }
  }

  const compaction = resolveCompactionCandidate({
    messages,
    existingMemory,
    recentCustomerLanguage,
    conversationPreferredLanguage,
    workspaceLanguage: params.workspaceLanguage,
    latestInboundText: params.latestInboundText,
    mode: params.mode,
    includeHistoryInContext: params.includeHistoryInContext,
  });
  const previousCoveredCount = existingMemory?.coveredMessageCount || 0;
  const deltaMessages = messages.slice(
    previousCoveredCount,
    compaction.coveredMessages.length
  );
  const compactedResult = await buildThreadReplyContextWithTurnUnderstanding({
    messages: compaction.retainedMessages,
    memory: compaction.memory,
    recentCustomerLanguage,
    conversationPreferredLanguage,
    workspaceLanguage: params.workspaceLanguage,
    latestInboundText: params.latestInboundText,
    mode: params.mode,
    includeHistoryInContext: params.includeHistoryInContext,
    quickReplyPayload: params.quickReplyPayload,
    scenarioStepAnswer: params.scenarioStepAnswer,
  });

  refreshThreadMemorySummaryInBackground({
    conversationId: params.conversationId,
    existingMemory,
    initialMemory: compactedResult.memory || compaction.memory,
    deltaMessages,
    preferredLanguage: compaction.insights.dominantLanguage,
    fallbackSummary: compaction.fallbackSummary,
    currentGoal: compaction.insights.currentGoal,
    unresolvedNeeds: compaction.insights.unresolvedNeeds,
    resolvedNeeds: compaction.insights.resolvedNeeds,
    coveredMessages: compaction.coveredMessages,
    activeSelection: compactedResult.context.activeSelection,
  });

  return compactedResult.context;
}

export const loadThreadReplyContext = traceableChain(
  loadThreadReplyContextImpl,
  {
    name: "airi.reply.load_thread_context",
    tags: ["airi", "reply", "thread-context"],
    getMetadata: params => ({
      conversation_id: params.conversationId,
      retrieval_query_mode: params.mode || "adaptive",
      include_history_in_context: params.includeHistoryInContext ?? true,
      preferred_language: params.conversationPreferredLanguage || null,
      workspace_language: params.workspaceLanguage || null,
    }),
    processInputs: inputs => {
      const payload = (
        "input" in inputs ? inputs.input : inputs
      ) as LoadThreadReplyContextParams;
      return {
        conversation_id: payload.conversationId,
        latest_inbound_preview: previewText(payload.latestInboundText, 240),
        mode: payload.mode || "adaptive",
        include_history_in_context: payload.includeHistoryInContext ?? true,
        conversation_preferred_language:
          payload.conversationPreferredLanguage || null,
        workspace_language: payload.workspaceLanguage || null,
      };
    },
    processOutputs: outputs => {
      const result = (
        "outputs" in outputs ? outputs.outputs : outputs
      ) as ThreadReplyContext;
      return {
        dominant_language: result.dominantLanguage || null,
        current_goal_preview: previewText(result.currentGoal, 160),
        active_goals: previewStringArray(result.activeGoals || [], 4, 100),
        open_asks: previewStringArray(result.openAsks || [], 4, 100),
        follow_up_mode: result.followUpMode || "none",
        has_unresolved_need: result.hasUnresolvedNeed,
        history_compacted: Boolean(result.historyCompacted),
        summary_covered_through_message_id:
          result.summaryCoveredThroughMessageId || null,
        summary_covered_message_count:
          result.summaryCoveredMessageCount || null,
        conversation_window_length: String(result.conversationWindow || "")
          .length,
        recent_conversation_tail_length: String(
          result.recentConversationTail || ""
        ).length,
      };
    },
  }
);
