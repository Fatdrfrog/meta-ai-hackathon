import "server-only";
import { AiriChatThread } from "@/models/airi-chat-thread";
import {
  createMetaAdsMcpConversationId,
  isMetaAdsMcpConversationId,
} from "@/lib/meta-ads/mcp/conversation-id";
type ConversationIdentity = { metaAdsMcpConversationId?: string };

function readIdentity(thread: ConversationIdentity | null): string | null {
  if (!thread) throw new Error("Airi chat thread not found");
  const value = thread.metaAdsMcpConversationId;
  if (value === undefined) return null;
  if (!isMetaAdsMcpConversationId(value)) {
    throw new Error("Invalid Meta Ads conversation identity");
  }
  return value;
}

/** Independent of user/workspace identifiers, shared by every turn in a thread.
 * The existing thread document is the atomic owner; no new collection is needed. */
export async function getMetaAdsMcpConversationId(params: {
  workspaceId: string;
  userId: string;
  threadId: string;
  signal?: AbortSignal;
}): Promise<string> {
  params.signal?.throwIfAborted();
  const filter = {
    _id: params.threadId,
    workspaceId: params.workspaceId,
    createdByUserId: params.userId,
  };
  const load = () =>
    AiriChatThread.findOne(filter)
      .select("metaAdsMcpConversationId")
      .lean<ConversationIdentity | null>();
  const existing = readIdentity(await load());
  params.signal?.throwIfAborted();
  if (existing) return existing;

  const candidate = createMetaAdsMcpConversationId();
  const initialized = await AiriChatThread.findOneAndUpdate(
    { ...filter, metaAdsMcpConversationId: { $exists: false } },
    { $set: { metaAdsMcpConversationId: candidate } },
    {
      new: true,
      timestamps: false,
      projection: { metaAdsMcpConversationId: 1 },
    }
  ).lean<ConversationIdentity | null>();
  params.signal?.throwIfAborted();
  // A simultaneous turn may have initialized the same thread first.
  const identity = readIdentity(initialized ?? (await load()));
  if (!identity)
    throw new Error("Meta Ads conversation identity was not saved");
  return identity;
}
