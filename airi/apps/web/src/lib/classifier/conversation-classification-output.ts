import type { AIChatMessage } from "@/lib/ai";
import {
  getAiriLanguageName,
  LANGUAGE_INSTRUCTIONS,
} from "@/lib/airi/shared/language-policy";
import {
  CLASSIFICATION_OUTPUT_LIMITS,
} from "@/lib/classifier/conversation-analysis-constants";
import {
  CLASSIFICATION_ENTITY_TYPES,
  CLASSIFICATION_KEY_MOMENT_TYPES,
  type ClassificationEntityType,
  type ClassificationKeyMomentType,
  type ClassificationResult,
  type ConversationClassificationBusinessContext,
} from "@/lib/classifier/conversation-analysis-types";
import { InvalidClassificationOutputError } from "@/lib/classifier/conversation-classification-errors";
import { parseClassificationPaymentEvidence } from "@/lib/classifier/conversation-payment-evidence";
import {
  buildTaxonomyDecisionGuide,
  type WorkspaceTaxonomy,
} from "@/lib/classifier/taxonomy";
import { readNonEmptyString } from "@icecore/shared/lib/value-utils";

const REQUIRED_RESULT_KEYS = [
  "category",
  "priority",
  "sentiment",
  "summary",
  "action",
  "tags",
  "confidence",
  "extracted_entities",
  "key_moments",
  "is_best_practice",
] as const;
const OPTIONAL_RESULT_KEYS = [
  "agent_performance_scorecard",
  "payment_evidence",
] as const;
const SCORECARD_SCORE_KEYS = [
  "empathy_score",
  "clarity_score",
  "script_adherence_score",
  "resolution_efficiency_score",
] as const;
const PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
const SENTIMENTS = new Set(["positive", "neutral", "negative"]);
const ENTITY_TYPES = new Set<string>(CLASSIFICATION_ENTITY_TYPES);
const KEY_MOMENT_TYPES = new Set<string>(CLASSIFICATION_KEY_MOMENT_TYPES);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  const constructor = Object.prototype.hasOwnProperty.call(
    prototype,
    "constructor"
  )
    ? (prototype as { constructor?: unknown }).constructor
    : undefined;
  return (
    typeof constructor === "function" && constructor.name === "Object"
  );
}

function assertExactKeys(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new InvalidClassificationOutputError(path);
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key)) ||
    keys.some(key => !allowed.has(key))
  ) {
    if (path === "$root") {
      const missing = required.find(
        key => !Object.prototype.hasOwnProperty.call(value, key)
      );
      throw new InvalidClassificationOutputError(missing ?? path);
    }
    throw new InvalidClassificationOutputError(path);
  }
}

function assertCanonicalText(
  value: unknown,
  path: string,
  maximumLength: number
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim().length < 1 ||
    value !== value.trim()
  ) {
    throw new InvalidClassificationOutputError(path);
  }
}

function assertFiniteRange(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new InvalidClassificationOutputError(path);
  }
}

