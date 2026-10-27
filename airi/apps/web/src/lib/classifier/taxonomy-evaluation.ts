import { chatCompletionWithFallback, getLightTextModel } from "@/lib/ai";
import { extractJsonObject } from "@/lib/ai/json-object";
import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
import { matchAllowedOption } from "@/lib/classifier/decision";
import { asRecord } from "@icecore/shared/lib/value-utils";
import {
  buildTaxonomyDecisionGuide,
  type FewShotExample,
  type WorkspaceTaxonomy,
} from "@/lib/classifier/taxonomy";

export type CategorySelectionResult = {
  category: string;
  confidence: number;
  rationale: string;
  evidence: string[];
};

export type EffectiveCategorySource =
  | "stored"
  | "reclassified"
  | "fallback_other";

export type EffectiveConversationCategoryResult = {
  effectiveCategory: string;
  categorySource: EffectiveCategorySource;
  categoryConfidence: number;
  categoryEvidence: string | null;
  warnings: string[];
};

function toBoundedNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, numeric));
}

function toStringArray(value: unknown, maxItems = 5): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(item => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function buildCategoryFewShotMessages(
  fewShots: FewShotExample[] | undefined,
  allowedLabels: string[]
): Array<{ role: "user" | "assistant"; content: string }> {
  if (!Array.isArray(fewShots) || fewShots.length === 0) {
    return [];
  }

  return fewShots.slice(0, 6).flatMap(example => {
    const matchedLabel = matchAllowedOption(example.label, allowedLabels);
    const text = String(example.text || "").trim();
    if (!matchedLabel || !text) {
      return [];
    }

    const evidence = text.replace(/\s+/g, " ").slice(0, 160);
    return [
      {
        role: "user" as const,
        content: `Example conversation:\n${text}\n\nReturn the best category using the response schema.`,
      },
      {
        role: "assistant" as const,
        content: JSON.stringify({
          category: matchedLabel,
          confidence: 0.95,
          rationale: `Dominant business intent fits ${matchedLabel}.`,
          evidence: evidence ? [evidence] : [],
        }),
      },
    ];
  });
}

function normalizeCategorySelectionResult(
  raw: unknown,
  allowedLabels: string[],
  defaultCategory: string
): CategorySelectionResult {
  const parsed = asRecord(raw);
  const matchedCategory =
    matchAllowedOption(
      typeof parsed.category === "string" ? parsed.category : "",
      allowedLabels
    ) || defaultCategory;

  return {
    category: matchedCategory,
    confidence: toBoundedNumber(parsed.confidence, 0.5),
    rationale:
      typeof parsed.rationale === "string" ? parsed.rationale.trim() : "",
    evidence: toStringArray(parsed.evidence, 3),
  };
}

function resolveDefaultCategory(taxonomy: WorkspaceTaxonomy): string {
  return (
    matchAllowedOption("Other", taxonomy.labels) ||
    taxonomy.labels[0] ||
    "Other"
  );
}

function formatCategoryEvidence(
  parts: Array<string | null | undefined>
): string | null {
  const value = parts
    .map(part => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" | ");
  return value || null;
}

export async function selectCategoryWithSchema(params: {
  businessContext: string;
  textForAnalysis: string;
  taxonomy: WorkspaceTaxonomy;
  defaultCategory?: string;
  existingCategory?: string | null;
}): Promise<CategorySelectionResult> {
  const defaultCategory =
    params.defaultCategory || resolveDefaultCategory(params.taxonomy);
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [
    {
      role: "system",
      content: [
        "You assign one durable business classification to a customer conversation.",
        "This classification is used for segmentation, reporting, and automation.",
        "Choose the single best category from the provided taxonomy.",
        "Prefer the customer's dominant actionable business intent or lifecycle state, not a buzzword or incidental topic.",
        'Use "Other" only when the taxonomy does not clearly support a more specific category.',
        "If an existing category is provided, keep it unless the latest state of the conversation clearly supports a different category.",
        `Return JSON only with keys: category (one of: ${params.taxonomy.labels.join(", ")}), confidence (0-1), rationale (string, max 240 chars), evidence (array of up to 3 strings, each max 180 chars).`,
      ].join(" "),
    },
    ...buildCategoryFewShotMessages(
      params.taxonomy.fewShots,
      params.taxonomy.labels
    ),
    {
      role: "user",
      content: [
        `Business context: ${params.businessContext}`,
        `Available categories: ${params.taxonomy.labels.join(", ")}`,
        `Taxonomy guidance:\n${buildTaxonomyDecisionGuide(params.taxonomy)}`,
        `Existing category: ${params.existingCategory || "none"}`,
        "Conversation transcript:",
        params.textForAnalysis,
        "Select the one best category. Prioritize the most recent messages while using earlier messages as context.",
      ].join("\n\n"),
    },
  ];

  // json_object makes chatCompletionWithFallback apply the structured-JSON
  // config of whichever provider's model runs (Claude or the Gemini fallback).
  const response = await chatCompletionWithFallback({
    model: getLightTextModel(),
    messages,
    responseFormat: { type: "json_object" },
    temperature: 0,
  });

  const parsed = extractJsonObject(response.content);
  return normalizeCategorySelectionResult(
    parsed,
    params.taxonomy.labels,
    defaultCategory
  );
}

export async function resolveEffectiveConversationCategory(params: {
  taxonomy: WorkspaceTaxonomy;
  storedCategory?: string | null;
  storedConfidence?: number | null;
  evaluateCategory?: (() => Promise<CategorySelectionResult>) | null;
}): Promise<EffectiveConversationCategoryResult> {
  const defaultCategory = resolveDefaultCategory(params.taxonomy);
  const confidenceThreshold = params.taxonomy.confidenceThreshold || 0.7;
  const matchedStoredCategory = matchAllowedOption(
    params.storedCategory,
    params.taxonomy.labels
  );

  if (matchedStoredCategory) {
    const storedConf =
      typeof params.storedConfidence === "number" &&
      Number.isFinite(params.storedConfidence)
        ? Math.max(0, Math.min(1, params.storedConfidence))
        : null;
    const isConfidentEnough =
      storedConf === null || storedConf >= confidenceThreshold;

    if (isConfidentEnough || !params.evaluateCategory) {
      return {
        effectiveCategory: matchedStoredCategory,
        categorySource: "stored",
        categoryConfidence: storedConf ?? confidenceThreshold,
        categoryEvidence: "Stored classification matched the latest taxonomy.",
        warnings:
          !isConfidentEnough && !params.evaluateCategory
            ? ["low_confidence_category"]
            : [],
      };
    }
    // Low confidence but caller provided LLM: re-evaluate below.
  }

  if (!params.evaluateCategory) {
    return {
      effectiveCategory: defaultCategory,
      categorySource: "fallback_other",
      categoryConfidence: confidenceThreshold,
      categoryEvidence:
        "Reclassification was unavailable, so the conversation fell back to Other.",
      warnings: ["low_confidence_category"],
    };
  }

  try {
    const evaluated = await params.evaluateCategory();
    const matchedEvaluated = matchAllowedOption(
      evaluated.category,
      params.taxonomy.labels
    );

    if (matchedEvaluated && evaluated.confidence >= confidenceThreshold) {
      return {
        effectiveCategory: matchedEvaluated,
        categorySource: "reclassified",
        categoryConfidence: evaluated.confidence,
        categoryEvidence: formatCategoryEvidence([
          evaluated.evidence[0],
          evaluated.rationale,
        ]),
        warnings: [],
      };
    }

    return {
      effectiveCategory: defaultCategory,
      categorySource: "fallback_other",
      categoryConfidence: matchedEvaluated
        ? evaluated.confidence
        : confidenceThreshold,
      categoryEvidence: formatCategoryEvidence([
        evaluated.evidence[0],
        evaluated.rationale,
        "Fell back to Other because the category was missing or below the confidence threshold.",
      ]),
      warnings: ["low_confidence_category"],
    };
  } catch (error) {
    if (isWorkspaceAiPolicyError(error)) throw error;
    return {
      effectiveCategory: defaultCategory,
      categorySource: "fallback_other",
      categoryConfidence: confidenceThreshold,
      categoryEvidence:
        error instanceof Error && error.message.trim().length > 0
          ? error.message.trim()
          : "Reclassification failed and fell back to Other.",
      warnings: ["low_confidence_category"],
    };
  }
}
