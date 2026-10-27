export type LlmAnalyticsTranslator = (
  key: string,
  values?: Record<string, string | number>
) => string;

export interface LlmAnalyticsFormatters {
  number: (value: number) => string;
  compactNumber: (value: number) => string;
  percent: (value: number) => string;
  currency: (value: number) => string;
  milliseconds: (value: number) => string;
  perSecond: (value: number) => string;
  score: (value: number) => string;
  spendShare: (cost: number, totalCost: number) => string;
  shortDate: (value: string | null | undefined) => string | null;
  dateTime: (value: string | null | undefined) => string | null;
}

export function optionalNumberField(
  row: Record<string, unknown> | null | undefined,
  key: string
): number | null {
  const value = row?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export const LLM_OPERATION_MESSAGE_KEYS = {
  "ai.chat_completion": "operations.items.genericChatCompletion",
  "airi.coach": "operations.items.airiCoach",
  "airi_chat.title": "operations.items.airiChatTitle",
  "airi_chat.product_capabilities":
    "operations.items.airiChatProductCapabilities",
  "airi_chat.whatsapp_template_draft":
    "operations.items.airiChatWhatsAppTemplateDraft",
  "airi_chat.whatsapp_flow_draft": "operations.items.airiChatWhatsAppFlowDraft",
  "airi_chat.image_generation_brief":
    "operations.items.airiChatImageGenerationBrief",
  "airi_chat.opportunity_scan": "operations.items.airiChatOpportunityScan",
  "airi_chat.campaign_package": "operations.items.airiChatCampaignPackage",
  "airi_chat.intent_classification":
    "operations.items.airiChatIntentClassification",
  "airi_chat.reply": "operations.items.airiChatReply",
  "airi.rag.generate_response": "operations.items.ragGenerateResponse",
  "airi.rag.retrieval_intent_classifier":
    "operations.items.ragRetrievalIntentClassifier",
  "airi.rag.grounding_reflection": "operations.items.ragGroundingReflection",
  "airi.rag.verifier": "operations.items.ragVerifier",
  "airi.rag.reranker": "operations.items.ragReranker",
  "airi.rag.hyde": "operations.items.ragHyde",
  "airi.rag.query_cleaner": "operations.items.ragQueryCleaner",
  "airi.rag.prepare_query": "operations.items.ragPrepareQuery",
  "airi.reply.generate": "operations.items.replyGenerate",
  "airi.reply.turn_understanding": "operations.items.replyTurnUnderstanding",
  "airi.reply.load_thread_context": "operations.items.replyLoadThreadContext",
  "airi.reply.final_generation": "operations.items.replyFinalGeneration",
  "airi.reply.fallback_recovery_generation":
    "operations.items.replyFallbackRecoveryGeneration",
  "airi.reply.answer_coverage_judge":
    "operations.items.replyAnswerCoverageJudge",
} as const;

export const LLM_ENUM_MESSAGE_KEYS = {
  fallbackAction: {
    use_generated_reply: "enums.fallbackAction.useGeneratedReply",
    grounded_recovery: "enums.fallbackAction.groundedRecovery",
    intent_fallback: "enums.fallbackAction.intentFallback",
    generic_clarification: "enums.fallbackAction.genericClarification",
    clarifying_generation: "enums.fallbackAction.clarifyingGeneration",
  },
  fallbackReason: {
    generated_reply_complete: "enums.fallbackReason.generatedReplyComplete",
    empty_generated_reply: "enums.fallbackReason.emptyGeneratedReply",
    incomplete_generated_reply: "enums.fallbackReason.incompleteGeneratedReply",
    hyde_leakage_guard: "enums.fallbackReason.hydeLeakageGuard",
    missing_ask_coverage: "enums.fallbackReason.missingAskCoverage",
    grounded_context_available: "enums.fallbackReason.groundedContextAvailable",
    missing_knowledge_signal: "enums.fallbackReason.missingKnowledgeSignal",
    generic_ungrounded_turn: "enums.fallbackReason.genericUngroundedTurn",
    clarifying_generation_allowed:
      "enums.fallbackReason.clarifyingGenerationAllowed",
    evidence_policy_clarify: "enums.fallbackReason.evidencePolicyClarify",
    evidence_policy_handoff: "enums.fallbackReason.evidencePolicyHandoff",
  },
  resultType: {
    verified_snippet: "enums.resultType.verifiedSnippet",
    suggestion_with_ai: "enums.resultType.suggestionWithAi",
    ai_reply: "enums.resultType.aiReply",
    fallback: "enums.resultType.fallback",
    evidence_retrieve: "enums.resultType.evidenceRetrieve",
    evidence_context: "enums.resultType.evidenceContext",
    no_context: "enums.resultType.noContext",
  },
  turnKind: {
    greeting: "enums.turnKind.greeting",
    presence_check: "enums.turnKind.presenceCheck",
    meta_question: "enums.turnKind.metaQuestion",
    thanks: "enums.turnKind.thanks",
    farewell: "enums.turnKind.farewell",
    acknowledgment: "enums.turnKind.acknowledgment",
    impatience: "enums.turnKind.impatience",
    data_sharing: "enums.turnKind.dataSharing",
    question: "enums.turnKind.question",
    followup_question: "enums.turnKind.followupQuestion",
    unknown: "enums.turnKind.unknown",
  },
  channel: {
    whatsapp: "enums.channel.whatsApp",
    telegram: "enums.channel.telegram",
    email: "enums.channel.email",
    widget: "enums.channel.widget",
    instagram: "enums.channel.instagram",
    facebook: "enums.channel.facebook",
  },
  retrievalPath: {
    snippet: "enums.retrievalPath.snippet",
    kb: "enums.retrievalPath.knowledgeBase",
    blended: "enums.retrievalPath.blended",
    none: "enums.retrievalPath.none",
  },
  issueType: {
    knowledge_gap: "enums.issueType.knowledgeGap",
    unsupported_answer: "enums.issueType.unsupportedAnswer",
    bad_retrieval: "enums.issueType.badRetrieval",
    scenario_action_mismatch: "enums.issueType.scenarioActionMismatch",
    escalation_issue: "enums.issueType.escalationIssue",
    tone_policy_issue: "enums.issueType.tonePolicyIssue",
    cost_latency_spike: "enums.issueType.costLatencySpike",
    other: "enums.issueType.other",
  },
  severity: {
    critical: "enums.severity.critical",
    high: "enums.severity.high",
    medium: "enums.severity.medium",
    low: "enums.severity.low",
    info: "enums.severity.info",
  },
} as const;

export type LlmEnumKind = keyof typeof LLM_ENUM_MESSAGE_KEYS;

const INTL_LOCALES: Record<string, string> = {
  en: "en-US",
  ru: "ru-RU",
  kz: "kk-KZ",
};

interface LlmIntlFormatterSet {
  number: Intl.NumberFormat;
  compactNumber: Intl.NumberFormat;
  percent: Intl.NumberFormat;
  currency: Intl.NumberFormat;
  preciseCurrency: Intl.NumberFormat;
  dateTime: Intl.DateTimeFormat;
  shortDate: Intl.DateTimeFormat;
}

const llmIntlFormattersByLocale = new Map<string, LlmIntlFormatterSet>();

export function resolveLlmIntlLocale(locale: string): string {
  return INTL_LOCALES[locale] ?? locale;
}

function getLlmIntlFormatters(intlLocale: string): LlmIntlFormatterSet {
  const cached = llmIntlFormattersByLocale.get(intlLocale);
  if (cached) return cached;

  const formatters: LlmIntlFormatterSet = {
    number: new Intl.NumberFormat(intlLocale, {
      maximumFractionDigits: 1,
    }),
    compactNumber: new Intl.NumberFormat(intlLocale, {
      notation: "compact",
      maximumFractionDigits: 1,
    }),
    percent: new Intl.NumberFormat(intlLocale, {
      style: "percent",
      maximumFractionDigits: 1,
    }),
    currency: new Intl.NumberFormat(intlLocale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
    preciseCurrency: new Intl.NumberFormat(intlLocale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }),
    dateTime: new Intl.DateTimeFormat(intlLocale, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
    shortDate: new Intl.DateTimeFormat(intlLocale, {
      dateStyle: "medium",
      timeZone: "UTC",
    }),
  };
  llmIntlFormattersByLocale.set(intlLocale, formatters);
  return formatters;
}

function operationDetailKey(operation: string): string {
  if (operation === "ai.chat_completion") return "operations.details.generic";
  if (operation === "airi.coach") return "operations.details.coach";
  if (operation.startsWith("airi_chat.")) return "operations.details.airiChat";
  if (operation.startsWith("airi.rag.")) return "operations.details.rag";
  if (operation.startsWith("airi.reply.")) return "operations.details.reply";
  return "operations.details.unknown";
}

export function presentLlmOperation(
  operation: string,
  t: LlmAnalyticsTranslator
): { label: string; detail: string } {
  const messageKey = (
    LLM_OPERATION_MESSAGE_KEYS as Record<string, string | undefined>
  )[operation];

  if (!messageKey) {
    return {
      label: t("common.unknownValue", { value: operation }),
      detail: t("operations.details.unknown"),
    };
  }

  return {
    label: t(messageKey),
    detail: t(operationDetailKey(operation)),
  };
}

export function presentLlmEnum(
  kind: LlmEnumKind,
  value: string,
  t: LlmAnalyticsTranslator
): string {
  const messageKey = (
    LLM_ENUM_MESSAGE_KEYS[kind] as Record<string, string | undefined>
  )[value];
  return messageKey ? t(messageKey) : t("common.unknownValue", { value });
}

export function createLlmAnalyticsFormatters(
  locale: string,
  t: LlmAnalyticsTranslator
): LlmAnalyticsFormatters {
  const intlLocale = resolveLlmIntlLocale(locale);
  const intl = getLlmIntlFormatters(intlLocale);

  const number = (value: number) => intl.number.format(value);
  const currency = (value: number) => {
    const formatter =
      Math.abs(value) < 0.01 && value !== 0
        ? intl.preciseCurrency
        : intl.currency;
    return formatter.format(Number.isFinite(value) ? Math.max(0, value) : 0);
  };
  const milliseconds = (value: number) => {
    const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
    return safeValue >= 1_000
      ? t("units.seconds", { value: number(safeValue / 1_000) })
      : t("units.milliseconds", { value: number(Math.round(safeValue)) });
  };

  return {
    number,
    compactNumber: (value: number) => intl.compactNumber.format(value),
    percent: (value: number) => intl.percent.format(value / 100),
    currency,
    milliseconds,
    perSecond: (value: number) =>
      t("units.perSecond", { value: number(value) }),
    score: (value: number) =>
      t("units.scoreOutOf100", { value: number(value) }),
    spendShare: (cost: number, totalCost: number) => {
      const share =
        Number.isFinite(cost) && Number.isFinite(totalCost) && totalCost > 0
          ? Math.min(100, Math.max(0, (cost / totalCost) * 100))
          : 0;
      return t("units.shareOfSpend", { value: number(share) });
    },
    shortDate: (value: string | null | undefined) => {
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : intl.shortDate.format(date);
    },
    dateTime: (value: string | null | undefined) => {
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : intl.dateTime.format(date);
    },
  };
}
