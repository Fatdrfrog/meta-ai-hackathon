import { enqueueAiriCoachJobBestEffort } from "@/lib/airi/coach/coach-jobs";
import { sendEmail } from "@/lib/email/send-email";

import type { EmailSendResponse } from "@/types/models";
import type { ManagerReplyContext } from "./manager-reply-context";

export async function handleEmailReply({
  conversation,
  text,
  workspaceId,
  replyToMessageId,
}: ManagerReplyContext): Promise<EmailSendResponse> {
  const to = conversation.participants?.from?.[0];
  const fromAddress = conversation.participants?.to?.[0];

  if (!to || !fromAddress) {
    throw new Error("Email participants missing");
  }

  // The route loads only the last linked message id for this fallback.
  const lastMessageId = conversation.messages?.length
    ? String(conversation.messages[conversation.messages.length - 1])
    : undefined;
  const targetReplyToMessageId = replyToMessageId || lastMessageId;

  const result = await sendEmail({
    workspaceId,
    fromAddress,
    to: [to],
    subject: conversation.subject || undefined,
    text,
    replyToMessageId: targetReplyToMessageId,
    conversationId: String(conversation._id),
  });

  if (!result.ok) {
    throw new Error(result.error || "Failed to send email");
  }

  if (result.messageId) {
    enqueueAiriCoachJobBestEffort(
      {
        workspaceId,
        conversationId: String(conversation._id),
        messageId: String(result.messageId),
      },
      "Reply:Email"
    );
  }

  return {
    success: true,
    messageId: result.messageId,
  };
}
