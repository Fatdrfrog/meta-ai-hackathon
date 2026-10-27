import {
  chatCompletionWithFallback,
  getDefaultAIChatProviderOrder,
  getLightStructuredJsonGenerationConfig,
  getLightTextModel,
} from "@/lib/ai";
import { normalizeComparableText } from "@/lib/airi/reply/thread/reply-text-utils";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";

export type AnswerCoveragePlan = {
  asksDetected: string[];
  requiresCoverageCheck: boolean;
};

export type AnswerCoverageStatus =
  | "answered"
  | "partially_answered"
  | "not_answered"
  | "unanswerable_acknowledged";

export type AnswerCoverageJudgeItem = {
  ask: string;
  status: AnswerCoverageStatus;
  confidence: "low" | "medium" | "high";
  answerSpan: string;
  reason: string;
};

export type AnswerCoverageSource =
  | "llm_judge"
  | "skipped"
  | "judge_unavailable";

export type AnswerCoverageResult = {
  asksDetected: string[];
  asksAnswered: string[];
  missingAsks: string[];
  ambiguousMissingAsks: string[];
  fullyCovered: boolean;
  coverageSource: AnswerCoverageSource;
  judgeItems: AnswerCoverageJudgeItem[];
  repairInstruction: string | null;
};

const ANSWER_COVERAGE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  required: ["items", "repairInstruction"],
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: [
          "askIndex",
          "ask",
          "status",
          "confidence",
          "answerSpan",
          "reason",
        ],
        properties: {
          askIndex: { type: "INTEGER" },
          ask: { type: "STRING" },
          status: {
            type: "STRING",
            format: "enum",
            enum: [
              "answered",
              "partially_answered",
              "not_answered",
              "unanswerable_acknowledged",
            ],
          },
          confidence: {
            type: "STRING",
            format: "enum",
            enum: ["low", "medium", "high"],
          },
          answerSpan: { type: "STRING" },
          reason: { type: "STRING" },
        },
        propertyOrdering: [
          "askIndex",
          "ask",
          "status",
          "confidence",
          "answerSpan",
          "reason",
        ],
      },
    },
    repairInstruction: { type: "STRING", nullable: true },
  },
  propertyOrdering: ["items", "repairInstruction"],
};

function dedupeComparable(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = String(value || "").trim();
    const normalized = normalizeComparableText(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }

  return result;
}

function normalizeCoverageStatus(value: unknown): AnswerCoverageStatus {
  switch (value) {
    case "answered":
    case "partially_answered":
    case "not_answered":
    case "unanswerable_acknowledged":
      return value;
    default:
      return "not_answered";
  }
}

function normalizeCoverageConfidence(
  value: unknown
): AnswerCoverageJudgeItem["confidence"] {
  switch (value) {
    case "low":
    case "medium":
    case "high":
      return value;
    default:
      return "medium";
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/u);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

function normalizeAskIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value > 0 ? value : null;
}

function resolvePlannedAsk(params: {
  askIndex: number | null;
  ask: string;
  plannedAsks: string[];
  usedAsks: Set<string>;
}): string | null {
  if (params.askIndex !== null) {
    const indexedAsk = params.plannedAsks[params.askIndex - 1];
    if (indexedAsk && !params.usedAsks.has(indexedAsk)) {
      return indexedAsk;
    }
  }

  const normalizedAsk = normalizeComparableText(params.ask);
  if (!normalizedAsk) return null;

  const exact = params.plannedAsks.find(
    ask =>
      !params.usedAsks.has(ask) &&
      normalizeComparableText(ask) === normalizedAsk
  );
  if (exact) return exact;

  return null;
}

function normalizeJudgeItems(
  value: unknown,
  plannedAsks: string[]
): AnswerCoverageJudgeItem[] {
  if (!Array.isArray(value)) return [];

  const usedAsks = new Set<string>();
  const items: AnswerCoverageJudgeItem[] = [];

  for (const rawItem of value) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    const plannedAsk = resolvePlannedAsk({
      askIndex: normalizeAskIndex(item.askIndex),
      ask: readTrimmedString(item.ask),
      plannedAsks,
      usedAsks,
    });
    if (!plannedAsk) continue;

    usedAsks.add(plannedAsk);
    items.push({
      ask: plannedAsk,
      status: normalizeCoverageStatus(item.status),
      confidence: normalizeCoverageConfidence(item.confidence),
      answerSpan: readTrimmedString(item.answerSpan).slice(0, 500),
      reason: readTrimmedString(item.reason).slice(0, 500),
    });
  }

  for (const ask of plannedAsks) {
    if (usedAsks.has(ask)) continue;
    items.push({
      ask,
      status: "not_answered",
      confidence: "medium",
      answerSpan: "",
      reason: "The judge did not return an assessment for this ask.",
    });
  }

  return items;
}

function buildCoverageResult(params: {
  plan: AnswerCoveragePlan;
  coverageSource: AnswerCoverageSource;
  judgeItems?: AnswerCoverageJudgeItem[];
  repairInstruction?: string | null;
}): AnswerCoverageResult {
  const judgeItems = params.judgeItems || [];
  const answeredStatusSet = new Set<AnswerCoverageStatus>([
    "answered",
    "unanswerable_acknowledged",
  ]);
  const asksAnswered = judgeItems
    .filter(item => answeredStatusSet.has(item.status))
    .map(item => item.ask);
  const missingAsks = judgeItems
    .filter(item => !answeredStatusSet.has(item.status))
    .map(item => item.ask);
  const ambiguousMissingAsks = judgeItems
    .filter(item => item.status === "partially_answered")
    .map(item => item.ask);

  return {
    asksDetected: params.plan.asksDetected,
    asksAnswered,
    missingAsks,
    ambiguousMissingAsks,
    fullyCovered: missingAsks.length === 0,
    coverageSource: params.coverageSource,
    judgeItems,
    repairInstruction: params.repairInstruction || null,
  };
}

