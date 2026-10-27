import { readIdString } from "./value-utils";

type SourceScopedRecord =
  | { sourceId?: unknown; workspaceId?: unknown }
  | null
  | undefined;

type ReplySourceInput = {
  workspaceId?: unknown;
  conversation?: SourceScopedRecord;
  chat?: SourceScopedRecord;
};

/**
 * A customer's Chat record is shared by every workspace they write to (its id
 * is the customer, e.g. `wa_<phone>`), and each inbound message rewrites its
 * sourceId and workspaceId. Inside the conversation's workspace the chat holds
 * the live connection, even after a reconnect replaced the source row; once the
 * customer writes to another business it names that business's connection.
 * Returns the chat's source only while the chat is still on this workspace.
 */
export function resolveWorkspaceChatSourceId(
  params: ReplySourceInput,
): string | null {
  const chatSourceId = readIdString(params.chat?.sourceId);
  if (!chatSourceId) return null;
  const workspaceId =
    readIdString(params.workspaceId) ||
    readIdString(params.conversation?.workspaceId);
  const chatWorkspaceId = readIdString(params.chat?.workspaceId);
  // Without both workspace ids there is nothing to compare, so keep the chat.
  if (!workspaceId || !chatWorkspaceId) return chatSourceId;
  return chatWorkspaceId === workspaceId ? chatSourceId : null;
}

/** The connection a reply in this conversation goes out from. */
export function resolveConversationReplySourceId(
  params: ReplySourceInput,
): string | null {
  return (
    resolveWorkspaceChatSourceId(params) ||
    readIdString(params.conversation?.sourceId)
  );
}
