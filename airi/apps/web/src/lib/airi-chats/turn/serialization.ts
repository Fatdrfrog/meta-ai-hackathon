/** Public projections of threads, messages and run events. */

import {
  metaAdsMcpTransactionV2Schema,
  type MetaAdsMcpTransactionV2,
} from "@/lib/meta-ads/mcp/confirmation-contract";
import type { AiriMetaAdsMcpConfirmationExecution } from "@/lib/airi-chats/meta-ads-mcp-confirmation-store";
import { normalizeAiriChatPendingActions } from "@/lib/airi-chats/pending-actions";
import type { AiriChatRunEvent } from "@/lib/airi-chats/run-events";
import type {
  SerializedAiriChatThread,
  SerializedAiriChatMessage,
  ThreadLike,
  MessageLike,
} from "./types";

export function serializeThreadRunEvent(
  thread: ThreadLike
): Extract<AiriChatRunEvent, { type: "thread" }>["thread"] {
  const serialized = serializeAiriChatThread(thread);
  return {
    id: serialized.id,
    title: serialized.title,
    source: serialized.source,
    pinnedAt: serialized.pinnedAt,
    updatedAt: serialized.updatedAt,
  };
}

export function serializeUserRunMessage(
  message: MessageLike
): Extract<AiriChatRunEvent, { type: "user_message" }>["message"] {
  const serialized = serializeAiriChatMessage(message);
  return {
    id: serialized.id,
    threadId: serialized.threadId,
    role: "user",
    content: serialized.content,
    metadata: serialized.metadata,
    createdAt: serialized.createdAt,
  };
}

export function serializeAssistantRunMessage(
  message: MessageLike
): Extract<AiriChatRunEvent, { type: "assistant_message" }>["message"] {
  const serialized = serializeAiriChatMessage(message);
  return {
    id: serialized.id,
    threadId: serialized.threadId,
    role: "assistant",
    content: serialized.content,
    metadata: serialized.metadata,
    createdAt: serialized.createdAt,
  };
}

