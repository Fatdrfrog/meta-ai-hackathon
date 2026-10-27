import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
import {
  chatCompletionWithFallback,
  formatError,
  getLightTextModel,
} from "@/lib/ai";
import { createInferenceDeadline } from "@/lib/ai/inference-deadline";
import {
  buildHeuristicRagQueryPreparation,
  buildRagQueryPreparationFromFields,
  type RagQueryPreparation,
  type RagQueryPreparationFields,
} from "@/lib/airi/rag/query/query-cleaner";
import {
  createModelRetrievalIntent,
  createNeutralRetrievalIntent,
  type RetrievalIntentClassification,
} from "@/lib/airi/rag/query/retrieval-intent-classifier";
import type {
  AiriActiveSelection,
  AiriSelectionTransition,
} from "@/lib/airi/reply/selection";
import { parseGroundedReplyOptionPayload } from "@/lib/airi/reply/selection";
import {
  airiReplyLogger,
  compactLogList,
} from "@/lib/airi/reply/runtime/reply-logging";
import {
  previewStringArray,
  previewText,
  traceableChain,
} from "@/lib/observability/tracing";
import {
  contextDependentGenericQuestionStructural,
  countWordLikeTokens,
  isIntegrationReactionStubMessage,
  normalizeComparableText,
  shouldPreferStandaloneAskStructural,
  stripAiriPrefix,
} from "@/lib/airi/reply/thread/reply-text-utils";

export type TurnSafeReplyKey =
  | "greeting"
  | "presence_check"
  | "meta_question"
  | "thanks"
  | "farewell"
  | "acknowledgment"
  | "impatience"
  | "chit_chat"
  | "data_sharing";

export type TurnUnderstandingKind =
  | "greeting"
  | "presence_check"
  | "meta_question"
  | "thanks"
  | "farewell"
  | "acknowledgment"
  | "impatience"
  | "data_sharing"
  | "question"
  | "followup_question"
  | "unknown";

export type TurnUnderstandingConfidence = "low" | "medium" | "high";
export type TurnFollowUpMode =
  | "none"
  | "expand_last_grounding"
  | "resume_current_goal"
  | "resume_unresolved_need";
export type TurnPlanningSource = "model" | "fallback";
/** How the customer answered a scenario step's own question. */
export type ScenarioStepAnswerKind = "location" | "choice";

/** LLM-derived (with offline structural fallbacks) thread / planning signals — no phrase-list regex. */
export type TurnThreadScaffold = {
  trackThreadNeed: boolean;
  conversationalFollowup: boolean;
  shortEntityReference: boolean;
  contextDependentGenericQuestion: boolean;
  preferStandaloneAskOverFollowUpAnchor: boolean;
  genericResumeContinuation: boolean;
};

export type TurnUnderstanding = {
  kind: TurnUnderstandingKind;
  proceedWithRag: boolean;
  calendarAvailabilityRelevant: boolean;
  dependsOnPriorContext: boolean;
  safeReplyKey: TurnSafeReplyKey | null;
  confidence: TurnUnderstandingConfidence;
  asks: string[];
  coverageHints: string[];
  followUpMode: TurnFollowUpMode;
  followUpAnchor: string | null;
  queryVariants: string[];
  planningSource: TurnPlanningSource;
  threadScaffold: TurnThreadScaffold;
  selectionTransition: AiriSelectionTransition;
  /** Present when turn understanding produced retrieval prep; reuse in RAG planner to skip duplicate prep. */
  ragQueryPreparation?: RagQueryPreparation;
  /** Reused by retrieval so the normal Airi path does not classify the same turn twice. */
  retrievalIntent?: RetrievalIntentClassification;
  /** Set when the turn answers the scenario step's own question. */
  scenarioStepQuestion?: string;
};

type UnderstandCustomerTurnOptions = {
  workspaceId?: string | null;
  conversationId?: string | null;
  /** Legacy settings may carry this value; classification always uses the metered facade. */
  elevenlabsAgentId?: string | null;
  intentAnchor?: string | null;
  hasUnresolvedNeed?: boolean;
  currentGoal?: string | null;
  unresolvedNeeds?: string[];
  lastGrounding?: {
    intentAnchor?: string | null;
    answeredAsks?: string[];
  } | null;
  activeSelection?: AiriActiveSelection;
  quickReplyPayload?: string | null;
  /** Pre-resolved retrieval prep when already available (fallback planning uses this when present). */
  ragQueryPreparation?: RagQueryPreparation;
  /** A location or choice the customer sent in answer to the step's question. */
  scenarioStepAnswer?: {
    kind: ScenarioStepAnswerKind;
    question: string;
  } | null;
};

type RawTurnUnderstandingPayload = {
  kind?: string;
  type?: string;
  proceedWithRag?: boolean;
  proceedWithRAG?: boolean;
  calendarAvailabilityRelevant?: boolean;
  dependsOnPriorContext?: boolean;
  safeReplyKey?: string | null;
  confidence?: string;
  asks?: unknown;
  coverageHints?: unknown;
  followUpMode?: string | null;
  followUpAnchor?: string | null;
  queryVariants?: unknown;
  cleanedQuery?: unknown;
  subQueries?: unknown;
  trackThreadNeed?: boolean;
  conversationalFollowup?: boolean;
  shortEntityReference?: boolean;
  contextDependentGenericQuestion?: boolean;
  preferStandaloneAskOverFollowUpAnchor?: boolean;
  genericResumeContinuation?: boolean;
  selectionTransitionAction?: unknown;
  selectionLabel?: unknown;
  retrievalIntent?: {
    label?: unknown;
    confidence?: unknown;
    language?: unknown;
    queryVariants?: unknown;
    reason?: unknown;
  };
};

type BaseTurnUnderstanding = Omit<
  TurnUnderstanding,
  | "asks"
  | "coverageHints"
  | "followUpMode"
  | "followUpAnchor"
  | "queryVariants"
  | "planningSource"
  | "threadScaffold"
  | "selectionTransition"
>;

type TurnPlanning = Pick<
  TurnUnderstanding,
  | "asks"
  | "coverageHints"
  | "followUpMode"
  | "followUpAnchor"
  | "queryVariants"
  | "planningSource"
>;

