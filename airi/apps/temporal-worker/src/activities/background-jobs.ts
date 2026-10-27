import {
  assertContractVersion,
  AIRI_COACH_WORKFLOW_CONTRACT_VERSION,
  WIDGET_CSAT_WORKFLOW_CONTRACT_VERSION,
  type AiriCoachJobInput,
  type AiriCoachJobResult,
  type WidgetCsatActivityInput,
  type WidgetCsatActivityResult,
} from "@icecore/temporal";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { ApplicationFailure } from "@temporalio/activity";
import { getWorkspaceAiRequiredDetails } from "@icecore/shared/lib/workspace-ai-errors";
import { requireNonEmptyString as validateRequiredString } from "@icecore/shared/lib/value-utils";

function validateContractVersion(params: {
  value: number;
  max: number;
  label: string;
}): void {
  assertContractVersion(params.value, { max: params.max }, params.label);
}

export async function airiCoachActivity(
  input: AiriCoachJobInput,
): Promise<AiriCoachJobResult> {
  validateContractVersion({
    value: input.contractVersion,
    max: AIRI_COACH_WORKFLOW_CONTRACT_VERSION,
    label: "Airi coach activity",
  });

  const workspaceId = validateRequiredString(input.workspaceId, "workspaceId");
  const conversationId = validateRequiredString(
    input.conversationId,
    "conversationId",
  );
  const messageId = validateRequiredString(input.messageId, "messageId");

  airiWorkerLogger.info("airi.worker.background_jobs", {
    note: "airi_coach_start",
    workspaceId,
    conversationId,
    messageId,
  });

  const { runAiriCoachJob } = await import(
    "@/lib/airi/coach/run-airi-coach-job"
  );
  const result = await runAiriCoachJob({
    workspaceId,
    conversationId,
    messageId,
    agentId: input.agentId || null,
  }).catch((error: unknown) => {
    const required = getWorkspaceAiRequiredDetails(error);
    if (required) {
      throw ApplicationFailure.nonRetryable(required.error, required.code);
    }
    throw error;
  });

  airiWorkerLogger.info("airi.worker.background_jobs", {
    note: "airi_coach_complete",
    workspaceId,
    conversationId,
    messageId,
    skipped: result.skipped === true,
    reason: result.reason || null,
    tipCount: result.tipCount || 0,
  });

  return result;
}

export async function widgetCsatRequestActivity(
  input: WidgetCsatActivityInput,
): Promise<WidgetCsatActivityResult> {
  validateContractVersion({
    value: input.contractVersion,
    max: WIDGET_CSAT_WORKFLOW_CONTRACT_VERSION,
    label: "widget CSAT request activity",
  });

  const workspaceId = validateRequiredString(input.workspaceId, "workspaceId");
  const conversationId = validateRequiredString(
    input.conversationId,
    "conversationId",
  );

  const { sendWidgetCsatRequest } = await import("@/lib/widget-csat");
  return sendWidgetCsatRequest({
    workspaceId,
    conversationId,
  });
}

export async function widgetCsatTimeoutActivity(
  input: WidgetCsatActivityInput,
): Promise<WidgetCsatActivityResult> {
  validateContractVersion({
    value: input.contractVersion,
    max: WIDGET_CSAT_WORKFLOW_CONTRACT_VERSION,
    label: "widget CSAT timeout activity",
  });

  const workspaceId = validateRequiredString(input.workspaceId, "workspaceId");
  const conversationId = validateRequiredString(
    input.conversationId,
    "conversationId",
  );

  const { forceCloseWidgetCsatTimeout } = await import("@/lib/widget-csat");
  return forceCloseWidgetCsatTimeout({
    workspaceId,
    conversationId,
  });
}
