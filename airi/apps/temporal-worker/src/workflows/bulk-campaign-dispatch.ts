import {
  assertContractVersion,
  BULK_CAMPAIGN_DISPATCH_BEGIN_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_FINALIZE_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_LIFECYCLE_FINALIZE_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_PAUSE_SIGNAL,
  BULK_CAMPAIGN_DISPATCH_PAUSE_WAIT_QUERY,
  BULK_CAMPAIGN_DISPATCH_PAUSED_QUERY,
  BULK_CAMPAIGN_DISPATCH_PROGRESS_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_SEND_BATCH_ACTIVITY,
  resolveBulkCampaignDispatchBatchLimit,
  resolveBulkCampaignDispatchInterBatchDelayMs,
  type BulkCampaignDispatchBatchResult,
  type BulkCampaignDispatchBeginInput,
  type BulkCampaignDispatchBeginResult,
  type BulkCampaignDispatchFinalizeInput,
  type BulkCampaignDispatchLifecycleFinalizeInput,
  type BulkCampaignDispatchProgressInput,
  type BulkCampaignDispatchSendBatchInput,
  type BulkCampaignDispatchWorkflowInput,
  type BulkCampaignDispatchWorkflowResult,
} from "@icecore/temporal";
import {
  CancellationScope,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  isCancellation,
  log,
  patched,
  proxyActivities,
  setHandler,
  setWorkflowOptions,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";

import { LEGACY_BULK_CAMPAIGN_DISPATCH_START_GRACE_MS } from "../legacy-bulk-campaign-expiry";

const LEGACY_DISPATCH_EXPIRY_PATCH_ID =
  "legacy-bulk-campaign-dispatch-expiry-v1";
const PAUSE_WAIT_PATCH_ID = "bulk-campaign-dispatch-pause-wait-v1";
const DAILY_WAVE_SPACING_PATCH_ID =
  "bulk-campaign-dispatch-daily-wave-spacing-v1";

const pauseSignal = defineSignal<[boolean]>(BULK_CAMPAIGN_DISPATCH_PAUSE_SIGNAL);
const pausedQuery = defineQuery<boolean>(BULK_CAMPAIGN_DISPATCH_PAUSED_QUERY);
const pauseWaitQuery = defineQuery<boolean>(
  BULK_CAMPAIGN_DISPATCH_PAUSE_WAIT_QUERY,
);

type BulkCampaignOperatorPauseState = {
  paused: boolean;
};

function resolveDispatchBatchStep(params: {
  index: number;
  batchSize: number;
  totalItems: number;
  delayMs: number;
  dailyWaveLimit?: number | null;
  jitterSeed: string;
  useDailyWaveSpacing: boolean;
}): { limit: number; nextIndex: number; waitMs: number } {
  const {
    index,
    batchSize,
    totalItems,
    delayMs,
    dailyWaveLimit,
    jitterSeed,
    useDailyWaveSpacing,
  } = params;
  if (!useDailyWaveSpacing) {
    const limit = Math.min(batchSize, totalItems - index);
    const nextIndex = index + batchSize;
    return {
      limit,
      nextIndex,
      waitMs: nextIndex < totalItems ? delayMs : 0,
    };
  }
  const limit = resolveBulkCampaignDispatchBatchLimit({
    index,
    batchSize,
    totalItems,
    dailyWaveLimit,
  });
  const nextIndex = index + limit;
  return {
    limit,
    nextIndex,
    waitMs:
      nextIndex < totalItems
        ? resolveBulkCampaignDispatchInterBatchDelayMs({
            index,
            batchSize: limit,
            totalItems,
            delayMs,
            dailyWaveLimit,
            jitterSeed,
          })
        : 0,
  };
}

async function waitForDispatchGap(
  pauseState: BulkCampaignOperatorPauseState,
  waitMs: number,
): Promise<void> {
  if (!patched(PAUSE_WAIT_PATCH_ID)) {
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    return;
  }

  const deadline = Date.now() + Math.max(0, Math.floor(waitMs));
  while (true) {
    if (pauseState.paused) {
      await condition(() => !pauseState.paused);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return;
    }
    const pausedDuringWait = await condition(
      () => pauseState.paused,
      remaining,
    );
    if (!pausedDuringWait) {
      return;
    }
  }
}

const batchActivities = proxyActivities<{
  [BULK_CAMPAIGN_DISPATCH_SEND_BATCH_ACTIVITY]: (
    input: BulkCampaignDispatchSendBatchInput,
  ) => Promise<BulkCampaignDispatchBatchResult>;
}>({
  startToCloseTimeout: "900s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "60s",
  },
});