const SYSTEM_PROMPT = `You are a turn-understanding classifier for a customer support AI assistant named Airi.

Your task: analyze the customer's latest message IN THE CONTEXT OF THE CONVERSATION and return JSON describing:
1. what kind of turn it is
2. whether it should proceed to grounded retrieval
3. whether connected calendar availability would be relevant
4. the ask coverage plan for retrieval and answer generation

Allowed "kind" values:
- greeting
- presence_check
- meta_question
- thanks
- farewell
- acknowledgment
- impatience
- data_sharing
- question
- followup_question
- unknown

Definitions:
- "question" = a standalone substantive customer ask that should go to knowledge retrieval or grounded answering.
- "followup_question" = a turn that depends on prior unresolved context, a prior agent question, or an earlier topic to be answerable.
- "data_sharing" = customer is providing requested info such as phone/email/name.
- "unknown" = unclear meaning. If confidence is low, prefer proceedWithRag=true instead of blocking with a generic clarification.

IMPORTANT RULES:
- Always consider the full conversation context.
- Never classify a greeting-prefixed substantive ask as "greeting". Example: "Hello, I want to know about WhatsApp" is a question.
- When "Current locked selection" is provided and is not empty: infer intent from meaning, not message length. If the customer is agreeing to proceed with that offer, moving to payment/checkout, or asking for the next step only for that locked option, treat it as a substantive continuation: prefer kind "followup_question" or "question", set proceedWithRag=true, dependsOnPriorContext=true, selectionTransitionAction "keep_existing", and fill queryVariants/cleanedQuery/asks/coverageHints so the primary retrieval query names that selection (and quoted price if present). Do not use kind "acknowledgment" with proceedWithRag=false for that situation. If they clearly switch or abandon the offer, use "switch_selection" or "clear_selection" with fields that match their intent.
- For greeting / presence_check / meta_question / thanks / farewell / acknowledgment / impatience / data_sharing: set proceedWithRag=false unless the turn truly depends on earlier unresolved context or the locked-selection rule above applies.
- For question / followup_question: set proceedWithRag=true.
- Set calendarAvailabilityRelevant=true only when the latest customer turn is actively trying to schedule, book, reschedule, cancel, or choose a time for a call, demo, meeting, appointment, event reminder, or availability/time-slot question. Set it false for generic product interest, pricing, support, documents, or setup questions that do not need real availability.
- calendarAvailabilityRelevant only decides whether the runtime may consult connected Calendar free/busy; it must not change proceedWithRag by itself.
- Set dependsOnPriorContext=true only when the latest message relies on prior conversation state.
- safeReplyKey must be one of: greeting, presence_check, meta_question, thanks, farewell, acknowledgment, impatience, data_sharing, chit_chat, or null.
- Do not invent workflow state or say the assistant is already checking something.
- Preserve asks in the customer's language. Never translate asks into English.
- For multi-ask turns, include EACH distinct ask as its own entry in "asks". Treat these patterns as separate asks: two questions in one message, a question followed by a conditional "if X, what should I do?" clause, an enumerated list of things to know, or a statement + question combo. Do not collapse them into one ask just because they share a topic.
- When a turn contains a factual statement about the customer's own situation (e.g. "I have not taken the exam", "I already paid"), record that statement as a contextual fact (e.g. in coverageHints) rather than as an ask, so the reply writer does not ask the customer to restate it.
- For generic follow-ups like "tell me more" or "расскажи подробнее", use prior context to set followUpMode and followUpAnchor.
- "coverageHints" should be short customer-language phrases that help ensure every ask gets answered.
- "queryVariants" should be ordered retrieval queries in the customer's language. Put the best primary retrieval query first.
- "cleanedQuery" should be the main retrieval-ready query text in the customer's language. Remove greeting/filler, keep named entities and factual intent.
- "subQueries" should split clearly separate asks for retrieval (max 4). If not needed, return [].
- "retrievalIntent" is the retrieval-routing decision for the same customer turn. Use label service_overview, specific_factual, procedural, pricing, comparison, other, or unclear; include confidence, detected language, a concise reason, and 0-4 broad variants only for service_overview.
- "selectionTransitionAction" controls the locked customer selection state:
  - "keep_existing" when the turn continues, confirms, or proceeds with the current locked selection.
  - "select_offer" when the customer chooses one of the offered options.
  - "switch_selection" when the customer explicitly changes from one option to another.
  - "clear_selection" when the customer abandons the previous selection or asks to reset the choice.
  - "none" when the turn does not affect selection state.
- "selectionLabel" should contain the chosen option label only for "select_offer" or "switch_selection". If the customer is just confirming the currently locked selection, leave it null and use "keep_existing".
- If there is no current locked selection and the previous assistant message asked whether the customer wants one named offer/program/product, then a confirmation from the customer should be "select_offer" with that exact option label.
- If the customer chooses by ordinal, short reference, or confirmation, resolve the chosen label from the conversation context rather than leaving selectionTransitionAction as "none".
- If proceedWithRag=false, return empty arrays for asks/coverageHints/queryVariants/subQueries, followUpMode="none", followUpAnchor=null, cleanedQuery="", and calendarAvailabilityRelevant=false unless the customer is explicitly trying to schedule or reschedule.

Thread scaffolding (booleans — required on every response):
- "trackThreadNeed": true if this inbound should advance thread memory / open-needs tracking.
- "conversationalFollowup": true for thanks/greeting/presence/ack/impatience/social turns without a new substantive ask.
- "shortEntityReference": true if the message is a short name/code/reference (not a full question).
- "contextDependentGenericQuestion": true for short generic continuations like "tell me more" that need prior context to interpret.
- "preferStandaloneAskOverFollowUpAnchor": true when the message is a detailed standalone question and must not be collapsed into followUpAnchor alone.
- "genericResumeContinuation": true when the customer wants to repeat/continue prior information without naming a new topic.

OUTPUT FORMAT (JSON only):
{
  "kind": "greeting|presence_check|meta_question|thanks|farewell|acknowledgment|impatience|data_sharing|question|followup_question|unknown",
  "proceedWithRag": true|false,
  "calendarAvailabilityRelevant": true|false,
  "dependsOnPriorContext": true|false,
  "safeReplyKey": "greeting|presence_check|meta_question|thanks|farewell|acknowledgment|impatience|data_sharing|chit_chat|null",
  "confidence": "low|medium|high",
  "asks": ["string"],
  "coverageHints": ["string"],
  "followUpMode": "none|expand_last_grounding|resume_current_goal|resume_unresolved_need",
  "followUpAnchor": "string|null",
  "queryVariants": ["string"],
  "cleanedQuery": "string",
  "subQueries": ["string"],
  "retrievalIntent": {
    "label": "service_overview|specific_factual|procedural|pricing|comparison|other|unclear",
    "confidence": "low|medium|high",
    "language": "string",
    "queryVariants": ["string"],
    "reason": "string"
  },
  "trackThreadNeed": true|false,
  "conversationalFollowup": true|false,
  "shortEntityReference": true|false,
  "contextDependentGenericQuestion": true|false,
  "preferStandaloneAskOverFollowUpAnchor": true|false,
  "genericResumeContinuation": true|false,
  "selectionTransitionAction": "none|keep_existing|select_offer|switch_selection|clear_selection",
  "selectionLabel": "string|null"
}`;

const VALID_FOLLOW_UP_MODES = new Set<TurnFollowUpMode>([
  "none",
  "expand_last_grounding",
  "resume_current_goal",
  "resume_unresolved_need",
]);

