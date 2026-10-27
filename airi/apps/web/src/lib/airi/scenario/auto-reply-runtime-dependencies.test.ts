const mockFindOne = jest.fn();
const mockMessageFindOne = jest.fn();
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { findOne: (...args: unknown[]) => mockMessageFindOne(...args) },
}));
jest.mock("@/lib/temporal/airi-turn-execution", () => ({
  claimAiriTurnPreparation: jest.fn(),
  completeAiriTurnPreparation: jest.fn(),
  failAiriTurnPreparation: jest.fn(),
  recordAiriConversationTurnDisposition: jest.fn(),
}));

jest.mock("@/models/scenario", () => ({
  Scenario: { findOne: (...args: unknown[]) => mockFindOne(...args) },
}));
jest.mock("@/models/quick-reply", () => ({ QuickReply: {} }));
jest.mock("./scenario-runtime", () => ({
  resolveActiveScenarioRuntime: jest.fn(),
}));
jest.mock("../reply/runtime/auto-reply-scenario-state", () => ({
  clearPendingConditionStateAndPersist: jest.fn(),
  completeLockedScenarioAndPersist: jest.fn(),
  finalizeScenarioResolution: jest.fn(),
  persistPendingConditionState: jest.fn(),
  persistScenarioState: jest.fn(),
}));

import { scenarioRuntimeDependencies } from "./auto-reply-runtime-dependencies";
import { hasWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";

const scenarioId = "65f000000000000000000001";
const workspaceId = "workspace-1";

describe("auto-reply scenario snapshot boundary", () => {
  it("shares the text billing context across scenario work and clears it afterward", async () => {
    const result = await scenarioRuntimeDependencies.runTextAiAction(
      { workspaceId, actionId: "auto-reply:conversation:message" },
      async () => {
        expect(hasWorkspaceTextAiAction()).toBe(true);
        return "ready";
      }
    );
    expect(result).toBe("ready");
    expect(hasWorkspaceTextAiAction()).toBe(false);
  });
  beforeEach(() => {
    mockFindOne.mockReset();
    mockFindOne.mockReturnValue({
      select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })),
    });
  });

  it.each([
    "",
    "malformed-id",
    "0123456789ab",
    ` ${scenarioId}`,
    `${scenarioId} `,
  ])(
    "ignores malformed persisted scenario ID %j before querying Mongo",
    async malformedId => {
      await expect(
        scenarioRuntimeDependencies.loadActiveScenarioSnapshot({
          workspaceId,
          scenarioId: malformedId,
        })
      ).resolves.toBeNull();
      expect(mockFindOne).not.toHaveBeenCalled();
    }
  );

  it("excludes an active bulk campaign from the conversation snapshot lookup", async () => {
    const bulkCampaign = {
      _id: scenarioId,
      mode: "bulk_campaign",
      status: "active",
      nodes: [{ id: "bulk-1", data: { kind: "bulk" } }],
      edges: [],
    };
    mockFindOne.mockImplementation(query => ({
      select: jest.fn(() => ({
        lean: jest
          .fn()
          .mockResolvedValue(
            query.mode?.$ne === bulkCampaign.mode ? null : bulkCampaign
          ),
      })),
    }));

    await expect(
      scenarioRuntimeDependencies.loadActiveScenarioSnapshot({
        workspaceId,
        scenarioId,
      })
    ).resolves.toBeNull();
    expect(mockFindOne).toHaveBeenCalledWith({
      _id: scenarioId,
      workspaceId,
      status: "active",
      mode: { $ne: "bulk_campaign" },
      deletedAt: null,
    });
  });

  it.each([
    [
      { _id: { toString: () => "65f000000000000000000099" } },
      "65f000000000000000000099",
    ],
    [null, null],
  ])(
    "reads the latest outbound of a scenario action from runtime and bulk sends: %j",
    async (outbound, expected) => {
      const lean = jest.fn().mockResolvedValue(outbound);
      const select = jest.fn(() => ({ lean }));
      const sort = jest.fn(() => ({ select }));
      mockMessageFindOne.mockReset().mockReturnValue({ sort });

      await expect(
        scenarioRuntimeDependencies.findLatestScenarioActionOutbound({
          workspaceId,
          conversationId: "conversation-1",
          scenarioId,
          actionNodeId: "menu",
        })
      ).resolves.toBe(expected);
      // No origin.kind filter: bulk sends record "campaign", the runtime "scenario".
      expect(mockMessageFindOne).toHaveBeenCalledWith({
        workspaceId,
        conversation: "conversation-1",
        direction: "outbound",
        "origin.scenarioId": scenarioId,
        "origin.nodeId": "menu",
      });
      expect(sort).toHaveBeenCalledWith({ date: -1 });
      expect(select).toHaveBeenCalledWith(
        "_id channel messageId temporalDispatch.state delivery.status delivery.failedAt"
      );
    }
  );

  it("returns an active conversation graph through the shared runtime reader", async () => {
    const scenario = {
      _id: scenarioId,
      name: "Conversation",
      priority: 4,
      nodes: [
        { id: "action-1", data: { kind: "action", actionType: "reply" } },
      ],
      edges: [],
      updatedAt: new Date("2026-09-09T01:00:00.000Z"),
    };
    mockFindOne.mockReturnValue({
      select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(scenario) })),
    });

    await expect(
      scenarioRuntimeDependencies.loadActiveScenarioSnapshot({
        workspaceId,
        scenarioId,
      })
    ).resolves.toMatchObject(scenario);
  });
});