export function buildAnswerCoveragePlan(params: {
  openAsks?: string[];
  followUpAnchor?: string | null;
}): AnswerCoveragePlan {
  const hasOpenAsks = Boolean(params.openAsks && params.openAsks.length > 0);
  const fallbackAsks =
    !hasOpenAsks && params.followUpAnchor ? [params.followUpAnchor] : [];
  const asksDetected = dedupeComparable([
    ...(params.openAsks || []),
    ...fallbackAsks,
  ]).slice(0, 4);

  return {
    asksDetected,
    // Hard ask-coverage gating is only worth the latency for compound turns.
    // Single-ask turns still get judge telemetry, but should not trigger
    // repair passes on their own.
    requiresCoverageCheck: asksDetected.length >= 2,
  };
}

export function renderAnswerCoverageBlock(
  plan: AnswerCoveragePlan,
  options?: { missingAsks?: string[] }
): string | undefined {
  if (
    plan.asksDetected.length === 0 ||
    (!plan.requiresCoverageCheck &&
      (!options?.missingAsks || options.missingAsks.length === 0))
  ) {
    return undefined;
  }

  const lines = [
    "ANSWER COVERAGE REQUIREMENTS:",
    "- Cover every customer ask in one reply.",
    "- If one ask cannot be answered from grounded context, explicitly say that specific ask is still unconfirmed.",
    "- Do not answer only the first ask and ignore the rest.",
    "Asks to cover:",
    ...plan.asksDetected.map((ask, index) => `${index + 1}. ${ask}`),
  ];

  if (options?.missingAsks && options.missingAsks.length > 0) {
    lines.push(
      `Missing asks from the previous draft: ${options.missingAsks.join("; ")}`
    );
  }

  return lines.join("\n");
}

export async function evaluateAnswerCoverage(params: {
  reply: string;
  plan: AnswerCoveragePlan;
  latestCustomerMessage?: string;
  conversationContext?: string;
  groundedContext?: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  timeoutMs?: number;
}): Promise<AnswerCoverageResult> {
  if (!params.plan.requiresCoverageCheck) {
    return buildCoverageResult({
      plan: params.plan,
      coverageSource: "skipped",
    });
  }

  const timeoutMs = Math.min(5_000, params.timeoutMs ?? 5_000);
  if (timeoutMs < 1_000) {
    return buildCoverageResult({
      plan: params.plan,
      coverageSource: "judge_unavailable",
    });
  }

  const systemPrompt = [
    "You are an answer coverage judge for a customer support AI assistant.",
    "Decide whether the assistant reply covers each customer ask.",
    "Evaluate semantic coverage, not keyword overlap.",
    "An ask is covered when the reply directly answers it, or when the reply explicitly says that the grounded context does not confirm the answer.",
    "Do not require exact wording. Do not reward vague acknowledgement.",
    "Return JSON only.",
  ].join("\n");

  const userPrompt = [
    `Latest customer message:\n${params.latestCustomerMessage || ""}`,
    params.conversationContext
      ? `Conversation context:\n${params.conversationContext}`
      : "",
    params.groundedContext
      ? `Grounded context available to the assistant:\n${params.groundedContext}`
      : "",
    "Customer asks to judge:",
    ...params.plan.asksDetected.map((ask, index) => `${index + 1}. ${ask}`),
    `Assistant reply:\n${params.reply}`,
    [
      "For each ask, return:",
      "- askIndex must be the 1-based number from the customer asks list.",
      '- status "answered" only when the reply substantively answers that ask.',
      '- status "unanswerable_acknowledged" when the reply explicitly says that ask is not confirmed or not available from context.',
      '- status "partially_answered" when the reply touches the ask but leaves key requested information out.',
      '- status "not_answered" when the ask is ignored or only vaguely acknowledged.',
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const response = await chatCompletionWithFallback({
      model: getLightTextModel(),
      providerOrder: getDefaultAIChatProviderOrder(),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      responseFormat: { type: "json_object" },
      generationConfig: {
        ...getLightStructuredJsonGenerationConfig(),
        responseSchema: ANSWER_COVERAGE_RESPONSE_SCHEMA,
      },
      temperature: 0,
      resilience: {
        maxRetries: 0,
        timeoutMs,
      },
      analytics: {
        workspaceId: params.workspaceId || null,
        conversationId: params.conversationId || null,
        operation: "airi.reply.answer_coverage_judge",
        inputText: `${systemPrompt}\n\n${userPrompt}`,
        sourceService: "web.airi.reply",
        metadata: {
          asksCount: params.plan.asksDetected.length,
          requiresCoverageCheck: params.plan.requiresCoverageCheck,
        },
      },
    });
    const parsed = parseJsonObject(response.content || "");
    if (!parsed || !Array.isArray(parsed.items)) {
      throw new Error("Answer coverage judge returned invalid JSON");
    }
    const judgeItems = normalizeJudgeItems(
      parsed.items,
      params.plan.asksDetected
    );
    return buildCoverageResult({
      plan: params.plan,
      coverageSource: "llm_judge",
      judgeItems,
      repairInstruction: readTrimmedString(parsed?.repairInstruction),
    });
  } catch {
    return buildCoverageResult({
      plan: params.plan,
      coverageSource: "judge_unavailable",
    });
  }
}
