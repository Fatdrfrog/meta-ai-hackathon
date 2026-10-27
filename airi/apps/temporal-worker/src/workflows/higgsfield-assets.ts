import {
  assertContractVersion,
  HIGGSFIELD_ASSET_GENERATION_WORKFLOW_CONTRACT_VERSION,
  HIGGSFIELD_GENERATION_TIMEOUT_MS,
  HIGGSFIELD_GENERATION_WEBHOOK_SIGNAL,
  HIGGSFIELD_POLL_STATUS_ACTIVITY,
  HIGGSFIELD_PROCESS_WEBHOOK_ACTIVITY,
  HIGGSFIELD_STATUS_POLL_INTERVAL_MS,
  HIGGSFIELD_SUBMIT_GENERATION_ACTIVITY,
  type HiggsfieldAssetGenerationWebhookSignalInput,
  type HiggsfieldAssetGenerationWorkflowInput,
  type HiggsfieldAssetGenerationWorkflowResult,
  type HiggsfieldPollStatusActivityInput,
  type HiggsfieldProcessWebhookActivityInput,
  type HiggsfieldProcessWebhookActivityResult,
  type HiggsfieldSubmitGenerationActivityResult,
} from "@icecore/temporal";
import {
  condition,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
  setWorkflowOptions,
} from "@temporalio/workflow";

const webhookSignal = defineSignal<
  [HiggsfieldAssetGenerationWebhookSignalInput]
>(HIGGSFIELD_GENERATION_WEBHOOK_SIGNAL);

const higgsfieldActivities = proxyActivities<{
  [HIGGSFIELD_SUBMIT_GENERATION_ACTIVITY]: (
    input: HiggsfieldAssetGenerationWorkflowInput,
  ) => Promise<HiggsfieldSubmitGenerationActivityResult>;
  [HIGGSFIELD_PROCESS_WEBHOOK_ACTIVITY]: (
    input: HiggsfieldProcessWebhookActivityInput,
  ) => Promise<HiggsfieldProcessWebhookActivityResult>;
  [HIGGSFIELD_POLL_STATUS_ACTIVITY]: (
    input: HiggsfieldPollStatusActivityInput,
  ) => Promise<HiggsfieldAssetGenerationWebhookSignalInput>;
}>({
  startToCloseTimeout: "600s",
  retry: {
    maximumAttempts: 5,
    initialInterval: "10s",
    backoffCoefficient: 2,
    maximumInterval: "5m",
  },
});

const higgsfieldSubmitGenerationActivity = higgsfieldActivities[
  HIGGSFIELD_SUBMIT_GENERATION_ACTIVITY
] as (
  input: HiggsfieldAssetGenerationWorkflowInput,
) => Promise<HiggsfieldSubmitGenerationActivityResult>;

const higgsfieldProcessWebhookActivity = higgsfieldActivities[
  HIGGSFIELD_PROCESS_WEBHOOK_ACTIVITY
] as (
  input: HiggsfieldProcessWebhookActivityInput,
) => Promise<HiggsfieldProcessWebhookActivityResult>;

const higgsfieldPollStatusActivity = higgsfieldActivities[
  HIGGSFIELD_POLL_STATUS_ACTIVITY
] as (
  input: HiggsfieldPollStatusActivityInput,
) => Promise<HiggsfieldAssetGenerationWebhookSignalInput>;

const MAX_QUEUED_WEBHOOK_SIGNALS = 20;

function validateContractVersion(
  input: HiggsfieldAssetGenerationWorkflowInput,
) {
  assertContractVersion(
    input.contractVersion,
    { max: HIGGSFIELD_ASSET_GENERATION_WORKFLOW_CONTRACT_VERSION },
    "Higgsfield workflow",
  );
}

function timeoutWebhook(
  requestId: string | null,
): HiggsfieldAssetGenerationWebhookSignalInput {
  return {
    requestId,
    status: "failed",
    payload: {
      status: "failed",
      request_id: requestId,
      error: "Timed out waiting for Higgsfield webhook",
    },
  };
}

