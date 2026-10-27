import type { RagTurnEvent } from "@icecore/airi-runtime/llm-analytics";
import type {
  LlmEvaluationFixType,
  LlmEvaluationIssueType,
} from "@/models/llm-evaluation-review-item";

export type LlmEvaluationReviewItemDraft = {
  workspaceId: string;
  dedupeKey: string;
  conversationId?: string | null;
  messageId?: string | null;
  traceId?: string | null;
  status: "open";
  issueType: LlmEvaluationIssueType;
  severity: "critical" | "high" | "medium" | "low" | "info";
  source: "system_eval";
  title: string;
  summary: string;
  inputExcerpt?: string | null;
  outputExcerpt?: string | null;
  reasoningExcerpt?: string | null;
  suggestedFix: {
    type: LlmEvaluationFixType;
    title: string;
    description: string;
    targetId?: string | null;
    payload?: Record<string, unknown>;
  };
};

const DEFAULT_LATENCY_TARGET_MS = 10_000;

function compact(value: string | null | undefined): string | null {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function dedupeKeyFor(ragTurn: RagTurnEvent, issueType: string): string {
  return [
    "rag_turn",
    ragTurn.workspace_id,
    ragTurn.conversation_id || "conversation-unknown",
    ragTurn.message_id || ragTurn.answer_message_id || ragTurn.event_id,
    issueType,
  ].join(":");
}

function hasFallbackSignal(ragTurn: RagTurnEvent): boolean {
  const resultType = compact(ragTurn.result_type)?.toLowerCase();
  const fallbackReason = compact(ragTurn.fallback_reason)?.toLowerCase();
  const fallbackAction = compact(ragTurn.fallback_action)?.toLowerCase();

  return Boolean(
    resultType === "fallback" ||
      fallbackReason?.includes("missing") ||
      fallbackReason?.includes("gap") ||
      fallbackReason?.includes("context") ||
      fallbackAction?.includes("clarification") ||
      fallbackAction?.includes("fallback")
  );
}

function hasSourceContext(ragTurn: RagTurnEvent): boolean {
  return (
    ragTurn.source_ids.length > 0 ||
    Boolean(
      ragTurn.retrieval_context_count && ragTurn.retrieval_context_count > 0
    )
  );
}

function buildBaseDraft(
  ragTurn: RagTurnEvent,
  issueType: LlmEvaluationIssueType
): Pick<
  LlmEvaluationReviewItemDraft,
  | "workspaceId"
  | "dedupeKey"
  | "conversationId"
  | "messageId"
  | "traceId"
  | "status"
  | "source"
  | "inputExcerpt"
  | "outputExcerpt"
> {
  return {
    workspaceId: ragTurn.workspace_id,
    dedupeKey: dedupeKeyFor(ragTurn, issueType),
    conversationId: ragTurn.conversation_id || null,
    messageId: ragTurn.message_id || ragTurn.answer_message_id || null,
    traceId: ragTurn.trace_id || ragTurn.event_id,
    status: "open",
    source: "system_eval",
    inputExcerpt: ragTurn.input_excerpt || null,
    outputExcerpt: ragTurn.output_excerpt || null,
  };
}

export function buildReviewItemDraftsForRagTurn(
  ragTurn: RagTurnEvent
): LlmEvaluationReviewItemDraft[] {
  const drafts: LlmEvaluationReviewItemDraft[] = [];
  const hasContext = hasSourceContext(ragTurn);

  if (hasFallbackSignal(ragTurn) && !hasContext) {
    drafts.push({
      ...buildBaseDraft(ragTurn, "knowledge_gap"),
      issueType: "knowledge_gap",
      severity: "high",
      title: "Knowledge gap detected",
      summary:
        "The assistant used a fallback response without retrieved source context.",
      reasoningExcerpt:
        compact(ragTurn.fallback_reason) ||
        "Fallback response with no source ids attached.",
      suggestedFix: {
        type: "knowledge_base_update",
        title: "Add or update a KB answer",
        description:
          "Review the conversation and add an approved knowledge-base answer or source for this customer ask.",
        payload: {
          sourceIds: ragTurn.source_ids,
          fallbackReason: ragTurn.fallback_reason || null,
          fallbackAction: ragTurn.fallback_action || null,
        },
      },
    });
  }

  if (!hasFallbackSignal(ragTurn) && !hasContext) {
    drafts.push({
      ...buildBaseDraft(ragTurn, "unsupported_answer"),
      issueType: "unsupported_answer",
      severity: "high",
      title: "Answer lacks supporting sources",
      summary:
        "The assistant answered without source ids, so the response should be checked before it becomes a regression baseline.",
      reasoningExcerpt: "No retrieved source ids were attached to the turn.",
      suggestedFix: {
        type: "knowledge_base_update",
        title: "Attach an approved source",
        description:
          "Review whether the answer should cite existing material, use a new KB source, or be changed to an escalation.",
        payload: {
          resultType: ragTurn.result_type || null,
        },
      },
    });
  }

  if (
    typeof ragTurn.duration_ms === "number" &&
    ragTurn.duration_ms > DEFAULT_LATENCY_TARGET_MS
  ) {
    drafts.push({
      ...buildBaseDraft(ragTurn, "cost_latency_spike"),
      issueType: "cost_latency_spike",
      severity: ragTurn.duration_ms > 20_000 ? "high" : "medium",
      title: "Slow AI response",
      summary: `The RAG turn took ${Math.round(
        ragTurn.duration_ms
      )}ms, above the ${DEFAULT_LATENCY_TARGET_MS}ms target.`,
      reasoningExcerpt:
        "Customer-facing RAG latency exceeded the default target.",
      suggestedFix: {
        type: "prompt_rubric_change",
        title: "Review retrieval and prompt cost",
        description:
          "Check retrieval breadth, prompt size, and model routing before changing customer-visible behavior.",
        payload: {
          durationMs: ragTurn.duration_ms,
          generationModel: ragTurn.generation_model || null,
          retrievalPath: ragTurn.retrieval_path || null,
        },
      },
    });
  }

  return drafts;
}

export function isLlmReviewItemCreationEnabled(): boolean {
  const raw = String(
    process.env.LLM_ANALYTICS_REVIEW_ITEMS_ENABLED || ""
  ).trim();
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

export async function persistReviewItemDrafts(
  drafts: LlmEvaluationReviewItemDraft[]
): Promise<number> {
  if (drafts.length === 0 || !isLlmReviewItemCreationEnabled()) {
    return 0;
  }

  const [{ default: connectDB }, { default: LlmEvaluationReviewItem }] =
    await Promise.all([
      import("@/lib/mongoose"),
      import("@/models/llm-evaluation-review-item"),
    ]);

  await connectDB();

  const results = await Promise.all(
    drafts.map(draft =>
      LlmEvaluationReviewItem.updateOne(
        {
          workspaceId: draft.workspaceId,
          dedupeKey: draft.dedupeKey,
        },
        {
          $setOnInsert: draft,
        },
        {
          upsert: true,
          setDefaultsOnInsert: true,
        }
      )
    )
  );

  return results.reduce(
    (count, result) => count + (result.upsertedCount || 0),
    0
  );
}
