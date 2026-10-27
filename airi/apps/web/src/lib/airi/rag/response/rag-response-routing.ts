import type { FactualGroundingGuardResult } from "@/lib/airi/grounding/factual-grounding-guard";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import { normalizeComparableText } from "@/lib/airi/reply/thread/reply-text-utils";
import type { ContextDecision, HybridContext } from "@/lib/airi/rag/types";
import { ragLogger } from "@/lib/airi/shared/logger";
import type { GroundedReplyOption } from "@icecore/shared/types/message-preview";
import { buildGroundedReplyOptionCallbackKey } from "@icecore/shared/lib/grounded-reply-options";
import {
  mergePreservedKBArticles,
  selectBroadOverviewKBArticles,
  selectFallbackRecoveryKBArticles,
  selectMatchedKBArticles,
} from "./rag-response-kb-selection";
import type { RetrievalSummary } from "./types";

/** Re-exported for callers that only need hybrid option wiring. */
export { buildAssistantHybridRetrievalOptions } from "./assistant-hybrid-retrieval-options";

/** Context routing: locked selection, overview rescue, and merge rules before generation. */
export function resolveEffectiveRoutingDecision(
  contextDecision: ContextDecision,
  lockedSelectionKBArticles: KBArticleResult[],
  broadOverviewKBArticles: KBArticleResult[]
): ContextDecision {
  if (lockedSelectionKBArticles.length > 0) {
    return {
      ...contextDecision,
      useSnippet: false,
      useKB: true,
      priority: "kb",
      reasoning: "Locked customer selection sources preserved",
    };
  }
  if (broadOverviewKBArticles.length >= 2) {
    return {
      ...contextDecision,
      useKB: true,
      useSnippet: false,
      priority: "kb",
      reasoning: "Grouped overview rescue from medium-confidence KB candidates",
    };
  }
  return contextDecision;
}

export function isBroadOverviewRescueEligible(
  contextDecision: ContextDecision,
  lockedSelectionCount: number
): boolean {
  return (
    lockedSelectionCount === 0 &&
    contextDecision.priority === "generic" &&
    !contextDecision.useSnippet &&
    !contextDecision.useKB
  );
}

export function selectBroadOverviewRescueArticles(
  hybridContext: HybridContext,
  contextDecision: ContextDecision,
  lockedSelectionKBArticles: KBArticleResult[]
): KBArticleResult[] {
  if (
    !isBroadOverviewRescueEligible(
      contextDecision,
      lockedSelectionKBArticles.length
    )
  ) {
    return [];
  }
  return selectBroadOverviewKBArticles(hybridContext);
}

/** High-confidence matched list, or overview rescue set when that path fired. */
export function resolveMatchedKbArticlesBase(
  hybridContext: HybridContext,
  broadOverviewKBArticles: KBArticleResult[]
): KBArticleResult[] {
  return broadOverviewKBArticles.length >= 2
    ? broadOverviewKBArticles
    : selectMatchedKBArticles(hybridContext);
}

/** Generic branch: wider recovery merge (locked + near-threshold / verified). */
export function mergeLockedWithFallbackRecovery(
  lockedSelectionKBArticles: KBArticleResult[],
  hybridContext: HybridContext
): KBArticleResult[] {
  return mergePreservedKBArticles(
    lockedSelectionKBArticles,
    selectFallbackRecoveryKBArticles(hybridContext)
  );
}

/**
 * Retrieval summary fields common to guard / fallback / generation paths.
 * Keeps `factualGroundingGuard` in one shape everywhere it is attached.
 */
export function retrievalSummaryWithFactualGrounding(
  retrievalSummary: RetrievalSummary,
  factualGroundingGuard: FactualGroundingGuardResult,
  extra?: RetrievalSummary
): RetrievalSummary {
  return {
    ...retrievalSummary,
    factualGroundingGuard,
    ...extra,
  };
}

export function logAssistantReplyGenerationBranch(params: {
  workspaceId: string;
  conversationId: string;
  /** Pipeline branch name (not the same as `retrievalSummary.retrievalPath`). */
  pipelineBranch: string;
  decision: ContextDecision;
  hybridContext: HybridContext;
}): void {
  ragLogger.general.debug("Starting assistant reply generation", {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    decisionPriority: params.decision.priority,
    path: params.pipelineBranch,
    useKB: params.decision.useKB,
    useSnippet: params.decision.useSnippet,
    kbArticlesInHybrid: params.hybridContext.kbArticles?.length || 0,
  });
}

function buildKbArticleSourceIds(article: KBArticleResult): string[] {
  return Array.from(
    new Set(
      [article.sourceRecordId, article.documentId, article.id]
        .map(value => String(value || "").trim())
        .filter(Boolean)
    )
  ).slice(0, 8);
}