export function buildConversationClassificationPrompt(input: {
  businessContext: ConversationClassificationBusinessContext;
  conversationContext: string;
  textForAnalysis: string;
  taxonomy: WorkspaceTaxonomy;
  existingCategory: string | null;
  presentedMessageCount: number;
  repairReason?: string;
  paymentEvidenceMessageIndices?: number[];
}): AIChatMessage[] {
  const language = input.businessContext.airiLanguage;
  const languageName = getAiriLanguageName(language);
  const repairReason = readNonEmptyString(input.repairReason, {
    normalizeWhitespace: true,
    maxLength: CLASSIFICATION_OUTPUT_LIMITS.repairReasonLength,
  });
  return [
    {
      role: "system",
      content: [
        "You are an expert QA manager and conversation intelligence analyst.",
        `The company output language is ${languageName} (${language}).`,
        LANGUAGE_INSTRUCTIONS[language],
        "Understand the conversation in its original language, but write every text field in the company output language.",
        "Messages tagged [Bot] are automated. Score only human-agent behavior in agent_performance_scorecard.",
        "Choose exactly one case-sensitive category from the supplied taxonomy, based on the customer's dominant current actionable intent.",
        "Return one JSON object and no markdown or explanation.",
        `Required keys: category, priority, sentiment, summary, action, tags, confidence, extracted_entities, key_moments, is_best_practice. Optional keys: agent_performance_scorecard, payment_evidence. Summary and action are at most ${CLASSIFICATION_OUTPUT_LIMITS.summaryLength} characters.`,
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Business context: ${input.businessContext.businessContext}`,
        input.conversationContext
          ? `Conversation context:\n${input.conversationContext}`
          : "Conversation context: none",
        `Available categories: ${input.taxonomy.labels.join(", ")}`,
        `Taxonomy guidance:\n${buildTaxonomyDecisionGuide(input.taxonomy)}`,
        `Existing category: ${input.existingCategory || "none"}`,
        `Presented message count: ${input.presentedMessageCount}`,
        "Conversation transcript:",
        input.textForAnalysis,
        "Output rules:",
        '- priority is exactly "low", "medium", "high", or "urgent".',
        '- sentiment is exactly "positive", "neutral", or "negative".',
        `- tags has at most ${CLASSIFICATION_OUTPUT_LIMITS.tagCount} canonical strings, each at most ${CLASSIFICATION_OUTPUT_LIMITS.tagLength} characters.`,
        '- confidence has exactly category, priority, and sentiment numbers from 0 through 1.',
        `- extracted_entities has at most ${CLASSIFICATION_OUTPUT_LIMITS.entityCount} exact {type,value} entries; type is exactly one of: ${CLASSIFICATION_ENTITY_TYPES.join(", ")}.`,
        `- key_moments has at most ${CLASSIFICATION_OUTPUT_LIMITS.keyMomentCount} exact {type,message_index} entries; type is exactly one of: ${CLASSIFICATION_KEY_MOMENT_TYPES.join(", ")}, so leave out moments that fit none; every index refers to the numbered presented window.`,
        `- agent_performance_scorecard, when present, has exactly the keys ${SCORECARD_SCORE_KEYS.join(", ")} (finite numbers from 1 through 10) and overall_comment (at most ${CLASSIFICATION_OUTPUT_LIMITS.scorecardCommentLength} characters).`,
        "- is_best_practice is a required boolean.",
        input.paymentEvidenceMessageIndices?.length
          ? `- Also return payment_evidence (0-3 entries), only for incoming Messages ${input.paymentEvidenceMessageIndices.join(",")}: exact {message_index,kind,amount,currency}. kind is receipt or payment_claim. Include only a payment receipt or an explicit claim of a completed payment. Exclude quotes, invoices, payment requests, questions, future intentions, failed/cancelled transfers and refunds. amount is a positive number or null; currency is an explicit ISO currency code or null. Never infer amount/currency from an offer or treat a bot reply as evidence. This is unverified evidence for merchant review, not settlement confirmation. Return [] if absent or uncertain.`
          : "",
        repairReason ? `Repair reason: ${repairReason}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

export function parseConversationClassificationOutput(
  value: unknown,
  input: { taxonomyLabels: string[]; presentedMessageCount: number }
): ClassificationResult {
  assertExactKeys(
    value,
    "$root",
    REQUIRED_RESULT_KEYS,
    OPTIONAL_RESULT_KEYS
  );
  if (
    !Number.isSafeInteger(input.presentedMessageCount) ||
    input.presentedMessageCount < 0
  ) {
    throw new InvalidClassificationOutputError("$input.presentedMessageCount");
  }

  if (
    typeof value.category !== "string" ||
    !input.taxonomyLabels.includes(value.category)
  ) {
    throw new InvalidClassificationOutputError("category");
  }
  if (typeof value.priority !== "string" || !PRIORITIES.has(value.priority)) {
    throw new InvalidClassificationOutputError("priority");
  }
  if (typeof value.sentiment !== "string" || !SENTIMENTS.has(value.sentiment)) {
    throw new InvalidClassificationOutputError("sentiment");
  }
  assertCanonicalText(
    value.summary,
    "summary",
    CLASSIFICATION_OUTPUT_LIMITS.summaryLength
  );
  assertCanonicalText(
    value.action,
    "action",
    CLASSIFICATION_OUTPUT_LIMITS.actionLength
  );

  if (
    !Array.isArray(value.tags) ||
    value.tags.length > CLASSIFICATION_OUTPUT_LIMITS.tagCount
  ) {
    throw new InvalidClassificationOutputError("tags");
  }
  value.tags.forEach((tag, index) =>
    assertCanonicalText(
      tag,
      `tags[${index}]`,
      CLASSIFICATION_OUTPUT_LIMITS.tagLength
    )
  );

  assertExactKeys(value.confidence, "confidence", [
    "category",
    "priority",
    "sentiment",
  ]);
  assertFiniteRange(
    value.confidence.category,
    "confidence.category",
    0,
    1
  );
  assertFiniteRange(
    value.confidence.priority,
    "confidence.priority",
    0,
    1
  );
  assertFiniteRange(
    value.confidence.sentiment,
    "confidence.sentiment",
    0,
    1
  );

  if (
    !Array.isArray(value.extracted_entities) ||
    value.extracted_entities.length > CLASSIFICATION_OUTPUT_LIMITS.entityCount
  ) {
    throw new InvalidClassificationOutputError("extracted_entities");
  }
  const extractedEntities = value.extracted_entities.map((entity, index) => {
    const path = `extracted_entities[${index}]`;
    assertExactKeys(entity, path, ["type", "value"]);
    if (typeof entity.type !== "string" || !ENTITY_TYPES.has(entity.type)) {
      throw new InvalidClassificationOutputError(`${path}.type`);
    }
    assertCanonicalText(
      entity.value,
      `${path}.value`,
      CLASSIFICATION_OUTPUT_LIMITS.entityValueLength
    );
    return {
      type: entity.type as ClassificationEntityType,
      value: entity.value,
    };
  });

  if (
    !Array.isArray(value.key_moments) ||
    value.key_moments.length > CLASSIFICATION_OUTPUT_LIMITS.keyMomentCount
  ) {
    throw new InvalidClassificationOutputError("key_moments");
  }
  const keyMoments = value.key_moments.map((moment, index) => {
    const path = `key_moments[${index}]`;
    assertExactKeys(moment, path, ["type", "message_index"]);
    if (typeof moment.type !== "string" || !KEY_MOMENT_TYPES.has(moment.type)) {
      throw new InvalidClassificationOutputError(`${path}.type`);
    }
    if (
      !Number.isSafeInteger(moment.message_index) ||
      (moment.message_index as number) < 0 ||
      (moment.message_index as number) >= input.presentedMessageCount
    ) {
      throw new InvalidClassificationOutputError(`${path}.message_index`);
    }
    return {
      type: moment.type as ClassificationKeyMomentType,
      message_index: moment.message_index as number,
    };
  });

  let scorecard: ClassificationResult["agent_performance_scorecard"];
  if (Object.prototype.hasOwnProperty.call(value, "agent_performance_scorecard")) {
    const candidate = value.agent_performance_scorecard;
    assertExactKeys(candidate, "agent_performance_scorecard", [
      ...SCORECARD_SCORE_KEYS,
      "overall_comment",
    ]);
    for (const key of SCORECARD_SCORE_KEYS) {
      assertFiniteRange(
        candidate[key],
        `agent_performance_scorecard.${key}`,
        1,
        10
      );
    }
    assertCanonicalText(
      candidate.overall_comment,
      "agent_performance_scorecard.overall_comment",
      CLASSIFICATION_OUTPUT_LIMITS.scorecardCommentLength
    );
    scorecard = {
      empathy_score: candidate.empathy_score as number,
      clarity_score: candidate.clarity_score as number,
      script_adherence_score: candidate.script_adherence_score as number,
      resolution_efficiency_score:
        candidate.resolution_efficiency_score as number,
      overall_comment: candidate.overall_comment,
    };
  }

  if (typeof value.is_best_practice !== "boolean") {
    throw new InvalidClassificationOutputError("is_best_practice");
  }
  return {
    category: value.category,
    priority: value.priority as ClassificationResult["priority"],
    sentiment: value.sentiment as ClassificationResult["sentiment"],
    summary: value.summary,
    action: value.action,
    tags: value.tags as string[],
    confidence: {
      category: value.confidence.category,
      priority: value.confidence.priority,
      sentiment: value.confidence.sentiment,
    },
    extracted_entities: extractedEntities,
    key_moments: keyMoments,
    ...(scorecard ? { agent_performance_scorecard: scorecard } : {}),
    is_best_practice: value.is_best_practice,
    ...(Object.hasOwn(value, "payment_evidence")
      ? {
          payment_evidence: parseClassificationPaymentEvidence(
            value.payment_evidence,
            input.presentedMessageCount
          ),
        }
      : {}),
  };
}
