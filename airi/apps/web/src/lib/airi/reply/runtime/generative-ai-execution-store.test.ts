const mockConversationFindOneAndUpdate = jest.fn();
const mockConversationFindOne = jest.fn();
const mockConversationFindById = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockCreativeAssetFindOne = jest.fn();
const mockScenarioFindOne = jest.fn();

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOneAndUpdate: (...args: unknown[]) =>
      mockConversationFindOneAndUpdate(...args),
    findOne: (...args: unknown[]) => mockConversationFindOne(...args),
    findById: (...args: unknown[]) => mockConversationFindById(...args),
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
  },
}));

jest.mock("@/models/creative-asset", () => ({
  CreativeAsset: {
    findOne: (...args: unknown[]) => mockCreativeAssetFindOne(...args),
  },
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
  },
}));

import { buildScenarioRevisionFingerprint } from "@icecore/airi-runtime/scenario-generative-ai-identity";
import {
  advanceGenerativeExecutionPhase,
  claimGenerativeDelivery,
  claimGenerativeExecution,
  clearGenerativeExecutionIfOwned,
  countGenerativeAIStarts,
  exactStoredScenarioStateFilter,
  inspectGenerativeDeliveryPreflight,
  isAuthoritativeGenerativeScenarioRevisionActive,
  loadGenerativeExecutionIfOwned,
  parsePendingGenerativeExecution,
  readGenerativeExecutionOwnerRecord,
  terminalizeAcceptedGenerativeExecution,
  terminalizeGenerativeDelivery,
  type PendingGenerativeExecution,
} from "@/lib/airi/reply/runtime/generative-ai-execution-store";

const ACTIVE_SCENARIO_GRAPH = {
  version: 1,
  nodes: [
    {
      id: "action-1",
      type: "action",
      data: { kind: "action", actionType: "generative_ai" },
    },
  ],
  edges: [],
} as const;
const ACTIVE_SCENARIO_REVISION = buildScenarioRevisionFingerprint(
  ACTIVE_SCENARIO_GRAPH
);

const CLAIMED_VIDEO_ATTACHMENT = {
  url: "gcs://creative-assets/workspaces/workspace-1/creative-assets/video/output.mp4",
  mediaType: "video" as const,
  mimeType: "video/mp4",
  fileName: "output.mp4",
  fileSize: 8 * 1024 * 1024,
  bucket: "creative-assets",
  path: "workspaces/workspace-1/creative-assets/video/output.mp4",
};

const BASE_EXECUTION: PendingGenerativeExecution = {
  version: 1,
  configVersion: 1,
  executionId: "execution-1",
  phase: "accepted",
  scenarioId: "scenario-1",
  scenarioRevisionFingerprint: "revision-1",
  actionNodeId: "action-1",
  inputMessageId: "message-1",
  expectedInputKind: "text",
  mode: "text_to_video",
  composedPrompt: "Make a concise product video",
  sourceMedia: null,
  successTransition: {
    nextActionNodeId: "success-1",
    completesScenario: false,
  },
  failureTransition: {
    nextActionNodeId: null,
    completesScenario: true,
  },
  scenarioWorkflowId: "scenario-generation:execution-1",
  acceptedAt: "2026-07-30T10:00:00.000Z",
};

function pendingOwnerDocument(execution: unknown) {
  return { airi_pending_generative_execution: execution };
}

function leanQuery(value: unknown) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

/** The scenario state a compare-and-set filter requires, as it was read. */
function requiredScenarioState(filter: Record<string, unknown>): unknown {
  const expr = filter.$expr as
    | { $eq?: [{ $literal?: unknown }, unknown] }
    | undefined;
  return expr?.$eq ? expr.$eq[0].$literal : filter.airi_scenario_state;
}

