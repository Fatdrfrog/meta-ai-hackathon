import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "workflows",
    "bulk-campaign-dispatch.ts",
  ),
  "utf8",
);
const runtimeSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../packages/airi-runtime/src/bulk-campaign-dispatch.ts",
  ),
  "utf8",
);
const workerSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "worker.ts"),
  "utf8",
);
const starterSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../web/src/lib/temporal/bulk-campaign-dispatch.ts",
  ),
  "utf8",
);
const scenarioGeneratorSendSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../web/src/app/api/workspaces/[workspaceId]/scenario-generator/send/route.ts",
  ),
  "utf8",
);
const scenarioGeneratorSendOrchestratorSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../web/src/lib/campaign/generated-bulk-send-orchestrator.ts",
  ),
  "utf8",
);
const bulkCampaignActivitySource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "activities",
    "bulk-campaign.ts",
  ),
  "utf8",
);

test("bulk campaign batch activity has enough time for slow provider sends", () => {
  assert.match(source, /startToCloseTimeout:\s*"900s"/);
  assert.doesNotMatch(source, /startToCloseTimeout:\s*"300s"/);
});

test("bulk campaign email activity persists outbound conversations", () => {
  assert.match(runtimeSource, /persistCampaignEmailConversationMessage/);
  assert.match(runtimeSource, /persistEmailConversationForResult/);
  assert.match(
    runtimeSource,
    /await persistEmailConversationForResult\(\{\s*item,\s*messageId:\s*transportResult\.messageId/s,
  );
});

test("bulk campaign workflow preserves a dedicated v1/v2 command path", () => {
  assert.match(source, /input\.contractVersion\s*<=\s*2/);
  assert.match(source, /runLegacyBulkCampaignDispatch/);
  assert.match(source, /BULK_CAMPAIGN_DISPATCH_FINALIZE_ACTIVITY/);
});

test("v3 begins before sending and exits expired or cancelled campaigns without a send", () => {
  const lifecycleStart = source.indexOf(
    "async function runLifecycleManagedBulkCampaignDispatch",
  );
  const lifecycleSource = source.slice(lifecycleStart);
  const beginIndex = lifecycleSource.indexOf(
    "beginBulkCampaignDispatchActivity",
  );
  const firstSendIndex = lifecycleSource.indexOf(
    "dispatchBulkCampaignBatchLifecycleActivity",
  );

  assert.ok(lifecycleStart >= 0);
  assert.ok(beginIndex >= 0);
  assert.ok(firstSendIndex > beginIndex);
  assert.match(
    lifecycleSource.slice(beginIndex, firstSendIndex),
    /beginResult\.outcome\s*===\s*"expired"[\s\S]*beginResult\.outcome\s*===\s*"cancelled"[\s\S]*return/,
  );
});

test("v3 persists cumulative progress and stops a provider circuit before another batch", () => {
  const lifecycleSource = source.slice(
    source.indexOf("async function runLifecycleManagedBulkCampaignDispatch"),
  );
  const sendIndex = lifecycleSource.indexOf(
    "dispatchBulkCampaignBatchLifecycleActivity",
  );
  const progressIndex = lifecycleSource.indexOf(
    "updateBulkCampaignDispatchProgressActivity",
  );
  const circuitIndex = lifecycleSource.indexOf(
    'providerCircuit?.state === "open"',
  );
  const nextBatchDelayIndex = lifecycleSource.indexOf(
    "await waitForDispatchGap(pauseState, waitMs)",
    sendIndex,
  );

  assert.ok(sendIndex >= 0);
  assert.ok(progressIndex > sendIndex);
  assert.ok(circuitIndex > progressIndex);
  assert.ok(
    nextBatchDelayIndex < 0 || circuitIndex < nextBatchDelayIndex,
    "provider circuit must break before a delay or subsequent dispatch",
  );
});

test("operator pause is a signal/query plus patched wait, not a native Temporal pause", () => {
  assert.match(source, /defineSignal<\[boolean\]>\(BULK_CAMPAIGN_DISPATCH_PAUSE_SIGNAL\)/);
  assert.match(source, /defineQuery<boolean>\(BULK_CAMPAIGN_DISPATCH_PAUSED_QUERY\)/);
  assert.match(source, /defineQuery<boolean>\(\s*BULK_CAMPAIGN_DISPATCH_PAUSE_WAIT_QUERY/);
  assert.match(source, /setHandler\(pauseSignal/);
  assert.match(source, /setHandler\(pausedQuery/);
  assert.match(source, /setHandler\(pauseWaitQuery/);
  assert.match(source, /patched\(PAUSE_WAIT_PATCH_ID\)/);
  assert.match(source, /patched\(DAILY_WAVE_SPACING_PATCH_ID\)/);
  assert.match(source, /await condition\(\(\) => !pauseState\.paused\)/);
  assert.match(
    starterSource,
    /signalBulkCampaignDispatchPause/,
  );
});

test("v3 rejects short batch results instead of skipping unreported recipients", () => {
  const lifecycleSource = source.slice(
    source.indexOf("async function runLifecycleManagedBulkCampaignDispatch"),
  );
  assert.match(lifecycleSource, /batchResult\.results\.length\s*!==\s*limit/);
});

test("v3 observes cancellation after every non-cancellable batch including the final batch", () => {
  const lifecycleSource = source.slice(
    source.indexOf("async function runLifecycleManagedBulkCampaignDispatch"),
  );
  const batchScopeEnd = lifecycleSource.indexOf("if (!progressApplied)");
  const checkpointIndex = lifecycleSource.indexOf(
    "observeBulkCampaignCancellationCheckpoint",
  );

  assert.ok(checkpointIndex >= 0);
  assert.ok(checkpointIndex < batchScopeEnd);
});

test("v3 lifecycle cleanup is non-cancellable and handles workflow cancellation", () => {
  assert.match(source, /CancellationScope\.nonCancellable/);
  assert.match(source, /isCancellation\(error\)/);
  assert.match(source, /isCancellation\(error\)\s*\?\s*"cancelled"/);
  assert.match(source, /finalizeBulkCampaignDispatchLifecycleActivity/);
});

test("v3 preserves the original failure when lifecycle cleanup is exhausted", () => {
  const lifecycleSource = source.slice(
    source.indexOf("async function runLifecycleManagedBulkCampaignDispatch"),
  );
  assert.match(
    lifecycleSource,
    /try\s*\{\s*await finalizeLifecycle\(terminalState,\s*stopReason\);\s*\}\s*catch\s*\(cleanupError\)/,
  );
  assert.match(lifecycleSource, /log\.error/);
  assert.match(lifecycleSource, /throw error/);
});

test("worker registers distinct begin, progress, and lifecycle-finalize activities", () => {
  for (const activity of [
    "BULK_CAMPAIGN_DISPATCH_BEGIN_ACTIVITY",
    "BULK_CAMPAIGN_DISPATCH_PROGRESS_ACTIVITY",
    "BULK_CAMPAIGN_DISPATCH_LIFECYCLE_FINALIZE_ACTIVITY",
  ]) {
    assert.match(workerSource, new RegExp(`\\[${activity}\\]`));
  }
  assert.match(workerSource, /beginBulkCampaignDispatchActivity/);
  assert.match(workerSource, /updateBulkCampaignDispatchProgressActivity/);
  assert.match(workerSource, /finalizeBulkCampaignDispatchLifecycleActivity/);
});

test("new scenario generator sends use the admitted v3 queue", () => {
  assert.match(starterSource, /lifecycleManaged:\s*true/);
  assert.match(starterSource, /campaignId:\s*string/);
  assert.match(starterSource, /requestedAt:\s*string/);
  assert.match(starterSource, /dispatchExpiresAt:\s*string/);
  assert.match(
    starterSource,
    /contractVersion:\s*BULK_CAMPAIGN_DISPATCH_WORKFLOW_CONTRACT_VERSION/,
  );
  assert.doesNotMatch(
    starterSource,
    /LEGACY_BULK_CAMPAIGN_DISPATCH_WORKFLOW_CONTRACT_VERSION/,
  );
  assert.match(scenarioGeneratorSendSource, /executeGeneratedBulkSend\(\{/);
  assert.match(
    scenarioGeneratorSendOrchestratorSource,
    /queuePreparedBulkCampaignDispatch\(\{/,
  );
  assert.doesNotMatch(
    `${scenarioGeneratorSendSource}\n${scenarioGeneratorSendOrchestratorSource}`,
    /startBulkCampaignDispatchWorkflow\(\{[\s\S]*?lifecycleManaged:\s*false/,
  );
});

test("dispatch batch start logs snapshot ordinal identity", () => {
  assert.match(bulkCampaignActivitySource, /note:\s*"dispatch_batch_start"/);
  assert.match(
    bulkCampaignActivitySource,
    /snapshotOrdinal:\s*Number\.isInteger\(items\[0\]\?\.snapshotOrdinal\)/,
  );
});

test("legacy queued workflows fail closed before a stale provider send", () => {
  const legacySource = source.slice(
    source.indexOf("async function runLegacyBulkCampaignDispatch"),
    source.indexOf("function lifecycleResult"),
  );
  assert.match(legacySource, /patched\(LEGACY_DISPATCH_EXPIRY_PATCH_ID\)/);
  assert.match(legacySource, /workflowInfo\(\)\.startTime/);
  assert.match(legacySource, /stopReason:\s*"legacy_dispatch_expired"/);
  assert.match(
    bulkCampaignActivitySource,
    /isLegacyBulkCampaignActivityExpired/,
  );
  assert.match(
    bulkCampaignActivitySource,
    /ApplicationFailure\.nonRetryable\([\s\S]*LEGACY_BULK_CAMPAIGN_DISPATCH_EXPIRED/,
  );
});

test("v3 runtime persists logical recipient attempts and immediate failures", () => {
  assert.match(runtimeSource, /persistCampaignMessageAttemptWithOutbox/);
  assert.match(runtimeSource, /buildBulkCampaignDispatchLogicalRecipientKey/);
  assert.match(runtimeSource, /status:\s*"attempted"/);
  assert.match(runtimeSource, /status:\s*"failed"/);

  const singleItemSource = runtimeSource.slice(
    runtimeSource.indexOf("async function dispatchSingleBulkCampaignItem"),
    runtimeSource.indexOf("type IndexedBulkCampaignItem"),
  );
  assert.ok(
    singleItemSource.indexOf('status: "attempted"') <
      singleItemSource.indexOf("sendCampaignTransportSingle(request)"),
    "the immutable snapshot must be marked attempted before provider I/O",
  );
});

test("service text expires before attempt persistence and provider transport", () => {
  const singleItemSource = runtimeSource.slice(
    runtimeSource.indexOf("async function dispatchSingleBulkCampaignItem"),
    runtimeSource.indexOf("type IndexedBulkCampaignItem"),
  );
  const expiryIndex = singleItemSource.indexOf(
    "whatsapp_service_window_closed",
  );
  const attemptedIndex = singleItemSource.indexOf('status: "attempted"');
  const transportIndex = singleItemSource.indexOf(
    "sendCampaignTransportSingle(request)",
  );

  assert.ok(expiryIndex >= 0);
  assert.ok(expiryIndex < attemptedIndex);
  assert.ok(expiryIndex < transportIndex);
  assert.match(singleItemSource, /attempted:\s*false/);
});

test("v3 lifecycle accounts for service-window skips as processed but not attempted", () => {
  const lifecycleSource = source.slice(
    source.indexOf("async function runLifecycleManagedBulkCampaignDispatch"),
  );
  assert.match(lifecycleSource, /batchResult\.notAttemptedSends/);
  assert.match(lifecycleSource, /attemptedCount\s*\+=/);
  assert.match(
    lifecycleSource,
    /attemptedCount,\s*notAttemptedCount:\s*totalItems\s*-\s*attemptedCount/,
  );
});

test("runtime returns the shared provider-circuit policy result", () => {
  assert.match(runtimeSource, /classifyBulkCampaignProviderCircuit/);
  assert.match(runtimeSource, /batchStatus:\s*"completed"/);
  assert.match(runtimeSource, /providerCircuit/);
});

test("runtime leaves generated recipient delivery state to the canonical SQL ledger", () => {
  assert.doesNotMatch(runtimeSource, /ScenarioGeneratedRecipientMessage/);
  assert.doesNotMatch(runtimeSource, /updateGeneratedRecipientMessageStatus/);
  assert.doesNotMatch(
    runtimeSource,
    /generated_recipient_message_status_update_failed/,
  );
});

test("runtime drains started workers and stops scheduling after a fatal mapper error", () => {
  const poolSource = runtimeSource.slice(
    runtimeSource.indexOf("async function mapPool"),
    runtimeSource.indexOf("async function persistSentWithRetries"),
  );
  assert.match(poolSource, /hasFatalError/);
  assert.match(poolSource, /await Promise\.all/);
  assert.ok(
    poolSource.indexOf("await Promise.all") <
      poolSource.lastIndexOf("throw fatalError"),
    "started workers must drain before the fatal error escapes the activity",
  );
});

test("cancelled lifecycle persists cumulative progress and supplied cancellation metadata", () => {
  const finalizeSource = runtimeSource.slice(
    runtimeSource.indexOf(
      "export async function finalizeBulkCampaignDispatchLifecycle",
    ),
    runtimeSource.indexOf(
      "export async function finalizeBulkCampaignDispatch(",
    ),
  );
  assert.match(finalizeSource, /reconcileCampaignDispatchCancellation/);
  assert.match(finalizeSource, /processedCount:\s*input\.processedCount/);
  assert.match(finalizeSource, /stopReason:\s*input\.stopReason/);
  assert.match(finalizeSource, /providerCircuit:\s*input\.providerCircuit/);
});

test("terminal lifecycle completion does not depend on optional stats reconciliation", () => {
  const lifecycleFinalizeSource = runtimeSource.slice(
    runtimeSource.indexOf(
      "export async function finalizeBulkCampaignDispatchLifecycle",
    ),
    runtimeSource.indexOf(
      "export async function finalizeBulkCampaignDispatch(",
    ),
  );
  assert.doesNotMatch(lifecycleFinalizeSource, /recomputeCampaignStats/);
  assert.doesNotMatch(lifecycleFinalizeSource, /reconcileLegacyCampaignStats/);
});

test("legacy finalization preserves workflow totals without recomputing an absent ledger", () => {
  const legacyFinalizeSource = runtimeSource.slice(
    runtimeSource.indexOf(
      "export async function finalizeBulkCampaignDispatch(",
    ),
  );

  assert.match(legacyFinalizeSource, /reconcileLegacyCampaignStats\(input\)/);
  assert.match(runtimeSource, /successfulSends:\s*input\.successfulSends/);
  assert.match(runtimeSource, /failedSends:\s*input\.failedSends/);
  assert.match(runtimeSource, /throw new Error\(reconciliation\.error\)/);
  assert.doesNotMatch(legacyFinalizeSource, /recomputeCampaignStats/);
});