const finalizeActivities = proxyActivities<{
  [BULK_CAMPAIGN_DISPATCH_FINALIZE_ACTIVITY]: (
    input: BulkCampaignDispatchFinalizeInput,
  ) => Promise<void>;
}>({
  startToCloseTimeout: "60s",
  retry: {
    maximumAttempts: 3,
  },
});

const lifecycleActivities = proxyActivities<{
  [BULK_CAMPAIGN_DISPATCH_BEGIN_ACTIVITY]: (
    input: BulkCampaignDispatchBeginInput,
  ) => Promise<BulkCampaignDispatchBeginResult>;
  [BULK_CAMPAIGN_DISPATCH_PROGRESS_ACTIVITY]: (
    input: BulkCampaignDispatchProgressInput,
  ) => Promise<boolean>;
  [BULK_CAMPAIGN_DISPATCH_LIFECYCLE_FINALIZE_ACTIVITY]: (
    input: BulkCampaignDispatchLifecycleFinalizeInput,
  ) => Promise<void>;
}>({
  startToCloseTimeout: "60s",
  retry: {
    maximumAttempts: 10,
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "30s",
  },
});

const dispatchBulkCampaignBatchActivity = batchActivities[
  BULK_CAMPAIGN_DISPATCH_SEND_BATCH_ACTIVITY
] as (
  input: BulkCampaignDispatchSendBatchInput,
) => Promise<BulkCampaignDispatchBatchResult>;

const dispatchBulkCampaignBatchLifecycleActivity = batchActivities[
  BULK_CAMPAIGN_DISPATCH_SEND_BATCH_ACTIVITY
] as (
  input: BulkCampaignDispatchSendBatchInput,
) => Promise<BulkCampaignDispatchBatchResult>;

const finalizeBulkCampaignDispatchActivity = finalizeActivities[
  BULK_CAMPAIGN_DISPATCH_FINALIZE_ACTIVITY
] as (input: BulkCampaignDispatchFinalizeInput) => Promise<void>;

const beginBulkCampaignDispatchActivity = lifecycleActivities[
  BULK_CAMPAIGN_DISPATCH_BEGIN_ACTIVITY
] as (
  input: BulkCampaignDispatchBeginInput,
) => Promise<BulkCampaignDispatchBeginResult>;

const updateBulkCampaignDispatchProgressActivity = lifecycleActivities[
  BULK_CAMPAIGN_DISPATCH_PROGRESS_ACTIVITY
] as (input: BulkCampaignDispatchProgressInput) => Promise<boolean>;

const finalizeBulkCampaignDispatchLifecycleActivity = lifecycleActivities[
  BULK_CAMPAIGN_DISPATCH_LIFECYCLE_FINALIZE_ACTIVITY
] as (input: BulkCampaignDispatchLifecycleFinalizeInput) => Promise<void>;

function computeInitialScheduleDelayMs(scheduledAt?: string | null) {
  if (!scheduledAt) return 0;
  const scheduledAtMs = Date.parse(scheduledAt);
  if (!Number.isFinite(scheduledAtMs)) return 0;
  return Math.max(0, scheduledAtMs - Date.now());
}

function resolveTotalItems(
  input: BulkCampaignDispatchWorkflowInput,
  usePayloadStore: boolean,
): number {
  if (usePayloadStore) {
    return input.itemCount!;
  }
  if (input.items && input.items.length > 0) {
    return input.items.length;
  }
  throw new Error(
    "Bulk campaign workflow requires items or itemsPayloadKey with itemCount",
  );
}

