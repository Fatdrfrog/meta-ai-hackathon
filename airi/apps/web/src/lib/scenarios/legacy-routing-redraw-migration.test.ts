import { createDemoShopInteractiveNoReplyFixture } from "../../../test-fixtures/scenarios/demoshop-interactive-no-reply";
import {
  buildLegacyRoutingRedrawInventory,
  buildLegacyRoutingRedrawMigrationErrorEvent,
  parseLegacyRoutingRedrawMigrationArgs,
  planLegacyRoutingRedraw,
  runLegacyRoutingRedrawMigrationOperator,
} from "./legacy-routing-redraw-migration";

const workspaceId = "9c56d5cd-f6fe-48d5-a08c-2d7770375bb6";
const scenarioId = "69b91feab867aa73e3e91fe1";
const updatedAt = "2026-09-20T12:00:00.000Z";
const outputPath = "/tmp/legacy-routing-redraw-preimage.json";

function demoshopScenario() {
  return {
    _id: scenarioId,
    workspaceId,
    name: "DemoShop group",
    status: "active",
    updatedAt,
    ...createDemoShopInteractiveNoReplyFixture(),
  };
}

describe("planLegacyRoutingRedraw", () => {
  it("inventories DemoShop dedicated waits and the leftover shared logical node", () => {
    const plan = planLegacyRoutingRedraw(
      createDemoShopInteractiveNoReplyFixture()
    );

    expect(plan.conversions).toHaveLength(2);
    expect(plan.leftovers).toEqual([
      {
        nodeId: "flow-condition-shared",
        sourceKind: "post_action_condition",
        reason: "multiple_sources",
      },
    ]);
    expect(plan.hashes.beforeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.hashes.afterSha256).not.toBe(plan.hashes.beforeSha256);
  });
});

describe("parseLegacyRoutingRedrawMigrationArgs", () => {
  it("requires an explicit workspace unless all workspaces are confirmed", () => {
    expect(() => parseLegacyRoutingRedrawMigrationArgs([])).toThrow(
      /workspace ID is required/
    );
    expect(() =>
      parseLegacyRoutingRedrawMigrationArgs(["--all-workspaces"])
    ).toThrow(/confirm-all-workspaces/);
  });

  it("requires the apply review contract", () => {
    expect(() =>
      parseLegacyRoutingRedrawMigrationArgs([
        `--workspace-id=${workspaceId}`,
        "--apply",
      ])
    ).toThrow(/Apply requires/);
  });

  it("parses a dry-run inventory of one workspace", () => {
    expect(
      parseLegacyRoutingRedrawMigrationArgs([
        `--workspace-id=${workspaceId}`,
        "--relayout",
        `--output=${outputPath}`,
      ])
    ).toEqual({
      apply: false,
      relayout: true,
      allWorkspaces: false,
      workspaceId,
      outputPath,
    });
  });
});

