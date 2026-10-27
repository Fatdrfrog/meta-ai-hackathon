/** Confirmation and reconciliation of prepared Meta Ads MCP writes. */

import { AiriChatThreadNotFoundError } from "@/lib/airi-chats/errors";
import {
  AiriMetaAdsMcpConfirmationError,
  confirmAiriMetaAdsMcpMutationExecution,
  reconcileAiriMetaAdsMcpMutationExecution,
} from "@/lib/airi-chats/meta-ads-mcp-confirmation";
import { Types } from "mongoose";
import type {
  SupabaseClient,
  SerializedAiriChatMessage,
  MessageLike,
} from "./types";
import { serializeAiriChatMessage } from "./serialization";
import { getAiriChatThreadForUser } from "./persistence";

export type AiriChatMetaAdsMcpMutationResult = {
  assistantMessage: SerializedAiriChatMessage;
  confirmedMutationId: string;
  executionStatus: "succeeded" | "not_executed" | "outcome_unknown";
  replayed: boolean;
};

export async function confirmAiriChatMetaAdsMcpMutation(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  userId: string;
  threadId: string;
  messageId: string;
  mutationId: string;
  transactionDigest: string;
}): Promise<AiriChatMetaAdsMcpMutationResult> {
  const thread = await getAiriChatThreadForUser({
    workspaceId: params.workspaceId,
    userId: params.userId,
    threadId: params.threadId,
  });
  if (!thread) {
    throw new AiriChatThreadNotFoundError();
  }
  if (!Types.ObjectId.isValid(params.messageId)) {
    throw new AiriMetaAdsMcpConfirmationError(
      "CONFIRMATION_NOT_FOUND",
      "Message not found"
    );
  }

  const confirmed = await confirmAiriMetaAdsMcpMutationExecution({
    supabase: params.supabase,
    workspaceId: params.workspaceId,
    userId: params.userId,
    threadId: String(thread._id),
    messageId: params.messageId,
    mutationId: params.mutationId,
    transactionDigest: params.transactionDigest,
  });
  await thread.save();

  return {
    assistantMessage: serializeAiriChatMessage(
      confirmed.assistantMessage as MessageLike
    ),
    confirmedMutationId: confirmed.confirmedMutationId,
    executionStatus: confirmed.executionStatus,
    replayed: confirmed.replayed,
  };
}

export async function reconcileAiriChatMetaAdsMcpMutation(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  userId: string;
  threadId: string;
  messageId: string;
  mutationId: string;
  transactionDigest?: string;
  resolution: "succeeded" | "not_executed";
  note: string;
  providerIdentifiers?: Array<{ kind: string; id: string }>;
}): Promise<AiriChatMetaAdsMcpMutationResult> {
  const thread = await getAiriChatThreadForUser({
    workspaceId: params.workspaceId,
    userId: params.userId,
    threadId: params.threadId,
  });
  if (!thread) {
    throw new AiriChatThreadNotFoundError();
  }
  if (!Types.ObjectId.isValid(params.messageId)) {
    throw new AiriMetaAdsMcpConfirmationError(
      "CONFIRMATION_NOT_FOUND",
      "Message not found"
    );
  }

  const reconciled = await reconcileAiriMetaAdsMcpMutationExecution({
    supabase: params.supabase,
    workspaceId: params.workspaceId,
    userId: params.userId,
    threadId: String(thread._id),
    messageId: params.messageId,
    mutationId: params.mutationId,
    transactionDigest: params.transactionDigest,
    resolution: params.resolution,
    note: params.note,
    providerIdentifiers: params.providerIdentifiers,
  });
  await thread.save();

  return {
    assistantMessage: serializeAiriChatMessage(
      reconciled.assistantMessage as MessageLike
    ),
    confirmedMutationId: reconciled.confirmedMutationId,
    executionStatus: reconciled.executionStatus,
    replayed: reconciled.replayed,
  };
}