const TURN_UNDERSTANDING_RESPONSE_SCHEMA = {
  type: "OBJECT",
  required: [
    "kind",
    "proceedWithRag",
    "calendarAvailabilityRelevant",
    "dependsOnPriorContext",
    "safeReplyKey",
    "confidence",
    "asks",
    "coverageHints",
    "followUpMode",
    "followUpAnchor",
    "queryVariants",
    "cleanedQuery",
    "subQueries",
    "retrievalIntent",
    "trackThreadNeed",
    "conversationalFollowup",
    "shortEntityReference",
    "contextDependentGenericQuestion",
    "preferStandaloneAskOverFollowUpAnchor",
    "genericResumeContinuation",
    "selectionTransitionAction",
    "selectionLabel",
  ],
  properties: {
    kind: {
      type: "STRING",
      format: "enum",
      enum: [
        "greeting",
        "presence_check",
        "meta_question",
        "thanks",
        "farewell",
        "acknowledgment",
        "impatience",
        "data_sharing",
        "question",
        "followup_question",
        "unknown",
      ],
    },
    proceedWithRag: { type: "BOOLEAN" },
    calendarAvailabilityRelevant: { type: "BOOLEAN" },
    dependsOnPriorContext: { type: "BOOLEAN" },
    safeReplyKey: {
      type: "STRING",
      nullable: true,
      format: "enum",
      enum: [
        "greeting",
        "presence_check",
        "meta_question",
        "thanks",
        "farewell",
        "acknowledgment",
        "impatience",
        "data_sharing",
        "chit_chat",
      ],
    },
    confidence: {
      type: "STRING",
      format: "enum",
      enum: ["low", "medium", "high"],
    },
    asks: { type: "ARRAY", items: { type: "STRING" } },
    coverageHints: { type: "ARRAY", items: { type: "STRING" } },
    followUpMode: {
      type: "STRING",
      format: "enum",
      enum: [
        "none",
        "expand_last_grounding",
        "resume_current_goal",
        "resume_unresolved_need",
      ],
    },
    followUpAnchor: { type: "STRING", nullable: true },
    queryVariants: { type: "ARRAY", items: { type: "STRING" } },
    cleanedQuery: { type: "STRING" },
    subQueries: { type: "ARRAY", items: { type: "STRING" } },
    retrievalIntent: {
      type: "OBJECT",
      required: ["label", "confidence", "language", "queryVariants", "reason"],
      properties: {
        label: {
          type: "STRING",
          format: "enum",
          enum: [
            "service_overview",
            "specific_factual",
            "procedural",
            "pricing",
            "comparison",
            "other",
            "unclear",
          ],
        },
        confidence: {
          type: "STRING",
          format: "enum",
          enum: ["low", "medium", "high"],
        },
        language: { type: "STRING" },
        queryVariants: { type: "ARRAY", items: { type: "STRING" } },
        reason: { type: "STRING" },
      },
    },
    trackThreadNeed: { type: "BOOLEAN" },
    conversationalFollowup: { type: "BOOLEAN" },
    shortEntityReference: { type: "BOOLEAN" },
    contextDependentGenericQuestion: { type: "BOOLEAN" },
    preferStandaloneAskOverFollowUpAnchor: { type: "BOOLEAN" },
    genericResumeContinuation: { type: "BOOLEAN" },
    selectionTransitionAction: {
      type: "STRING",
      format: "enum",
      enum: [
        "none",
        "keep_existing",
        "select_offer",
        "switch_selection",
        "clear_selection",
      ],
    },
    selectionLabel: { type: "STRING", nullable: true },
  },
  propertyOrdering: [
    "kind",
    "proceedWithRag",
    "calendarAvailabilityRelevant",
    "dependsOnPriorContext",
    "safeReplyKey",
    "confidence",
    "asks",
    "coverageHints",
    "followUpMode",
    "followUpAnchor",
    "queryVariants",
    "cleanedQuery",
    "subQueries",
    "retrievalIntent",
    "trackThreadNeed",
    "conversationalFollowup",
    "shortEntityReference",
    "contextDependentGenericQuestion",
    "preferStandaloneAskOverFollowUpAnchor",
    "genericResumeContinuation",
    "selectionTransitionAction",
    "selectionLabel",
  ],
} satisfies Record<string, unknown>;

function resolveThreadScaffold(
  payload: RawTurnUnderstandingPayload | null,
  params: {
    kind: TurnUnderstandingKind;
    rawKind: string;
    proceedWithRag: boolean;
    safeReplyKey: TurnSafeReplyKey | null;
  }
): TurnThreadScaffold {
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;

  const socialKind =
    params.rawKind === "chit_chat" ||
    params.kind === "greeting" ||
    params.kind === "thanks" ||
    params.kind === "farewell" ||
    params.kind === "acknowledgment" ||
    params.kind === "presence_check" ||
    params.kind === "meta_question" ||
    params.kind === "impatience" ||
    params.safeReplyKey === "chit_chat";

  const defaultTrack =
    params.kind === "question" ||
    params.kind === "followup_question" ||
    params.kind === "data_sharing" ||
    (params.kind === "unknown" && params.proceedWithRag);

  return {
    trackThreadNeed: bool(payload?.trackThreadNeed, defaultTrack),
    conversationalFollowup: bool(
      payload?.conversationalFollowup,
      socialKind && !params.proceedWithRag
    ),
    shortEntityReference: bool(payload?.shortEntityReference, false),
    contextDependentGenericQuestion: bool(
      payload?.contextDependentGenericQuestion,
      params.kind === "followup_question" && params.proceedWithRag
    ),
    preferStandaloneAskOverFollowUpAnchor: bool(
      payload?.preferStandaloneAskOverFollowUpAnchor,
      false
    ),
    genericResumeContinuation: bool(payload?.genericResumeContinuation, false),
  };
}

function offlineThreadScaffold(message: string): TurnThreadScaffold {
  const text = String(message || "").trim();
  const tokens = countWordLikeTokens(text);
  const n = normalizeComparableText(text);
  return {
    trackThreadNeed:
      tokens >= 3 || (tokens >= 2 && text.length >= 20) || text.length >= 22,
    conversationalFollowup: false,
    shortEntityReference:
      tokens <= 2 &&
      text.length <= 48 &&
      !text.endsWith("?") &&
      !text.endsWith("？"),
    contextDependentGenericQuestion:
      contextDependentGenericQuestionStructural(text),
    preferStandaloneAskOverFollowUpAnchor: false,
    genericResumeContinuation: Boolean(n) && tokens <= 2 && n.length <= 28,
  };
}

function inferConfidence(
  kind: TurnUnderstandingKind,
  explicit?: unknown
): TurnUnderstandingConfidence {
  const normalized = String(explicit || "")
    .trim()
    .toLowerCase();
  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }
  if (kind === "unknown") return "low";
  if (kind === "question" || kind === "followup_question") return "medium";
  return "high";
}