describe("runLegacyRoutingRedrawMigrationOperator", () => {
  it("dry-runs an inventory without writing production state", async () => {
    const emit = jest.fn();
    const applyMigration = jest.fn();
    const writePreimage = jest.fn();
    const scenarios = [demoshopScenario()];
    const inventory = buildLegacyRoutingRedrawInventory({
      args: {
        apply: false,
        relayout: false,
        allWorkspaces: false,
        workspaceId,
      },
      scenarios,
    });

    const result = await runLegacyRoutingRedrawMigrationOperator(
      {
        apply: false,
        relayout: false,
        allWorkspaces: false,
        workspaceId,
        outputPath,
      },
      {
        listScenarios: async () => scenarios,
        applyMigration,
        writePreimage,
        emit,
      }
    );

    expect(result.applied).toBe(false);
    expect(result.inventory.candidateCount).toBe(2);
    expect(result.inventory.leftoverCount).toBe(1);
    expect(result.inventory.convertibleScenarioCount).toBe(1);
    expect(applyMigration).not.toHaveBeenCalled();
    expect(writePreimage).toHaveBeenCalledWith(outputPath, result.inventory);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "migration_leftover",
        leftover: expect.objectContaining({
          nodeId: "flow-condition-shared",
        }),
      })
    );
    expect(inventory.inventorySha256).toBe(result.inventory.inventorySha256);
  });

  it("applies only after the inventoried counts and hash match", async () => {
    const scenarios = [demoshopScenario()];
    const inventory = buildLegacyRoutingRedrawInventory({
      args: {
        apply: true,
        relayout: true,
        allWorkspaces: false,
        workspaceId,
        scenarioId,
      },
      scenarios,
    });
    const applyMigration = jest.fn().mockResolvedValue({
      beforeRevision: updatedAt,
      afterRevision: "2026-09-20T12:00:01.000Z",
      convertedConditionNodeIds: ["legacy-alpha", "legacy-beta"],
      convertedActionNodeIds: ["action-alpha", "action-beta"],
      remappedConversationIds: [],
      timerReplanResults: [],
      postCommitWarnings: [],
    });

    const result = await runLegacyRoutingRedrawMigrationOperator(
      {
        apply: true,
        relayout: true,
        allWorkspaces: false,
        workspaceId,
        scenarioId,
        expectedCount: 2,
        expectedScenarioCount: 1,
        expectedInventorySha256: inventory.inventorySha256,
        outputPath,
      },
      {
        listScenarios: async () => scenarios,
        applyMigration,
        writePreimage: jest.fn(),
        emit: jest.fn(),
      }
    );

    expect(result.applied).toBe(true);
    expect(applyMigration).toHaveBeenCalledWith({
      scenarioId,
      workspaceId,
      updatedBy: "migration:legacy-routing-redraw",
      expectedUpdatedAt: updatedAt,
      conversions: expect.arrayContaining([
        expect.objectContaining({ sourceNodeId: "legacy-alpha" }),
        expect.objectContaining({ sourceNodeId: "legacy-beta" }),
      ]),
      relayout: true,
    });
  });

  it("emits a committed apply result before surfacing the conversion error", async () => {
    const scenarios = [demoshopScenario()];
    const inventory = buildLegacyRoutingRedrawInventory({
      args: {
        apply: true,
        relayout: false,
        allWorkspaces: false,
        workspaceId,
        scenarioId,
      },
      scenarios,
    });
    const committedResult = {
      scenario: {} as never,
      beforeRevision: updatedAt,
      afterRevision: "2026-09-20T12:00:01.000Z",
      convertedConditionNodeIds: ["legacy-alpha", "legacy-beta"],
      convertedActionNodeIds: ["action-alpha", "action-beta"],
      remappedConversationIds: [],
      timerReplanResults: [],
      postCommitWarnings: [],
    };
    const emit = jest.fn();
    const applyMigration = jest.fn().mockRejectedValue(
      Object.assign(new Error("timer failed after commit"), {
        committed: true,
        committedResult,
      })
    );

    await expect(
      runLegacyRoutingRedrawMigrationOperator(
        {
          apply: true,
          relayout: false,
          allWorkspaces: false,
          workspaceId,
          scenarioId,
          expectedCount: 2,
          expectedScenarioCount: 1,
          expectedInventorySha256: inventory.inventorySha256,
          outputPath,
        },
        {
          listScenarios: async () => scenarios,
          applyMigration,
          writePreimage: jest.fn(),
          emit,
        }
      )
    ).rejects.toThrow("timer failed after commit");

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "migration_apply_result",
        scenarioId,
        afterRevision: committedResult.afterRevision,
      })
    );
  });

  it("refuses apply when the inventory hash drifted", async () => {
    await expect(
      runLegacyRoutingRedrawMigrationOperator(
        {
          apply: true,
          relayout: false,
          allWorkspaces: false,
          workspaceId,
          expectedCount: 2,
          expectedScenarioCount: 1,
          expectedInventorySha256: "a".repeat(64),
          outputPath,
        },
        {
          listScenarios: async () => [demoshopScenario()],
          applyMigration: jest.fn(),
          writePreimage: jest.fn(),
          emit: jest.fn(),
        }
      )
    ).rejects.toThrow(/changed after review/);
  });
});

describe("buildLegacyRoutingRedrawMigrationErrorEvent", () => {
  it("preserves operator error codes", () => {
    let caught: unknown;
    try {
      parseLegacyRoutingRedrawMigrationArgs([]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(buildLegacyRoutingRedrawMigrationErrorEvent(caught)).toEqual({
      type: "migration_error",
      code: "legacy_routing_redraw_target_required",
      message: expect.stringContaining("workspace ID"),
    });
  });
});
