import Chat from "@/models/chat";
import User from "@/models/user";
import { mixedIdLookupValues, toStringId } from "./shared";

type ContactRefs = { user?: unknown; chat?: unknown };
type ContactRecord = { _id?: unknown };

export type ConversationContactBundle<TConversation, TUser, TChat> = {
  conversation: TConversation;
  user: TUser | null;
  chat: TChat | null;
};

export type LoadConversationContactBundlesOptions = {
  /** Mongo select for referenced users; each caller decides on `email`. */
  userSelect: string;
  chatSelect: string;
  /** Server-side time limit for each lookup; omitted means none. */
  maxTimeMS?: number;
};

/** Profiles stored inline on the conversation are used as they are. */
function inlineRecord<T>(value: unknown): T | null {
  return typeof value === "object" && value !== null ? (value as T) : null;
}

function referencedId(value: unknown): unknown {
  return typeof value === "object" && value !== null ? null : value;
}

function indexById<T extends ContactRecord>(records: T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const record of records) {
    const id = toStringId(record._id);
    if (id) byId.set(id, record);
  }
  return byId;
}

function lookUp<T>(byId: Map<string, T>, reference: unknown): T | null {
  const id = toStringId(reference);
  return (id && byId.get(id)) || null;
}

/**
 * Resolves each conversation's user and chat: an inline profile wins,
 * otherwise one `$in` lookup per collection by Mixed id (see
 * `mixedIdLookupValues`). Conversations keep their order.
 */
export async function loadConversationContactBundles<
  TConversation extends ContactRefs,
  TUser extends ContactRecord,
  TChat extends ContactRecord,
>(
  conversations: TConversation[],
  options: LoadConversationContactBundlesOptions
): Promise<ConversationContactBundle<TConversation, TUser, TChat>[]> {
  const userIds = mixedIdLookupValues(
    conversations.map(conversation => referencedId(conversation.user))
  );
  const chatIds = mixedIdLookupValues(
    conversations.map(conversation => referencedId(conversation.chat))
  );

  const { maxTimeMS } = options;
  const findUsers = async (): Promise<TUser[]> => {
    if (userIds.length === 0) return [];
    const query = User.find({ _id: { $in: userIds } }).select(
      options.userSelect
    );
    const bounded =
      maxTimeMS === undefined ? query : query.maxTimeMS(maxTimeMS);
    return bounded.lean<TUser[]>();
  };
  const findChats = async (): Promise<TChat[]> => {
    if (chatIds.length === 0) return [];
    const query = Chat.find({ _id: { $in: chatIds } }).select(
      options.chatSelect
    );
    const bounded =
      maxTimeMS === undefined ? query : query.maxTimeMS(maxTimeMS);
    return bounded.lean<TChat[]>();
  };
  const [users, chats] = await Promise.all([findUsers(), findChats()]);

  const usersById = indexById(users);
  const chatsById = indexById(chats);
  return conversations.map(conversation => ({
    conversation,
    user:
      inlineRecord<TUser>(conversation.user) ??
      lookUp(usersById, conversation.user),
    chat:
      inlineRecord<TChat>(conversation.chat) ??
      lookUp(chatsById, conversation.chat),
  }));
}
