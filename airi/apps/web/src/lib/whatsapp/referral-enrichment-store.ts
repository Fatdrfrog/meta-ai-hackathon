import connectDB from "@/lib/mongoose";
import Message from "@/models/message";
import type { ConversationDocument } from "@/types/models";
import {
  hasWhatsAppReferralContent,
  mergeWhatsAppReferral,
} from "@icecore/airi-runtime/whatsapp-message-recovery";
import {
  persistWhatsAppConversationReferral,
  buildWhatsAppReferralRagContext,
  enrichWhatsAppReferralWithMetaAdMetadata,
  type NormalizedWhatsAppReferral,
} from "./referral-enrichment";

export type WhatsAppReferralEnrichmentIntent = {
  workspaceId: string;
  conversationId: string;
  messageId: string;
};

/** Both the outbox worker and Airi admission use this idempotent repair. */
export async function enrichStoredWhatsAppReferral(
  input: WhatsAppReferralEnrichmentIntent,
  options: { allowUnavailable?: boolean } = {}
): Promise<void> {
  await connectDB();
  const owner = {
    _id: input.messageId,
    workspaceId: input.workspaceId,
    conversation: input.conversationId,
    direction: "inbound",
    channel: "whatsapp",
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const message = await Message.findOne(owner).lean<{
      whatsappReferral?: NormalizedWhatsAppReferral;
      ragContext?: string;
      date: Date;
    } | null>();
    if (!message)
      throw new Error(
        "WhatsApp referral message is missing or changed ownership"
      );
    const previous = message.whatsappReferral;
    // An all-null default would only rewrite itself (and updatedAt) per message.
    if (!previous || !hasWhatsAppReferralContent(previous)) return;
    const enriched = await enrichWhatsAppReferralWithMetaAdMetadata({
      workspaceId: input.workspaceId,
      referral: previous,
    });
    if (!enriched) return;
    const merged = mergeWhatsAppReferral(
      previous,
      enriched
    ) as NormalizedWhatsAppReferral;
    const oldContext = buildWhatsAppReferralRagContext(previous);
    const nextContext = buildWhatsAppReferralRagContext(merged);
    const ragContext =
      oldContext && message.ragContext?.includes(oldContext)
        ? message.ragContext.replace(oldContext, nextContext || "")
        : [message.ragContext, nextContext].filter(Boolean).join("\n");
    const updated = await Message.updateOne(
      {
        ...owner,
        whatsappReferral: previous,
        ragContext: message.ragContext ?? null,
      },
      {
        $set: {
          whatsappReferral: merged,
          ...(ragContext ? { ragContext } : {}),
        },
      }
    );
    if (!updated.matchedCount) continue;
    // A crash after the message CAS must still repair the conversation on retry.
    await persistWhatsAppConversationReferral(
      {
        _id: input.conversationId,
        workspaceId: input.workspaceId,
      } as unknown as ConversationDocument,
      merged,
      message.date
    );
    if (
      merged.campaignLabelStatus === "unavailable" &&
      !options.allowUnavailable
    ) {
      throw new Error(
        "WhatsApp referral metadata unavailable; retry durable enrichment"
      );
    }
    return;
  }
  throw new Error(
    "WhatsApp referral enrichment contention; retry durable work"
  );
}