async function runLegacyBulkCampaignDispatch(
  input: BulkCampaignDispatchWorkflowInput,
  pauseState: BulkCampaignOperatorPauseState,
  useDailyWaveSpacing: boolean,
): Promise<BulkCampaignDispatchWorkflowResult> {
  const usePayloadStore =
    input.contractVersion >= 2 &&
    Boolean(input.itemsPayloadKey?.trim()) &&
    (input.itemCount ?? 0) > 0;

  const totalItems = resolveTotalItems(input, usePayloadStore);
  const batchSize = Math.max(1, Math.floor(input.batchPlan.batchSize || 1));
  const delayMs = Math.max(0, Math.floor(input.batchPlan.delayMs || 0));
  let successfulSends = 0;
  let failedSends = 0;
  let notAttemptedSends = 0;
  let batchCount = 0;
  const initialDelayMs = computeInitialScheduleDelayMs(input.scheduledAt);
  await waitForDispatchGap(pauseState, initialDelayMs);
  if (patched(LEGACY_DISPATCH_EXPIRY_PATCH_ID)) {
    const scheduledAtMs = Date.parse(input.scheduledAt || "");
    const startDeadlineAnchor = Number.isFinite(scheduledAtMs)
      ? scheduledAtMs
      : workflowInfo().startTime.getTime();
    if (
      Date.now() - startDeadlineAnchor >
      LEGACY_BULK_CAMPAIGN_DISPATCH_START_GRACE_MS
    ) {
      return {
        campaignId: input.campaignId || null,
        processed: 0,
        successfulSends: 0,
        failedSends: 0,
        batchCount: 0,
        terminalState: "expired",
        attemptedCount: 0,
        notAttemptedCount: totalItems,
        stopReason: "legacy_dispatch_expired",
      };
    }
  }

  for (let index = 0; index < totalItems; ) {
    await waitForDispatchGap(pauseState, 0);
    const { limit, nextIndex, waitMs } = resolveDispatchBatchStep({
      index,
      batchSize,
      totalItems,
      delayMs,
      dailyWaveLimit: input.dailyWaveLimit ?? input.batchPlan.dailyWaveLimit,
      jitterSeed: input.campaignId || workflowInfo().workflowId,
      useDailyWaveSpacing,
    });
    const batchResult = usePayloadStore
      ? await dispatchBulkCampaignBatchActivity({
          mode: "store",
          workspaceId: input.workspaceId,
          payloadKey: input.itemsPayloadKey!.trim(),
          offset: index,
          limit,
        })
      : await dispatchBulkCampaignBatchActivity({
          mode: "inline",
          items: input.items!.slice(index, index + limit),
        });
    successfulSends += batchResult.successfulSends;
    failedSends += batchResult.failedSends;
    notAttemptedSends += batchResult.notAttemptedSends ?? 0;
    batchCount += 1;
    if (waitMs > 0) {
      await waitForDispatchGap(pauseState, waitMs);
    }
    index = nextIndex;
  }

  if (input.campaignId) {
    await finalizeBulkCampaignDispatchActivity({
      workspaceId: input.workspaceId,
      campaignId: input.campaignId,
      successfulSends,
      failedSends,
    });
  }

  return {
    campaignId: input.campaignId || null,
    processed: totalItems,
    successfulSends,
    failedSends,
    batchCount,
    attemptedCount: successfulSends + failedSends,
    notAttemptedCount: notAttemptedSends,
  };
}

function lifecycleResult(params: {
  campaignId: string;
  processedCount: number;
  acceptedCount: number;
  failedCount: number;
  attemptedCount: number;
  notAttemptedCount: number;
  batchCount: number;
  terminalState: "completed" | "failed" | "expired" | "cancelled";
  stopReason?: string | null;
  providerCircuit?: BulkCampaignDispatchBatchResult["providerCircuit"];
}): BulkCampaignDispatchWorkflowResult {
  return {
    campaignId: params.campaignId,
    processed: params.processedCount,
    successfulSends: params.acceptedCount,
    failedSends: params.failedCount,
    batchCount: params.batchCount,
    terminalState: params.terminalState,
    attemptedCount: params.attemptedCount,
    notAttemptedCount: params.notAttemptedCount,
    stopReason: params.stopReason ?? null,
    providerCircuit: params.providerCircuit,
  };
}

async function observeBulkCampaignCancellationCheckpoint(): Promise<void> {
  await sleep(1);
}