function normalizeRawKind(value: unknown): TurnUnderstandingKind | "chit_chat" {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized) return "unknown";
  if (normalized === "actual_question") return "question";
  if (
    normalized === "greeting" ||
    normalized === "presence_check" ||
    normalized === "meta_question" ||
    normalized === "thanks" ||
    normalized === "farewell" ||
    normalized === "acknowledgment" ||
    normalized === "impatience" ||
    normalized === "data_sharing" ||
    normalized === "question" ||
    normalized === "followup_question" ||
    normalized === "unknown" ||
    normalized === "chit_chat"
  ) {
    return normalized;
  }

  return "unknown";
}

function inferSafeReplyKey(
  kind: TurnUnderstandingKind | "chit_chat",
  explicit?: unknown
): TurnSafeReplyKey | null {
  const normalized = String(explicit || "")
    .trim()
    .toLowerCase();
  if (
    normalized === "greeting" ||
    normalized === "presence_check" ||
    normalized === "meta_question" ||
    normalized === "thanks" ||
    normalized === "farewell" ||
    normalized === "acknowledgment" ||
    normalized === "impatience" ||
    normalized === "data_sharing" ||
    normalized === "chit_chat"
  ) {
    return normalized;
  }

  if (
    kind === "greeting" ||
    kind === "presence_check" ||
    kind === "meta_question" ||
    kind === "thanks" ||
    kind === "farewell" ||
    kind === "acknowledgment" ||
    kind === "impatience" ||
    kind === "data_sharing" ||
    kind === "chit_chat"
  ) {
    return kind;
  }

  return null;
}

function dedupeComparable(values: string[], limit: number = 4): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawValue of values) {
    const value = stripAiriPrefix(String(rawValue || ""))
      .replace(/\s+/g, " ")
      .trim();
    const normalized = normalizeComparableText(value);
    if (!value || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
    if (result.length >= limit) break;
  }

  return result;
}

function compactPlanStrings(values: unknown, limit: number = 4): string[] {
  if (!Array.isArray(values)) return [];
  return dedupeComparable(
    values.map(item => String(item || "").trim()).filter(Boolean),
    limit
  );
}

