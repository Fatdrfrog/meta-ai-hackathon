import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BULK_CAMPAIGN_DISPATCH_BEGIN_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_SEND_BATCH_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_PROGRESS_ACTIVITY,
  BULK_CAMPAIGN_DISPATCH_LIFECYCLE_FINALIZE_ACTIVITY,
  type BulkCampaignDispatchSendBatchInput,
  type BulkCampaignDispatchProgressInput,
  type BulkCampaignDispatchWorkflowResult,
} from "@icecore/temporal";
import { createLocalTemporalWorkflowHarness } from "./testing/local-temporal.js";

test(
  "campaign continuation preserves cumulative progress and sends every batch once",
  { timeout: 90_000 },
  async () => {
    const harness = await createLocalTemporalWorkflowHarness(
      fileURLToPath(
        new URL("./workflows/bulk-campaign-dispatch.ts", import.meta.url),
      ),
      { suggestContinueAsNewAfterEvents: 20 },
    );
    const offsets: number[] = [];
    const progress: number[] = [];
    const batchKeys: string[] = [];
    let beginCount = 0;
    let finalizations = 0;
    try {
      await harness.run({
        workflowType: "bulkCampaignDispatchWorkflow",
        input: {
          contractVersion: 3,
          lifecycleManaged: true,
          workspaceId: "workspace-1",
          campaignId: "campaign-1",
          itemsPayloadKey: "immutable/manifest",
          itemCount: 12,
          batchPlan: {
            batchSize: 1,
            delayMs: 1,
            ratePerSecond: 1,
            rateSource: "test",
          },
        },
        activities: {
          [BULK_CAMPAIGN_DISPATCH_BEGIN_ACTIVITY]: async () => {
            beginCount += 1;
            return {
              outcome: beginCount === 1 ? "started" : "already_started",
              status: "running",
              workflowId: null,
            };
          },
          [BULK_CAMPAIGN_DISPATCH_SEND_BATCH_ACTIVITY]: async (
            input: BulkCampaignDispatchSendBatchInput,
          ) => {
            assert.equal(input.mode, "store");
            if (input.mode !== "store")
              throw new Error("Expected stored batch");
            offsets.push(input.offset);
            batchKeys.push((input as { batchKey?: string }).batchKey || "");
            return {
              results: [
                {
                  channel: "email",
                  recipient: `${input.offset}@example.com`,
                  success: true,
                },
              ],
              successfulSends: 1,
              failedSends: 0,
            };
          },
          [BULK_CAMPAIGN_DISPATCH_PROGRESS_ACTIVITY]: async (
            input: BulkCampaignDispatchProgressInput,
          ) => {
            progress.push(input.processedCount);
            return true;
          },
          [BULK_CAMPAIGN_DISPATCH_LIFECYCLE_FINALIZE_ACTIVITY]: async () => {
            finalizations += 1;
          },
        },
        assert: async (handle) => {
          const result =
            (await handle.result()) as BulkCampaignDispatchWorkflowResult;
          assert.equal(result.processed, 12);
          assert.equal(result.successfulSends, 12);
          assert.equal(result.batchCount, 12);
          assert.deepEqual(
            offsets,
            Array.from({ length: 12 }, (_, i) => i),
          );
          assert.deepEqual(
            progress,
            Array.from({ length: 12 }, (_, i) => i + 1),
          );
          assert.equal(finalizations, 1);
          assert.ok(beginCount > 1, "must cross a real ContinueAsNew boundary");
          assert.equal(new Set(batchKeys).size, 12);
          assert.ok(batchKeys.every(Boolean));
        },
      });
    } finally {
      await harness.close();
    }
  },
);