async function runLifecycleManagedBulkCampaignDispatch(
  input: BulkCampaignDispatchWorkflowInput,
  pauseState: BulkCampaignOperatorPauseState,
  useDailyWaveSpacing: boolean,
): Promise<BulkCampaignDispatchWorkflowResult> {
  const campaignId = input.campaignId?.trim();
  if (input.lifecycleManaged !== true || !campaignId) {
    throw new Error(
      "Bulk campaign workflow contract v3 requires lifecycleManaged=true and campaignId",
    );
  }

  const usePayloadStore =
    Boolean(input.itemsPayloadKey?.trim()) && (input.itemCount ?? 0) > 0;
  const totalItems = resolveTotalItems(input, usePayloadStore);
  const batchSize = Math.max(1, Math.floor(input.batchPlan.batchSize || 1));
  const delayMs = Math.max(0, Math.floor(input.batchPlan.delayMs || 0));
  const continuationEnabled = patched("bulk-campaign-dispatch-continuation-v1");
  const resumed = continuationEnabled ? input.continuation : undefined;
  if (resumed && (
    [resumed.nextIndex, resumed.processedCount, resumed.acceptedCount, resumed.failedCount, resumed.attemptedCount, resumed.batchCount]
      .some(value => !Number.isSafeInteger(value) || value < 0) ||
    resumed.nextIndex >= totalItems || resumed.nextIndex !== resumed.processedCount ||
    resumed.acceptedCount + resumed.failedCount !== resumed.attemptedCount ||
    resumed.attemptedCount > resumed.processedCount
  )) throw new Error("Invalid bulk campaign continuation");
  let processedCount = resumed?.processedCount ?? 0;
  let acceptedCount = resumed?.acceptedCount ?? 0;
  let failedCount = resumed?.failedCount ?? 0;
  let attemptedCount = resumed?.attemptedCount ?? 0;
  let batchCount = resumed?.batchCount ?? 0;
  let continuation: BulkCampaignDispatchWorkflowInput["continuation"];
  let lifecycleStarted = false;
  let terminalState: "completed" | "failed" | "cancelled" = "completed";
  let stopReason: string | null = null;
  let providerCircuit: BulkCampaignDispatchBatchResult["providerCircuit"] = {
    state: "closed",
  };

  const finalizeLifecycle = async (
    status: "completed" | "failed" | "cancelled",
    reason: string | null,
  ) =>
    CancellationScope.nonCancellable(async () => {
      await finalizeBulkCampaignDispatchLifecycleActivity({
        workspaceId: input.workspaceId,
        campaignId,
        status,
        processedCount,
        acceptedCount,
        failedCount,
        attemptedCount,
        notAttemptedCount: totalItems - attemptedCount,
        stopReason: reason,
        providerCircuit,
      });
    });

  try {
    const initialDelayMs = resumed ? 0 : computeInitialScheduleDelayMs(input.scheduledAt);
    await waitForDispatchGap(pauseState, initialDelayMs);

    const beginResult = await beginBulkCampaignDispatchActivity({ campaignId });
    if (
      beginResult.outcome === "expired" ||
      beginResult.outcome === "cancelled"
    ) {
      return lifecycleResult({
        campaignId,
        processedCount,
        acceptedCount,
        failedCount,
        attemptedCount,
        notAttemptedCount: totalItems - attemptedCount,
        batchCount,
        terminalState: beginResult.outcome,
        stopReason:
          beginResult.outcome === "expired"
            ? "dispatch_expired"
            : "cancelled_by_operator",
      });
    }
    if (
      beginResult.outcome !== "started" &&
      beginResult.outcome !== "already_started"
    ) {
      throw new Error(
        `Bulk campaign dispatch begin failed closed: ${beginResult.outcome}`,
      );
    }
    lifecycleStarted = true;

    for (let index = resumed?.nextIndex ?? 0; index < totalItems; ) {
      await waitForDispatchGap(pauseState, 0);
      const { limit, nextIndex, waitMs } = resolveDispatchBatchStep({
        index,
        batchSize,
        totalItems,
        delayMs,
        dailyWaveLimit: input.dailyWaveLimit ?? input.batchPlan.dailyWaveLimit,
        jitterSeed: input.campaignId || workflowInfo().workflowId,
        useDailyWaveSpacing,
      });
      // V3 treats one complete provider batch plus its persisted progress as
      // the cancellation boundary, then observes cancellation immediately.
      const { batchResult, progressApplied } =
        await CancellationScope.nonCancellable(async () => {
          const batchResult = usePayloadStore
            ? await dispatchBulkCampaignBatchLifecycleActivity({
                mode: "store",
                workspaceId: input.workspaceId,
                payloadKey: input.itemsPayloadKey!.trim(),
                offset: index,
                limit,
                lifecycleManaged: true,
                campaignId,
                ...(continuationEnabled ? { batchKey: `offset:${index}` } : {}),
              })
            : await dispatchBulkCampaignBatchLifecycleActivity({
                mode: "inline",
                items: input.items!.slice(index, index + limit),
                lifecycleManaged: true,
                campaignId,
                ...(continuationEnabled ? { batchKey: `offset:${index}` } : {}),
              });
          const batchNotAttemptedSends = batchResult.notAttemptedSends ?? 0;

          if (
            batchResult.results.length !==
              batchResult.successfulSends +
                batchResult.failedSends +
                batchNotAttemptedSends ||
            batchResult.results.length !== limit
          ) {
            throw new Error(
              "Bulk campaign batch returned inconsistent result counts",
            );
          }

          processedCount += batchResult.results.length;
          acceptedCount += batchResult.successfulSends;
          failedCount += batchResult.failedSends;
          attemptedCount +=
            batchResult.successfulSends + batchResult.failedSends;
          batchCount += 1;
          const progressApplied =
            await updateBulkCampaignDispatchProgressActivity({
              campaignId,
              processedCount,
              acceptedCount,
              failedCount,
              attemptedCount,
              notAttemptedCount: totalItems - attemptedCount,
            });
          return { batchResult, progressApplied };
        });

      await observeBulkCampaignCancellationCheckpoint();

      if (!progressApplied) {
        terminalState = "cancelled";
        stopReason = "dispatch_cancelled";
        break;
      }

      providerCircuit = batchResult.providerCircuit || { state: "closed" };
      if (providerCircuit?.state === "open") {
        terminalState = "failed";
        stopReason = "provider_circuit_open";
        break;
      }

      if (waitMs > 0) {
        await waitForDispatchGap(pauseState, waitMs);
      }
      index = nextIndex;
      const info = workflowInfo();
      if (continuationEnabled && index < totalItems && (
        info.continueAsNewSuggested || info.historyLength >= 8000 ||
        batchCount - (resumed?.batchCount ?? 0) >= 500
      )) {
        continuation = { nextIndex: index, processedCount, acceptedCount, failedCount,
          attemptedCount, batchCount, paused: pauseState.paused };
        break;
      }
    }
  } catch (error) {
    if (!lifecycleStarted && !isCancellation(error)) {
      throw error;
    }
    terminalState = isCancellation(error) ? "cancelled" : "failed";
    stopReason = isCancellation(error)
      ? "workflow_cancelled"
      : "dispatch_failed";
    try {
      await finalizeLifecycle(terminalState, stopReason);
    } catch (cleanupError) {
      log.error("Bulk campaign lifecycle cleanup exhausted retries", {
        campaignId,
        terminalState,
        stopReason,
        cleanupError:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
      });
    }
    throw error;
  }

  if (continuation) {
    return continueAsNew<typeof bulkCampaignDispatchWorkflow>({ ...input, continuation });
  }
  await finalizeLifecycle(terminalState, stopReason);
  return lifecycleResult({
    campaignId,
    processedCount,
    acceptedCount,
    failedCount,
    attemptedCount,
    notAttemptedCount: totalItems - attemptedCount,
    batchCount,
    terminalState,
    stopReason,
    providerCircuit,
  });
}

export async function bulkCampaignDispatchWorkflow(
  input: BulkCampaignDispatchWorkflowInput,
): Promise<BulkCampaignDispatchWorkflowResult> {
  const pauseWaitEnabled = patched(PAUSE_WAIT_PATCH_ID);
  const useDailyWaveSpacing = patched(DAILY_WAVE_SPACING_PATCH_ID);
  const pauseState: BulkCampaignOperatorPauseState = { paused: input.contractVersion >= 3 && input.continuation?.paused === true };
  setHandler(pauseSignal, (paused) => {
    pauseState.paused = paused === true;
  });
  setHandler(pausedQuery, () => pauseState.paused);
  setHandler(pauseWaitQuery, () => pauseWaitEnabled);

  assertContractVersion(
    input.contractVersion,
    { max: 3 },
    "bulk campaign workflow",
  );

  if (input.contractVersion <= 2) {
    return runLegacyBulkCampaignDispatch(
      input,
      pauseState,
      useDailyWaveSpacing,
    );
  }
  return runLifecycleManagedBulkCampaignDispatch(
    input,
    pauseState,
    useDailyWaveSpacing,
  );
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  bulkCampaignDispatchWorkflow,
);