describe("generative AI execution store", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("preserves frozen image configuration and accepts a matching image success claim", () => {
    const execution = {
      ...BASE_EXECUTION,
      mode: "text_to_image",
      imageConfig: {
        provider: "google",
        sourceId: "11111111-1111-4111-8111-111111111111",
        modelId: "gemini-3.1-flash-image",
        aspectRatio: "16:9",
        referenceImages: [],
        includeInboundText: true,
      },
      phase: "delivering",
      assetId: "asset-1",
      videoWorkflowId: "creative-image-generation:asset-1",
      deliveryClaim: {
        token: "claim-1",
        kind: "success_image",
        deliveryKey: "image-1",
        reservedMessageId: "message-2",
        claimedAt: BASE_EXECUTION.acceptedAt,
        attemptToken: "attempt-1",
        attachment: {
          ...CLAIMED_VIDEO_ATTACHMENT,
          mediaType: "image",
          mimeType: "image/png",
          fileSize: 1024,
        },
      },
    };
    expect(parsePendingGenerativeExecution(execution)).toEqual(execution);
    expect(
      parsePendingGenerativeExecution({ ...execution, imageConfig: undefined })
    ).toBeNull();
    expect(
      parsePendingGenerativeExecution({
        ...execution,
        deliveryClaim: { ...execution.deliveryClaim, kind: "success_video" },
      })
    ).toBeNull();
    expect(
      parsePendingGenerativeExecution({
        ...execution,
        deliveryClaim: {
          ...execution.deliveryClaim,
          attachment: {
            ...execution.deliveryClaim.attachment,
            fileSize: 5 * 1024 * 1024 + 1,
          },
        },
      })
    ).toBeNull();
  });

  it("allows one concurrent claimant and returns that owner to the loser", async () => {
    let owner: PendingGenerativeExecution | null = null;
    mockConversationFindOneAndUpdate.mockImplementation(
      async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
        if (owner) return null;
        owner = update.$set
          .airi_pending_generative_execution as PendingGenerativeExecution;
        return pendingOwnerDocument(owner);
      }
    );
    mockConversationFindOne.mockImplementation(() =>
      leanQuery(owner ? pendingOwnerDocument(owner) : null)
    );

    const [first, second] = await Promise.all([
      claimGenerativeExecution({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        execution: BASE_EXECUTION,
      }),
      claimGenerativeExecution({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        execution: BASE_EXECUTION,
      }),
    ]);

    expect([first.status, second.status].sort()).toEqual([
      "claimed",
      "existing",
    ]);
    const winner =
      first.status === "claimed"
        ? first
        : second.status === "claimed"
          ? second
          : null;
    expect(winner?.execution).toEqual(BASE_EXECUTION);
    expect(mockConversationFindOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      {
        _id: "conversation-1",
        workspaceId: "workspace-1",
        "airi_scenario_state.lockedScenarioId": "scenario-1",
        "airi_scenario_state.currentActionNodeId": "action-1",
        "airi_scenario_state.scenarioRevisionFingerprint": "revision-1",
        airi_pending_generative_execution: null,
      },
      {
        $set: {
          airi_pending_generative_execution: BASE_EXECUTION,
        },
        $push: {
          airi_generative_starts: {
            scenarioId: "scenario-1",
            actionNodeId: "action-1",
            acceptedAt: new Date(BASE_EXECUTION.acceptedAt),
          },
        },
      },
      {
        new: true,
        projection: { airi_pending_generative_execution: 1 },
        lean: true,
      }
    );
  });

  it("keeps every start of the last day, dropping only older ones", async () => {
    mockConversationFindOneAndUpdate.mockResolvedValue(null);
    mockConversationFindOne.mockReturnValue(leanQuery(null));

    await claimGenerativeExecution({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      execution: BASE_EXECUTION,
    });

    const dayBefore = new Date(
      Date.parse(BASE_EXECUTION.acceptedAt) - 24 * 60 * 60 * 1000
    );
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1", workspaceId: "workspace-1" },
      {
        $pull: {
          airi_generative_starts: { acceptedAt: { $lt: dayBefore } },
        },
      }
    );
    const [, update] = mockConversationFindOneAndUpdate.mock.calls[0];
    expect(update.$push.airi_generative_starts).not.toHaveProperty("$slice");
  });

  it("counts a node's starts in this conversation within the window", async () => {
    const since = new Date("2026-09-27T09:00:00.000Z");
    const start = (patch: Record<string, unknown>) => ({
      scenarioId: "scenario-1",
      actionNodeId: "action-1",
      acceptedAt: new Date("2026-09-28T08:00:00.000Z"),
      ...patch,
    });
    const select = jest.fn(() => ({
      lean: async () => ({
        airi_generative_starts: [
          start({}),
          start({ acceptedAt: since }),
          start({ acceptedAt: new Date("2026-09-27T08:59:59.999Z") }),
          start({ actionNodeId: "action-2" }),
          start({ scenarioId: "scenario-2" }),
        ],
      }),
    }));
    mockConversationFindById.mockReturnValue({ select });

    await expect(
      countGenerativeAIStarts({
        conversationId: "conversation-1",
        scenarioId: "scenario-1",
        actionNodeId: "action-1",
        since,
      })
    ).resolves.toBe(2);
    expect(mockConversationFindById).toHaveBeenCalledWith("conversation-1");

    mockConversationFindById.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
    await expect(
      countGenerativeAIStarts({
        conversationId: "missing",
        scenarioId: "scenario-1",
        actionNodeId: "action-1",
        since,
      })
    ).resolves.toBe(0);
  });

  it("does not let a different inbound overwrite the active owner", async () => {
    const contender = {
      ...BASE_EXECUTION,
      executionId: "execution-2",
      inputMessageId: "message-2",
    };
    mockConversationFindOneAndUpdate.mockResolvedValue(null);
    mockConversationFindOne.mockReturnValue(
      leanQuery(pendingOwnerDocument(BASE_EXECUTION))
    );

    const result = await claimGenerativeExecution({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      execution: contender,
    });

    expect(result).toEqual({
      status: "existing",
      execution: BASE_EXECUTION,
    });
    expect(mockConversationFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a persisted pending owner is malformed", async () => {
    mockConversationFindOneAndUpdate.mockResolvedValue(null);
    mockConversationFindOne.mockReturnValue(
      leanQuery(
        pendingOwnerDocument({
          ...BASE_EXECUTION,
          acceptedAt: new Date("2026-07-30T10:00:00.000Z"),
        } as unknown as PendingGenerativeExecution)
      )
    );

    await expect(
      claimGenerativeExecution({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        execution: BASE_EXECUTION,
      })
    ).resolves.toEqual({ status: "stale" });
    await expect(
      readGenerativeExecutionOwnerRecord({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
      })
    ).resolves.toEqual({
      classification: "malformed",
      execution: null,
    });
  });

  it("rejects a non-completing frozen transition without a next action", () => {
    expect(
      parsePendingGenerativeExecution({
        ...BASE_EXECUTION,
        successTransition: {
          nextActionNodeId: null,
          completesScenario: false,
        },
      })
    ).toBeNull();
    expect(
      parsePendingGenerativeExecution({
        ...BASE_EXECUTION,
        successTransition: {
          nextActionNodeId: "success-1",
          completesScenario: true,
        },
      })
    ).toBeNull();
  });

  it("accepts frozen input only as each mode expects it", () => {
    const sourceMedia = {
      whatsappMediaId: "media-1",
      declaredMimeType: "image/jpeg",
      fileName: null,
    };
    const imageToVideo = {
      ...BASE_EXECUTION,
      mode: "image_to_video" as const,
      expectedInputKind: "image" as const,
      sourceMedia,
    };
    expect(parsePendingGenerativeExecution(imageToVideo)).toEqual(imageToVideo);
    for (const invalid of [
      { ...imageToVideo, sourceMedia: null },
      { ...imageToVideo, expectedInputKind: "text" },
      { ...BASE_EXECUTION, sourceMedia },
      { ...BASE_EXECUTION, expectedInputKind: "image" },
      { ...BASE_EXECUTION, expectedInputKind: "video" },
      { ...BASE_EXECUTION, mode: "text_to_audio" },
      { ...BASE_EXECUTION, phase: "queued" },
      { ...BASE_EXECUTION, unexpectedField: true },
    ]) {
      expect(parsePendingGenerativeExecution(invalid)).toBeNull();
    }
  });

  it("rejects a delivering success owner without its immutable attachment", () => {
    expect(
      parsePendingGenerativeExecution({
        ...BASE_EXECUTION,
        phase: "delivering",
        assetId: "507f191e810c19729de860ea",
        videoWorkflowId: "video-generation:507f191e810c19729de860ea",
        deliveryClaim: {
          token: "delivery-token-1",
          kind: "success_video",
          deliveryKey: "generative-video:execution-1",
          reservedMessageId: "507f1f77bcf86cd799439011",
          claimedAt: "2026-07-30T10:05:00.000Z",
        },
      })
    ).toBeNull();
  });

  it("replaces the complete owner canonically when adding the video workflow identity", async () => {
    const { acceptedAt, ...executionBeforeAcceptedAt } = BASE_EXECUTION;
    const preparingExecution: PendingGenerativeExecution = {
      ...executionBeforeAcceptedAt,
      phase: "preparing_generation",
      videoWorkflowId: "video-generation:execution-1",
      acceptedAt,
    };
    mockConversationFindOne.mockReturnValue(
      leanQuery(pendingOwnerDocument(BASE_EXECUTION))
    );
    mockConversationFindOneAndUpdate.mockResolvedValue(null);

    const result = await advanceGenerativeExecutionPhase({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      expectedPhase: "accepted",
      nextPhase: "preparing_generation",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
      updates: {
        videoWorkflowId: "video-generation:execution-1",
      },
    });

    expect(result).toBeNull();
    expect(mockConversationFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: "conversation-1",
        workspaceId: "workspace-1",
        "airi_pending_generative_execution.executionId": "execution-1",
        "airi_pending_generative_execution.phase": "accepted",
        "airi_pending_generative_execution.scenarioId": "scenario-1",
        "airi_pending_generative_execution.scenarioRevisionFingerprint":
          "revision-1",
        "airi_pending_generative_execution.actionNodeId": "action-1",
        airi_pending_generative_execution: BASE_EXECUTION,
      },
      {
        $set: {
          airi_pending_generative_execution: preparingExecution,
        },
      },
      {
        new: true,
        projection: { airi_pending_generative_execution: 1 },
        lean: true,
      }
    );
    const update = mockConversationFindOneAndUpdate.mock.calls[0]?.[1] as {
      $set: Record<string, unknown>;
    };
    expect(Object.keys(update.$set)).toEqual([
      "airi_pending_generative_execution",
    ]);
    expect(
      Object.keys(
        update.$set
          .airi_pending_generative_execution as PendingGenerativeExecution
      )
    ).toEqual([
      "version",
      "configVersion",
      "executionId",
      "phase",
      "scenarioId",
      "scenarioRevisionFingerprint",
      "actionNodeId",
      "inputMessageId",
      "expectedInputKind",
      "mode",
      "composedPrompt",
      "sourceMedia",
      "successTransition",
      "failureTransition",
      "scenarioWorkflowId",
      "videoWorkflowId",
      "acceptedAt",
    ]);
  });

  it("does not let generic phase advancement claim delivery", async () => {
    const result = await advanceGenerativeExecutionPhase({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      expectedPhase: "generating",
      nextPhase: "delivering",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
    } as Parameters<typeof advanceGenerativeExecutionPhase>[0]);

    expect(result).toBeNull();
    expect(mockConversationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("claims generating to delivering with the deterministic delivery identity", async () => {
    const deliveryClaim = {
      token: "delivery-token-1",
      kind: "success_video" as const,
      deliveryKey: "generative-video:execution-1",
      reservedMessageId: "507f1f77bcf86cd799439011",
      claimedAt: "2026-07-30T10:05:00.000Z",
      attemptToken: "attempt-1",
      attachment: CLAIMED_VIDEO_ATTACHMENT,
    };
    const deliveringExecution: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      scenarioRevisionFingerprint: ACTIVE_SCENARIO_REVISION,
      phase: "delivering",
      assetId: "507f191e810c19729de860ea",
      videoWorkflowId: "video-generation:507f191e810c19729de860ea",
      deliveryClaim,
    };
    const generatingExecution: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      scenarioRevisionFingerprint: ACTIVE_SCENARIO_REVISION,
      phase: "generating",
      assetId: "507f191e810c19729de860ea",
      videoWorkflowId: "video-generation:507f191e810c19729de860ea",
    };
    mockConversationFindOne.mockReturnValue(
      leanQuery(pendingOwnerDocument(generatingExecution))
    );
    mockConversationFindOneAndUpdate.mockResolvedValue(
      pendingOwnerDocument(deliveringExecution)
    );
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        nodes: ACTIVE_SCENARIO_GRAPH.nodes,
        edges: ACTIVE_SCENARIO_GRAPH.edges,
      })
    );

    const result = await claimGenerativeDelivery({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: ACTIVE_SCENARIO_REVISION,
      actionNodeId: "action-1",
      assetId: "507f191e810c19729de860ea",
      videoWorkflowId: "video-generation:507f191e810c19729de860ea",
      attemptToken: "attempt-1",
      deliveryClaim,
    });

    expect(result).toEqual(deliveringExecution);
    expect(mockConversationFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: "conversation-1",
        workspaceId: "workspace-1",
        "airi_pending_generative_execution.executionId": "execution-1",
        "airi_pending_generative_execution.phase": "generating",
        "airi_pending_generative_execution.scenarioId": "scenario-1",
        "airi_pending_generative_execution.scenarioRevisionFingerprint":
          ACTIVE_SCENARIO_REVISION,
        "airi_pending_generative_execution.actionNodeId": "action-1",
        "airi_pending_generative_execution.assetId": "507f191e810c19729de860ea",
        "airi_pending_generative_execution.videoWorkflowId":
          "video-generation:507f191e810c19729de860ea",
        "airi_scenario_state.lockedScenarioId": "scenario-1",
        "airi_scenario_state.currentActionNodeId": "action-1",
        "airi_scenario_state.scenarioRevisionFingerprint":
          ACTIVE_SCENARIO_REVISION,
        airi_pending_generative_execution: generatingExecution,
      },
      {
        $set: {
          airi_pending_generative_execution: deliveringExecution,
        },
      },
      {
        new: true,
        projection: { airi_pending_generative_execution: 1 },
        lean: true,
      }
    );
    const update = mockConversationFindOneAndUpdate.mock.calls[0]?.[1] as {
      $set: Record<string, unknown>;
    };
    expect(Object.keys(update.$set)).toEqual([
      "airi_pending_generative_execution",
    ]);
    expect(Object.keys(result?.deliveryClaim || {})).toEqual([
      "token",
      "kind",
      "deliveryKey",
      "reservedMessageId",
      "claimedAt",
      "attemptToken",
      "attachment",
    ]);
    expect(Object.keys(result?.deliveryClaim?.attachment || {})).toEqual([
      "url",
      "mediaType",
      "mimeType",
      "fileName",
      "fileSize",
      "bucket",
      "path",
    ]);
  });

  it("does not claim a terminal delivery without the exact generated asset", async () => {
    const result = await claimGenerativeDelivery({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
      deliveryClaim: {
        token: "delivery-token-1",
        kind: "failure_feedback",
        deliveryKey: "generative-failure:execution-1",
        reservedMessageId: "507f1f77bcf86cd799439011",
        claimedAt: "2026-07-30T10:05:00.000Z",
        attemptToken: null,
        attachment: null,
      },
    } as Parameters<typeof claimGenerativeDelivery>[0]);

    expect(result).toBeNull();
    expect(mockConversationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "scenario replacement",
      {
        lockedScenarioId: "scenario-2",
        currentActionNodeId: "action-2",
        scenarioRevisionFingerprint: "revision-2",
      },
    ],
    [
      "scenario clear",
      {
        lockedScenarioId: null,
        currentActionNodeId: null,
        scenarioRevisionFingerprint: null,
      },
    ],
    [
      "revision drift",
      {
        lockedScenarioId: "scenario-1",
        currentActionNodeId: "action-1",
        scenarioRevisionFingerprint: "revision-2",
      },
    ],
  ])(
    "loses the delivery claim when a concurrent %s changes the live owner",
    async (_label, liveScenarioState) => {
      const generatingExecution: PendingGenerativeExecution = {
        ...BASE_EXECUTION,
        scenarioRevisionFingerprint: ACTIVE_SCENARIO_REVISION,
        phase: "generating",
        assetId: "507f191e810c19729de860ea",
        videoWorkflowId: "video-generation:507f191e810c19729de860ea",
      };
      mockConversationFindOne.mockReturnValue(
        leanQuery(pendingOwnerDocument(generatingExecution))
      );
      mockScenarioFindOne.mockReturnValue(
        leanQuery({
          nodes: ACTIVE_SCENARIO_GRAPH.nodes,
          edges: ACTIVE_SCENARIO_GRAPH.edges,
        })
      );
      mockConversationFindOneAndUpdate.mockImplementation(
        async (
          filter: Record<string, unknown>,
          update: {
            $set: Record<string, unknown>;
          }
        ) => {
          const livePredicates = {
            "airi_scenario_state.lockedScenarioId":
              liveScenarioState.lockedScenarioId,
            "airi_scenario_state.currentActionNodeId":
              liveScenarioState.currentActionNodeId,
            "airi_scenario_state.scenarioRevisionFingerprint":
              liveScenarioState.scenarioRevisionFingerprint,
          };
          const matchesLiveState = Object.entries(livePredicates).every(
            ([key, value]) => filter[key] === undefined || filter[key] === value
          );
          if (!matchesLiveState) return null;
          return pendingOwnerDocument({
            ...generatingExecution,
            phase: "delivering",
            deliveryClaim:
              update.$set["airi_pending_generative_execution.deliveryClaim"],
          });
        }
      );

      const result = await claimGenerativeDelivery({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        executionId: "execution-1",
        scenarioId: "scenario-1",
        scenarioRevisionFingerprint: ACTIVE_SCENARIO_REVISION,
        actionNodeId: "action-1",
        assetId: "507f191e810c19729de860ea",
        videoWorkflowId: "video-generation:507f191e810c19729de860ea",
        attemptToken: "attempt-1",
        deliveryClaim: {
          token: "delivery-token-1",
          kind: "success_video",
          deliveryKey: "generative-video:execution-1",
          reservedMessageId: "507f1f77bcf86cd799439011",
          claimedAt: "2026-07-30T10:05:00.000Z",
          attemptToken: "attempt-1",
          attachment: CLAIMED_VIDEO_ATTACHMENT,
        },
      });

      expect(result).toBeNull();
    }
  );

  it("leaves a malformed phase owner unchanged", async () => {
    mockConversationFindOne.mockReturnValue(
      leanQuery(
        pendingOwnerDocument({
          ...BASE_EXECUTION,
          version: 2,
        })
      )
    );

    const result = await advanceGenerativeExecutionPhase({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      expectedPhase: "accepted",
      nextPhase: "preparing_generation",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
    });

    expect(result).toBeNull();
    expect(mockConversationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("reads only the exact execution owner at the expected phase", async () => {
    const preparingExecution: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      phase: "preparing_generation",
    };
    mockConversationFindOne
      .mockReturnValueOnce(leanQuery(pendingOwnerDocument(preparingExecution)))
      .mockReturnValueOnce(leanQuery(pendingOwnerDocument(preparingExecution)));
    const input = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
      expectedPhase: "preparing_generation" as const,
    };

    await expect(loadGenerativeExecutionIfOwned(input)).resolves.toEqual(
      preparingExecution
    );
    await expect(
      loadGenerativeExecutionIfOwned({
        ...input,
        actionNodeId: "different-action",
      })
    ).resolves.toBeNull();
  });

  it("does not overwrite an illegal existing delivery claim", async () => {
    mockConversationFindOne.mockReturnValue(
      leanQuery(
        pendingOwnerDocument({
          ...BASE_EXECUTION,
          phase: "generating",
          assetId: "507f191e810c19729de860ea",
          videoWorkflowId: "video-generation:507f191e810c19729de860ea",
          deliveryClaim: {
            token: "stale-token",
            kind: "failure_feedback",
            deliveryKey: "stale-delivery",
            reservedMessageId: "507f1f77bcf86cd799439012",
            claimedAt: "2026-07-30T10:04:00.000Z",
          },
        })
      )
    );

    const result = await claimGenerativeDelivery({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
      assetId: "507f191e810c19729de860ea",
      videoWorkflowId: "video-generation:507f191e810c19729de860ea",
      attemptToken: "attempt-1",
      deliveryClaim: {
        token: "delivery-token-1",
        kind: "success_video",
        deliveryKey: "generative-video:execution-1",
        reservedMessageId: "507f1f77bcf86cd799439011",
        claimedAt: "2026-07-30T10:05:00.000Z",
        attemptToken: "attempt-1",
        attachment: CLAIMED_VIDEO_ATTACHMENT,
      },
    });

    expect(result).toBeNull();
    expect(mockConversationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("recovers the same deterministic delivery claim already in progress", async () => {
    const deliveryClaim = {
      token: "delivery-token-1",
      kind: "success_video" as const,
      deliveryKey: "generative-video:execution-1",
      reservedMessageId: "507f1f77bcf86cd799439011",
      claimedAt: "2026-07-30T10:04:00.000Z",
      attemptToken: "attempt-1",
      attachment: CLAIMED_VIDEO_ATTACHMENT,
    };
    const deliveringExecution: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      phase: "delivering",
      assetId: "507f191e810c19729de860ea",
      videoWorkflowId: "video-generation:507f191e810c19729de860ea",
      deliveryClaim,
    };
    mockConversationFindOne
      .mockReturnValueOnce(leanQuery(pendingOwnerDocument(deliveringExecution)))
      .mockReturnValueOnce(
        leanQuery(pendingOwnerDocument(deliveringExecution))
      );

    const result = await claimGenerativeDelivery({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
      assetId: "507f191e810c19729de860ea",
      videoWorkflowId: "video-generation:507f191e810c19729de860ea",
      attemptToken: "attempt-1",
      deliveryClaim,
    });

    expect(result).toEqual(deliveringExecution);
    expect(mockConversationFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockScenarioFindOne).not.toHaveBeenCalled();
  });

  it("exact-clears an unclaimed delivery when its authoritative scenario is stale", async () => {
    const generatingExecution: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      scenarioRevisionFingerprint: ACTIVE_SCENARIO_REVISION,
      phase: "generating",
      assetId: "507f191e810c19729de860ea",
      videoWorkflowId: "video-generation:507f191e810c19729de860ea",
    };
    mockConversationFindOne.mockReturnValue(
      leanQuery(pendingOwnerDocument(generatingExecution))
    );
    mockScenarioFindOne.mockReturnValue(leanQuery(null));
    mockConversationUpdateOne.mockResolvedValue({ modifiedCount: 1 });

    const result = await claimGenerativeDelivery({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: ACTIVE_SCENARIO_REVISION,
      actionNodeId: "action-1",
      assetId: "507f191e810c19729de860ea",
      videoWorkflowId: "video-generation:507f191e810c19729de860ea",
      attemptToken: "attempt-1",
      deliveryClaim: {
        token: "delivery-token-1",
        kind: "success_video",
        deliveryKey: "generative-video:execution-1",
        reservedMessageId: "507f1f77bcf86cd799439011",
        claimedAt: "2026-07-30T10:05:00.000Z",
        attemptToken: "attempt-1",
        attachment: CLAIMED_VIDEO_ATTACHMENT,
      },
    });

    expect(result).toBeNull();
    expect(mockConversationFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        "airi_pending_generative_execution.phase": "generating",
        airi_pending_generative_execution: generatingExecution,
      }),
      { $unset: { airi_pending_generative_execution: "" } }
    );
  });

  it("validates the exact active delivery claim before provider dispatch", async () => {
    const deliveringExecution: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      phase: "delivering",
      assetId: "507f191e810c19729de860ea",
      videoWorkflowId: "video-generation:507f191e810c19729de860ea",
      deliveryClaim: {
        token: "delivery-token-1",
        kind: "success_video",
        deliveryKey: "generative-video:execution-1",
        reservedMessageId: "507f1f77bcf86cd799439011",
        claimedAt: "2026-07-30T10:04:00.000Z",
        attemptToken: "attempt-1",
        attachment: {
          url: "gcs://creative-assets/workspaces/workspace-1/creative-assets/video/output.mp4",
          mediaType: "video",
          mimeType: "video/mp4",
          fileName: "output.mp4",
          fileSize: 8 * 1024 * 1024,
          bucket: "creative-assets",
          path: "workspaces/workspace-1/creative-assets/video/output.mp4",
        },
      },
    };
    mockConversationFindOne.mockReturnValue(
      leanQuery(pendingOwnerDocument(deliveringExecution))
    );
    mockCreativeAssetFindOne.mockReturnValue(leanQuery(null));
    const guard = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
      deliveryClaimToken: "delivery-token-1",
      deliveryKey: "generative-video:execution-1",
      reservedMessageId: "507f1f77bcf86cd799439011",
      assetId: "507f191e810c19729de860ea",
      videoWorkflowId: "video-generation:507f191e810c19729de860ea",
      attemptToken: "attempt-1",
      context: {
        content: "",
        scenarioAttachments: [
          {
            url: "gcs://creative-assets/workspaces/workspace-1/creative-assets/video/output.mp4",
            mediaType: "video",
            mimeType: "video/mp4",
            fileName: "output.mp4",
            fileSize: 8 * 1024 * 1024,
            bucket: "creative-assets",
            path: "workspaces/workspace-1/creative-assets/video/output.mp4",
          },
        ],
      },
    };

    await expect(inspectGenerativeDeliveryPreflight(guard)).resolves.toEqual({
      classification: "valid",
    });
    expect(mockCreativeAssetFindOne).not.toHaveBeenCalled();
    await expect(
      inspectGenerativeDeliveryPreflight({
        ...guard,
        attemptToken: "stale-attempt",
      })
    ).resolves.toEqual({ classification: "invalid_payload" });
    await expect(
      inspectGenerativeDeliveryPreflight({
        ...guard,
        deliveryClaimToken: "stale-claim",
      })
    ).resolves.toEqual({ classification: "stale_claim" });
    await expect(
      inspectGenerativeDeliveryPreflight({
        ...guard,
        context: {
          ...guard.context,
          scenarioAttachments: [
            {
              ...(
                guard.context.scenarioAttachments as Array<
                  Record<string, unknown>
                >
              )[0],
              path: "workspaces/workspace-1/tampered.mp4",
            },
          ],
        },
      })
    ).resolves.toEqual({ classification: "invalid_payload" });
  });

  it("requires the authoritative scenario to remain active, undeleted, and revision-exact", async () => {
    mockScenarioFindOne.mockReturnValueOnce(
      leanQuery({
        nodes: ACTIVE_SCENARIO_GRAPH.nodes,
        edges: ACTIVE_SCENARIO_GRAPH.edges,
      })
    );
    const input = {
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: ACTIVE_SCENARIO_REVISION,
    };

    await expect(
      isAuthoritativeGenerativeScenarioRevisionActive(input)
    ).resolves.toBe(true);
    expect(mockScenarioFindOne).toHaveBeenNthCalledWith(1, {
      _id: "scenario-1",
      workspaceId: "workspace-1",
      status: "active",
      mode: { $ne: "bulk_campaign" },
      deletedAt: null,
    });

    mockScenarioFindOne.mockReturnValueOnce(leanQuery(null));
    await expect(
      isAuthoritativeGenerativeScenarioRevisionActive(input)
    ).resolves.toBe(false);

    mockScenarioFindOne.mockReturnValueOnce(
      leanQuery({
        nodes: [
          ...ACTIVE_SCENARIO_GRAPH.nodes,
          { id: "edited", type: "action", data: { kind: "action" } },
        ],
        edges: ACTIVE_SCENARIO_GRAPH.edges,
      })
    );
    await expect(
      isAuthoritativeGenerativeScenarioRevisionActive(input)
    ).resolves.toBe(false);
  });

  it("claims exact pre-asset failure delivery from an early phase", async () => {
    const importing: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      scenarioRevisionFingerprint: ACTIVE_SCENARIO_REVISION,
      phase: "importing_source",
    };
    mockConversationFindOne.mockReturnValue(
      leanQuery(pendingOwnerDocument(importing))
    );
    mockConversationFindOneAndUpdate.mockResolvedValue(
      pendingOwnerDocument({
        ...importing,
        phase: "delivering",
        deliveryClaim: {
          token: "failure-token",
          kind: "failure_feedback",
          deliveryKey: "failure-delivery",
          reservedMessageId: "507f1f77bcf86cd799439011",
          claimedAt: "2026-07-30T10:05:00.000Z",
          attemptToken: null,
          attachment: null,
        },
      })
    );
    mockScenarioFindOne.mockReturnValue(
      leanQuery({
        nodes: ACTIVE_SCENARIO_GRAPH.nodes,
        edges: ACTIVE_SCENARIO_GRAPH.edges,
      })
    );

    const result = await claimGenerativeDelivery({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: ACTIVE_SCENARIO_REVISION,
      actionNodeId: "action-1",
      assetId: null,
      videoWorkflowId: null,
      attemptToken: null,
      deliveryClaim: {
        token: "failure-token",
        kind: "failure_feedback",
        deliveryKey: "failure-delivery",
        reservedMessageId: "507f1f77bcf86cd799439011",
        claimedAt: "2026-07-30T10:05:00.000Z",
        attemptToken: null,
        attachment: null,
      },
    });

    expect(result?.phase).toBe("delivering");
  });

  it("preflights pre-asset failure feedback only with non-empty text and no media", async () => {
    const deliveringExecution: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      phase: "delivering",
      deliveryClaim: {
        token: "failure-token",
        kind: "failure_feedback",
        deliveryKey: "failure-delivery",
        reservedMessageId: "507f1f77bcf86cd799439011",
        claimedAt: "2026-07-30T10:05:00.000Z",
        attemptToken: null,
        attachment: null,
      },
    };
    mockConversationFindOne.mockReturnValue(
      leanQuery(pendingOwnerDocument(deliveringExecution))
    );
    const input = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
      deliveryClaimToken: "failure-token",
      deliveryKey: "failure-delivery",
      reservedMessageId: "507f1f77bcf86cd799439011",
      assetId: null,
      videoWorkflowId: null,
      attemptToken: null,
      context: {
        content: "We couldn't create a video this time. Please try again.",
      },
    };

    await expect(inspectGenerativeDeliveryPreflight(input)).resolves.toEqual({
      classification: "valid",
    });
    await expect(
      inspectGenerativeDeliveryPreflight({
        ...input,
        context: { content: "" },
      })
    ).resolves.toEqual({ classification: "invalid_payload" });
  });

  it("does not clear a malformed persisted owner", async () => {
    mockConversationFindOne.mockReturnValue(
      leanQuery(
        pendingOwnerDocument({
          ...BASE_EXECUTION,
          successTransition: {
            nextActionNodeId: "success-1",
          },
        })
      )
    );

    const result = await clearGenerativeExecutionIfOwned({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      expectedPhase: "accepted",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
    });

    expect(result).toBe(false);
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  it("only clears the exact expected phase and owner", async () => {
    const deliveringExecution: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      phase: "delivering",
      assetId: "507f191e810c19729de860ea",
      videoWorkflowId: "video-generation:507f191e810c19729de860ea",
      deliveryClaim: {
        token: "delivery-token-1",
        kind: "success_video",
        deliveryKey: "generative-video:execution-1",
        reservedMessageId: "507f1f77bcf86cd799439011",
        claimedAt: "2026-07-30T10:05:00.000Z",
        attemptToken: "attempt-1",
        attachment: CLAIMED_VIDEO_ATTACHMENT,
      },
    };
    mockConversationFindOne
      .mockReturnValueOnce(leanQuery(pendingOwnerDocument(BASE_EXECUTION)))
      .mockReturnValueOnce(
        leanQuery(pendingOwnerDocument(deliveringExecution))
      );
    mockConversationUpdateOne
      .mockResolvedValueOnce({ modifiedCount: 0 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
    const baseInput = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
    };

    const nonterminalResult = await clearGenerativeExecutionIfOwned({
      ...baseInput,
      expectedPhase: "accepted",
    });
    const terminalResult = await clearGenerativeExecutionIfOwned({
      ...baseInput,
      expectedPhase: "delivering",
    });

    expect(nonterminalResult).toBe(false);
    expect(terminalResult).toBe(true);
    expect(mockConversationUpdateOne).toHaveBeenNthCalledWith(
      2,
      {
        _id: "conversation-1",
        workspaceId: "workspace-1",
        "airi_pending_generative_execution.executionId": "execution-1",
        "airi_pending_generative_execution.phase": "delivering",
        "airi_pending_generative_execution.scenarioId": "scenario-1",
        "airi_pending_generative_execution.scenarioRevisionFingerprint":
          "revision-1",
        "airi_pending_generative_execution.actionNodeId": "action-1",
        airi_pending_generative_execution: deliveringExecution,
      },
      { $unset: { airi_pending_generative_execution: "" } }
    );
  });

  it("atomically exact-clears an accepted owner for manual handoff", async () => {
    mockConversationFindOne.mockReturnValue(
      leanQuery(pendingOwnerDocument(BASE_EXECUTION))
    );
    mockConversationFindOneAndUpdate.mockResolvedValue(
      pendingOwnerDocument(null)
    );

    const result = await terminalizeAcceptedGenerativeExecution({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
      outcome: "manual_handoff",
    });

    expect(result).toBe(true);
    expect(mockConversationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        airi_pending_generative_execution: BASE_EXECUTION,
      }),
      { $unset: { airi_pending_generative_execution: "" } },
      expect.any(Object)
    );
  });

  it("atomically applies the frozen Failure transition when acknowledgment was not sent", async () => {
    const execution: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      failureTransition: {
        nextActionNodeId: "failure-1",
        completesScenario: false,
      },
    };
    mockConversationFindOne.mockReturnValue(
      leanQuery({
        airi_pending_generative_execution: execution,
        airi_scenario_state: {
          lockedScenarioId: "scenario-1",
          lockedScenarioName: "Launch",
          scenarioRevisionFingerprint: "revision-1",
          currentActionNodeId: "action-1",
          currentPathNodeIds: ["path-1"],
          currentBranchNodeIds: ["branch-1"],
          completedScenarios: [],
          lastMessageId: "message-before-ack",
        },
      })
    );
    mockConversationFindOneAndUpdate.mockResolvedValue(
      pendingOwnerDocument(null)
    );

    const result = await terminalizeAcceptedGenerativeExecution({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      executionId: "execution-1",
      scenarioId: "scenario-1",
      scenarioRevisionFingerprint: "revision-1",
      actionNodeId: "action-1",
      outcome: "failure",
    });

    expect(result).toBe(true);
    expect(mockConversationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        airi_pending_generative_execution: execution,
      }),
      {
        $set: {
          airi_scenario_state: expect.objectContaining({
            currentActionNodeId: "failure-1",
            currentPathNodeIds: [],
            currentBranchNodeIds: [],
            pendingConditionNodeId: null,
            pendingSourceActionNodeId: null,
            lastMessageId: "message-before-ack",
          }),
        },
        $unset: { airi_pending_generative_execution: "" },
      },
      expect.any(Object)
    );
  });

  it("exact-clears the accepted owner when concurrent scenario drift defeats failure terminalization", async () => {
    const execution: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      failureTransition: {
        nextActionNodeId: "failure-1",
        completesScenario: false,
      },
    };
    const scenarioState = {
      lockedScenarioId: "scenario-1",
      lockedScenarioName: "Launch",
      scenarioRevisionFingerprint: "revision-1",
      currentActionNodeId: "action-1",
      lastMessageId: "message-before-ack",
    };
    const driftedScenarioState = {
      lockedScenarioId: "scenario-2",
      lockedScenarioName: "Replacement",
      scenarioRevisionFingerprint: "revision-2",
      currentActionNodeId: "action-2",
      lastMessageId: "concurrent-message",
    };
    let liveOwner: PendingGenerativeExecution | null = execution;
    let liveScenarioState = scenarioState;
    mockConversationFindOne.mockReturnValue(
      leanQuery({
        airi_pending_generative_execution: execution,
        airi_scenario_state: scenarioState,
      })
    );
    mockConversationFindOneAndUpdate.mockImplementation(
      async (
        filter: Record<string, unknown>,
        update: { $unset?: { airi_pending_generative_execution: string } }
      ) => {
        if (mockConversationFindOneAndUpdate.mock.calls.length === 1) {
          liveScenarioState = driftedScenarioState;
        }
        if (
          JSON.stringify(filter.airi_pending_generative_execution) !==
            JSON.stringify(liveOwner) ||
          (requiredScenarioState(filter) !== undefined &&
            JSON.stringify(requiredScenarioState(filter)) !==
              JSON.stringify(liveScenarioState))
        ) {
          return null;
        }
        if (update.$unset?.airi_pending_generative_execution === "") {
          liveOwner = null;
        }
        return pendingOwnerDocument(liveOwner);
      }
    );

    await expect(
      terminalizeAcceptedGenerativeExecution({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        executionId: "execution-1",
        scenarioId: "scenario-1",
        scenarioRevisionFingerprint: "revision-1",
        actionNodeId: "action-1",
        outcome: "failure",
      })
    ).resolves.toBe(true);

    expect(liveOwner).toBeNull();
    expect(mockConversationFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      {
        _id: "conversation-1",
        workspaceId: "workspace-1",
        "airi_pending_generative_execution.executionId": "execution-1",
        "airi_pending_generative_execution.phase": "accepted",
        "airi_pending_generative_execution.scenarioId": "scenario-1",
        "airi_pending_generative_execution.scenarioRevisionFingerprint":
          "revision-1",
        "airi_pending_generative_execution.actionNodeId": "action-1",
        airi_pending_generative_execution: execution,
      },
      { $unset: { airi_pending_generative_execution: "" } },
      {
        new: true,
        projection: { airi_pending_generative_execution: 1 },
        lean: true,
      }
    );
  });

  it.each([
    ["sent success video", "success_video", "success-1", "sent"],
    ["sent success image", "success_image", "success-1", "sent"],
    ["unsent final image", "success_image", "failure-1", "outcome_unknown"],
    ["sent failure feedback", "failure_feedback", "failure-1", "sent"],
    ["unsent final video", "success_video", "failure-1", "outcome_unknown"],
  ] as const)(
    "atomically terminalizes %s once through the frozen transition",
    async (_label, claimKind, nextActionNodeId, classification) => {
      const execution: PendingGenerativeExecution = {
        ...BASE_EXECUTION,
        ...(claimKind === "success_image"
          ? {
              mode: "text_to_image" as const,
              imageConfig: {
                provider: "google" as const,
                sourceId: "11111111-1111-4111-8111-111111111111",
                modelId: "gemini-3.1-flash-image",
                aspectRatio: "16:9" as const,
                referenceImages: [],
                includeInboundText: true,
              },
            }
          : {}),
        phase: "delivering",
        assetId: "507f191e810c19729de860ea",
        videoWorkflowId: "video-generation:507f191e810c19729de860ea",
        successTransition: {
          nextActionNodeId: "success-1",
          completesScenario: false,
        },
        failureTransition: {
          nextActionNodeId: "failure-1",
          completesScenario: false,
        },
        deliveryClaim: {
          token: "delivery-token-1",
          kind: claimKind,
          deliveryKey: "delivery-1",
          reservedMessageId: "507f1f77bcf86cd799439011",
          claimedAt: "2026-07-30T10:05:00.000Z",
          attemptToken: "attempt-1",
          attachment:
            claimKind === "success_video"
              ? CLAIMED_VIDEO_ATTACHMENT
              : claimKind === "success_image"
                ? {
                    ...CLAIMED_VIDEO_ATTACHMENT,
                    mediaType: "image",
                    mimeType: "image/png",
                    fileSize: 1024,
                  }
                : null,
        },
      };
      mockConversationFindOne.mockReturnValue(
        leanQuery({
          airi_pending_generative_execution: execution,
          airi_scenario_state: {
            lockedScenarioId: "scenario-1",
            lockedScenarioName: "Launch",
            scenarioRevisionFingerprint: "revision-1",
            currentActionNodeId: "action-1",
            completedScenarios: [],
            lastMessageId: "message-before-result",
          },
        })
      );
      mockConversationFindOneAndUpdate.mockResolvedValue(
        pendingOwnerDocument(null)
      );

      const result = await terminalizeGenerativeDelivery({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        executionId: "execution-1",
        scenarioId: "scenario-1",
        scenarioRevisionFingerprint: "revision-1",
        actionNodeId: "action-1",
        deliveryClaimToken: "delivery-token-1",
        delivery: {
          deliveryKey: "delivery-1",
          outboundMessageId: "507f1f77bcf86cd799439011",
          outboundDate: "2026-07-30T10:06:00.000Z",
          classification,
        },
      });

      expect(result).toBe(true);
      expect(mockConversationFindOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          airi_pending_generative_execution: execution,
        }),
        {
          $set: {
            airi_scenario_state: expect.objectContaining({
              currentActionNodeId: nextActionNodeId,
            }),
          },
          $unset: { airi_pending_generative_execution: "" },
        },
        expect.any(Object)
      );
      const update = mockConversationFindOneAndUpdate.mock.calls[0]?.[1] as {
        $set: { airi_scenario_state: { lastMessageId: string | null } };
      };
      expect(update.$set.airi_scenario_state.lastMessageId).toBe(
        classification === "sent"
          ? "507f1f77bcf86cd799439011"
          : "message-before-result"
      );
    }
  );

  it("canonically records and bounds a completed scenario after sent video delivery", async () => {
    const execution: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      phase: "delivering",
      assetId: "507f191e810c19729de860ea",
      videoWorkflowId: "video-generation:507f191e810c19729de860ea",
      successTransition: {
        nextActionNodeId: null,
        completesScenario: true,
      },
      deliveryClaim: {
        token: "delivery-token-1",
        kind: "success_video",
        deliveryKey: "delivery-1",
        reservedMessageId: "507f1f77bcf86cd799439011",
        claimedAt: "2026-07-30T10:05:00.000Z",
        attemptToken: "attempt-1",
        attachment: CLAIMED_VIDEO_ATTACHMENT,
      },
    };
    const completedScenarios = [
      {
        scenarioId: "scenario-1",
        scenarioName: "Old Launch",
        completedAt: "2026-07-01T10:00:00.000Z",
        lastActionNodeId: "old-action",
        lastMessageId: "old-message",
      },
      ...Array.from({ length: 24 }, (_, index) => ({
        scenarioId: `prior-${index}`,
        scenarioName: `Prior ${index}`,
        completedAt: new Date(Date.UTC(2026, 6, 2 + index, 10)).toISOString(),
        lastActionNodeId: `prior-action-${index}`,
        lastMessageId: `prior-message-${index}`,
      })),
    ];
    mockConversationFindOne.mockReturnValue(
      leanQuery({
        airi_pending_generative_execution: execution,
        airi_scenario_state: {
          lockedScenarioId: "scenario-1",
          lockedScenarioName: "Launch",
          scenarioRevisionFingerprint: "revision-1",
          currentActionNodeId: "action-1",
          completedScenarios,
          lastMessageId: "message-before-result",
        },
      })
    );
    mockConversationFindOneAndUpdate.mockResolvedValue(
      pendingOwnerDocument(null)
    );

    await expect(
      terminalizeGenerativeDelivery({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        executionId: "execution-1",
        scenarioId: "scenario-1",
        scenarioRevisionFingerprint: "revision-1",
        actionNodeId: "action-1",
        deliveryClaimToken: "delivery-token-1",
        delivery: {
          deliveryKey: "delivery-1",
          outboundMessageId: "507f1f77bcf86cd799439011",
          outboundDate: "2026-07-30T10:06:00.000Z",
          classification: "sent",
        },
      })
    ).resolves.toBe(true);

    const update = mockConversationFindOneAndUpdate.mock.calls[0]?.[1] as {
      $set: {
        airi_scenario_state: {
          lockedScenarioId: string | null;
          lockedScenarioName: string | null;
          currentActionNodeId: string | null;
          completedScenarios: Array<{
            scenarioId: string;
            scenarioName: string | null;
            completedAt: Date;
            lastActionNodeId: string | null;
            lastMessageId: string | null;
          }>;
        };
      };
    };
    const nextState = update.$set.airi_scenario_state;
    expect(nextState.lockedScenarioId).toBeNull();
    expect(nextState.lockedScenarioName).toBeNull();
    expect(nextState.currentActionNodeId).toBeNull();
    expect(nextState.completedScenarios).toHaveLength(25);
    expect(
      nextState.completedScenarios.filter(
        entry => entry.scenarioId === "scenario-1"
      )
    ).toEqual([
      {
        scenarioId: "scenario-1",
        scenarioName: "Launch",
        completedAt: new Date("2026-07-30T10:06:00.000Z"),
        lastActionNodeId: "action-1",
        lastMessageId: "507f1f77bcf86cd799439011",
      },
    ]);
  });

  it("exact-clears a claimed delivery without branching when scenario state drifted", async () => {
    const execution: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      phase: "delivering",
      assetId: "507f191e810c19729de860ea",
      videoWorkflowId: "video-generation:507f191e810c19729de860ea",
      deliveryClaim: {
        token: "delivery-token-1",
        kind: "success_video",
        deliveryKey: "delivery-1",
        reservedMessageId: "507f1f77bcf86cd799439011",
        claimedAt: "2026-07-30T10:05:00.000Z",
        attemptToken: "attempt-1",
        attachment: CLAIMED_VIDEO_ATTACHMENT,
      },
    };
    const driftedScenarioState = {
      lockedScenarioId: "scenario-2",
      scenarioRevisionFingerprint: "revision-2",
      currentActionNodeId: "action-2",
    };
    mockConversationFindOne.mockReturnValue(
      leanQuery({
        airi_pending_generative_execution: execution,
        airi_scenario_state: driftedScenarioState,
      })
    );
    mockConversationFindOneAndUpdate.mockResolvedValue(
      pendingOwnerDocument(null)
    );

    await expect(
      terminalizeGenerativeDelivery({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        executionId: "execution-1",
        scenarioId: "scenario-1",
        scenarioRevisionFingerprint: "revision-1",
        actionNodeId: "action-1",
        deliveryClaimToken: "delivery-token-1",
        delivery: {
          deliveryKey: "delivery-1",
          outboundMessageId: "507f1f77bcf86cd799439011",
          outboundDate: "2026-07-30T10:06:00.000Z",
          classification: "sent",
        },
      })
    ).resolves.toBe(true);

    expect(mockConversationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        airi_pending_generative_execution: execution,
        $expr: {
          $eq: [{ $literal: driftedScenarioState }, "$airi_scenario_state"],
        },
      }),
      { $unset: { airi_pending_generative_execution: "" } },
      expect.any(Object)
    );
  });

  it("compares the scenario state as stored, so a state another schema wrote still matches", () => {
    const { Conversation: RealConversation } = jest.requireActual<
      typeof import("@/models/conversation")
    >("@/models/conversation");
    const castFilter = (filter: Record<string, unknown>) => {
      const query = RealConversation.findOne(filter);
      query.cast(RealConversation);
      return query.getFilter() as Record<string, unknown>;
    };
    // Written by a build whose schema had no form answers yet.
    const stored = {
      lockedScenarioId: "scenario-1",
      currentActionNodeId: "action-1",
      scenarioRevisionFingerprint: "revision-1",
      pickedOptions: null,
      startedScenarios: [],
      lastMatchedAt: new Date("2026-09-30T10:00:00.000Z"),
    };

    // A plain filter gains every schema default, so it could never match.
    const plain = castFilter({ airi_scenario_state: stored })
      .airi_scenario_state as { toObject(): Record<string, unknown> };
    expect(Object.keys(plain.toObject())).toContain("formAnswers");

    const exact = castFilter(exactStoredScenarioStateFilter(stored)).$expr as {
      $eq: [{ $literal: Record<string, unknown> }, string];
    };
    expect(exact.$eq[1]).toBe("$airi_scenario_state");
    expect(Object.keys(exact.$eq[0].$literal)).toEqual(Object.keys(stored));
    expect(exact.$eq[0].$literal).toEqual(stored);
    // No stored state keeps the plain match, as before.
    expect(exactStoredScenarioStateFilter(null)).toEqual({
      airi_scenario_state: null,
    });
  });

  it("manual handoff terminalization exact-clears without changing scenario state", async () => {
    const execution: PendingGenerativeExecution = {
      ...BASE_EXECUTION,
      phase: "delivering",
      deliveryClaim: {
        token: "delivery-token-1",
        kind: "failure_feedback",
        deliveryKey: "delivery-1",
        reservedMessageId: "507f1f77bcf86cd799439011",
        claimedAt: "2026-07-30T10:05:00.000Z",
        attemptToken: null,
        attachment: null,
      },
    };
    mockConversationFindOne.mockReturnValue(
      leanQuery({
        airi_pending_generative_execution: execution,
        airi_scenario_state: { lockedScenarioId: "scenario-1" },
      })
    );
    mockConversationFindOneAndUpdate.mockResolvedValue(
      pendingOwnerDocument(null)
    );

    await expect(
      terminalizeGenerativeDelivery({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        executionId: "execution-1",
        scenarioId: "scenario-1",
        scenarioRevisionFingerprint: "revision-1",
        actionNodeId: "action-1",
        deliveryClaimToken: "delivery-token-1",
        delivery: {
          deliveryKey: "delivery-1",
          outboundMessageId: "507f1f77bcf86cd799439011",
          outboundDate: null,
          classification: "skipped",
          skipped: true,
          skipReason: "manual_handoff_active",
        },
      })
    ).resolves.toBe(true);

    expect(mockConversationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        airi_pending_generative_execution: execution,
      }),
      { $unset: { airi_pending_generative_execution: "" } },
      expect.any(Object)
    );
  });

  it("defines the private owner and revision carrier as string-backed subdocuments", () => {
    const { Conversation } = jest.requireActual("@/models/conversation") as {
      Conversation: {
        schema: {
          path(path: string):
            | {
                instance?: string;
                schema?: { paths: Record<string, unknown> };
              }
            | undefined;
        };
      };
    };

    expect(
      Conversation.schema.path("airi_pending_generative_execution")
    ).toBeDefined();
    expect(
      Conversation.schema.path("airi_generative_starts.acceptedAt")?.instance
    ).toBe("Date");
    expect(
      Conversation.schema.path("airi_pending_generative_execution.acceptedAt")
        ?.instance
    ).toBe("String");
    expect(
      Conversation.schema.path(
        "airi_pending_generative_execution.deliveryClaim.claimedAt"
      )?.instance
    ).toBe("String");
    expect(
      Conversation.schema.path(
        "airi_scenario_state.scenarioRevisionFingerprint"
      )?.instance
    ).toBe("String");
    expect(
      Object.keys(
        Conversation.schema.path(
          "airi_pending_generative_execution.deliveryClaim"
        )?.schema?.paths || {}
      )
    ).toEqual([
      "token",
      "kind",
      "deliveryKey",
      "reservedMessageId",
      "claimedAt",
      "attemptToken",
      "attachment",
    ]);
    expect(
      Object.keys(
        Conversation.schema.path(
          "airi_pending_generative_execution.deliveryClaim.attachment"
        )?.schema?.paths || {}
      )
    ).toEqual([
      "url",
      "mediaType",
      "mimeType",
      "fileName",
      "fileSize",
      "bucket",
      "path",
    ]);
  });
});
