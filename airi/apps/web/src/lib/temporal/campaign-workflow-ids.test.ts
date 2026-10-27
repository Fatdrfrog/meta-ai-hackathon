import {
  buildBulkCampaignDispatchWorkflowId,
  buildCampaignNodeScheduledOccurrenceWorkflowId,
  buildCampaignNodeRunWorkflowId,
  buildCampaignNodeScheduledWorkflowId,
  buildCampaignScheduleActionWorkflowId,
  sanitizeTemporalWorkflowIdPart,
} from "@icecore/temporal";

describe("shared Temporal campaign workflow ids", () => {
  it("sanitizes workflow id parts with the legacy campaign client rules", () => {
    expect(sanitizeTemporalWorkflowIdPart("workspace:1 / node.2")).toBe(
      "workspace-1-node.2"
    );
  });

  it("builds reusable bulk campaign dispatch workflow ids", () => {
    expect(
      buildBulkCampaignDispatchWorkflowId({
        workspaceId: "workspace:1",
        executionId: "campaign/42",
      })
    ).toBe("bulk-campaign-dispatch:workspace-1:campaign-42");
  });

  it("builds reusable campaign node run workflow ids", () => {
    expect(
      buildCampaignNodeRunWorkflowId({
        workspaceId: "workspace:1",
        scenarioId: "scenario/2",
        nodeId: "node:3",
        executionId: "run 4",
      })
    ).toBe("campaign-node-run:workspace-1:scenario-2:node-3:run-4");
  });

  it("builds reusable scheduled campaign node workflow ids", () => {
    expect(
      buildCampaignNodeScheduledWorkflowId({
        workspaceId: "workspace:1",
        scenarioId: "scenario/2",
        nodeId: "node:3",
      })
    ).toBe("campaign-node-run:workspace-1:scenario-2:node-3:scheduled");
  });

  it("builds deterministic schedule action and occurrence workflow ids", () => {
    expect(
      buildCampaignScheduleActionWorkflowId({
        scheduleId: "campaign-node:workspace:1:scenario/2:node:3",
      })
    ).toBe(
      "campaign-schedule-action:campaign-node-workspace-1-scenario-2-node-3"
    );

    expect(
      buildCampaignNodeScheduledOccurrenceWorkflowId({
        workspaceId: "workspace:1",
        scenarioId: "scenario/2",
        nodeId: "node:3",
        scheduledFor: "2099-05-15T10:00:00.000Z",
      })
    ).toBe(
      "campaign-node-run:workspace-1:scenario-2:node-3:scheduled-2099-05-15T10-00-00.000Z"
    );
  });
});
