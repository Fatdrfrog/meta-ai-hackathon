const mockScenarioFindOneAndUpdate = jest.fn();
const mockScenarioStartSession = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockLinkedConditionUpdateOne = jest.fn();
const mockLinkedConditionModelUpdateOne = jest.fn();
const mockLoadLegacyRoutingMigrationState = jest.fn();
const mockValidateScenarioGraph = jest.fn();
const mockFindWhatsAppFlowProvisioningOperations = jest.fn();
const mockLoadCurrentWhatsAppSourceWabaBindings = jest.fn();
const mockLoadWhatsAppQrEntryPointReadiness = jest.fn();
const mockAssertTimerReplanIngressIndexes = jest.fn();
const mockEnqueueTimerReplanIngress = jest.fn();
const mockProcessTimerReplanIngressKeys = jest.fn();

jest.mock("@/models/scenario", () => ({
  Scenario: {
    collection: {
      findOneAndUpdate: (...args: unknown[]) =>
        mockScenarioFindOneAndUpdate(...args),
    },
    startSession: (...args: unknown[]) => mockScenarioStartSession(...args),
  },
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
  },
}));

jest.mock("@/models/scenario-linked-condition", () => ({
  __esModule: true,
  default: {
    updateOne: (...args: unknown[]) =>
      mockLinkedConditionModelUpdateOne(...args),
    collection: {
      updateOne: (...args: unknown[]) => mockLinkedConditionUpdateOne(...args),
    },
  },
}));

jest.mock("./legacy-routing-migration-preimage", () => {
  const actual = jest.requireActual("./legacy-routing-migration-preimage");
  return {
    ...actual,
    loadLegacyRoutingMigrationState: (...args: unknown[]) =>
      mockLoadLegacyRoutingMigrationState(...args),
  };
});

jest.mock("@/models/whatsapp-flow-provisioning-operation", () => ({
  WhatsAppFlowProvisioningOperation: {
    find: (...args: unknown[]) =>
      mockFindWhatsAppFlowProvisioningOperations(...args),
  },
}));

jest.mock("@/lib/scenarios/graph-validation", () => ({
  ...jest.requireActual("@/lib/scenarios/graph-validation"),
  validateScenarioGraph: (...args: unknown[]) =>
    mockValidateScenarioGraph(...args),
}));

jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  loadCurrentWhatsAppSourceWabaBindings: (...args: unknown[]) =>
    mockLoadCurrentWhatsAppSourceWabaBindings(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/queries", () => ({
  loadWhatsAppQrEntryPointReadinessByBindings: (...args: unknown[]) =>
    mockLoadWhatsAppQrEntryPointReadiness(...args),
}));

jest.mock("@/lib/airi/scenario/timer-recovery/ingress", () => {
  return {
    assertTimerReplanIngressIndexes: (...args: unknown[]) =>
      mockAssertTimerReplanIngressIndexes(...args),
    enqueueTimerReplanIngress: (...args: unknown[]) =>
      mockEnqueueTimerReplanIngress(...args),
    processTimerReplanIngressKeys: (...args: unknown[]) =>
      mockProcessTimerReplanIngressKeys(...args),
  };
});

import {
  LegacyRoutingConversionError,
  convertLegacyRoutingInTransaction,
  type LegacyRoutingConversionInstruction,
} from "./legacy-routing-conversion-service";
import { buildLegacyRoutingMigrationPreimage } from "./legacy-routing-migration-preimage";
import { canonicalizeLegacyInteractiveNoReplyAssignmentEdges } from "./legacy-action-routing";
import {
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  buildFlowBranchSourceHandleId,
} from "@icecore/scenario-contracts";
import mongoose, { Types } from "mongoose";

const actualValidateScenarioGraph = jest.requireActual<
  typeof import("@/lib/scenarios/graph-validation")
>("@/lib/scenarios/graph-validation").validateScenarioGraph;

const scenarioId = "65f000000000000000000001";
const scenarioObjectId = new Types.ObjectId(scenarioId);
const linkedConditionId = new Types.ObjectId("65f000000000000000000010");
const collidingLinkedConditionId = new Types.ObjectId(
  "65f000000000000000000011"
);
const workspaceId = "workspace-1";
const beforeRevision = "2026-05-04T07:26:11.684Z";
const afterRevision = "2026-05-04T07:30:00.000Z";

type TestGraph = {
  nodes: Array<{ id: string; data: Record<string, unknown> }>;
  edges: Array<Record<string, unknown>>;
};

function createDedicatedAssignment(index: number) {
  const actionNodeId = `action-${index}`;
  const conditionNodeId = `condition-${index}`;
  const targetNodeId = `target-${index}`;
  return {
    nodes: [
      {
        id: actionNodeId,
        data: { kind: "action", actionType: "reply" },
      },
      {
        id: conditionNodeId,
        data: {
          kind: "logic",
          logicType: "post_action_condition",
          postActionConditionVariant: "interactive_no_reply",
          conditionBranches: [
            {
              id: `timeout-${index}`,
              type: "no_reply_timeout",
              timeoutMinutes: 30,
            },
          ],
        },
      },
      {
        id: targetNodeId,
        data: { kind: "action", actionType: "reply" },
      },
    ],
    edges: [
      {
        id: `assignment-${index}`,
        source: actionNodeId,
        target: conditionNodeId,
        sourceHandle: "right-source-interactive-no-reply",
      },
      {
        id: `timeout-edge-${index}`,
        source: conditionNodeId,
        target: targetNodeId,
        sourceHandle: "right-source-condition-no_reply_timeout",
      },
    ],
  };
}

function createGraph(assignmentCount = 1): TestGraph {
  const assignments = Array.from({ length: assignmentCount }, (_, index) =>
    createDedicatedAssignment(index + 1)
  );
  return {
    nodes: assignments.flatMap(assignment => assignment.nodes),
    edges: assignments.flatMap(assignment => assignment.edges),
  };
}

