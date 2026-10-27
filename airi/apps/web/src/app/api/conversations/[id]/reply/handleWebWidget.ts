import {
  persistManagerOutboundMessage,
  upsertManagerAuthor,
} from "@/lib/conversation-messages";
import { realtime } from "@/lib/realtime/server";
import type { PopulatedMessage } from "@/types/models";
import type { ManagerReplyContext } from "./manager-reply-context";

export async function handleWebWidget({
  conversation,
  text,
  workspaceId,
  manager,
}: ManagerReplyContext): Promise<PopulatedMessage> {
  const managerUser = await upsertManagerAuthor(manager);
  const now = new Date();

  // Widget messages have no provider id; the widget shows the author name
  // separately, so the text carries no name prefix.
  const message = await persistManagerOutboundMessage({
    conversation,
    workspaceId,
    channel: "web_widget",
    managerId: manager.id,
    managerUser,
    message: { date: now, text },
    logTag: "Reply:WebWidget",
  });

  // The visitor's widget listens on its own channel.
  await realtime
    .trigger(`conversation-${conversation._id}`, "message.new", {
      id: String(message._id),
      conversationId: String(conversation._id),
      workspaceId,
      text,
      direction: "outbound",
      timestamp: now.toISOString(),
      authorName: managerUser.firstName || manager.name,
    })
    .catch(() => {
      console.warn("[Reply:WebWidget] Widget realtime emit failed", {
        conversationId: String(conversation._id),
        workspaceId,
        messageId: String(message._id),
      });
    });

  return message;
}
