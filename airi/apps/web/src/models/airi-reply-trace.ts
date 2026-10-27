import mongoose from "mongoose";

const AIRI_REPLY_TRACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const AiriReplyTraceSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true, index: true },
    inboundMessageId: { type: String, required: true, index: true },
    outboundMessageId: { type: String, default: null, index: true },
    channel: { type: String, default: null },
    delivered: { type: Boolean, default: false },
    deliveredReason: { type: String, default: null },
    queryText: { type: String, default: null },
    lastMessageQuery: { type: String, default: null },
    intentAnchor: { type: String, default: null },
    activeGoals: { type: [String], default: [] },
    openAsks: { type: [String], default: [] },
    queryVariants: { type: [String], default: [] },
    followUpMode: {
      type: String,
      enum: [
        "none",
        "expand_last_grounding",
        "resume_current_goal",
        "resume_unresolved_need",
      ],
      default: "none",
    },
    followUpAnchor: { type: String, default: null },
    fallbackPlanningUsed: { type: Boolean, default: false },
    retrievalPriority: { type: String, default: null },
    groundingSourceKind: {
      type: String,
      enum: ["snippet", "kb", "mixed", "none"],
      default: "none",
    },
    chosenSourceIds: { type: [String], default: [] },
    snippetShortCircuitedKB: { type: Boolean, default: false },
    model: { type: String, default: null },
    provider: { type: String, default: null },
    latencyMs: { type: Number, default: null },
    finishReason: { type: String, default: null },
    fallbackAction: { type: String, default: null },
    fallbackReason: { type: String, default: null },
    coverage: {
      asksDetected: { type: [String], default: [] },
      asksAnswered: { type: [String], default: [] },
      missingAsks: { type: [String], default: [] },
    },
    activeSelection: {
      label: { type: String, default: null },
      sourceIds: { type: [String], default: [] },
      quotedPriceText: { type: String, default: null },
    },
    selectionPinned: { type: Boolean, default: false },
    historyCompacted: { type: Boolean, default: false },
    summaryCoveredThroughMessageId: { type: String, default: null },
    summaryCoveredMessageCount: { type: Number, default: null },
    // Phase 3.6: canonical wide-event payload emitted by the RAG response
    // service (`rag.request.complete`). Stored verbatim as `Mixed` so we
    // avoid schema drift as new fields are added.
    ragWideEvent: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + AIRI_REPLY_TRACE_TTL_MS),
    },
  },
  { timestamps: true }
);

AiriReplyTraceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
AiriReplyTraceSchema.index(
  { workspaceId: 1, conversationId: 1, inboundMessageId: 1, createdAt: -1 },
  { name: "airi_reply_trace_conversation_lookup" }
);

export default mongoose.models.AiriReplyTrace ||
  mongoose.model("AiriReplyTrace", AiriReplyTraceSchema);