export function serializeAiriChatThread(
  thread: ThreadLike
): SerializedAiriChatThread {
  const createdAt = thread.createdAt ? new Date(thread.createdAt) : new Date();
  const updatedAt = thread.updatedAt ? new Date(thread.updatedAt) : createdAt;

  return {
    id: String(thread._id),
    workspaceId: thread.workspaceId,
    title: thread.title,
    status: thread.status,
    source: thread.source,
    pinnedAt: thread.pinnedAt ? new Date(thread.pinnedAt).toISOString() : null,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

export type PublicMetaAdsMcpExecution = {
  version: 1 | 2;
  id: string;
  toolName: string;
  summary: string;
  status: "executing" | "not_executed" | "succeeded" | "outcome_unknown";
  claimedAt: string;
  completedAt?: string;
  transaction?: MetaAdsMcpTransactionV2;
  reconciliation?: {
    actorUserId?: string;
    resolution: "succeeded" | "not_executed";
    note: string;
    providerIdentifiers?: Array<{ kind: string; id: string }>;
    reconciledAt: string;
  };
};

export function toPublicMetaAdsMcpReconciliation(
  value: unknown
): PublicMetaAdsMcpExecution["reconciliation"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const reconciliation = value as Record<string, unknown>;
  const resolution = reconciliation.resolution;
  const note = reconciliation.note;
  const reconciledAt = reconciliation.reconciledAt;
  if (
    (resolution !== "succeeded" && resolution !== "not_executed") ||
    typeof note !== "string" ||
    !note.trim() ||
    note.length > 500 ||
    typeof reconciledAt !== "string"
  ) {
    return undefined;
  }
  const rawIdentifiers = reconciliation.providerIdentifiers;
  const providerIdentifiers = Array.isArray(rawIdentifiers)
    ? rawIdentifiers.flatMap(identifier => {
        if (!identifier || typeof identifier !== "object") return [];
        const record = identifier as Record<string, unknown>;
        return typeof record.kind === "string" &&
          record.kind.trim() &&
          record.kind.length <= 100 &&
          typeof record.id === "string" &&
          record.id.trim() &&
          record.id.length <= 200
          ? [{ kind: record.kind, id: record.id }]
          : [];
      })
    : [];
  if (providerIdentifiers.length > 20) return undefined;
  const actor =
    typeof reconciliation.actorUserId === "string"
      ? reconciliation.actorUserId
      : typeof reconciliation.userId === "string"
        ? reconciliation.userId
        : undefined;
  return {
    ...(actor ? { actorUserId: actor } : {}),
    resolution,
    note,
    ...(providerIdentifiers.length ? { providerIdentifiers } : {}),
    reconciledAt,
  };
}

export function toPublicMetaAdsMcpExecution(
  value: unknown
): PublicMetaAdsMcpExecution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const execution = value as Partial<AiriMetaAdsMcpConfirmationExecution> &
    Record<string, unknown>;
  if (
    typeof execution.id !== "string" ||
    typeof execution.claimedAt !== "string"
  ) {
    return null;
  }
  const rawStatus = execution.status;
  const status = rawStatus === "rejected" ? "not_executed" : rawStatus;
  if (
    status !== "executing" &&
    status !== "not_executed" &&
    status !== "succeeded" &&
    status !== "outcome_unknown"
  ) {
    return null;
  }

  if (execution.version === 2) {
    const parsedTransaction = metaAdsMcpTransactionV2Schema.safeParse(
      execution.transaction
    );
    if (
      !parsedTransaction.success ||
      parsedTransaction.data.id !== execution.id
    ) {
      return null;
    }
    const reconciliation = toPublicMetaAdsMcpReconciliation(
      execution.reconciliation
    );
    const exposesProtectedTransaction =
      status === "executing" || status === "outcome_unknown";
    return {
      version: 2,
      id: execution.id,
      toolName: parsedTransaction.data.tool.name,
      summary: parsedTransaction.data.summary,
      status,
      claimedAt: execution.claimedAt,
      ...(typeof execution.completedAt === "string"
        ? { completedAt: execution.completedAt }
        : {}),
      ...(exposesProtectedTransaction
        ? { transaction: parsedTransaction.data }
        : {}),
      ...(reconciliation ? { reconciliation } : {}),
    };
  }

  if (
    execution.version !== 1 ||
    typeof execution.toolName !== "string" ||
    typeof execution.summary !== "string"
  ) {
    return null;
  }
  const legacyReconciliation = toPublicMetaAdsMcpReconciliation(
    execution.reconciliation
  );
  return {
    version: 1,
    id: execution.id,
    toolName: execution.toolName,
    summary: execution.summary,
    status,
    claimedAt: execution.claimedAt,
    ...(typeof execution.completedAt === "string"
      ? { completedAt: execution.completedAt }
      : {}),
    ...(legacyReconciliation ? { reconciliation: legacyReconciliation } : {}),
  };
}

export function toPublicAiriChatMessageMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!metadata) return null;
  const publicMetadata = { ...metadata };

  if ("pendingActions" in publicMetadata) {
    // Reconstruct only safe action fields, including the explicit legacy-expired
    // sentinel, rather than exposing historical mutation payload fields.
    publicMetadata.pendingActions = normalizeAiriChatPendingActions(metadata);
  }
  if ("airiMetaAdsMcpPending" in publicMetadata) {
    const pending = publicMetadata.airiMetaAdsMcpPending;
    publicMetadata.airiMetaAdsMcpPending = Array.isArray(pending)
      ? pending.flatMap(value => {
          const parsed = metaAdsMcpTransactionV2Schema.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  }
  if ("airiMetaAdsMcpExecutions" in publicMetadata) {
    const executions = publicMetadata.airiMetaAdsMcpExecutions;
    publicMetadata.airiMetaAdsMcpExecutions = Array.isArray(executions)
      ? executions.flatMap(value => {
          const projected = toPublicMetaAdsMcpExecution(value);
          return projected ? [projected] : [];
        })
      : [];
  }
  return publicMetadata;
}

export function toPublicAiriChatMessageContent(message: MessageLike): string {
  const metadata = message.metadata;
  if (
    metadata?.intent !== "meta_ads_mcp" ||
    typeof metadata.confirmedMutationId !== "string" ||
    message.content.startsWith("Requested status:")
  ) {
    return message.content;
  }
  const toolName =
    typeof metadata.confirmedToolName === "string"
      ? metadata.confirmedToolName
      : "Meta Ads action";
  const rawStatus = metadata.confirmationStatus;
  const status = rawStatus === "rejected" ? "not_executed" : rawStatus;
  const providerOutcome =
    status === "succeeded"
      ? "Completed"
      : status === "not_executed"
        ? "Not executed"
        : "Unknown";
  return `Requested status: **Unavailable for this legacy confirmation**\n\nProvider outcome: **${providerOutcome}**\n\nThe historical provider payload for **${toolName}** is hidden. Review Meta Ads Manager when provider outcome is unknown.`;
}

export function serializeAiriChatMessage(
  message: MessageLike
): SerializedAiriChatMessage {
  const createdAt = message.createdAt
    ? new Date(message.createdAt)
    : new Date();

  return {
    id: String(message._id),
    threadId: String(message.threadId),
    workspaceId: message.workspaceId,
    role: message.role,
    content: toPublicAiriChatMessageContent(message),
    metadata: toPublicAiriChatMessageMetadata(message.metadata),
    createdAt: createdAt.toISOString(),
  };
}