function failureMessage(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current instanceof Error) {
      const message = current.message.trim();
      if (message && !/^Activity task failed/i.test(message)) {
        return message;
      }
      current = current.cause;
      continue;
    }
    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }
    break;
  }
  return "Failed to start Higgsfield generation";
}

function failureWebhook(
  error: unknown,
): HiggsfieldAssetGenerationWebhookSignalInput {
  return {
    requestId: null,
    status: "failed",
    payload: {
      status: "failed",
      error: failureMessage(error),
    },
  };
}

function isTerminalProviderStatus(
  webhook: HiggsfieldAssetGenerationWebhookSignalInput,
): boolean {
  return (
    webhook.status === "completed" ||
    webhook.status === "failed" ||
    webhook.status === "nsfw" ||
    webhook.status === "cancelled"
  );
}

export async function higgsfieldAssetGenerationWorkflow(
  input: HiggsfieldAssetGenerationWorkflowInput,
): Promise<HiggsfieldAssetGenerationWorkflowResult> {
  validateContractVersion(input);

  const webhooks: HiggsfieldAssetGenerationWebhookSignalInput[] = [];
  setHandler(webhookSignal, (payload) => {
    const last = webhooks[webhooks.length - 1];
    if (
      last &&
      last.requestId === payload.requestId &&
      last.status === payload.status
    ) {
      webhooks[webhooks.length - 1] = payload;
      return;
    }
    webhooks.push(payload);
    if (webhooks.length > MAX_QUEUED_WEBHOOK_SIGNALS) {
      webhooks.splice(0, webhooks.length - MAX_QUEUED_WEBHOOK_SIGNALS);
    }
  });

  let start: HiggsfieldSubmitGenerationActivityResult;
  try {
    start = await higgsfieldSubmitGenerationActivity(input);
  } catch (error) {
    return higgsfieldProcessWebhookActivity({
      contractVersion: input.contractVersion,
      assetId: input.assetId,
      webhook: failureWebhook(error),
    });
  }

  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? Math.max(1, Math.floor(input.timeoutMs))
      : HIGGSFIELD_GENERATION_TIMEOUT_MS;
  const pollIntervalMs = Math.min(
    HIGGSFIELD_STATUS_POLL_INTERVAL_MS,
    timeoutMs,
  );
  const startedAt = Date.now();

  while (true) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      return higgsfieldProcessWebhookActivity({
        contractVersion: input.contractVersion,
        assetId: input.assetId,
        webhook: timeoutWebhook(start.providerRequestId),
      });
    }

    const remainingMs = Math.max(0, timeoutMs - elapsedMs);
    const waitMs = Math.max(1, Math.min(pollIntervalMs, remainingMs || 1));
    const signaled = await condition(() => webhooks.length > 0, waitMs);

    let webhook: HiggsfieldAssetGenerationWebhookSignalInput | undefined;
    if (signaled) {
      webhook = webhooks.shift() ?? timeoutWebhook(start.providerRequestId);
    } else if (start.providerStatusUrl || start.providerRequestId) {
      try {
        webhook = await higgsfieldPollStatusActivity({
          contractVersion: input.contractVersion,
          assetId: input.assetId,
          providerRequestId: start.providerRequestId,
          providerStatusUrl: start.providerStatusUrl,
        });
      } catch (pollError) {
        log.warn("status_poll_failed", {
          assetId: input.assetId,
          requestId: start.providerRequestId,
          error:
            pollError instanceof Error ? pollError.message : String(pollError),
        });
        if (Date.now() - startedAt < timeoutMs) {
          continue;
        }
        webhook = timeoutWebhook(start.providerRequestId);
      }
    } else {
      webhook = timeoutWebhook(start.providerRequestId);
    }

    const result = await higgsfieldProcessWebhookActivity({
      contractVersion: input.contractVersion,
      assetId: input.assetId,
      webhook,
    });

    if (result.terminal) {
      return result;
    }

    if (
      Date.now() - startedAt >= timeoutMs &&
      !isTerminalProviderStatus(webhook)
    ) {
      return higgsfieldProcessWebhookActivity({
        contractVersion: input.contractVersion,
        assetId: input.assetId,
        webhook: timeoutWebhook(start.providerRequestId),
      });
    }
  }
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  higgsfieldAssetGenerationWorkflow,
);
