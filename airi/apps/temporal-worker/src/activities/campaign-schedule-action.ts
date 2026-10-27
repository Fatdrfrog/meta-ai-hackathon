import {
  assertContractVersion,
  CAMPAIGN_SCHEDULE_ACTION_WORKFLOW_CONTRACT_VERSION,
  type CampaignScheduleActionClaimActivityInput,
  type CampaignScheduleActionClaimActivityResult,
  type CampaignScheduleActionCompleteActivityInput,
} from "@icecore/temporal";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { isMongoDuplicateKeyError } from "@icecore/shared/lib/mongo-errors";
import { readDate as normalizeDate } from "@icecore/shared/lib/value-utils";

type CampaignScheduleRunRecord = {
  childWorkflowId?: string | null;
  scheduledFor?: Date | string | null;
};

function assertSupportedContract(input: { contractVersion: number }) {
  assertContractVersion(
    input.contractVersion,
    { max: CAMPAIGN_SCHEDULE_ACTION_WORKFLOW_CONTRACT_VERSION },
    "campaign schedule action",
  );
}

async function resolveScheduleActionTime(input: {
  scheduleId: string;
  actionWorkflowId: string;
  actionWorkflowRunId: string;
  actionFirstExecutionRunId: string;
  scheduledFor?: Date | string | null;
  actionRunStartedAt?: Date | string | null;
}) {
  const scheduledFor = normalizeDate(input.scheduledFor);
  if (scheduledFor) {
    return {
      scheduledFor,
      takenAt: normalizeDate(input.actionRunStartedAt) || new Date(),
    };
  }

  const { getTemporalScheduleClient } = await import(
    "@/lib/temporal/campaign-node-run-client"
  );
  const description = await getTemporalScheduleClient()
    .getHandle(input.scheduleId)
    .describe();

  const recentActions = description.info.recentActions || [];
  const action = [...recentActions].reverse().find((candidate) => {
    if (candidate.action.type !== "startWorkflow") return false;
    const workflow = candidate.action.workflow;
    return (
      workflow.firstExecutionRunId === input.actionFirstExecutionRunId ||
      workflow.firstExecutionRunId === input.actionWorkflowRunId
    );
  });

  if (!action) {
    throw new Error(
      `Unable to resolve scheduled action time for ${input.scheduleId}`,
    );
  }

  return {
    scheduledFor: action.scheduledAt,
    takenAt: action.takenAt,
  };
}

async function findExistingScheduleRun(params: {
  scheduleId: string;
  scheduledFor: Date;
}): Promise<CampaignScheduleRunRecord | null> {
  const CampaignScheduleRun = (await import("@/models/campaign-schedule-run"))
    .default;
  return (await CampaignScheduleRun.findOne({
    scheduleId: params.scheduleId,
    scheduledFor: params.scheduledFor,
  })
    .select("childWorkflowId scheduledFor")
    .lean()) as CampaignScheduleRunRecord | null;
}

export async function campaignScheduleActionClaimActivity(
  input: CampaignScheduleActionClaimActivityInput,
): Promise<CampaignScheduleActionClaimActivityResult> {
  assertSupportedContract(input);

  const workspaceId = String(input.workspaceId || "").trim();
  const scenarioId = String(input.scenarioId || "").trim();
  const nodeId = String(input.nodeId || "").trim();
  const scheduleId = String(input.scheduleId || "").trim();
  if (!workspaceId || !scenarioId || !nodeId || !scheduleId) {
    throw new Error(
      "workspaceId, scenarioId, nodeId, and scheduleId are required",
    );
  }

  const connectDB = (await import("@/lib/mongoose")).default;
  const CampaignScheduleRun = (await import("@/models/campaign-schedule-run"))
    .default;
  await connectDB();

  const actionTime = await resolveScheduleActionTime(input);
  const scheduledFor = actionTime.scheduledFor;
  const scheduledForIso = scheduledFor.toISOString();

  const existing = await findExistingScheduleRun({ scheduleId, scheduledFor });
  if (existing?.childWorkflowId) {
    return {
      status: "duplicate",
      scheduleId,
      scheduledFor: scheduledForIso,
      existingChildWorkflowId: existing.childWorkflowId,
    };
  }

  try {
    await CampaignScheduleRun.findOneAndUpdate(
      { scheduleId, scheduledFor },
      {
        $setOnInsert: {
          workspaceId,
          scenarioId,
          nodeId,
          scheduleId,
          scheduledFor,
          takenAt: actionTime.takenAt,
          status: "claimed",
        },
        $set: {
          actionWorkflowId: input.actionWorkflowId,
          actionWorkflowRunId: input.actionWorkflowRunId,
          lastError: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  } catch (error) {
    if (!isMongoDuplicateKeyError(error)) {
      throw error;
    }
    const duplicate = await findExistingScheduleRun({
      scheduleId,
      scheduledFor,
    });
    if (duplicate?.childWorkflowId) {
      return {
        status: "duplicate",
        scheduleId,
        scheduledFor: scheduledForIso,
        existingChildWorkflowId: duplicate.childWorkflowId,
      };
    }
  }

  airiWorkerLogger.info("airi.worker.campaign_schedule_action", {
    note: "claimed",
    workspaceId,
    scenarioId,
    nodeId,
    scheduleId,
    scheduledFor: scheduledForIso,
  });

  return {
    status: "claimed",
    scheduleId,
    scheduledFor: scheduledForIso,
    takenAt: actionTime.takenAt.toISOString(),
  };
}

export async function campaignScheduleActionCompleteActivity(
  input: CampaignScheduleActionCompleteActivityInput,
): Promise<void> {
  assertSupportedContract(input);

  const scheduleId = String(input.scheduleId || "").trim();
  const scheduledFor = new Date(input.scheduledFor);
  if (!scheduleId || !Number.isFinite(scheduledFor.getTime())) {
    throw new Error("scheduleId and scheduledFor are required");
  }

  const connectDB = (await import("@/lib/mongoose")).default;
  const CampaignScheduleRun = (await import("@/models/campaign-schedule-run"))
    .default;
  await connectDB();

  await CampaignScheduleRun.findOneAndUpdate(
    { scheduleId, scheduledFor },
    {
      $set: {
        childWorkflowId: input.childWorkflowId,
        actionWorkflowId: input.actionWorkflowId,
        actionWorkflowRunId: input.actionWorkflowRunId,
        status: "started",
        lastError: null,
      },
    },
    { upsert: false, new: true },
  ).lean();
}
