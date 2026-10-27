import connectDB from "@/lib/mongoose";
import { buildDeterministicMongoObjectId } from "@/lib/mongo-deterministic-id";
import { Conversation } from "@/models/conversation";
import AiriReplyTrace from "@/models/airi-reply-trace";

type ReplyTraceGroundingSourceKind = "snippet" | "kb" | "mixed" | "none";
type ReplyTraceFollowUpMode =
  | "none"
  | "expand_last_grounding"
  | "resume_current_goal"
  | "resume_unresolved_need";

export function resolveReplyTraceGroundingSourceKind(params: {
  hasSnippet: boolean;
  hasKB: boolean;
}): ReplyTraceGroundingSourceKind {
  if (params.hasSnippet && params.hasKB) return "mixed";
  if (params.hasKB) return "kb";
  if (params.hasSnippet) return "snippet";
  return "none";
}

export type PersistAiriReplyTraceParams = {
  idempotencyKey?: string | null;
  workspaceId: string;
  conversationId: string;
  inboundMessageId: string;
  outboundMessageId?: string | null;
  channel?: string | null;
  delivered: boolean;
  deliveredReason?: string | null;
  queryText?: string | null;
  lastMessageQuery?: string | null;
  intentAnchor?: string | null;
  activeGoals?: string[];
  openAsks?: string[];
  queryVariants?: string[];
  followUpMode?: ReplyTraceFollowUpMode | null;
  followUpAnchor?: string | null;
  fallbackPlanningUsed?: boolean;
  retrievalPriority?: string | null;
  groundingSourceKind?: ReplyTraceGroundingSourceKind;
  chosenSourceIds?: string[];
  snippetShortCircuitedKB?: boolean;
  model?: string | null;
  provider?: string | null;
  latencyMs?: number | null;
  finishReason?: string | null;
  fallbackAction?: string | null;
  fallbackReason?: string | null;
  coverage?: {
    asksDetected?: string[];
    asksAnswered?: string[];
    missingAsks?: string[];
  } | null;
  activeSelection?: {
    label?: string | null;
    sourceIds?: string[];
    quotedPriceText?: string | null;
  } | null;
  selectionPinned?: boolean;
  historyCompacted?: boolean;
  summaryCoveredThroughMessageId?: string | null;
  summaryCoveredMessageCount?: number | null;
  ragWideEvent?: Record<string, unknown> | null;
};

function compactStringArray(
  values?: string[] | null,
  limit: number = 6
): string[] {
  return Array.from(
    new Set(
      (values || []).map(value => String(value || "").trim()).filter(Boolean)
    )
  ).slice(0, limit);
}

export async function persistAiriReplyTrace(
  params: PersistAiriReplyTraceParams
): Promise<void> {
  if (
    !params.workspaceId ||
    !params.conversationId ||
    !params.inboundMessageId
  ) {
    return;
  }

  await connectDB();

  const coverage = {
    asksDetected: compactStringArray(params.coverage?.asksDetected, 6),
    asksAnswered: compactStringArray(params.coverage?.asksAnswered, 6),
    missingAsks: compactStringArray(params.coverage?.missingAsks, 6),
  };
  const chosenSourceIds = compactStringArray(params.chosenSourceIds, 8);
  const groundingSourceKind = params.groundingSourceKind || "none";

  const traceDocument = {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    inboundMessageId: params.inboundMessageId,
    outboundMessageId: params.outboundMessageId || null,
    channel: params.channel || null,
    delivered: params.delivered,
    deliveredReason: params.deliveredReason || null,
    queryText: params.queryText || null,
    lastMessageQuery: params.lastMessageQuery || null,
    intentAnchor: params.intentAnchor || null,
    activeGoals: compactStringArray(params.activeGoals, 5),
    openAsks: compactStringArray(params.openAsks, 5),
    queryVariants: compactStringArray(params.queryVariants, 4),
    followUpMode: params.followUpMode || "none",
    followUpAnchor: params.followUpAnchor || null,
    fallbackPlanningUsed: Boolean(params.fallbackPlanningUsed),
    retrievalPriority: params.retrievalPriority || null,
    groundingSourceKind,
    chosenSourceIds,
    snippetShortCircuitedKB: Boolean(params.snippetShortCircuitedKB),
    model: params.model || null,
    provider: params.provider || null,
    latencyMs: typeof params.latencyMs === "number" ? params.latencyMs : null,
    finishReason: params.finishReason || null,
    fallbackAction: params.fallbackAction || null,
    fallbackReason: params.fallbackReason || null,
    coverage,
    activeSelection: params.activeSelection
      ? {
          label:
            typeof params.activeSelection.label === "string"
              ? params.activeSelection.label.trim()
              : null,
          sourceIds: compactStringArray(params.activeSelection.sourceIds, 8),
          quotedPriceText:
            typeof params.activeSelection.quotedPriceText === "string" &&
            params.activeSelection.quotedPriceText.trim()
              ? params.activeSelection.quotedPriceText.trim()
              : null,
        }
      : null,
    selectionPinned: Boolean(params.selectionPinned),
    historyCompacted: Boolean(params.historyCompacted),
    summaryCoveredThroughMessageId:
      params.summaryCoveredThroughMessageId || null,
    summaryCoveredMessageCount:
      typeof params.summaryCoveredMessageCount === "number"
        ? params.summaryCoveredMessageCount
        : null,
    ragWideEvent:
      params.ragWideEvent && typeof params.ragWideEvent === "object"
        ? params.ragWideEvent
        : null,
  };

  if (params.idempotencyKey) {
    await AiriReplyTrace.findOneAndUpdate(
      {
        _id: buildDeterministicMongoObjectId(
          "airi-reply-trace",
          params.idempotencyKey
        ),
      },
      { $set: traceDocument },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } else {
    await AiriReplyTrace.create(traceDocument);
  }

  if (
    params.delivered &&
    params.outboundMessageId &&
    groundingSourceKind !== "none"
  ) {
    await Conversation.updateOne(
      { _id: params.conversationId },
      {
        $set: {
          "airi_context_memory.lastGrounding": {
            sourceKind: groundingSourceKind,
            sourceIds: chosenSourceIds,
            intentAnchor: params.intentAnchor || null,
            answeredAsks: coverage.asksAnswered,
            updatedAt: new Date(),
          },
        },
      }
    );
  }
}
