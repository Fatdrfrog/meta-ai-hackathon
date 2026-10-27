import Message from "@/models/message";
import { hasHumanOutboundSince } from "@/lib/airi/reply/runtime/human-outbound";
import { airiOrchestrationLogger } from "@/lib/airi/reply/runtime/reply-logging";

export type ShouldContinueProcessingOptions = {
  preserveScenarioDelivery?: boolean;
  checkpointLabel?: string | null;
};

/**
 * Mid-turn cancellation checkpoint. Turns for one conversation already run
 * one at a time (the per-conversation workflow and the Mongo preparation
 * claim), so the turn's own message is the reference point: a newer inbound
 * message, or a human reply after it, cancels the turn. Both checks are
 * indexed Mongo reads, about a millisecond from the worker.
 */
export async function shouldContinueProcessing(
  workspaceId: string,
  conversationId: string,
  currentMessageId: string,
  currentTimestamp: number,
  options: ShouldContinueProcessingOptions = {}
): Promise<boolean> {
  try {
    const newerMessagePromise = Message.findOne({
      conversation: conversationId,
      direction: "inbound",
      date: { $gt: new Date(currentTimestamp) },
    })
      .sort({ date: -1 })
      .lean()
      .select("_id date") as Promise<{ _id: unknown; date?: Date } | null>;
    const newerHumanOutboundPromise = hasHumanOutboundSince({
      conversationId,
      since: new Date(currentTimestamp + 1),
    });

    const [newerMessage, newerHumanOutbound] = await Promise.all([
      newerMessagePromise,
      newerHumanOutboundPromise,
    ]);

    if (newerMessage) {
      airiOrchestrationLogger.info("airi.orchestration.processing_guard", {
        workspaceId,
        conversationId,
        messageId: currentMessageId,
        note: options.preserveScenarioDelivery
          ? "preserved_scenario_delivery_after_newer_inbound_message"
          : "cancelled_newer_inbound_message",
        newerMessageId: String(newerMessage._id || ""),
        checkpointLabel: options.checkpointLabel || null,
      });
      if (!options.preserveScenarioDelivery) {
        return false; // Abort - newer message exists
      }
    }

    if (newerHumanOutbound) {
      airiOrchestrationLogger.info("airi.orchestration.processing_guard", {
        workspaceId,
        conversationId,
        messageId: currentMessageId,
        note: options.preserveScenarioDelivery
          ? "preserved_scenario_delivery_after_newer_human_outbound"
          : "cancelled_newer_human_outbound",
        checkpointLabel: options.checkpointLabel || null,
      });
      if (!options.preserveScenarioDelivery) {
        return false; // Abort - manager/human took over
      }
    }

    return true; // Continue processing
  } catch (err) {
    airiOrchestrationLogger.error("airi.orchestration.processing_guard", err, {
      workspaceId,
      conversationId,
      messageId: currentMessageId,
      note: "processing_guard_check_failed",
    });
    return true; // On error, continue processing
  }
}
