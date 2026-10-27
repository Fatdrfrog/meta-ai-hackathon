import mongoose, { type Document, type Model } from "mongoose";

/**
 * Cross-instance owner of one conversation's engagement work. The snapshot
 * transactions stay correct without it; the lease only stops two processes
 * from running them on the same conversation at once and aborting each other.
 */
export interface IConversationEngagementLease extends Document<string> {
  _id: string;
  ownerToken: string | null;
  expiresAt: Date;
}

const ConversationEngagementLeaseSchema =
  new mongoose.Schema<IConversationEngagementLease>(
    {
      _id: { type: String, required: true },
      ownerToken: { type: String, default: null },
      expiresAt: { type: Date, required: true },
    },
    {
      collection: "conversation_engagement_leases",
      versionKey: false,
    }
  );

/** Released leases keep their row for a day so a busy conversation reuses it. */
export const CONVERSATION_ENGAGEMENT_LEASE_TTL_INDEX_SPEC = {
  keys: { expiresAt: 1 },
  options: {
    name: "conversation_engagement_lease_expiry_v1",
    expireAfterSeconds: 24 * 60 * 60,
  },
} as const;

export const ConversationEngagementLease =
  (mongoose.models
    .ConversationEngagementLease as Model<IConversationEngagementLease>) ||
  mongoose.model<IConversationEngagementLease>(
    "ConversationEngagementLease",
    ConversationEngagementLeaseSchema
  );
