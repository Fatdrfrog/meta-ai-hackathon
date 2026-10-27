import assert from "node:assert/strict";
import test from "node:test";

import {
  BULK_CAMPAIGN_DISPATCH_BEGIN_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_LIFECYCLE_FINALIZE_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_LIFECYCLE_STATES,
  BULK_CAMPAIGN_DISPATCH_PROGRESS_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_PAUSE_SIGNAL,
  BULK_CAMPAIGN_DISPATCH_PAUSE_WAIT_QUERY,
  BULK_CAMPAIGN_DISPATCH_PAUSED_QUERY,
  BULK_CAMPAIGN_DISPATCH_PAUSED_STOP_REASON,
  BULK_CAMPAIGN_DISPATCH_WORKFLOW_CONTRACT_VERSION,
  buildBulkCampaignDispatchLogicalRecipientKey,
  resolveBulkCampaignDispatchBatchLimit,
  resolveBulkCampaignDispatchInterBatchDelayMs,
  resolveBulkCampaignOverflowQueueJitterMs,
  BULK_CAMPAIGN_OVERFLOW_QUEUE_BASE_INTERVAL_MS,
  BULK_CAMPAIGN_OVERFLOW_QUEUE_BOUNDARY_PADDING_MS,
  BULK_CAMPAIGN_OVERFLOW_QUEUE_CLOCK_SKEW_MS,
  BULK_CAMPAIGN_OVERFLOW_QUEUE_DELIVERY_SETTLE_MS,
  BULK_CAMPAIGN_OVERFLOW_QUEUE_INTERVAL_MS,
  BULK_CAMPAIGN_OVERFLOW_QUEUE_JITTER_MAX_MS,
  BULK_CAMPAIGN_OVERFLOW_QUEUE_WINDOW_MS,
  type BulkCampaignDispatchBeginInput,
  type BulkCampaignDispatchBeginResult,
  type BulkCampaignDispatchLifecycleFinalizeInput,
  type BulkCampaignDispatchItem,
  type BulkCampaignDispatchProgressInput,
  type BulkCampaignDispatchSendBatchInput,
  type BulkCampaignDispatchWorkflowInput,
} from "./contracts.ts";

test("bulk dispatch v3 items carry an optional immutable snapshot ordinal", () => {
  const admittedItem: BulkCampaignDispatchItem = {
    channel: "whatsapp",
    workspaceId: "workspace-1",
    snapshotOrdinal: 7,
    recipient: { phone: "77010000001" },
    phoneNumberId: "phone-number-1",
    templateName: "promo",
  };
  const legacyItem: BulkCampaignDispatchItem = {
    channel: "email",
    workspaceId: "workspace-1",
    recipient: { email: "person@example.com" },
    templateKey: "announcement",
  };

  assert.equal(BULK_CAMPAIGN_DISPATCH_WORKFLOW_CONTRACT_VERSION, 3);
  assert.equal(admittedItem.snapshotOrdinal, 7);
  assert.equal(legacyItem.snapshotOrdinal, undefined);
});

test("bulk dispatch contract carries a stable dispatch identity and expiry fields", () => {
  const input: BulkCampaignDispatchWorkflowInput = {
    contractVersion: 2,
    workspaceId: "workspace-1",
    campaignId: "dispatch-1",
    requestedAt: "2026-07-23T10:00:00.000Z",
    dispatchExpiresAt: "2026-07-23T10:15:00.000Z",
    batchPlan: {
      batchSize: 1,
      delayMs: 0,
      ratePerSecond: 1,
      rateSource: "test",
    },
    items: [],
  };

  assert.equal(input.campaignId, "dispatch-1");
  assert.equal(input.dispatchExpiresAt, "2026-07-23T10:15:00.000Z");
  assert.deepEqual(BULK_CAMPAIGN_DISPATCH_LIFECYCLE_STATES, [
    "queued",
    "scheduled",
    "running",
    "completed",
    "failed",
    "expired",
    "cancelled",
  ]);
});

