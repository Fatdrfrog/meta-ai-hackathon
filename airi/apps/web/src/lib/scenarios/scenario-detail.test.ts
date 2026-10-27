const mockConnectDB = jest.fn();
const mockFindOne = jest.fn();
const mockEnrichScenarioNodesMediaDisplayUrls = jest.fn();
const mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget = jest.fn();
const mockLoadLinkedConditionParentCountByNodeId = jest.fn();
const mockListOutstandingTimerReplanIngressForScenario = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
}));

jest.mock("@/lib/scenarios/scenario-serialization", () => ({
  serializeScenario: (scenario: unknown) => scenario,
}));

jest.mock("@/lib/scenarios/linked-conditions", () => ({
  loadLinkedConditionParentCountByNodeId: (...args: unknown[]) =>
    mockLoadLinkedConditionParentCountByNodeId(...args),
}));

jest.mock("@/lib/scenarios/linked-parent-summaries", () => ({
  attachLinkedParentScenarioIds: async (scenario: unknown) => scenario,
}));

jest.mock("@/lib/scenarios/scenario-asset-media-enrichment", () => ({
  enrichScenarioNodesMediaDisplayUrls: (...args: unknown[]) =>
    mockEnrichScenarioNodesMediaDisplayUrls(...args),
  enrichScenarioNodesMediaDisplayUrlsWithinBudget: (...args: unknown[]) =>
    mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget(...args),
}));

jest.mock("@/lib/airi/scenario/timer-recovery/ingress", () => ({
  listOutstandingTimerReplanIngressForScenario: (...args: unknown[]) =>
    mockListOutstandingTimerReplanIngressForScenario(...args),
}));

import {
  loadScenarioDetail,
  readScenarioDetailMediaSigning,
  SCENARIO_DETAIL_MEDIA_SIGNING_BUDGET_MS,
} from "./scenario-detail";

const scenarioId = "65f000000000000000000001";
const mediaPath = "workspaces/workspace-1/creative-assets/image/card.png";
const durableNodes = [
  {
    id: "action-1",
    data: {
      actionAttachments: [
        { url: `gcs://media/${mediaPath}`, bucket: "media", path: mediaPath },
      ],
    },
  },
];
const signedNodes = [
  {
    id: "action-1",
    data: {
      actionAttachments: [
        {
          url: "https://storage.example/card.png?signature=1",
          bucket: "media",
          path: mediaPath,
        },
      ],
    },
  },
];

function arrangeStoredScenario(scenario: Record<string, unknown> | null) {
  mockFindOne.mockReturnValue({
    lean: jest.fn().mockResolvedValue(scenario),
  });
}

describe("loadScenarioDetail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockLoadLinkedConditionParentCountByNodeId.mockResolvedValue({});
    mockListOutstandingTimerReplanIngressForScenario.mockResolvedValue({
      status: null,
      affectedConversationIds: [],
      hasMore: false,
    });
    mockEnrichScenarioNodesMediaDisplayUrls.mockResolvedValue(signedNodes);
    mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget.mockResolvedValue({
      nodes: durableNodes,
      pending: true,
    });
    arrangeStoredScenario({
      _id: scenarioId,
      workspaceId: "workspace-1",
      nodes: durableNodes,
      edges: [],
    });
  });

  it("waits for every signed URL unless the reader asks for deferred media", async () => {
    const detail = await loadScenarioDetail({
      workspaceId: "workspace-1",
      scenarioId,
    });

    expect(mockEnrichScenarioNodesMediaDisplayUrls).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      nodes: durableNodes,
    });
    expect(
      mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget
    ).not.toHaveBeenCalled();
    expect(detail?.scenario.nodes).toEqual(signedNodes);
    expect(detail?.metadata).toEqual({
      linkedConditionParentCountByNodeId: {},
    });
  });

  it("time-boxes signing and flags pending media for a deferred read", async () => {
    const detail = await loadScenarioDetail({
      workspaceId: "workspace-1",
      scenarioId,
      mediaSigning: "deferred",
    });

    expect(
      mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      nodes: durableNodes,
      budgetMs: SCENARIO_DETAIL_MEDIA_SIGNING_BUDGET_MS,
    });
    expect(mockEnrichScenarioNodesMediaDisplayUrls).not.toHaveBeenCalled();
    expect(detail?.scenario.nodes).toEqual(durableNodes);
    expect(detail?.metadata).toEqual({
      linkedConditionParentCountByNodeId: {},
      mediaDisplayUrlsPending: true,
    });
  });

  it("returns null for a missing scenario without signing anything", async () => {
    arrangeStoredScenario(null);

    await expect(
      loadScenarioDetail({
        workspaceId: "workspace-1",
        scenarioId,
        mediaSigning: "deferred",
      })
    ).resolves.toBeNull();
    expect(mockFindOne).toHaveBeenCalledWith({
      _id: scenarioId,
      workspaceId: "workspace-1",
      deletedAt: null,
    });
    expect(mockEnrichScenarioNodesMediaDisplayUrls).not.toHaveBeenCalled();
    expect(
      mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget
    ).not.toHaveBeenCalled();
  });
});

describe("readScenarioDetailMediaSigning", () => {
  it("defers only for the exact deferred value", () => {
    expect(readScenarioDetailMediaSigning("deferred")).toBe("deferred");
    for (const value of [null, "", "complete", "DEFERRED", "deferred "]) {
      expect(readScenarioDetailMediaSigning(value)).toBe("complete");
    }
  });
});
