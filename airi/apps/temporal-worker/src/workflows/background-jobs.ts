import {
  assertContractVersion,
  AIRI_COACH_ACTIVITY,
  AIRI_COACH_WORKFLOW_CONTRACT_VERSION,
  WIDGET_CSAT_REQUEST_ACTIVITY,
  WIDGET_CSAT_REQUEST_DELAY_MS,
  WIDGET_CSAT_TIMEOUT_ACTIVITY,
  WIDGET_CSAT_TIMEOUT_DELAY_MS,
  WIDGET_CSAT_WORKFLOW_CONTRACT_VERSION,
  type AiriCoachJobInput,
  type AiriCoachJobResult,
  type WidgetCsatActivityInput,
  type WidgetCsatActivityResult,
  type WidgetCsatWorkflowInput,
  type WidgetCsatWorkflowResult,
} from "@icecore/temporal";
import {
  proxyActivities,
  setWorkflowOptions,
  sleep,
} from "@temporalio/workflow";

const coachActivities = proxyActivities<{
  [AIRI_COACH_ACTIVITY]: (
    input: AiriCoachJobInput,
  ) => Promise<AiriCoachJobResult>;
}>({
  startToCloseTimeout: "300s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5s",
    backoffCoefficient: 2,
    maximumInterval: "60s",
  },
});

const csatActivities = proxyActivities<{
  [WIDGET_CSAT_REQUEST_ACTIVITY]: (
    input: WidgetCsatActivityInput,
  ) => Promise<WidgetCsatActivityResult>;
  [WIDGET_CSAT_TIMEOUT_ACTIVITY]: (
    input: WidgetCsatActivityInput,
  ) => Promise<WidgetCsatActivityResult>;
}>({
  startToCloseTimeout: "120s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "5s",
    backoffCoefficient: 2,
    maximumInterval: "120s",
  },
});

const airiCoachActivity = coachActivities[AIRI_COACH_ACTIVITY] as (
  input: AiriCoachJobInput,
) => Promise<AiriCoachJobResult>;

const widgetCsatRequestActivity = csatActivities[
  WIDGET_CSAT_REQUEST_ACTIVITY
] as (input: WidgetCsatActivityInput) => Promise<WidgetCsatActivityResult>;

const widgetCsatTimeoutActivity = csatActivities[
  WIDGET_CSAT_TIMEOUT_ACTIVITY
] as (input: WidgetCsatActivityInput) => Promise<WidgetCsatActivityResult>;

function validateContractVersion(params: {
  value: number;
  max: number;
  label: string;
}): void {
  assertContractVersion(params.value, { max: params.max }, params.label);
}

function resolveDelayMs(value: number | null | undefined, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.floor(value));
}

function shouldRunCsatTimeout(request: WidgetCsatActivityResult): boolean {
  if (!request.skipped) return true;
  return request.reason === "csat_already_sent";
}

export async function airiCoachWorkflow(
  input: AiriCoachJobInput,
): Promise<AiriCoachJobResult> {
  validateContractVersion({
    value: input.contractVersion,
    max: AIRI_COACH_WORKFLOW_CONTRACT_VERSION,
    label: "Airi coach workflow",
  });

  return airiCoachActivity(input);
}

export async function widgetCsatWorkflow(
  input: WidgetCsatWorkflowInput,
): Promise<WidgetCsatWorkflowResult> {
  validateContractVersion({
    value: input.contractVersion,
    max: WIDGET_CSAT_WORKFLOW_CONTRACT_VERSION,
    label: "widget CSAT workflow",
  });

  const activityInput: WidgetCsatActivityInput = {
    contractVersion: input.contractVersion,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
  };
  const requestDelayMs = resolveDelayMs(
    input.requestDelayMs,
    WIDGET_CSAT_REQUEST_DELAY_MS,
  );

  if (requestDelayMs > 0) {
    await sleep(requestDelayMs);
  }

  const request = await widgetCsatRequestActivity(activityInput);
  if (!shouldRunCsatTimeout(request)) {
    return {
      conversationId: input.conversationId,
      request,
      timeout: {
        ok: true,
        skipped: true,
        reason: "request_skipped",
      },
    };
  }

  const timeoutDelayMs = resolveDelayMs(
    input.timeoutDelayMs,
    WIDGET_CSAT_TIMEOUT_DELAY_MS,
  );

  if (timeoutDelayMs > 0) {
    await sleep(timeoutDelayMs);
  }

  const timeout = await widgetCsatTimeoutActivity(activityInput);
  return {
    conversationId: input.conversationId,
    request,
    timeout,
  };
}

setWorkflowOptions({ versioningBehavior: "AUTO_UPGRADE" }, airiCoachWorkflow);
setWorkflowOptions({ versioningBehavior: "AUTO_UPGRADE" }, widgetCsatWorkflow);
