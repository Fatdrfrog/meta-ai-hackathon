import type { ManagerAuthor } from "@/lib/conversation-messages";
import type {
  ConversationDocument,
  EmailSendResponse,
  PopulatedMessage,
} from "@/types/models";
import type { OutboundAttachment } from "@/types/outbound-attachment";

/**
 * What the reply route hands every channel handler. The route has already
 * validated the payload (text or a usable attachment, no profanity),
 * checked membership and the plan gate, and normalized the attachments for
 * the channel.
 */
export type ManagerReplyContext = {
  conversation: ConversationDocument;
  /** Trimmed; empty only when attachments carry the reply. */
  text: string;
  workspaceId: string;
  manager: ManagerAuthor;
  attachments: OutboundAttachment[];
  replyToMessageId?: string;
  instagramReplyMode: "comment" | "private";
};

export type ManagerReplyHandler = (
  context: ManagerReplyContext
) => Promise<PopulatedMessage | EmailSendResponse>;