test("bulk dispatch v3 has distinct lifecycle activity contracts", () => {
  const beginInput: BulkCampaignDispatchBeginInput = {
    campaignId: "dispatch-1",
  };
  const beginResult: BulkCampaignDispatchBeginResult = {
    outcome: "started",
    status: "running",
    workflowId: "bulk-campaign-dispatch:workspace-1:dispatch-1",
  };
  const progressInput: BulkCampaignDispatchProgressInput = {
    campaignId: "dispatch-1",
    processedCount: 2,
    acceptedCount: 1,
    failedCount: 1,
    attemptedCount: 2,
    notAttemptedCount: 3,
  };
  const finalizeInput: BulkCampaignDispatchLifecycleFinalizeInput = {
    workspaceId: "workspace-1",
    campaignId: "dispatch-1",
    status: "failed",
    processedCount: 2,
    acceptedCount: 1,
    failedCount: 1,
    attemptedCount: 2,
    notAttemptedCount: 3,
    stopReason: "provider_circuit_open",
    providerCircuit: {
      state: "open",
      provider: "meta",
      code: "131042",
    },
  };

  assert.equal(BULK_CAMPAIGN_DISPATCH_WORKFLOW_CONTRACT_VERSION, 3);
  assert.equal(
    BULK_CAMPAIGN_DISPATCH_BEGIN_ACTIVITY,
    "bulkCampaignDispatchBegin",
  );
  assert.equal(
    BULK_CAMPAIGN_DISPATCH_PAUSE_SIGNAL,
    "bulkCampaignDispatchPause",
  );
  assert.equal(
    BULK_CAMPAIGN_DISPATCH_PAUSED_QUERY,
    "bulkCampaignDispatchPaused",
  );
  assert.equal(
    BULK_CAMPAIGN_DISPATCH_PAUSE_WAIT_QUERY,
    "bulkCampaignDispatchPauseWaitSupported",
  );
  assert.equal(
    BULK_CAMPAIGN_DISPATCH_PAUSED_STOP_REASON,
    "paused_by_operator",
  );
  assert.equal(
    BULK_CAMPAIGN_DISPATCH_PROGRESS_ACTIVITY,
    "bulkCampaignDispatchProgress",
  );
  assert.equal(
    BULK_CAMPAIGN_DISPATCH_LIFECYCLE_FINALIZE_ACTIVITY,
    "bulkCampaignDispatchLifecycleFinalize",
  );
  assert.equal(beginInput.campaignId, "dispatch-1");
  assert.equal(beginResult.outcome, "started");
  assert.equal(progressInput.notAttemptedCount, 3);
  assert.equal(finalizeInput.providerCircuit?.code, "131042");
});

test("v3 send batches are explicitly lifecycle managed", () => {
  const input: BulkCampaignDispatchSendBatchInput = {
    mode: "store",
    workspaceId: "workspace-1",
    payloadKey: "bulk/payload.json",
    offset: 0,
    limit: 2,
    lifecycleManaged: true,
    campaignId: "dispatch-1",
  };

  assert.equal(input.lifecycleManaged, true);
  assert.equal(input.campaignId, "dispatch-1");
});

test("bulk dispatch owns one normalized logical recipient key", () => {
  assert.equal(
    buildBulkCampaignDispatchLogicalRecipientKey({
      channel: "whatsapp",
      workspaceId: "workspace-1",
      recipient: { phone: "+7 (700) 000-00-01" },
      phoneNumberId: "phone-number-1",
      templateName: "promo",
    }),
    "77000000001",
  );
  assert.equal(
    buildBulkCampaignDispatchLogicalRecipientKey({
      channel: "telegram",
      workspaceId: "workspace-1",
      sourceId: " Bot-Source ",
      recipient: { chatId: " 42 " },
      messageText: "Hello",
    }),
    "bot-source:42",
  );
  assert.equal(
    buildBulkCampaignDispatchLogicalRecipientKey({
      channel: "email",
      workspaceId: "workspace-1",
      recipient: { email: " Person@Example.COM " },
    }),
    "person@example.com",
  );
});

