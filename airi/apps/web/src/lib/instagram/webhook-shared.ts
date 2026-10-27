import type { AiriAutoReplyParams } from "@icecore/airi-runtime/auto-reply";
import { invalidateRequestsForWorkspace } from "@/lib/cache";
import { decryptMaybeString, type EncryptedString } from "@/lib/crypto";
import { realtime } from "@/lib/realtime/server";
import { acceptAiriConversationIngress } from "@/lib/temporal/airi-direct-ingress";
import Message from "@/models/message";
import User from "@/models/user";
import { resolveInstagramGraphBaseCandidates } from "@icecore/shared/lib/meta/graph-version";

// Dependency-free home so lead naming can share it without this module's imports.
export { INSTAGRAM_USER_PLACEHOLDER } from "./user-placeholder";

export interface InstagramSourceData {
  id: string;
  workspace_id: string;
  pageAccessToken: EncryptedString | string;
  pageId: string;
  instagramScopedId?: string;
  instagramBusinessAccountId?: string;
  instagramUsername?: string;
  authMethod?: string;
}

export function resolveInstagramAccessToken(
  token: EncryptedString | string
): string {
  return decryptMaybeString(token);
}

export function getInstagramGraphApiBases(authMethod?: string): string[] {
  return resolveInstagramGraphBaseCandidates(authMethod);
}

export function hashInstagramIdToNumber(value: string): number {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) + hash + value.charCodeAt(index);
  }
  return Math.abs(hash) % 9007199254740991;
}

export function buildInstagramAiriJobPayload(
  params: AiriAutoReplyParams
): AiriAutoReplyParams {
  return {
    ...params,
    newMessage: {
      _id: params.newMessage._id,
      text: params.newMessage.text,
      ragContext: params.newMessage.ragContext,
      date: params.newMessage.date,
      conversation: params.newMessage.conversation,
      direction: params.newMessage.direction,
      channel: params.newMessage.channel,
    } as AiriAutoReplyParams["newMessage"],
    conversation: {
      _id: params.conversation._id,
      sourceId: params.conversation.sourceId,
      createdAt: params.conversation.createdAt,
      updatedAt: params.conversation.updatedAt,
      lastMessageAt: params.conversation.lastMessageAt,
    } as AiriAutoReplyParams["conversation"],
    chatDocument: {
      _id: params.chatDocument._id,
      sourceId: params.chatDocument.sourceId,
      workspaceId: params.chatDocument.workspaceId,
      businessConnectionId: params.chatDocument.businessConnectionId,
    } as AiriAutoReplyParams["chatDocument"],
  };
}

export async function queueInstagramAiriAutoReply(
  params: AiriAutoReplyParams,
  options: {
    missingContextError: string;
  }
) {
  const workspaceId = String(params.workspaceId || "");
  const conversationId = String(params.conversation?._id || "");
  const messageId = String(params.newMessage?._id || "");

  if (!workspaceId || !conversationId || !messageId) {
    throw new Error(options.missingContextError);
  }

  await acceptAiriConversationIngress(
    params.newMessage,
    buildInstagramAiriJobPayload(params)
  );
}

export async function publishInstagramConversationMessage(params: {
  workspaceId: string;
  conversationId: unknown;
  messageId: unknown;
  isNewConversation: boolean;
}) {
  await invalidateRequestsForWorkspace(params.workspaceId);
  const { triggerConversationRealtime } = await import(
    "@/lib/realtime-updates"
  );
  await triggerConversationRealtime(
    String(params.conversationId),
    params.isNewConversation
  );
  await realtime.trigger(
    `private-conversation-${params.conversationId}`,
    "new-message",
    await Message.findById(params.messageId).populate({
      path: "author",
      model: User,
      select: "firstName isBot",
    })
  );
}
