import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CAMPAIGN_DELIVERY_DRAIN_ACTIVITY,
  CAMPAIGN_EXECUTION_FINALIZE_ACTIVITY,
  CAMPAIGN_NODE_RUN_ACTIVITY,
  CAMPAIGN_NODE_RUN_WORKFLOW_CONTRACT_VERSION,
  type CampaignNodeRunActivityInput,
  type CampaignNodeRunWorkflowResult,
} from "@icecore/temporal";
import { createLocalTemporalWorkflowHarness } from "./testing/local-temporal.js";

test(
  "same-day birthday occurrences reuse one active execution child without failing",
  { timeout: 90_000 },
  async () => {
    const harness = await createLocalTemporalWorkflowHarness(
      fileURLToPath(
        new URL("./testing/campaign-node-run-overlap.ts", import.meta.url),
      ),
    );
    const campaignId = randomUUID();
    let materializations = 0;
    try {
      await harness.run({
        workflowType: "birthdayOccurrenceOverlapWorkflow",
        input: {
          contractVersion: CAMPAIGN_NODE_RUN_WORKFLOW_CONTRACT_VERSION,
          workspaceId: "birthday-overlap",
          scenarioId: "scenario-1",
          nodeId: "birthday-root",
          scheduledFor: "2099-04-17T09:00:00.000Z",
          executionSource: "scenario_schedule",
        },
        activities: {
          [CAMPAIGN_NODE_RUN_ACTIVITY]: async (
            input: CampaignNodeRunActivityInput,
          ) => {
            materializations += 1;
            return {
              status: "materialized",
              scenarioId: input.scenarioId,
              nodeId: input.nodeId,
              campaignId,
              shadowMode: false,
              audienceSource: "birthday",
              runKey: "birthday:2099-04-17",
              candidates: 1,
              created: 0,
              wouldCreate: 0,
              pendingCount: 1,
              batchPlan: {
                batchSize: 1,
                delayMs: 1_000,
                ratePerSecond: 1,
                rateSource: "telegram_default_throughput",
              },
            };
          },
          [CAMPAIGN_DELIVERY_DRAIN_ACTIVITY]: async () => {
            return {
              processed: 0,
              completed: 0,
              retried: 0,
              failedTerminal: 0,
              skipped: 0,
              recoveredStale: 0,
              pendingCount: 1,
              nextDispatchAt: new Date(Date.now() + 60_000).toISOString(),
            };
          },
          [CAMPAIGN_EXECUTION_FINALIZE_ACTIVITY]: async () => {
            throw new Error("Execution must remain pending during overlap");
          },
        },
        assert: async (handle) => {
          const results =
            (await handle.result()) as CampaignNodeRunWorkflowResult[];
          assert.equal(materializations, 2);
          assert.equal(results.length, 2);
          assert.equal(
            results[0].executionWorkflowId,
            results[1].executionWorkflowId,
          );
          assert.equal(
            results[0].executionWorkflowId,
            `campaign-execution:birthday-overlap:${campaignId}`,
          );
          const history = await handle.fetchHistory();
          assert.equal(
            history.events?.filter(
              (event) => event.childWorkflowExecutionStartedEventAttributes,
            ).length,
            1,
          );
        },
      });
    } finally {
      await harness.close();
    }
  },
);
