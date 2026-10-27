import connectDB from "@/lib/mongoose";
import { recordCustomerStageSnapshotForConversation } from "@/lib/customers/service";
import { Conversation } from "@/models/conversation";

export type BulkCampaignCronMeta = {
  scenarioId?: string;
  scheduleId?: string;
  nodeId?: string;
  conversationId?: string;
  templateName?: string;
  nextInternalLabel?: string;
};

export async function applyBulkCampaignCronTransitions(
  cronMeta: BulkCampaignCronMeta | undefined
) {
  const effectiveScenarioId = cronMeta?.scenarioId || cronMeta?.scheduleId;
  if (!cronMeta?.conversationId || !effectiveScenarioId || !cronMeta?.nodeId) {
    return;
  }

  try {
    await connectDB();

    const setPatch: Record<string, unknown> = {
      last_bulk_sent_at: new Date(),
    };

    if (cronMeta.nextInternalLabel && cronMeta.nextInternalLabel !== "none") {
      setPatch.internal_labels = [cronMeta.nextInternalLabel];
    }

    await Conversation.updateOne(
      { _id: cronMeta.conversationId },
      {
        $set: setPatch,
        $push: {
          bulk_campaign_history: {
            scheduleId: cronMeta.scheduleId || effectiveScenarioId,
            scenarioId: effectiveScenarioId,
            nodeId: cronMeta.nodeId,
            sentAt: new Date(),
            templateName: cronMeta.templateName,
            labelApplied:
              cronMeta.nextInternalLabel &&
              cronMeta.nextInternalLabel !== "none"
                ? cronMeta.nextInternalLabel
                : undefined,
          },
        },
      }
    );

    await recordCustomerStageSnapshotForConversation({
      conversationId: cronMeta.conversationId,
      actor: { type: "system", label: "bulk_campaign_transition" },
    }).catch(() => null);
  } catch (error) {
    console.error("[Job] Failed to apply cron transitions", {
      conversationId: cronMeta.conversationId,
      scenarioId: effectiveScenarioId,
      nodeId: cronMeta.nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
