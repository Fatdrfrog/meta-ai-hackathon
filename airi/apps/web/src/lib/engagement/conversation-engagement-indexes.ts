import connectDB from "@/lib/mongoose";
import Message, { MESSAGE_ENGAGEMENT_INDEX_SPECS } from "@/models/message";
import {
  Conversation,
  CONVERSATION_ENGAGEMENT_BOOTSTRAP_INDEX_SPEC,
} from "@/models/conversation";
import {
  ConversationEngagementState,
  CONVERSATION_ENGAGEMENT_STATE_BOOTSTRAP_INDEX_SPEC,
} from "@/models/conversation-engagement-state";
import {
  ConversationEngagementLease,
  CONVERSATION_ENGAGEMENT_LEASE_TTL_INDEX_SPEC,
} from "@/models/conversation-engagement-lease";

const indexCache = globalThis as typeof globalThis & {
  __conversationEngagementIndexPromise?: Promise<void>;
};

/** Canonical provisioning shared by web gates and the worker maintenance owner. */
export async function ensureConversationEngagementIndexes(): Promise<void> {
  if (!indexCache.__conversationEngagementIndexPromise) {
    indexCache.__conversationEngagementIndexPromise = (async () => {
      await connectDB();
      for (const spec of MESSAGE_ENGAGEMENT_INDEX_SPECS)
        await Message.collection.createIndex(spec.keys, spec.options);
      const spec = CONVERSATION_ENGAGEMENT_BOOTSTRAP_INDEX_SPEC;
      await Conversation.collection.createIndex(spec.keys, spec.options);
      // Transactions write this collection, and Mongo can't create one inside a transaction.
      await ConversationEngagementState.createCollection();
      const state = CONVERSATION_ENGAGEMENT_STATE_BOOTSTRAP_INDEX_SPEC;
      await ConversationEngagementState.collection.createIndex(
        state.keys,
        state.options
      );
      const lease = CONVERSATION_ENGAGEMENT_LEASE_TTL_INDEX_SPEC;
      await ConversationEngagementLease.collection.createIndex(
        lease.keys,
        lease.options
      );
    })().catch(error => {
      delete indexCache.__conversationEngagementIndexPromise;
      throw error;
    });
  }
  await indexCache.__conversationEngagementIndexPromise;
}