function compactOptionalString(value: unknown): string | null {
  const normalized = stripAiriPrefix(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function normalizeSelectionTransition(
  payload: RawTurnUnderstandingPayload | null,
  options?: UnderstandCustomerTurnOptions
): AiriSelectionTransition {
  const rawAction = String(payload?.selectionTransitionAction || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  let action: AiriSelectionTransition["action"] = "none";
  if (
    rawAction === "none" ||
    rawAction === "keep_existing" ||
    rawAction === "select_offer" ||
    rawAction === "switch_selection" ||
    rawAction === "clear_selection"
  ) {
    action = rawAction;
  } else if (options?.activeSelection) {
    action = "keep_existing";
  }

  return {
    action,
    selectionLabel: compactOptionalString(payload?.selectionLabel),
  };
}

function compactRagSubQueries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return dedupeComparable(
    value.map(item => String(item || "").trim()).filter(Boolean),
    4
  );
}

function resolveTurnRagQueryPreparation(params: {
  payload: RawTurnUnderstandingPayload | null;
  message: string;
  proceedWithRag: boolean;
  existingPrep?: RagQueryPreparation;
}): RagQueryPreparation | undefined {
  if (params.existingPrep) {
    return params.existingPrep;
  }

  const cleanedQuery =
    typeof params.payload?.cleanedQuery === "string"
      ? params.payload.cleanedQuery.trim()
      : undefined;
  const subQueries = compactRagSubQueries(params.payload?.subQueries);

  if (cleanedQuery !== undefined || subQueries.length > 0) {
    return buildRagQueryPreparationFromFields(
      params.message,
      {
        cleanedQuery,
        subQueries,
      } satisfies RagQueryPreparationFields,
      "llm"
    );
  }

  if (!params.proceedWithRag) {
    return undefined;
  }

  return buildHeuristicRagQueryPreparation(params.message);
}

function joinDistinctIntentParts(parts: string[]): string {
  return dedupeComparable(parts, 6).join(". ").slice(0, 400);
}

function normalizeFollowUpMode(value: unknown): TurnFollowUpMode | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return VALID_FOLLOW_UP_MODES.has(normalized as TurnFollowUpMode)
    ? (normalized as TurnFollowUpMode)
    : null;
}

function emptyTurnPlanning(planningSource: TurnPlanningSource): TurnPlanning {
  return {
    asks: [],
    coverageHints: [],
    followUpMode: "none",
    followUpAnchor: null,
    queryVariants: [],
    planningSource,
  };
}

export const EMPTY_THREAD_SCAFFOLD: TurnThreadScaffold = {
  trackThreadNeed: false,
  conversationalFollowup: false,
  shortEntityReference: false,
  contextDependentGenericQuestion: false,
  preferStandaloneAskOverFollowUpAnchor: false,
  genericResumeContinuation: false,
};

const TURN_UNDERSTANDING_TIMEOUT_MS = 8_000;

function resolveFallbackFollowUp(params: {
  dependsOnPriorContext: boolean;
  options?: UnderstandCustomerTurnOptions;
}): Pick<TurnPlanning, "followUpMode" | "followUpAnchor"> {
  if (!params.dependsOnPriorContext) {
    return {
      followUpMode: "none",
      followUpAnchor: null,
    };
  }

  const lastGroundingAnchor = compactOptionalString(
    params.options?.lastGrounding?.intentAnchor
  );
  if (lastGroundingAnchor) {
    return {
      followUpMode: "expand_last_grounding",
      followUpAnchor: lastGroundingAnchor,
    };
  }

  const unresolvedNeeds = dedupeComparable(
    params.options?.unresolvedNeeds || [],
    6
  );
  const currentGoal = compactOptionalString(
    params.options?.currentGoal || params.options?.intentAnchor
  );
  const normalizedCurrentGoal = normalizeComparableText(currentGoal || "");
  const currentUnresolvedNeed =
    normalizedCurrentGoal &&
    unresolvedNeeds.find(
      need => normalizeComparableText(need) === normalizedCurrentGoal
    );
  if (currentUnresolvedNeed) {
    return {
      followUpMode: "resume_unresolved_need",
      followUpAnchor: currentUnresolvedNeed,
    };
  }

  if (currentGoal) {
    return {
      followUpMode: "resume_current_goal",
      followUpAnchor: currentGoal,
    };
  }

  const unresolvedNeed = unresolvedNeeds[unresolvedNeeds.length - 1];
  if (unresolvedNeed) {
    return {
      followUpMode: "resume_unresolved_need",
      followUpAnchor: unresolvedNeed,
    };
  }

  return {
    followUpMode: "resume_current_goal",
    followUpAnchor: null,
  };
}

function resolveCleanedQueryAndSplits(
  originalText: string,
  options?: UnderstandCustomerTurnOptions
): {
  cleanedQuery: string;
  splitQuestions: string[];
  ragExplicitlyNonSearchable: boolean;
} {
  const prep = options?.ragQueryPreparation;
  if (prep) {
    const cleanedQuery = prep.cleanedQuery.trim();
    const splitQuestions = prep.subQueries.filter(s => s.trim().length >= 3);
    const ragExplicitlyNonSearchable =
      prep.source === "llm" &&
      cleanedQuery.length === 0 &&
      splitQuestions.length === 0;
    return { cleanedQuery, splitQuestions, ragExplicitlyNonSearchable };
  }
  const cleanedQuery = originalText.trim().replace(/\s+/g, " ").trim();
  return {
    cleanedQuery,
    splitQuestions: [],
    ragExplicitlyNonSearchable: false,
  };
}

function buildFallbackTurnPlanning(params: {
  message: string;
  proceedWithRag: boolean;
  dependsOnPriorContext: boolean;
  options?: UnderstandCustomerTurnOptions;
  threadScaffold: TurnThreadScaffold;
}): TurnPlanning {
  if (!params.proceedWithRag) {
    return emptyTurnPlanning("fallback");
  }

  const originalText = stripAiriPrefix(String(params.message || ""))
    .replace(/\s+/g, " ")
    .trim();
  const { cleanedQuery, splitQuestions, ragExplicitlyNonSearchable } =
    resolveCleanedQueryAndSplits(originalText, params.options);
  const followUp = resolveFallbackFollowUp({
    dependsOnPriorContext: params.dependsOnPriorContext,
    options: params.options,
  });
  const preferStandaloneAsk =
    Boolean(cleanedQuery) &&
    Boolean(followUp.followUpAnchor) &&
    (shouldPreferStandaloneAskStructural(
      cleanedQuery,
      followUp.followUpAnchor || ""
    ) ||
      params.threadScaffold.preferStandaloneAskOverFollowUpAnchor);
  const mergedFollowUpAsk =
    params.dependsOnPriorContext &&
    followUp.followUpAnchor &&
    cleanedQuery &&
    !preferStandaloneAsk
      ? dedupeComparable([cleanedQuery, followUp.followUpAnchor], 2).join(" ")
      : "";
  const shouldUseMergedFollowUpAsk =
    Boolean(mergedFollowUpAsk) &&
    (splitQuestions.length === 0 ||
      params.threadScaffold.contextDependentGenericQuestion ||
      contextDependentGenericQuestionStructural(cleanedQuery));

  const asks = ragExplicitlyNonSearchable
    ? dedupeComparable(
        followUp.followUpAnchor ? [followUp.followUpAnchor] : [],
        4
      ).filter(Boolean)
    : dedupeComparable(
        shouldUseMergedFollowUpAsk
          ? [mergedFollowUpAsk]
          : splitQuestions.length > 0
            ? splitQuestions
            : mergedFollowUpAsk
              ? [mergedFollowUpAsk]
              : preferStandaloneAsk
                ? [cleanedQuery || originalText]
                : [cleanedQuery || originalText, followUp.followUpAnchor || ""],
        4
      ).filter(Boolean);

  const primaryQuery = ragExplicitlyNonSearchable
    ? followUp.followUpAnchor || ""
    : asks.length >= 2
      ? joinDistinctIntentParts(asks)
      : preferStandaloneAsk
        ? asks[0] || cleanedQuery || originalText
        : followUp.followUpAnchor || asks[0] || cleanedQuery || originalText;

  const contextualStandaloneVariant =
    preferStandaloneAsk && asks[0] && followUp.followUpAnchor
      ? `${asks[0]} ${followUp.followUpAnchor}`.trim()
      : "";

  const queryVariants = ragExplicitlyNonSearchable
    ? dedupeComparable(
        [
          primaryQuery,
          ...asks,
          contextualStandaloneVariant,
          followUp.followUpAnchor || "",
        ].filter(s => s.length > 0),
        4
      )
    : dedupeComparable(
        [
          primaryQuery,
          ...asks,
          contextualStandaloneVariant,
          followUp.followUpAnchor || "",
          cleanedQuery,
          originalText,
        ],
        4
      );

  const coverageHints = ragExplicitlyNonSearchable
    ? dedupeComparable(
        [...asks, followUp.followUpAnchor || ""].filter(s => s.length > 0),
        4
      )
    : dedupeComparable(
        [...asks, followUp.followUpAnchor || "", cleanedQuery],
        4
      );

  return {
    asks,
    coverageHints,
    followUpMode:
      followUp.followUpAnchor || params.dependsOnPriorContext
        ? followUp.followUpMode
        : "none",
    followUpAnchor: followUp.followUpAnchor,
    queryVariants,
    planningSource: "fallback",
  };
}

function buildModelTurnPlanning(params: {
  payload: RawTurnUnderstandingPayload | null;
  base: Pick<
    TurnUnderstanding,
    "proceedWithRag" | "dependsOnPriorContext" | "confidence"
  >;
  message: string;
  options?: UnderstandCustomerTurnOptions;
  threadScaffold: TurnThreadScaffold;
}): TurnPlanning {
  if (!params.base.proceedWithRag) {
    return emptyTurnPlanning("model");
  }

  const fallbackPlan = buildFallbackTurnPlanning({
    message: params.message,
    proceedWithRag: params.base.proceedWithRag,
    dependsOnPriorContext: params.base.dependsOnPriorContext,
    options: params.options,
    threadScaffold: params.threadScaffold,
  });
  const asks = compactPlanStrings(params.payload?.asks, 4);
  const followUpMode =
    normalizeFollowUpMode(params.payload?.followUpMode) || "none";
  const followUpAnchor = compactOptionalString(params.payload?.followUpAnchor);
  const modelCoverageHints = compactPlanStrings(
    params.payload?.coverageHints,
    4
  );
  const coverageHints =
    modelCoverageHints.length > 0
      ? modelCoverageHints
      : dedupeComparable([...asks, followUpAnchor || ""], 4);
  const queryVariants = dedupeComparable(
    compactPlanStrings(params.payload?.queryVariants, 4),
    4
  );
  const usablePlanning =
    (asks.length > 0 || followUpAnchor || queryVariants.length > 0) &&
    (!params.base.dependsOnPriorContext ||
      (followUpMode !== "none" && Boolean(followUpAnchor))) &&
    queryVariants.length > 0 &&
    (asks.length > 0 || Boolean(followUpAnchor));

  if (params.base.confidence === "low" || !usablePlanning) {
    return fallbackPlan;
  }

  return {
    asks,
    coverageHints:
      coverageHints.length > 0
        ? coverageHints
        : dedupeComparable([...asks, followUpAnchor || ""], 4),
    followUpMode,
    followUpAnchor,
    queryVariants,
    planningSource: "model",
  };
}

function normalizeTurnUnderstanding(
  payload: RawTurnUnderstandingPayload | null,
  params: {
    message: string;
    options?: UnderstandCustomerTurnOptions;
  }
): TurnUnderstanding {
  const rawKind = normalizeRawKind(payload?.kind || payload?.type);
  const kind: TurnUnderstandingKind =
    rawKind === "chit_chat" ? "unknown" : rawKind;
  const confidence = inferConfidence(kind, payload?.confidence);
  const safeReplyKey = inferSafeReplyKey(rawKind, payload?.safeReplyKey);
  const dependsOnPriorContext = Boolean(
    payload?.dependsOnPriorContext ||
      kind === "followup_question" ||
      (payload == null &&
        params.options?.hasUnresolvedNeed &&
        typeof params.options?.intentAnchor === "string" &&
        params.options.intentAnchor.trim())
  );
  const explicitProceed =
    typeof payload?.proceedWithRag === "boolean"
      ? payload.proceedWithRag
      : typeof payload?.proceedWithRAG === "boolean"
        ? payload.proceedWithRAG
        : undefined;
  const calendarAvailabilityRelevant =
    payload?.calendarAvailabilityRelevant === true;

  let proceedWithRag = explicitProceed ?? false;
  if (kind === "question" || kind === "followup_question") {
    proceedWithRag = true;
  } else if (kind === "unknown" && !safeReplyKey) {
    proceedWithRag = true;
  }

  const ragQueryPreparation = resolveTurnRagQueryPreparation({
    payload,
    message: params.message,
    proceedWithRag,
    existingPrep: params.options?.ragQueryPreparation,
  });
  const optionsWithPrep =
    ragQueryPreparation &&
    params.options?.ragQueryPreparation !== ragQueryPreparation
      ? {
          ...params.options,
          ragQueryPreparation,
        }
      : params.options;

  const threadScaffold = resolveThreadScaffold(payload, {
    kind,
    rawKind: String(rawKind),
    proceedWithRag,
    safeReplyKey,
  });
  const selectionTransition = normalizeSelectionTransition(
    payload,
    params.options
  );

  const planning = buildModelTurnPlanning({
    payload,
    base: {
      proceedWithRag,
      dependsOnPriorContext,
      confidence,
    },
    message: params.message,
    options: optionsWithPrep,
    threadScaffold,
  });
  const retrievalQuery =
    ragQueryPreparation?.cleanedQuery ||
    planning.queryVariants[0] ||
    params.message;
  const retrievalIntent = proceedWithRag
    ? (createModelRetrievalIntent({
        query: retrievalQuery,
        language: payload?.retrievalIntent?.language,
        label: payload?.retrievalIntent?.label,
        confidence: payload?.retrievalIntent?.confidence,
        queryVariants: payload?.retrievalIntent?.queryVariants,
        reason: payload?.retrievalIntent?.reason,
        source: "turn_understanding",
      }) ??
      buildTurnRetrievalIntent(
        retrievalQuery,
        "Turn understanding returned no usable retrieval label."
      ))
    : null;

  return {
    kind,
    proceedWithRag,
    calendarAvailabilityRelevant,
    dependsOnPriorContext,
    safeReplyKey: proceedWithRag ? null : safeReplyKey,
    confidence,
    threadScaffold,
    selectionTransition,
    ...planning,
    ...(ragQueryPreparation ? { ragQueryPreparation } : {}),
    ...(retrievalIntent ? { retrievalIntent } : {}),
  };
}

function parseTurnUnderstandingPayload(
  content: string
): RawTurnUnderstandingPayload | null {
  const normalizedContent = String(content || "").trim();
  if (!normalizedContent) {
    return null;
  }

  try {
    return JSON.parse(normalizedContent) as RawTurnUnderstandingPayload;
  } catch {
    const embedded = normalizedContent.match(/\{[\s\S]*\}/);
    if (!embedded) return null;
    try {
      return JSON.parse(embedded[0]) as RawTurnUnderstandingPayload;
    } catch {
      return null;
    }
  }
}

function formatTurnUnderstandingConversationWindow(
  conversationWindow?: string
): string {
  const text = String(conversationWindow || "").trim();
  if (!text) return "";
  const maxChars = 2200;
  if (text.length <= maxChars) return text;

  const head = text.slice(0, 500).trim();
  const tail = text.slice(-1600).trim();
  return [
    head ? `Earlier context excerpt:\n${head}` : "",
    tail ? `Recent context excerpt:\n${tail}` : "",
  ]
    .filter(Boolean)
    .join("\n\n...\n\n");
}

/**
 * Retrieval takes its routing from the turn and otherwise makes its own
 * classifier call (2.5–4.7 s in production). A turn without a model label
 * carries the neutral intent that classifier returns when it can't decide.
 */
function buildTurnRetrievalIntent(
  query: string,
  reason: string
): RetrievalIntentClassification {
  return createNeutralRetrievalIntent({
    query,
    source: "turn_understanding",
    reason,
  });
}

function buildFallbackTurnUnderstanding(
  message: string,
  _conversationWindow?: string,
  options?: UnderstandCustomerTurnOptions
): TurnUnderstanding {
  const text = String(message || "").trim();
  const dependsOnPriorContext = Boolean(
    options?.hasUnresolvedNeed &&
      typeof options?.intentAnchor === "string" &&
      options.intentAnchor.trim()
  );

  const withPlanning = (
    base: BaseTurnUnderstanding,
    scaffold: TurnThreadScaffold
  ): TurnUnderstanding => {
    const ragQueryPreparation =
      options?.ragQueryPreparation ||
      (base.proceedWithRag
        ? buildHeuristicRagQueryPreparation(message)
        : undefined);

    return {
      ...base,
      threadScaffold: scaffold,
      selectionTransition: options?.activeSelection
        ? { action: "keep_existing", selectionLabel: null }
        : { action: "none", selectionLabel: null },
      ...buildFallbackTurnPlanning({
        message,
        proceedWithRag: base.proceedWithRag,
        dependsOnPriorContext: base.dependsOnPriorContext,
        options: ragQueryPreparation
          ? {
              ...options,
              ragQueryPreparation,
            }
          : options,
        threadScaffold: scaffold,
      }),
      ...(ragQueryPreparation ? { ragQueryPreparation } : {}),
      ...(base.proceedWithRag
        ? {
            retrievalIntent: buildTurnRetrievalIntent(
              ragQueryPreparation?.cleanedQuery || text,
              "Turn understanding model unavailable."
            ),
          }
        : {}),
    };
  };

  if (isIntegrationReactionStubMessage(text)) {
    return withPlanning(
      {
        kind: "acknowledgment",
        proceedWithRag: false,
        calendarAvailabilityRelevant: false,
        dependsOnPriorContext: false,
        safeReplyKey: "acknowledgment",
        confidence: "high",
      },
      {
        ...EMPTY_THREAD_SCAFFOLD,
        conversationalFollowup: true,
        trackThreadNeed: false,
      }
    );
  }

  return withPlanning(
    {
      kind: "unknown",
      proceedWithRag: true,
      calendarAvailabilityRelevant: false,
      dependsOnPriorContext,
      safeReplyKey: null,
      confidence: "low",
    },
    offlineThreadScaffold(text)
  );
}

function buildGroundedOptionTurnUnderstanding(
  message: string,
  options?: UnderstandCustomerTurnOptions
): TurnUnderstanding | null {
  const explicitOption = parseGroundedReplyOptionPayload(
    options?.quickReplyPayload
  );
  if (!explicitOption) {
    return null;
  }

  const cleanedQuery = explicitOption.quotedPriceText
    ? `${explicitOption.label} ${explicitOption.quotedPriceText}`.trim()
    : explicitOption.label;
  const ragQueryPreparation = buildRagQueryPreparationFromFields(
    message,
    {
      cleanedQuery,
      subQueries: [],
    },
    "fallback"
  );

  return {
    kind: "followup_question",
    proceedWithRag: true,
    calendarAvailabilityRelevant: false,
    dependsOnPriorContext: true,
    safeReplyKey: null,
    confidence: "high",
    asks: [explicitOption.label],
    coverageHints: [explicitOption.label],
    followUpMode: "resume_current_goal",
    followUpAnchor:
      explicitOption.label ||
      options?.activeSelection?.label ||
      options?.intentAnchor ||
      null,
    queryVariants: [cleanedQuery],
    planningSource: "fallback",
    threadScaffold: {
      ...EMPTY_THREAD_SCAFFOLD,
      trackThreadNeed: true,
      shortEntityReference: true,
    },
    selectionTransition: {
      action: options?.activeSelection ? "switch_selection" : "select_offer",
      selectionLabel: explicitOption.label,
    },
    ragQueryPreparation,
    retrievalIntent: buildTurnRetrievalIntent(
      cleanedQuery,
      "Customer picked a grounded option."
    ),
  };
}

/**
 * A shared location or a picked option answers the question the scenario
 * step just asked, so the turn is anchored on that question instead of an
 * older topic, and needs no model call to tell.
 */
function buildScenarioStepAnswerTurnUnderstanding(
  message: string,
  language: string,
  options?: UnderstandCustomerTurnOptions
): TurnUnderstanding | null {
  const question = compactOptionalString(options?.scenarioStepAnswer?.question);
  if (!question) return null;
  const ragQueryPreparation = buildRagQueryPreparationFromFields(
    message,
    { cleanedQuery: question, subQueries: [] },
    "fallback"
  );
  // Settled here, so retrieval skips its own classifier call.
  const retrievalIntent = createModelRetrievalIntent({
    query: question,
    language,
    label: "other",
    confidence: "high",
    reason: "scenario_step_answer",
    source: "turn_understanding",
  });

  return {
    kind: "data_sharing",
    proceedWithRag: true,
    calendarAvailabilityRelevant: false,
    dependsOnPriorContext: true,
    safeReplyKey: null,
    confidence: "high",
    asks: [],
    coverageHints: [question],
    followUpMode: "resume_current_goal",
    followUpAnchor: question,
    queryVariants: [question],
    planningSource: "fallback",
    threadScaffold: EMPTY_THREAD_SCAFFOLD,
    selectionTransition: options?.activeSelection
      ? { action: "keep_existing", selectionLabel: null }
      : { action: "none", selectionLabel: null },
    ragQueryPreparation,
    ...(retrievalIntent ? { retrievalIntent } : {}),
    scenarioStepQuestion: question,
  };
}

async function understandCustomerTurnImpl(
  message: string,
  language: string,
  conversationWindow?: string,
  options?: UnderstandCustomerTurnOptions
): Promise<TurnUnderstanding> {
  const text = String(message || "").trim();
  if (!text) {
    return {
      kind: "unknown",
      proceedWithRag: true,
      calendarAvailabilityRelevant: false,
      dependsOnPriorContext: false,
      safeReplyKey: null,
      confidence: "low",
      threadScaffold: EMPTY_THREAD_SCAFFOLD,
      selectionTransition: { action: "none", selectionLabel: null },
      ...emptyTurnPlanning("fallback"),
    };
  }

  if (isIntegrationReactionStubMessage(text)) {
    return buildFallbackTurnUnderstanding(text, conversationWindow, options);
  }

  const explicitGroundedOptionTurn = buildGroundedOptionTurnUnderstanding(
    text,
    options
  );
  if (explicitGroundedOptionTurn) {
    airiReplyLogger.info("airi.reply.turn_understanding", {
      outcome: "structured_quick_reply",
      durationMs: 0,
      language,
      provider: null,
      model: null,
      hasConversationWindow: Boolean(conversationWindow),
      hasIntentAnchor: Boolean(options?.intentAnchor),
      hasUnresolvedNeed: Boolean(options?.hasUnresolvedNeed),
      kind: explicitGroundedOptionTurn.kind,
      confidence: explicitGroundedOptionTurn.confidence,
      proceedWithRag: explicitGroundedOptionTurn.proceedWithRag,
      calendarAvailabilityRelevant:
        explicitGroundedOptionTurn.calendarAvailabilityRelevant,
      dependsOnPriorContext: explicitGroundedOptionTurn.dependsOnPriorContext,
      safeReplyKey: explicitGroundedOptionTurn.safeReplyKey,
      followUpMode: explicitGroundedOptionTurn.followUpMode,
      planningSource: explicitGroundedOptionTurn.planningSource,
      selectionTransitionAction:
        explicitGroundedOptionTurn.selectionTransition.action,
      asksCount: explicitGroundedOptionTurn.asks.length,
      queryVariantsCount: explicitGroundedOptionTurn.queryVariants.length,
      asks: compactLogList(explicitGroundedOptionTurn.asks, { maxItems: 2 }),
      queryVariants: compactLogList(explicitGroundedOptionTurn.queryVariants, {
        maxItems: 2,
      }),
    });
    return explicitGroundedOptionTurn;
  }

  const scenarioStepAnswerTurn = buildScenarioStepAnswerTurnUnderstanding(
    text,
    language,
    options
  );
  if (scenarioStepAnswerTurn) {
    airiReplyLogger.info("airi.reply.turn_understanding", {
      outcome: "scenario_step_answer",
      durationMs: 0,
      language,
      provider: null,
      model: null,
      answerKind: options?.scenarioStepAnswer?.kind || null,
      hasConversationWindow: Boolean(conversationWindow),
      kind: scenarioStepAnswerTurn.kind,
      followUpMode: scenarioStepAnswerTurn.followUpMode,
      planningSource: scenarioStepAnswerTurn.planningSource,
      queryVariants: compactLogList(scenarioStepAnswerTurn.queryVariants, {
        maxItems: 1,
      }),
    });
    return scenarioStepAnswerTurn;
  }

  const fallback = buildFallbackTurnUnderstanding(
    text,
    conversationWindow,
    options
  );
  const startedAt = Date.now();
  const inferenceDeadline = createInferenceDeadline(
    TURN_UNDERSTANDING_TIMEOUT_MS
  );
  let provider: string | null = null;
  let model: string | null = null;

  const logTurnUnderstanding = (
    outcome: "classified" | "fallback",
    result: TurnUnderstanding
  ) => {
    airiReplyLogger.info("airi.reply.turn_understanding", {
      outcome,
      durationMs: Date.now() - startedAt,
      language,
      provider,
      model,
      hasConversationWindow: Boolean(conversationWindow),
      hasIntentAnchor: Boolean(options?.intentAnchor),
      hasUnresolvedNeed: Boolean(options?.hasUnresolvedNeed),
      kind: result.kind,
      confidence: result.confidence,
      proceedWithRag: result.proceedWithRag,
      calendarAvailabilityRelevant: result.calendarAvailabilityRelevant,
      dependsOnPriorContext: result.dependsOnPriorContext,
      safeReplyKey: result.safeReplyKey,
      followUpMode: result.followUpMode,
      planningSource: result.planningSource,
      selectionTransitionAction: result.selectionTransition.action,
      asksCount: result.asks.length,
      queryVariantsCount: result.queryVariants.length,
      asks: compactLogList(result.asks, { maxItems: 2 }),
      queryVariants: compactLogList(result.queryVariants, { maxItems: 2 }),
    });
  };

  try {
    const langMaps: Record<string, string> = {
      en: "English",
      ru: "Russian",
      kz: "Kazakh",
      uz: "Uzbek",
    };
    const targetLanguage = langMaps[language] || "English";
    const formattedConversationWindow =
      formatTurnUnderstandingConversationWindow(conversationWindow);
    const contextLines = [
      formattedConversationWindow
        ? `Conversation window:\n${formattedConversationWindow}`
        : "Conversation window is unavailable.",
      options?.intentAnchor
        ? `Current unresolved intent anchor:\n${options.intentAnchor.slice(0, 220)}`
        : "",
      options?.currentGoal
        ? `Current goal:\n${String(options.currentGoal).slice(0, 220)}`
        : "",
      options?.lastGrounding?.intentAnchor
        ? `Last grounded topic:\n${String(options.lastGrounding.intentAnchor).slice(0, 220)}`
        : "",
      options?.activeSelection
        ? `Current locked selection:\n${[
            `label=${options.activeSelection.label}`,
            `kind=${options.activeSelection.kind}`,
            options.activeSelection.quotedPriceText
              ? `quoted_price=${options.activeSelection.quotedPriceText}`
              : "",
          ]
            .filter(Boolean)
            .join("; ")}`
        : "Current locked selection: none.",
      options?.unresolvedNeeds && options.unresolvedNeeds.length > 0
        ? `Open needs:\n${options.unresolvedNeeds.slice(0, 4).join("; ")}`
        : "",
      `Has unresolved need: ${options?.hasUnresolvedNeed ? "yes" : "no"}`,
    ].filter(Boolean);

    const textModelTimeoutMs = inferenceDeadline.nextTimeoutMs(
      TURN_UNDERSTANDING_TIMEOUT_MS
    );
    if (!textModelTimeoutMs) {
      throw new Error("Turn-understanding inference deadline exhausted");
    }

    const turnModel = getLightTextModel();
    const response = await chatCompletionWithFallback({
      model: turnModel,
      analytics: options?.workspaceId
        ? {
            workspaceId: options.workspaceId,
            conversationId: options.conversationId || null,
            operation: "airi.reply.turn_understanding",
            sourceService: "web.airi.reply",
          }
        : undefined,
      messages: [
        {
          role: "system",
          content: `${SYSTEM_PROMPT}\nRespond in ${targetLanguage}.`,
        },
        {
          role: "user",
          content: [
            ...contextLines,
            `Latest customer message:\n"${text}"`,
          ].join("\n\n"),
        },
      ],
      responseFormat: { type: "json_object" },
      generationConfig: {
        responseSchema: TURN_UNDERSTANDING_RESPONSE_SCHEMA,
      },
      temperature: 0.1,
      resilience: {
        maxRetries: 0,
        timeoutMs: textModelTimeoutMs,
      },
    });
    provider = response.provider || null;
    model = response.model || turnModel;

    const result = normalizeTurnUnderstanding(
      parseTurnUnderstandingPayload(response.content || ""),
      {
        message: text,
        options,
      }
    );
    logTurnUnderstanding("classified", result);
    return result;
  } catch (error) {
    if (isWorkspaceAiPolicyError(error)) throw error;
    airiReplyLogger.error("airi.reply.turn_understanding", error, {
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      language,
      provider,
      model,
      hasConversationWindow: Boolean(conversationWindow),
      kind: fallback.kind,
      confidence: fallback.confidence,
      proceedWithRag: fallback.proceedWithRag,
      calendarAvailabilityRelevant: fallback.calendarAvailabilityRelevant,
      followUpMode: fallback.followUpMode,
      planningSource: fallback.planningSource,
      asksCount: fallback.asks.length,
      queryVariantsCount: fallback.queryVariants.length,
      formattedError: formatError(error),
    });
    logTurnUnderstanding("fallback", fallback);
    return fallback;
  }
}

export const understandCustomerTurn = traceableChain(
  understandCustomerTurnImpl,
  {
    name: "airi.reply.turn_understanding",
    tags: ["airi", "reply", "turn-understanding"],
    processInputs: inputs => {
      const payload = "args" in inputs ? inputs.args : [inputs];
      const [message, language, conversationWindow, options] = payload as [
        string,
        string,
        string | undefined,
        UnderstandCustomerTurnOptions | undefined,
      ];
      return {
        language,
        message_preview: previewText(message, 240),
        has_conversation_window: Boolean(conversationWindow),
        conversation_window_length: String(conversationWindow || "").length,
        intent_anchor_preview: previewText(options?.intentAnchor, 160),
        current_goal_preview: previewText(options?.currentGoal, 160),
        active_selection_label_preview: previewText(
          options?.activeSelection?.label,
          120
        ),
        has_unresolved_need: Boolean(options?.hasUnresolvedNeed),
        unresolved_needs: previewStringArray(
          options?.unresolvedNeeds || [],
          4,
          120
        ),
      };
    },
    processOutputs: outputs => {
      const result = (
        "outputs" in outputs ? outputs.outputs : outputs
      ) as TurnUnderstanding;
      return {
        kind: result.kind,
        confidence: result.confidence,
        proceed_with_rag: result.proceedWithRag,
        calendar_availability_relevant: result.calendarAvailabilityRelevant,
        depends_on_prior_context: result.dependsOnPriorContext,
        follow_up_mode: result.followUpMode,
        selection_transition_action: result.selectionTransition.action,
        selection_label_preview: previewText(
          result.selectionTransition.selectionLabel,
          120
        ),
        planning_source: result.planningSource,
        asks: previewStringArray(result.asks, 4, 120),
        query_variants: previewStringArray(result.queryVariants, 4, 120),
      };
    },
  }
);
