import mongoose, { type Model } from "mongoose";

/**
 * One conversation's engagement projection state. Engagement transactions
 * write this document and the messages only; the conversation document keeps
 * just the derived metrics, copied by a plain write after each commit, so
 * plain ingest writes to the conversation can no longer abort a transaction.
 * Field names match the conversation fields they replace.
 */
export interface IConversationEngagementState {
  _id: mongoose.Types.ObjectId;
  workspaceId?: string | null;
  engagement_accumulator?: unknown;
  engagement_metrics?: Record<string, unknown> | null;
  /** Bumped by every commit that changes the metrics; guards the copy. */
  revision: number;
}

const ConversationEngagementStateSchema =
  new mongoose.Schema<IConversationEngagementState>(
    {
      _id: { type: mongoose.Schema.Types.ObjectId, required: true },
      workspaceId: { type: String, default: null },
      engagement_accumulator: { type: mongoose.Schema.Types.Mixed },
      engagement_metrics: { type: mongoose.Schema.Types.Mixed, default: null },
      revision: { type: Number, default: 0 },
    },
    {
      collection: "conversation_engagement_states",
      versionKey: false,
      minimize: false,
    }
  );

export const CONVERSATION_ENGAGEMENT_STATE_BOOTSTRAP_INDEX_SPEC = {
  keys: {
    "engagement_accumulator.phase": 1,
    "engagement_accumulator.leaseUntil": 1,
    _id: 1,
  },
  options: {
    name: "engagement_state_bootstrap_lease_v1",
    partialFilterExpression: { "engagement_accumulator.phase": "building" },
  },
} as const;
ConversationEngagementStateSchema.index(
  CONVERSATION_ENGAGEMENT_STATE_BOOTSTRAP_INDEX_SPEC.keys,
  CONVERSATION_ENGAGEMENT_STATE_BOOTSTRAP_INDEX_SPEC.options
);

export const ConversationEngagementState =
  (mongoose.models
    .ConversationEngagementState as Model<IConversationEngagementState>) ||
  mongoose.model<IConversationEngagementState>(
    "ConversationEngagementState",
    ConversationEngagementStateSchema
  );