function buildGroundedReplyOptionDescription(
  article: KBArticleResult
): string | null {
  const content = String(article.fullContent || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!content) {
    return null;
  }

  return truncateAtWordBoundary(content, GROUNDED_REPLY_DESCRIPTION_MAX_CHARS);
}

const GROUNDED_REPLY_LABEL_MAX_CHARS = 20;
const GROUNDED_REPLY_DESCRIPTION_MAX_CHARS = 72;
const GENERIC_GROUNDED_REPLY_LABELS = new Set([
  "faq",
  "faqs",
  "q a",
  "qa",
  "question answer",
  "questions answers",
]);

function truncateAtWordBoundary(value: string, maxChars: number): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (Array.from(text).length <= maxChars) {
    return text;
  }

  const chars = Array.from(text);
  const hardLimit = chars.slice(0, maxChars).join("");
  const trimmedHardLimit = hardLimit.trimEnd();
  const nextChar = chars[maxChars] || "";

  if (/\s/.test(nextChar) || /\s$/.test(hardLimit)) {
    return trimmedHardLimit;
  }

  const hardLimitWithoutTrailingSpace = trimmedHardLimit;
  const lastSpace = hardLimitWithoutTrailingSpace.lastIndexOf(" ");

  if (lastSpace >= Math.min(8, maxChars - 1)) {
    return hardLimitWithoutTrailingSpace.slice(0, lastSpace).trim();
  }

  return hardLimitWithoutTrailingSpace;
}

function stripGenericGroundedReplyLabelPrefix(value: string): string {
  return String(value || "")
    .replace(
      /^\s*(?:(?:q\s*(?:[\/&-]\s*)?a)\b|faqs?\b|questions?\s*(?:and|&)?\s*answers?\b)\s*[:\-|]*\s*/i,
      ""
    )
    .replace(/^[\s:;,\-.|]+/, "")
    .trim();
}

function isGenericGroundedReplyOptionLabel(value: string): boolean {
  const comparable = normalizeComparableText(value);
  return (
    !comparable ||
    GENERIC_GROUNDED_REPLY_LABELS.has(comparable) ||
    (comparable.length <= 2 && comparable.replace(/\s/g, "").length <= 2)
  );
}

function sanitizeGroundedReplyOptionLabel(value: string): string {
  const stripped = stripGenericGroundedReplyLabelPrefix(value);
  if (isGenericGroundedReplyOptionLabel(stripped)) {
    return "";
  }

  const label = truncateAtWordBoundary(
    stripped,
    GROUNDED_REPLY_LABEL_MAX_CHARS
  );
  return isGenericGroundedReplyOptionLabel(label) ? "" : label;
}

function buildGroundedReplyOptionLabel(article: KBArticleResult): string {
  const candidates = [
    article.citationLabel,
    article.title,
    article.documentTitle,
  ];

  for (const candidate of candidates) {
    const label = sanitizeGroundedReplyOptionLabel(String(candidate || ""));
    if (label) {
      return label;
    }
  }

  return "";
}

export function buildGroundedReplyOptionsFromKbArticles(
  kbArticles: KBArticleResult[],
  limit: number = 4
): GroundedReplyOption[] {
  const options: GroundedReplyOption[] = [];
  const seen = new Set<string>();
  const seenLabels = new Set<string>();

  for (const article of kbArticles) {
    const label = buildGroundedReplyOptionLabel(article);
    const labelKey = normalizeComparableText(label);
    const sourceIds = buildKbArticleSourceIds(article);
    const documentKey =
      article.documentId ||
      article.sourceRecordId ||
      normalizeComparableText(article.documentTitle || article.title) ||
      article.id;
    const sectionKey = normalizeComparableText(
      article.citationLabel || article.title || String(article.chunkIndex ?? "")
    );
    const dedupeKey = [documentKey, sectionKey || label || sourceIds.join(":")]
      .map(value => String(value || "").trim())
      .filter(Boolean)
      .join(":");
    if (
      !label ||
      !labelKey ||
      sourceIds.length === 0 ||
      !dedupeKey ||
      seen.has(dedupeKey) ||
      seenLabels.has(labelKey)
    ) {
      continue;
    }

    seen.add(dedupeKey);
    seenLabels.add(labelKey);
    options.push({
      id: article.id,
      callbackKey: buildGroundedReplyOptionCallbackKey(options.length),
      label,
      description: buildGroundedReplyOptionDescription(article),
      selectionKind: null,
      sourceKind: "kb",
      sourceIds,
      sourceRecordId: article.sourceRecordId || null,
      sourceDocumentId: article.documentId || null,
      quotedPriceText: null,
      quotedPriceAmount: null,
      quotedPriceCurrency: null,
    });

    if (options.length >= limit) {
      break;
    }
  }

  return options;
}