test("resolveBulkCampaignDispatchInterBatchDelayMs waits a Meta moving-window interval when crossing a daily wave", () => {
  assert.equal(
    BULK_CAMPAIGN_OVERFLOW_QUEUE_WINDOW_MS,
    24 * 60 * 60 * 1000,
  );
  assert.equal(BULK_CAMPAIGN_OVERFLOW_QUEUE_DELIVERY_SETTLE_MS, 5 * 60 * 1000);
  assert.equal(BULK_CAMPAIGN_OVERFLOW_QUEUE_CLOCK_SKEW_MS, 30 * 1000);
  assert.equal(BULK_CAMPAIGN_OVERFLOW_QUEUE_JITTER_MAX_MS, 60 * 1000);
  assert.equal(
    BULK_CAMPAIGN_OVERFLOW_QUEUE_BOUNDARY_PADDING_MS,
    BULK_CAMPAIGN_OVERFLOW_QUEUE_DELIVERY_SETTLE_MS +
      BULK_CAMPAIGN_OVERFLOW_QUEUE_CLOCK_SKEW_MS,
  );
  assert.equal(
    BULK_CAMPAIGN_OVERFLOW_QUEUE_BASE_INTERVAL_MS,
    BULK_CAMPAIGN_OVERFLOW_QUEUE_WINDOW_MS +
      BULK_CAMPAIGN_OVERFLOW_QUEUE_BOUNDARY_PADDING_MS,
  );
  assert.equal(
    BULK_CAMPAIGN_OVERFLOW_QUEUE_INTERVAL_MS,
    BULK_CAMPAIGN_OVERFLOW_QUEUE_BASE_INTERVAL_MS +
      BULK_CAMPAIGN_OVERFLOW_QUEUE_JITTER_MAX_MS,
  );
  assert.equal(
    resolveBulkCampaignDispatchInterBatchDelayMs({
      index: 0,
      batchSize: 50,
      totalItems: 2145,
      delayMs: 2000,
      dailyWaveLimit: 250,
    }),
    2000,
  );
  assert.equal(
    resolveBulkCampaignDispatchInterBatchDelayMs({
      index: 200,
      batchSize: 50,
      totalItems: 2145,
      delayMs: 2000,
      dailyWaveLimit: 250,
    }),
    BULK_CAMPAIGN_OVERFLOW_QUEUE_BASE_INTERVAL_MS,
  );
  const jittered = resolveBulkCampaignDispatchInterBatchDelayMs({
    index: 200,
    batchSize: 50,
    totalItems: 2145,
    delayMs: 2000,
    dailyWaveLimit: 250,
    jitterSeed: "campaign-overflow-1",
  });
  assert.ok(jittered >= BULK_CAMPAIGN_OVERFLOW_QUEUE_BASE_INTERVAL_MS);
  assert.ok(jittered <= BULK_CAMPAIGN_OVERFLOW_QUEUE_INTERVAL_MS);
  assert.equal(
    jittered - BULK_CAMPAIGN_OVERFLOW_QUEUE_BASE_INTERVAL_MS,
    resolveBulkCampaignOverflowQueueJitterMs({
      seed: "campaign-overflow-1",
      waveIndex: 1,
    }),
  );
  assert.equal(
    resolveBulkCampaignOverflowQueueJitterMs({
      seed: "campaign-overflow-1",
      waveIndex: 1,
    }),
    resolveBulkCampaignOverflowQueueJitterMs({
      seed: "campaign-overflow-1",
      waveIndex: 1,
    }),
  );
  assert.equal(
    resolveBulkCampaignDispatchInterBatchDelayMs({
      index: 2100,
      batchSize: 50,
      totalItems: 2145,
      delayMs: 2000,
      dailyWaveLimit: 250,
    }),
    0,
  );
});

test("resolveBulkCampaignDispatchBatchLimit splits a batch at the daily wave boundary", () => {
  assert.equal(
    resolveBulkCampaignDispatchBatchLimit({
      index: 200,
      batchSize: 100,
      totalItems: 2145,
      dailyWaveLimit: 250,
    }),
    50,
  );
  assert.equal(
    resolveBulkCampaignDispatchBatchLimit({
      index: 0,
      batchSize: 50,
      totalItems: 2145,
      dailyWaveLimit: 250,
    }),
    50,
  );
  assert.equal(
    resolveBulkCampaignDispatchBatchLimit({
      index: 2140,
      batchSize: 50,
      totalItems: 2145,
    }),
    5,
  );
});