function createScenario(params?: {
  assignmentCount?: number;
  status?: "active" | "draft";
  updatedAt?: Date;
}) {
  const graph = createGraph(params?.assignmentCount);
  return {
    _id: scenarioObjectId,
    workspaceId,
    name: "Conversation",
    mode: "conversation",
    status: params?.status || "draft",
    updatedAt: params?.updatedAt || new Date(beforeRevision),
    ...graph,
  };
}

function createActiveWhatsAppQrScenario() {
  const scenario = createScenario({ status: "active" });
  const entryPointId = "11111111-1111-4111-8111-111111111111";
  scenario.nodes = [
    {
      id: "trigger-qr",
      data: {
        kind: "trigger",
        triggerType: "incoming_customer_message",
        triggerConfig: { entryPointType: "whatsapp_qr", entryPointId },
      },
    },
    ...scenario.nodes,
  ];
  scenario.edges = [
    {
      id: "trigger-action",
      source: "trigger-qr",
      target: "action-1",
    },
    ...scenario.edges,
  ];
  return scenario;
}

function createInstruction(index = 1): LegacyRoutingConversionInstruction {
  return {
    sourceActionNodeId: `action-${index}`,
    sourceNodeId: `condition-${index}`,
    sourceKind: "post_action_condition",
  };
}

function arrangeTransaction(params?: {
  scenario?: ReturnType<typeof createScenario>;
  conversationRows?: Array<Record<string, unknown>>;
  conversationMatchedCount?: number;
  loseScenarioCas?: boolean;
  linkedConditionRows?: Array<Record<string, unknown>>;
  preimageSha256?: string;
  retryAfterFirstLoad?: boolean;
  updatedScenarioAt?: Date;
  endSessionError?: Error;
}) {
  const abortTransaction = jest.fn().mockResolvedValue(undefined);
  const session = {
    withTransaction: jest.fn(async callback => {
      try {
        if (params?.retryAfterFirstLoad) {
          try {
            await callback();
          } catch (error) {
            if ((error as { code?: unknown }).code !== "transient-test") {
              throw error;
            }
          }
        }
        return await callback();
      } catch (error) {
        await abortTransaction();
        throw error;
      }
    }),
    abortTransaction,
    endSession: params?.endSessionError
      ? jest.fn().mockRejectedValue(params.endSessionError)
      : jest.fn().mockResolvedValue(undefined),
  };
  const scenario = params?.scenario || createScenario();
  const updatedScenario = {
    ...scenario,
    updatedAt: params?.updatedScenarioAt || new Date(afterRevision),
  };
  const conversationRows = (params?.conversationRows || []).map(row => ({
    workspaceId,
    updatedAt: new Date("2026-05-04T07:10:00.000Z"),
    __v: 0,
    ...row,
    airi_scenario_state: {
      lockedScenarioId: scenarioId,
      pendingStartedAt: new Date("2026-05-04T07:05:00.000Z"),
      pendingLastOutboundMessageId: `outbound-${String(row._id)}`,
      ...((row.airi_scenario_state as Record<string, unknown> | undefined) ||
        {}),
    },
  }));
  const linkedConditionRows = params?.linkedConditionRows || [];
  const preimage = buildLegacyRoutingMigrationPreimage({
    target: {
      workspaceId,
      scenarioId,
      candidatePairs: canonicalizeLegacyInteractiveNoReplyAssignmentEdges({
        nodes: scenario.nodes,
        edges: scenario.edges,
      })
        .filter(
          edge =>
            edge.sourceHandle === ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
        )
        .map(edge => ({
          sourceActionNodeId: String(edge.source),
          sourceNodeId: String(edge.target),
        })),
    },
    scenario,
    pendingConversations: conversationRows,
    linkedConditions: linkedConditionRows,
  });
  const loadedState = {
    preimage: {
      ...preimage,
      ...(params?.preimageSha256
        ? { preimageSha256: params.preimageSha256 }
        : {}),
    },
    raw: {
      scenario,
      pendingConversations: conversationRows,
      linkedConditions: linkedConditionRows,
    },
    semantic: {
      scenario: mongoose.mongo.BSON.deserialize(
        mongoose.mongo.BSON.serialize(scenario)
      ),
    },
  };

  mockScenarioStartSession.mockResolvedValue(session);
  mockScenarioFindOneAndUpdate.mockResolvedValue(
    params?.loseScenarioCas
      ? null
      : mongoose.mongo.BSON.deserialize(
          mongoose.mongo.BSON.serialize(updatedScenario)
        )
  );
  mockConversationUpdateOne.mockResolvedValue({
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
  });
  if (
    params?.conversationMatchedCount !== undefined &&
    params.conversationMatchedCount < conversationRows.length
  ) {
    mockConversationUpdateOne.mockReset();
    for (let index = 0; index < conversationRows.length; index += 1) {
      mockConversationUpdateOne.mockResolvedValueOnce({
        acknowledged: true,
        matchedCount: index < params.conversationMatchedCount ? 1 : 0,
        modifiedCount: index < params.conversationMatchedCount ? 1 : 0,
      });
    }
  }
  mockLinkedConditionUpdateOne.mockResolvedValue({
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
  });
  mockLinkedConditionModelUpdateOne.mockResolvedValue({
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
  });
  if (params?.retryAfterFirstLoad) {
    mockLoadLegacyRoutingMigrationState
      .mockRejectedValueOnce({ code: "transient-test" })
      .mockResolvedValue(loadedState);
  } else {
    mockLoadLegacyRoutingMigrationState.mockResolvedValue(loadedState);
  }

  return {
    scenario,
    session,
    updatedScenario,
    preimage: loadedState.preimage,
  };
}

describe("convertLegacyRoutingInTransaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateScenarioGraph.mockReturnValue(null);
    mockAssertTimerReplanIngressIndexes.mockResolvedValue(undefined);
    mockEnqueueTimerReplanIngress.mockImplementation(
      async ({ conversationId }) => ({
        ingressKey: `ingress:${conversationId}`,
      })
    );
    mockProcessTimerReplanIngressKeys.mockImplementation(
      async ({ ingressKeys }: { ingressKeys: string[] }) => ({
        summary: {
          claimed: ingressKeys.length,
          signaled: ingressKeys.length,
          retryScheduled: 0,
          failed: 0,
          superseded: 0,
          leaseLost: 0,
        },
        results: ingressKeys.map(ingressKey => ({
          ingressKey,
          conversationId: ingressKey.replace(/^ingress:/, ""),
          status: "signaled",
        })),
      })
    );
    mockLoadCurrentWhatsAppSourceWabaBindings.mockResolvedValue({});
    mockLoadWhatsAppQrEntryPointReadiness.mockResolvedValue({});
    mockFindWhatsAppFlowProvisioningOperations.mockReturnValue({
      select: jest.fn(() => ({
        session: jest.fn(() => ({
          lean: jest.fn().mockResolvedValue([]),
        })),
        lean: jest.fn().mockResolvedValue([]),
      })),
    });
  });

  it.each(["draft", "active"] as const)(
    "converts an unfinished %s graph only when it remains a draft",
    async status => {
      const scenario = createScenario({ status });
      scenario.nodes.unshift({ id: "trigger-1", data: { kind: "trigger" } });
      scenario.nodes.push({
        id: "unfinished",
        data: { kind: "action", actionType: "reply", actionReplyText: "" },
      });
      scenario.edges.unshift({ source: "trigger-1", target: "action-1" });
      arrangeTransaction({ scenario });
      mockValidateScenarioGraph.mockImplementation(actualValidateScenarioGraph);

      const conversion = convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      });

      if (status === "draft") {
        await expect(conversion).resolves.toMatchObject({
          convertedConditionNodeIds: ["condition-1"],
          convertedActionNodeIds: ["action-1"],
        });
        const update = mockScenarioFindOneAndUpdate.mock.calls[0]?.[1];
        expect(update.$set.nodes).toContainEqual({
          id: "unfinished",
          data: { kind: "action", actionType: "reply", actionReplyText: "" },
        });
        expect(update.$set.nodes).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "condition-1" }),
          ])
        );
      } else {
        await expect(conversion).rejects.toMatchObject({
          code: "singleFlowRequired",
          status: 400,
        });
        expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
      }
    }
  );

  it("commits an exact revision once and returns literal conversion metadata", async () => {
    const { session } = arrangeTransaction();

    const result = await convertLegacyRoutingInTransaction({
      scenarioId,
      workspaceId,
      updatedBy: "user-1",
      expectedUpdatedAt: beforeRevision,
      conversions: [createInstruction()],
    });

    expect(result).toMatchObject({
      beforeRevision,
      afterRevision,
      convertedConditionNodeIds: ["condition-1"],
      convertedActionNodeIds: ["action-1"],
      remappedConversationIds: [],
      timerReplanResults: [],
      postCommitWarnings: [],
    });
    expect(mockScenarioFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockScenarioFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: scenarioObjectId,
        workspaceId,
        deletedAt: null,
        updatedAt: new Date(beforeRevision),
        __v: { $exists: false },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          updatedBy: "user-1",
          nodes: expect.not.arrayContaining([
            expect.objectContaining({ id: "condition-1" }),
          ]),
        }),
        $inc: { __v: 1 },
      }),
      expect.objectContaining({
        returnDocument: "after",
        includeResultMetadata: false,
        promoteValues: true,
        promoteLongs: true,
        promoteBuffers: false,
        session,
      })
    );
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it("commits a reviewed generic Flow alias as one dedicated assignment", async () => {
    const scenario = createScenario();
    scenario.nodes[0].data = {
      ...scenario.nodes[0].data,
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Choose" },
          flowConfig: {
            templateId: "flow-1",
            ctaText: "Open",
            screens: [
              {
                id: "screen-1",
                title: "Choose",
                fields: [
                  {
                    id: "plan",
                    label: "Plan",
                    fieldType: "RadioButtonsGroup",
                    options: [{ id: "one", title: "One" }],
                  },
                ],
              },
            ],
          },
        },
      },
    };
    scenario.edges[0].sourceHandle = ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID;
    scenario.edges.splice(1, 0, {
      id: "specific-flow-option",
      source: "action-1",
      target: "condition-1",
      sourceHandle: buildFlowBranchSourceHandleId("plan", "one"),
    });
    arrangeTransaction({ scenario });

    const result = await convertLegacyRoutingInTransaction({
      scenarioId,
      workspaceId,
      updatedBy: "migration:interactive-no-reply",
      expectedUpdatedAt: beforeRevision,
      expectedDedicatedAssignmentCount: 1,
      conversions: [createInstruction()],
    });

    expect(result.convertedConditionNodeIds).toEqual(["condition-1"]);
    const persistedEdges = mockScenarioFindOneAndUpdate.mock.calls[0]?.[1]?.$set
      ?.edges as Array<Record<string, unknown>>;
    expect(
      persistedEdges.some(edge => edge.id === "specific-flow-option")
    ).toBe(false);
    expect(
      persistedEdges.some(
        edge => edge.sourceHandle === ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID
      )
    ).toBe(false);
  });

  it("rejects a stale revision before any collection write", async () => {
    arrangeTransaction({
      scenario: createScenario({
        updatedAt: new Date("2026-05-04T08:00:00.000Z"),
      }),
    });

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "scenario_updated_conflict",
      status: 409,
    });

    expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  it("validates the complete active graph before persisting it", async () => {
    arrangeTransaction({ scenario: createScenario({ status: "active" }) });
    mockValidateScenarioGraph.mockReturnValue("whatsappServiceMessageInvalid");

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "whatsappServiceMessageInvalid",
      status: 400,
    });

    expect(mockValidateScenarioGraph).toHaveBeenCalledTimes(1);
    expect(mockValidateScenarioGraph).toHaveBeenCalledWith(
      expect.not.arrayContaining([
        expect.objectContaining({ id: "condition-1" }),
      ]),
      expect.any(Array),
      expect.objectContaining({ mode: "runnable" })
    );
    expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  it("keeps a ready active WhatsApp QR scenario runnable during conversion", async () => {
    arrangeTransaction({ scenario: createActiveWhatsAppQrScenario() });
    mockLoadWhatsAppQrEntryPointReadiness.mockResolvedValueOnce({
      "trigger-qr": {
        entryPointId: "11111111-1111-4111-8111-111111111111",
        ready: true,
      },
    });
    mockValidateScenarioGraph.mockImplementation(actualValidateScenarioGraph);

    const result = await convertLegacyRoutingInTransaction({
      scenarioId,
      workspaceId,
      updatedBy: "user-1",
      expectedUpdatedAt: beforeRevision,
      conversions: [createInstruction()],
    });

    expect(result.afterRevision).toBe(afterRevision);
    expect(mockScenarioFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("rejects active WhatsApp QR conversion when its entry point is not ready", async () => {
    arrangeTransaction({ scenario: createActiveWhatsAppQrScenario() });
    mockLoadWhatsAppQrEntryPointReadiness.mockResolvedValueOnce({
      "trigger-qr": {
        entryPointId: "11111111-1111-4111-8111-111111111111",
        ready: false,
      },
    });
    mockValidateScenarioGraph.mockImplementation(actualValidateScenarioGraph);

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "whatsappQrEntryPointIncomplete",
      status: 400,
    });

    expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("applies two exact conversions to one graph and persists once", async () => {
    arrangeTransaction({ scenario: createScenario({ assignmentCount: 2 }) });

    const result = await convertLegacyRoutingInTransaction({
      scenarioId,
      workspaceId,
      updatedBy: "user-1",
      expectedUpdatedAt: beforeRevision,
      expectedDedicatedAssignmentCount: 2,
      conversions: [createInstruction(1), createInstruction(2)],
    });

    expect(result.convertedConditionNodeIds).toEqual([
      "condition-1",
      "condition-2",
    ]);
    expect(result.convertedActionNodeIds).toEqual(["action-1", "action-2"]);
    expect(mockValidateScenarioGraph).toHaveBeenCalledTimes(1);
    expect(mockScenarioFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockScenarioFindOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          nodes: expect.not.arrayContaining([
            expect.objectContaining({ id: "condition-1" }),
            expect.objectContaining({ id: "condition-2" }),
          ]),
        }),
      }),
      expect.any(Object)
    );
  });

  it("hard-stops a reviewed preimage digest mismatch before any write", async () => {
    arrangeTransaction();

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "migration:interactive-no-reply",
        expectedUpdatedAt: beforeRevision,
        expectedPreimageSha256: "a".repeat(64),
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "legacy_action_routing_preimage_mismatch",
      status: 409,
    });

    expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
    expect(mockLinkedConditionUpdateOne).not.toHaveBeenCalled();
  });

  it("reloads and rechecks the canonical preimage on a transaction callback retry", async () => {
    const { preimage } = arrangeTransaction({ retryAfterFirstLoad: true });

    await convertLegacyRoutingInTransaction({
      scenarioId,
      workspaceId,
      updatedBy: "migration:interactive-no-reply",
      expectedUpdatedAt: beforeRevision,
      expectedPreimageSha256: preimage.preimageSha256,
      conversions: [createInstruction()],
    });

    expect(mockLoadLegacyRoutingMigrationState).toHaveBeenCalledTimes(2);
  });

  it("remaps only the preloaded conversation and linked rows with exact version guards", async () => {
    const parentRefs = [
      {
        parentScenarioId: scenarioId,
        conditionNodeId: "condition-1",
        branchType: "no_reply_timeout",
        sourceActionNodeId: "action-1",
        scenarioLinkNodeId: "link-1",
      },
      {
        parentScenarioId: "scenario-other",
        conditionNodeId: "condition-other",
        branchType: "user_replied",
        sourceActionNodeId: "action-other",
        scenarioLinkNodeId: "link-other",
      },
    ];
    const { session } = arrangeTransaction({
      conversationRows: [
        {
          _id: "conversation-1",
          airi_scenario_state: {
            lockedScenarioId: scenarioId,
            pendingConditionNodeId: "condition-1",
            pendingSourceActionNodeId: "action-1",
            pendingLastOutboundMessageId: "outbound-1",
            pendingStartedAt: new Date("2026-05-04T07:05:00.000Z"),
            collectedData: { nested: ["one", { two: true }] },
          },
        },
      ],
      linkedConditionRows: [
        {
          _id: linkedConditionId,
          workspaceId,
          parentRefs,
          updatedAt: new Date("2026-05-04T07:15:00.000Z"),
          __v: 8,
        },
      ],
    });

    await convertLegacyRoutingInTransaction({
      scenarioId,
      workspaceId,
      updatedBy: "migration:interactive-no-reply",
      expectedUpdatedAt: beforeRevision,
      conversions: [createInstruction()],
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      {
        _id: "conversation-1",
        workspaceId,
        updatedAt: new Date("2026-05-04T07:10:00.000Z"),
        __v: 0,
        "airi_scenario_state.lockedScenarioId": scenarioId,
        "airi_scenario_state.pendingConditionNodeId": "condition-1",
        "airi_scenario_state.pendingSourceActionNodeId": "action-1",
      },
      {
        $set: {
          "airi_scenario_state.pendingConditionNodeId":
            "__system:action-outcomes:action-1",
          updatedAt: expect.any(Date),
        },
        $unset: { "airi_scenario_state.pendingLegacyRouting": "" },
        $inc: { __v: 1 },
      },
      { session, timestamps: false }
    );
    const conversationUpdate = mockConversationUpdateOne.mock.calls[0][1];
    expect(conversationUpdate.$set).not.toHaveProperty("airi_scenario_state");
    expect(JSON.stringify(conversationUpdate)).not.toContain("collectedData");
    expect(JSON.stringify(conversationUpdate)).not.toContain(
      "pendingStartedAt"
    );
    expect(mockLinkedConditionUpdateOne).toHaveBeenCalledWith(
      {
        _id: linkedConditionId,
        workspaceId,
        updatedAt: new Date("2026-05-04T07:15:00.000Z"),
        __v: 8,
        parentRefs,
      },
      {
        $set: {
          parentRefs: [
            {
              ...parentRefs[0],
              conditionNodeId: "__system:action-outcomes:action-1",
            },
            parentRefs[1],
          ],
          updatedAt: expect.any(Date),
        },
        $inc: { __v: 1 },
      },
      { session }
    );
  });

  it("remaps only exact pending waits and preserves their timer anchors", async () => {
    const pendingStartedAt = new Date("2026-05-04T07:00:00.000Z");
    const { session } = arrangeTransaction({
      conversationRows: [
        {
          _id: "conversation-1",
          airi_scenario_state: {
            pendingConditionNodeId: "condition-1",
            pendingSourceActionNodeId: "action-1",
            pendingStartedAt,
            pendingLastOutboundMessageId: "outbound-1",
          },
        },
      ],
    });

    const result = await convertLegacyRoutingInTransaction({
      scenarioId,
      workspaceId,
      updatedBy: "user-1",
      expectedUpdatedAt: beforeRevision,
      conversions: [createInstruction()],
    });

    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "conversation-1",
        workspaceId,
        "airi_scenario_state.lockedScenarioId": scenarioId,
        "airi_scenario_state.pendingConditionNodeId": "condition-1",
        "airi_scenario_state.pendingSourceActionNodeId": "action-1",
      }),
      expect.objectContaining({
        $set: {
          "airi_scenario_state.pendingConditionNodeId":
            "__system:action-outcomes:action-1",
          updatedAt: expect.any(Date),
        },
        $unset: { "airi_scenario_state.pendingLegacyRouting": "" },
      }),
      { session, timestamps: false }
    );
    expect(result.remappedConversationIds).toEqual(["conversation-1"]);
    expect(mockEnqueueTimerReplanIngress).toHaveBeenCalledWith({
      workspaceId,
      conversationId: "conversation-1",
      expectedScenarioId: scenarioId,
      expectedConditionNodeId: "__system:action-outcomes:action-1",
      expectedSourceActionNodeId: "action-1",
      anchorId: "outbound-1",
      messageDate: pendingStartedAt,
      enqueuedAt: expect.any(Date),
      session,
    });
    expect(mockProcessTimerReplanIngressKeys).toHaveBeenCalledWith({
      ingressKeys: ["ingress:conversation-1"],
    });
    expect(result.timerReplanResults).toEqual([
      expect.objectContaining({
        conversationId: "conversation-1",
        status: "replanned",
      }),
    ]);
    expect(mockConversationUpdateOne.mock.calls[0][1]).not.toHaveProperty(
      "$set.airi_scenario_state.pendingStartedAt"
    );
    expect(mockConversationUpdateOne.mock.calls[0][1]).not.toHaveProperty(
      "$set.airi_scenario_state.pendingLastOutboundMessageId"
    );
  });

  it("aborts the transaction when a guarded pending remap loses a pre-read row", async () => {
    arrangeTransaction({
      conversationRows: [
        {
          _id: "conversation-1",
          airi_scenario_state: {
            pendingConditionNodeId: "condition-1",
            pendingSourceActionNodeId: "action-1",
          },
        },
        {
          _id: "conversation-2",
          airi_scenario_state: {
            pendingConditionNodeId: "condition-1",
            pendingSourceActionNodeId: "action-1",
          },
        },
      ],
      conversationMatchedCount: 1,
    });

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "legacy_action_routing_pending_remap_conflict",
      status: 409,
    });

    expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockProcessTimerReplanIngressKeys).not.toHaveBeenCalled();
  });

  it("hard-stops an expected dedicated-assignment count mismatch before writes", async () => {
    arrangeTransaction();

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        expectedDedicatedAssignmentCount: 2,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "legacy_action_routing_candidate_count_mismatch",
      status: 409,
    });

    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
    expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects duplicate dedicated edges when another planned conversion has no assignment", async () => {
    const scenario = createScenario({ assignmentCount: 2 });
    scenario.edges = scenario.edges.map(edge =>
      edge.id === "assignment-2"
        ? {
            ...edge,
            id: "assignment-1-duplicate",
            source: "action-1",
            target: "condition-1",
          }
        : edge
    );
    arrangeTransaction({ scenario });

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        expectedDedicatedAssignmentCount: 2,
        conversions: [createInstruction(1), createInstruction(2)],
      })
    ).rejects.toMatchObject({
      code: "legacy_action_routing_candidate_count_mismatch",
      status: 409,
    });

    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
    expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("observes the mocked transaction abort when late scenario CAS loses after session-bound remaps", async () => {
    const { session } = arrangeTransaction({
      loseScenarioCas: true,
      conversationRows: [
        {
          _id: "conversation-1",
          airi_scenario_state: {
            pendingConditionNodeId: "condition-1",
            pendingSourceActionNodeId: "action-1",
          },
        },
      ],
    });

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "scenario_updated_conflict",
      status: 409,
    });

    expect(mockLoadLegacyRoutingMigrationState).toHaveBeenCalledWith({
      workspaceId,
      scenarioId,
      candidatePairs: [
        {
          sourceActionNodeId: "action-1",
          sourceNodeId: "condition-1",
        },
      ],
      session,
    });
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      { session, timestamps: false }
    );
    expect(session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(mockProcessTimerReplanIngressKeys).not.toHaveBeenCalled();
  });

  it("hard-stops a wrong-source pending row included by condition-id discovery", async () => {
    arrangeTransaction({
      conversationRows: [
        {
          _id: "conversation-wrong-source",
          airi_scenario_state: {
            pendingConditionNodeId: "condition-1",
            pendingSourceActionNodeId: "action-wrong",
          },
        },
      ],
    });

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "migration:interactive-no-reply",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "legacy_action_routing_external_state_invalid",
      status: 409,
    });
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
    expect(mockLinkedConditionUpdateOne).not.toHaveBeenCalled();
    expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("dedupes a converted parent ref while preserving raw BSON through the native collection write", async () => {
    const forwardCompatibleDate = new Date("2026-05-04T06:00:00.000Z");
    const firstLegacyRef = {
      parentScenarioId: scenarioId,
      conditionNodeId: "condition-1",
      branchType: "no_reply_timeout",
      sourceActionNodeId: "action-1",
      scenarioLinkNodeId: "link-1",
      futureProviderState: {
        checkedAt: forwardCompatibleDate,
        int32: new mongoose.mongo.Int32(3),
        double: new mongoose.mongo.Double(3),
        long: mongoose.mongo.Long.fromNumber(3),
        expression: new mongoose.mongo.BSONRegExp("a/b", "imxs"),
      },
    };
    const alreadyCanonicalRef = {
      parentScenarioId: scenarioId,
      conditionNodeId: "__system:action-outcomes:action-1",
      branchType: "no_reply_timeout",
      sourceActionNodeId: "action-1",
      scenarioLinkNodeId: "link-1",
      futureProviderState: { shouldBeDropped: true },
    };
    arrangeTransaction({
      linkedConditionRows: [
        {
          _id: collidingLinkedConditionId,
          workspaceId,
          parentRefs: [firstLegacyRef, alreadyCanonicalRef],
          updatedAt: new Date("2026-05-04T07:15:00.000Z"),
          __v: 3,
        },
      ],
    });

    await convertLegacyRoutingInTransaction({
      scenarioId,
      workspaceId,
      updatedBy: "migration:interactive-no-reply",
      expectedUpdatedAt: beforeRevision,
      conversions: [createInstruction()],
    });

    expect(mockLinkedConditionUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockLinkedConditionModelUpdateOne).not.toHaveBeenCalled();
    const linkedUpdate = mockLinkedConditionUpdateOne.mock.calls[0][1];
    expect(linkedUpdate.$set.parentRefs).toEqual([
      {
        ...firstLegacyRef,
        conditionNodeId: "__system:action-outcomes:action-1",
      },
    ]);
    expect(linkedUpdate.$set.parentRefs[0].futureProviderState.checkedAt).toBe(
      forwardCompatibleDate
    );
    expect(linkedUpdate.$set.parentRefs[0].futureProviderState).toEqual(
      expect.objectContaining({
        int32: expect.any(mongoose.mongo.Int32),
        double: expect.any(mongoose.mongo.Double),
        long: expect.any(mongoose.mongo.Long),
        expression: expect.any(mongoose.mongo.BSONRegExp),
      })
    );
    expect(
      linkedUpdate.$set.parentRefs[0].futureProviderState.expression
    ).toMatchObject({ pattern: "a/b", options: "imsx" });
  });

  it("hard-stops a linked-condition preimage without a raw ObjectId", async () => {
    arrangeTransaction({
      linkedConditionRows: [
        {
          _id: "not-an-object-id",
          workspaceId,
          parentRefs: [
            {
              parentScenarioId: scenarioId,
              conditionNodeId: "condition-1",
              branchType: "no_reply_timeout",
              sourceActionNodeId: "action-1",
              scenarioLinkNodeId: "link-1",
            },
          ],
          updatedAt: new Date("2026-05-04T07:15:00.000Z"),
          __v: 3,
        },
      ],
    });

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "migration:interactive-no-reply",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "legacy_action_routing_preimage_invalid",
      committed: false,
    });
    expect(mockLinkedConditionUpdateOne).not.toHaveBeenCalled();
    expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("hard-stops a scenario preimage without a raw ObjectId", async () => {
    arrangeTransaction({
      scenario: {
        ...createScenario(),
        _id: "not-an-object-id",
      } as unknown as ReturnType<typeof createScenario>,
    });

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "migration:interactive-no-reply",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "legacy_action_routing_preimage_invalid",
      committed: false,
    });
    expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("converts from raw Scenario graph rows without normalizing forward-compatible Mixed fields", async () => {
    const scenario = createScenario();
    const futureDate = new Date("2026-05-04T05:00:00.000Z");
    const target = scenario.nodes.find(node => node.id === "target-1");
    if (!target) throw new Error("target fixture missing");
    target.data.futureProviderState = {
      preservedDate: futureDate,
      nested: [1, { enabled: true }],
    };
    const timeoutEdge = scenario.edges.find(
      edge => edge.id === "timeout-edge-1"
    );
    if (!timeoutEdge) throw new Error("edge fixture missing");
    timeoutEdge.futureProviderState = { preservedDate: futureDate };
    arrangeTransaction({ scenario });

    await convertLegacyRoutingInTransaction({
      scenarioId,
      workspaceId,
      updatedBy: "migration:interactive-no-reply",
      expectedUpdatedAt: beforeRevision,
      conversions: [createInstruction()],
    });

    const scenarioUpdate = mockScenarioFindOneAndUpdate.mock.calls[0][1];
    const persistedTarget = scenarioUpdate.$set.nodes.find(
      (node: { id?: unknown }) => node.id === "target-1"
    );
    const persistedEdge = scenarioUpdate.$set.edges.find(
      (edge: { id?: unknown }) => edge.id === "timeout-edge-1"
    );
    expect(persistedTarget.data.futureProviderState.preservedDate).toBe(
      futureDate
    );
    expect(persistedEdge.futureProviderState.preservedDate).toBe(futureDate);
  });

  it("writes canonical routing while preserving untouched typed BSON graph values", async () => {
    const scenario = createScenario();
    const rawVersion = new mongoose.mongo.Int32(4);
    (scenario as Record<string, unknown>).__v = rawVersion;
    const action = scenario.nodes.find(node => node.id === "action-1");
    const timeoutEdge = scenario.edges.find(
      edge => edge.id === "timeout-edge-1"
    );
    if (!action || !timeoutEdge) throw new Error("typed fixture missing");
    action.data.forwardCompatibleNumbers = {
      int32: new mongoose.mongo.Int32(1),
      double: new mongoose.mongo.Double(1),
      long: mongoose.mongo.Long.fromNumber(1),
      expression: new mongoose.mongo.BSONRegExp("node/value", "imxs"),
    };
    action.data.actionWhatsAppFutureProviderState = {
      version: new mongoose.mongo.Int32(7),
    };
    timeoutEdge.forwardCompatibleNumbers = {
      int32: new mongoose.mongo.Int32(2),
      double: new mongoose.mongo.Double(2),
      long: mongoose.mongo.Long.fromNumber(2),
      expression: new mongoose.mongo.BSONRegExp("edge/value", "sx"),
    };
    arrangeTransaction({ scenario });

    const result = await convertLegacyRoutingInTransaction({
      scenarioId,
      workspaceId,
      updatedBy: "migration:interactive-no-reply",
      expectedUpdatedAt: beforeRevision,
      conversions: [createInstruction()],
    });

    expect(mockScenarioFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockScenarioFindOneAndUpdate.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        _id: scenarioObjectId,
        updatedAt: new Date(beforeRevision),
        __v: rawVersion,
      })
    );
    const scenarioUpdate = mockScenarioFindOneAndUpdate.mock.calls[0][1];
    const persistedAction = scenarioUpdate.$set.nodes.find(
      (node: { id?: unknown }) => node.id === "action-1"
    );
    const persistedEdge = scenarioUpdate.$set.edges.find(
      (edge: { id?: unknown }) => edge.id === "timeout-edge-1"
    );
    expect(persistedAction.data.actionOutcomes).toEqual({
      version: 1,
      noReply: { enabled: true, timeoutMinutes: 30 },
    });
    expect(persistedEdge).toEqual(
      expect.objectContaining({
        source: "action-1",
        sourceHandle: "right-source-action-outcome::no-reply",
      })
    );
    expect(persistedAction.data.forwardCompatibleNumbers).toEqual({
      int32: expect.any(mongoose.mongo.Int32),
      double: expect.any(mongoose.mongo.Double),
      long: expect.any(mongoose.mongo.Long),
      expression: expect.any(mongoose.mongo.BSONRegExp),
    });
    expect(persistedAction.data.actionWhatsAppFutureProviderState).toEqual({
      version: expect.any(mongoose.mongo.Int32),
    });
    expect(persistedEdge.forwardCompatibleNumbers).toEqual({
      int32: expect.any(mongoose.mongo.Int32),
      double: expect.any(mongoose.mongo.Double),
      long: expect.any(mongoose.mongo.Long),
      expression: expect.any(mongoose.mongo.BSONRegExp),
    });
    expect(
      persistedAction.data.forwardCompatibleNumbers.expression
    ).toMatchObject({ pattern: "node/value", options: "imsx" });
    expect(persistedEdge.forwardCompatibleNumbers.expression).toMatchObject({
      pattern: "edge/value",
      options: "sx",
    });
    const returnedAction = (
      result.scenario.nodes as Array<{
        id: string;
        data: Record<string, unknown>;
      }>
    ).find(node => node.id === "action-1");
    expect(returnedAction?.data.forwardCompatibleNumbers).toEqual({
      int32: 1,
      double: 1,
      long: 1,
      expression: expect.any(RegExp),
    });
  });

  it("advances the scenario revision when the clock equals the current revision", async () => {
    jest.useFakeTimers().setSystemTime(new Date(beforeRevision));
    const nextRevision = new Date(new Date(beforeRevision).getTime() + 1);
    arrangeTransaction({ updatedScenarioAt: nextRevision });

    try {
      const result = await convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "migration:interactive-no-reply",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      });

      expect(result.afterRevision).toBe(nextRevision.toISOString());
      expect(mockScenarioFindOneAndUpdate.mock.calls[0][1]).toMatchObject({
        $set: { updatedAt: nextRevision },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("hard-stops before opening a transaction when durable ingress indexes are unavailable", async () => {
    arrangeTransaction();
    mockAssertTimerReplanIngressIndexes.mockRejectedValueOnce(
      new Error("indexes unavailable")
    );

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "legacy_action_routing_timer_ingress_unavailable",
      status: 503,
      committed: false,
    });
    expect(mockScenarioStartSession).not.toHaveBeenCalled();
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
    expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["anchor", { pendingLastOutboundMessageId: null }],
    ["timestamp", { pendingStartedAt: null }],
  ])(
    "hard-stops a pending conversation without its exact timer %s",
    async (_label, stateOverride) => {
      arrangeTransaction({
        conversationRows: [
          {
            _id: "conversation-1",
            airi_scenario_state: {
              pendingConditionNodeId: "condition-1",
              pendingSourceActionNodeId: "action-1",
              ...stateOverride,
            },
          },
        ],
      });

      await expect(
        convertLegacyRoutingInTransaction({
          scenarioId,
          workspaceId,
          updatedBy: "user-1",
          expectedUpdatedAt: beforeRevision,
          conversions: [createInstruction()],
        })
      ).rejects.toMatchObject({
        code: "legacy_action_routing_pending_timer_identity_invalid",
        status: 409,
        committed: false,
      });
      expect(mockConversationUpdateOne).not.toHaveBeenCalled();
      expect(mockEnqueueTimerReplanIngress).not.toHaveBeenCalled();
      expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  it("aborts all conversion writes when durable ingress enqueue fails", async () => {
    const { session } = arrangeTransaction({
      conversationRows: [
        {
          _id: "conversation-1",
          airi_scenario_state: {
            pendingConditionNodeId: "condition-1",
            pendingSourceActionNodeId: "action-1",
          },
        },
      ],
    });
    mockEnqueueTimerReplanIngress.mockRejectedValueOnce(
      new Error("ingress write unavailable")
    );

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "legacy_action_routing_timer_ingress_enqueue_failed",
      status: 503,
      committed: false,
      cause: expect.objectContaining({
        message: "ingress write unavailable",
      }),
    });
    expect(session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(mockScenarioFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockProcessTimerReplanIngressKeys).not.toHaveBeenCalled();
  });

  it("reports immediate durable-ingress processing failure as a committed conversion", async () => {
    arrangeTransaction({
      conversationRows: [
        {
          _id: "conversation-1",
          airi_scenario_state: {
            pendingConditionNodeId: "condition-1",
            pendingSourceActionNodeId: "action-1",
          },
        },
      ],
    });
    mockProcessTimerReplanIngressKeys.mockRejectedValueOnce(
      new Error("timer ingress processor unavailable")
    );

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "legacy_action_routing_timer_replan_failed",
      status: 500,
      committed: true,
      committedResult: {
        beforeRevision,
        afterRevision,
        remappedConversationIds: ["conversation-1"],
        postCommitWarnings: [
          {
            code: "legacy_action_routing_timer_replan_failed",
            affectedConversationIds: ["conversation-1"],
            recoveryStatus: "pending",
            retryable: false,
          },
        ],
      },
      timerReplanFailures: [
        {
          conversationId: "conversation-1",
          status: "rejected",
          reason: "timer ingress processor unavailable",
        },
      ],
    });
    expect(mockScenarioFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("reports session cleanup failure without hiding the committed conversion", async () => {
    arrangeTransaction({
      endSessionError: new Error("session cleanup unavailable"),
    });

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "legacy_action_routing_session_cleanup_failed",
      status: 500,
      committed: true,
      committedResult: {
        beforeRevision,
        afterRevision,
        convertedConditionNodeIds: ["condition-1"],
        remappedConversationIds: [],
        postCommitWarnings: [
          {
            code: "legacy_action_routing_session_cleanup_failed",
            affectedConversationIds: [],
          },
        ],
      },
    });
    expect(mockScenarioFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("treats a superseded durable ingress as successfully completed", async () => {
    arrangeTransaction({
      conversationRows: [
        {
          _id: "conversation-1",
          airi_scenario_state: {
            pendingConditionNodeId: "condition-1",
            pendingSourceActionNodeId: "action-1",
          },
        },
      ],
    });
    mockProcessTimerReplanIngressKeys.mockResolvedValueOnce({
      summary: {
        claimed: 1,
        signaled: 0,
        retryScheduled: 0,
        failed: 0,
        superseded: 1,
        leaseLost: 0,
      },
      results: [
        {
          ingressKey: "ingress:conversation-1",
          conversationId: "conversation-1",
          status: "superseded",
        },
      ],
    });

    const result = await convertLegacyRoutingInTransaction({
      scenarioId,
      workspaceId,
      updatedBy: "user-1",
      expectedUpdatedAt: beforeRevision,
      conversions: [createInstruction()],
    });

    expect(result.postCommitWarnings).toEqual([]);
    expect(result.timerReplanResults).toEqual([
      expect.objectContaining({
        conversationId: "conversation-1",
        status: "conflict",
        reason: "conversation_state_changed",
      }),
    ]);
  });

  it("marks terminal durable-ingress failure as manually retryable", async () => {
    arrangeTransaction({
      conversationRows: [
        {
          _id: "conversation-1",
          airi_scenario_state: {
            pendingConditionNodeId: "condition-1",
            pendingSourceActionNodeId: "action-1",
          },
        },
      ],
    });
    mockProcessTimerReplanIngressKeys.mockResolvedValueOnce({
      summary: {
        claimed: 1,
        signaled: 0,
        retryScheduled: 0,
        failed: 1,
        superseded: 0,
        leaseLost: 0,
      },
      results: [
        {
          ingressKey: "ingress:conversation-1",
          conversationId: "conversation-1",
          status: "failed",
        },
      ],
    });

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      committed: true,
      committedResult: {
        postCommitWarnings: [
          {
            code: "legacy_action_routing_timer_replan_failed",
            recoveryStatus: "failed",
            retryable: true,
          },
        ],
      },
    });
  });

  it("preserves timer and session-cleanup warnings when both fail after commit", async () => {
    arrangeTransaction({
      endSessionError: new Error("session cleanup unavailable"),
      conversationRows: [
        {
          _id: "conversation-1",
          airi_scenario_state: {
            pendingConditionNodeId: "condition-1",
            pendingSourceActionNodeId: "action-1",
          },
        },
      ],
    });
    mockProcessTimerReplanIngressKeys.mockResolvedValueOnce({
      summary: {
        claimed: 1,
        signaled: 0,
        retryScheduled: 1,
        failed: 0,
        superseded: 0,
        leaseLost: 0,
      },
      results: [
        {
          ingressKey: "ingress:conversation-1",
          conversationId: "conversation-1",
          status: "retry_scheduled",
        },
      ],
    });

    await expect(
      convertLegacyRoutingInTransaction({
        scenarioId,
        workspaceId,
        updatedBy: "user-1",
        expectedUpdatedAt: beforeRevision,
        conversions: [createInstruction()],
      })
    ).rejects.toMatchObject({
      code: "legacy_action_routing_timer_replan_failed",
      committed: true,
      committedResult: {
        postCommitWarnings: [
          {
            code: "legacy_action_routing_timer_replan_failed",
            affectedConversationIds: ["conversation-1"],
            recoveryStatus: "pending",
            retryable: false,
          },
          {
            code: "legacy_action_routing_session_cleanup_failed",
            affectedConversationIds: [],
          },
        ],
      },
      timerReplanFailures: [
        {
          conversationId: "conversation-1",
          status: "non_success",
          result: expect.objectContaining({
            reason: "timer_replan_ingress_retry_scheduled",
          }),
        },
      ],
      cause: expect.any(AggregateError),
    });
  });

  it("exports a typed conversion error for route-level status mapping", () => {
    const error = new LegacyRoutingConversionError("code", 409, "message");

    expect(error).toMatchObject({
      name: "LegacyRoutingConversionError",
      code: "code",
      status: 409,
      message: "message",
    });
  });
});
