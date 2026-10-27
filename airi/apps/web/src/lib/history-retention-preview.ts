import {
  asRecord,
  type UnknownRecord as Row,
} from "@icecore/shared/lib/value-utils";
import { getWhatsAppRecoverySourceMessage } from "@icecore/airi-runtime/whatsapp-message-recovery";
type PreviewInput = {
  companyId: string;
  workspaceId: string;
  retentionDays: number;
  now: Date;
  conversations: Array<{
    conversation: Row;
    messages: Row[];
    messagesComplete: boolean;
  }>;
};

export function buildHistoryRetentionPreview(input: PreviewInput) {
  if (
    !input.companyId ||
    !input.workspaceId ||
    !Number.isInteger(input.retentionDays) ||
    input.retentionDays < 180 ||
    input.retentionDays > 3650 ||
    !Number.isFinite(input.now.getTime())
  ) {
    throw new Error(
      "A company, workspace and retention period between 180 and 3650 days are required."
    );
  }
  if (input.conversations.length > 100)
    throw new Error("Preview is limited to 100 conversations per page.");
  const cutoff = new Date(
    input.now.getTime() - input.retentionDays * 86_400_000
  );
  const old = (value: unknown) => {
    if (!(typeof value === "string" || value instanceof Date)) return false;
    const time = new Date(value).getTime();
    return Number.isFinite(time) && time < cutoff.getTime();
  };
  const candidates: Array<{
    conversationId: string;
    messageIds: string[];
    messageCount: number;
    declaredMediaBytes: number;
  }> = [];
  const excluded: Array<{ conversationId: string; reason: string }> = [];
  for (const entry of input.conversations) {
    const { conversation, messages } = entry;
    const conversationId = String(conversation._id);
    let reason: string | null = null;
    if (conversation.workspaceId !== input.workspaceId)
      reason = "workspace_mismatch";
    else if (
      conversation.status !== "closed" ||
      !old(conversation.service_closed_at) ||
      !old(conversation.lastMessageAt) ||
      !old(conversation.updatedAt)
    )
      reason = "not_closed_and_inactive";
    else if (
      conversation.airi_scenario_state ||
      conversation.airi_pending_generative_execution ||
      (conversation.classification_state &&
        !["ready", "not_applicable"].includes(
          String(asRecord(conversation.classification_state).status)
        ))
    )
      reason = "workflow_or_recovery_state";
    else if (!entry.messagesComplete || messages.length > 1000)
      reason = "message_page_incomplete";
    else if (
      messages.some(
        message =>
          message.workspaceId !== input.workspaceId ||
          String(message.conversation) !== conversationId ||
          !old(message.date) ||
          ["unsupported", "errors"].includes(
            String(
              getWhatsAppRecoverySourceMessage(message.rawSourcePayload)?.type
            )
          ) ||
          ["reserved", "dispatching", "outcome_unknown"].includes(
            String(asRecord(message.temporalDispatch).state)
          ) ||
          (asRecord(message.mediaAnalysis).status &&
            !["completed", "skipped"].includes(
              String(asRecord(message.mediaAnalysis).status)
            ))
      )
    )
      reason = "message_activity_or_recovery";
    if (reason) {
      excluded.push({ conversationId, reason });
      continue;
    }
    candidates.push({
      conversationId,
      messageIds: messages.map(message => String(message._id)),
      messageCount: messages.length,
      declaredMediaBytes: messages.reduce(
        (sum, message) =>
          sum +
          (typeof message.fileSize === "number" &&
          Number.isSafeInteger(message.fileSize) &&
          message.fileSize > 0
            ? message.fileSize
            : 0),
        0
      ),
    });
  }
  return {
    companyId: input.companyId,
    workspaceId: input.workspaceId,
    retentionDays: input.retentionDays,
    cutoff: cutoff.toISOString(),
    generatedAt: input.now.toISOString(),
    deletionAuthorized: false as const,
    mediaBytesAreEstimates: true as const,
    candidates,
    excluded,
    noticeDraft: `Proposed airi.chat history policy: closed conversations inactive for ${input.retentionDays} days may be archived after advance notice. No deletion date has been set. Export access and the final notice period must be confirmed before this policy takes effect.`,
  };
}
