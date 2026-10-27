import connectDB from "@/lib/mongoose";
import CampaignDeliveryTask from "@/models/campaign-delivery-task";

export async function retireCampaignDeliveryTasksForScenario(params: {
  workspaceId: string;
  scenarioId: string;
  reason: string;
  now?: Date;
}) {
  await connectDB();

  const now = params.now || new Date();
  const result = await CampaignDeliveryTask.updateMany(
    {
      workspaceId: params.workspaceId,
      scenarioId: params.scenarioId,
      status: { $in: ["pending", "retry"] },
    },
    {
      $set: {
        status: "skipped",
        completedAt: now,
        skipReason: params.reason,
        lastError: null,
        processingStartedAt: null,
        processingLeaseId: null,
        processingLeaseHeartbeatAt: null,
        wakeMethod: null,
        wakeMessageId: null,
        wakeScheduledFor: null,
        wakePublishedAt: null,
        wakeCancelledAt: now,
      },
    }
  );

  return {
    skipped: result.modifiedCount || 0,
  };
}
