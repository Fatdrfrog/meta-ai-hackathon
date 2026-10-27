const mockConnectDB = jest.fn();
const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockEnsureCompanyConversationCapacity = jest.fn();
const mockEnsureCompanyScenarioCapacity = jest.fn();
const mockBuildCompanyLimitExceededResponse = jest.fn();
const mockBuildCompanyScenarioLimitExceededResponse = jest.fn();
const mockScenarioCreate = jest.fn();
const mockScenarioInsertMany = jest.fn();
const mockScenarioFind = jest.fn();
const mockBirthdayStartSession = jest.fn();
const mockBirthdaySettingsUpdateOne = jest.fn();
const mockBirthdaySettingsCreateIndex = jest.fn();
const mockEmitWorkspaceUsageDeltaBestEffort = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockValidateScenarioGraph = jest.fn();
const mockLoadWhatsAppQrEntryPointReadiness = jest.fn();
const mockImportCustomerBirthdays = jest.fn();

jest.mock("@/lib/customers/customer-birthday-import", () => ({
  importCustomerBirthdays: (...args: unknown[]) =>
    mockImportCustomerBirthdays(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE:
    "company_conversation_limit_exceeded",
  ensureCompanyConversationCapacity: (...args: unknown[]) =>
    mockEnsureCompanyConversationCapacity(...args),
  ensureCompanyScenarioCapacity: (...args: unknown[]) =>
    mockEnsureCompanyScenarioCapacity(...args),
  buildCompanyLimitExceededResponse: (...args: unknown[]) =>
    mockBuildCompanyLimitExceededResponse(...args),
  buildCompanyScenarioLimitExceededResponse: (...args: unknown[]) =>
    mockBuildCompanyScenarioLimitExceededResponse(...args),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { client: "supabase-admin" },
}));

const mockCaptureFunnelEvent = jest.fn();
jest.mock("@/lib/funnel-analytics", () => ({
  captureFunnelEvent: (...args: unknown[]) => mockCaptureFunnelEvent(...args),
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    create: (...args: unknown[]) => mockScenarioCreate(...args),
    insertMany: (...args: unknown[]) => mockScenarioInsertMany(...args),
    find: (...args: unknown[]) => mockScenarioFind(...args),
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
  },
}));

jest.mock("@/models/workspace-airi-settings", () => ({
  __esModule: true,
  default: {
    startSession: (...args: unknown[]) => mockBirthdayStartSession(...args),
    updateOne: (...args: unknown[]) => mockBirthdaySettingsUpdateOne(...args),
    collection: {
      createIndex: (...args: unknown[]) =>
        mockBirthdaySettingsCreateIndex(...args),
    },
  },
}));

jest.mock("@/lib/limits/company-usage-events", () => ({
  emitWorkspaceUsageDeltaBestEffort: (...args: unknown[]) =>
    mockEmitWorkspaceUsageDeltaBestEffort(...args),
}));

jest.mock("@/lib/scenarios/graph-validation", () => ({
  ...jest.requireActual("@/lib/scenarios/graph-validation"),
  validateScenarioGraph: (...args: unknown[]) =>
    mockValidateScenarioGraph(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/queries", () => ({
  loadWhatsAppQrEntryPointReadiness: (...args: unknown[]) =>
    mockLoadWhatsAppQrEntryPointReadiness(...args),
}));

jest.mock("@/lib/scenarios/linked-conditions", () => ({
  LINKED_CONDITION_ERROR_CODES: {
    conflictingChildReuse: "conflicting_child_reuse",
    missingChildTrigger: "missing_child_trigger",
  },
  loadLinkedConditionParentCountByNodeId: jest.fn(async () => ({})),
  syncScenarioLinkedConditions: jest.fn(async () => undefined),
  validateConditionalScenarioLinks: jest.fn(async () => []),
}));

jest.mock("@/lib/scenarios/linked-parent-summaries", () => ({
  attachLinkedParentScenarioIds: jest.fn(async scenario => scenario),
}));

import { NextResponse } from "next/server";
import {
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
  buildFlowBranchSourceHandleId,
} from "@icecore/scenario-contracts";
import { POST } from "./route";

function createPostRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/scenarios", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/scenarios", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockImportCustomerBirthdays.mockResolvedValue({ imported: 1, updated: 0 });
    mockBirthdaySettingsCreateIndex.mockResolvedValue("workspaceId_1");
    mockBirthdaySettingsUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockBirthdayStartSession.mockResolvedValue({
      withTransaction: jest.fn(async callback => callback()),
      endSession: jest.fn().mockResolvedValue(undefined),
    });
    const birthdayQuery = {
      select: jest.fn(),
      session: jest.fn(),
      lean: jest.fn().mockResolvedValue([]),
    };
    birthdayQuery.select.mockReturnValue(birthdayQuery);
    birthdayQuery.session.mockReturnValue(birthdayQuery);
    mockScenarioFind.mockReturnValue(birthdayQuery);
    const { validateScenarioGraph } = jest.requireActual(
      "@/lib/scenarios/graph-validation"
    ) as typeof import("@/lib/scenarios/graph-validation");
    mockValidateScenarioGraph.mockImplementation(validateScenarioGraph);
    mockLoadWhatsAppQrEntryPointReadiness.mockResolvedValue({});
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      supabase: { from: jest.fn() },
    });
    mockEnsureCompanyConversationCapacity.mockResolvedValue({
      allowed: true,
      limit: {
        subscriptionType: "free",
        conversationLimit: 500,
        conversationCount: 100,
        conversationsRemaining: 400,
        exhausted: false,
        lockedCapabilities: [],
      },
    });
    mockEnsureCompanyScenarioCapacity.mockResolvedValue({
      allowed: false,
      limit: {
        subscriptionType: "free",
        scenarioLimit: 5,
        scenarioCount: 5,
        scenariosRemaining: 0,
        scenarioExhausted: true,
        lockedCapabilities: ["scenario_creation"],
      },
    });
    mockBuildCompanyLimitExceededResponse.mockReturnValue(
      NextResponse.json(
        {
          code: "company_conversation_limit_exceeded",
          error: "Company conversation limit exceeded",
        },
        { status: 402 }
      )
    );
    mockBuildCompanyScenarioLimitExceededResponse.mockReturnValue(
      NextResponse.json(
        {
          code: "company_scenario_limit_exceeded",
          error: "Company scenario limit exceeded",
        },
        { status: 402 }
      )
    );
  });

  it.each([
    { label: "null nodes", graph: { nodes: null } },
    { label: "object nodes", graph: { nodes: {} } },
    { label: "object edges", graph: { edges: {} } },
    { label: "null node", graph: { nodes: [null] } },
    { label: "missing node ID", graph: { nodes: [{ data: {} }] } },
    {
      label: "node ID with surrounding whitespace",
      graph: { nodes: [{ id: " action-1 ", data: { kind: "action" } }] },
    },
    {
      label: "edge source with surrounding whitespace",
      graph: { edges: [{ source: " action-1", target: "action-2" }] },
    },
    {
      label: "non-object node data",
      graph: { nodes: [{ id: "a", data: [] }] },
    },
    {
      label: "duplicate node IDs",
      graph: {
        nodes: [
          { id: "a", data: { kind: "action" } },
          { id: "a", data: { kind: "action" } },
        ],
      },
    },
    { label: "null edge", graph: { edges: [null] } },
    { label: "missing edge source", graph: { edges: [{ target: "a" }] } },
    {
      label: "non-string edge target",
      graph: { edges: [{ source: "a", target: 2 }] },
    },
    {
      label: "duplicate edge IDs",
      graph: {
        edges: [
          { id: "e", source: "a", target: "b" },
          { id: "e", source: "a", target: "b" },
        ],
      },
    },
    {
      label: "invalid viewport",
      graph: { viewport: { x: 0, y: 0, zoom: "1" } },
    },
  ])("rejects $label before creating a scenario", async ({ graph }) => {
    const response = await POST(
      createPostRequest({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "Malformed graph",
        status: "draft",
        nodes: [],
        edges: [],
        ...graph,
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid scenario graph payload",
      code: "scenario_graph_invalid",
    });
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockValidateScenarioGraph).not.toHaveBeenCalled();
    expect(mockScenarioCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["draft", "empty"],
    ["draft", "disconnected"],
    ["active", "empty"],
    ["active", "disconnected"],
  ])(
    "handles an unfinished %s %s graph without losing edits",
    async (status, graphKind) => {
      const nodes =
        graphKind === "empty"
          ? []
          : [
              { id: "trigger-1", data: { kind: "trigger" } },
              { id: "action-1", data: { kind: "action", actionType: "reply" } },
              {
                id: "unfinished",
                data: {
                  kind: "action",
                  actionType: "generative_ai",
                  actionGenerativeAIConfig: {
                    version: 1,
                    mode: "text_to_video",
                    prompt: "",
                  },
                },
              },
            ];
      const edges =
        graphKind === "empty"
          ? []
          : [{ source: "trigger-1", target: "action-1" }];
      mockEnsureCompanyScenarioCapacity.mockResolvedValueOnce({
        allowed: true,
      });
      mockScenarioCreate.mockImplementation(async record => ({
        toObject: () => record,
      }));
      mockScenarioFindOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });

      const response = await POST(
        createPostRequest({
          workspaceId: "11111111-1111-4111-8111-111111111111",
          name: "Unfinished graph",
          status,
          nodes,
          edges,
        })
      );

      if (status === "draft") {
        expect(response.status).toBe(201);
        expect(mockScenarioCreate.mock.calls[0]?.[0]).toMatchObject({
          status,
          nodes,
          edges,
        });
        await expect(response.json()).resolves.toMatchObject({
          scenario: { status, nodes, edges },
        });
      } else {
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          code:
            graphKind === "empty" ? "oneTriggerRequired" : "singleFlowRequired",
        });
        expect(mockScenarioCreate).not.toHaveBeenCalled();
      }
    }
  );

  it.each(["draft", "active"])(
    "validates unfinished message triggers and template selection only when created %s",
    async status => {
      for (const fixture of [
        {
          triggerConfig: { messageMatchMode: "exact", keywordPattern: "" },
          actionData: { actionType: "reply" },
          code: "messageTriggerIncomplete",
        },
        {
          triggerConfig: {
            messageMatchMode: "contains",
            keywordMatchMode: "regex",
            keywordPattern: "[",
          },
          actionData: { actionType: "reply" },
          code: "messageTriggerIncomplete",
        },
        {
          triggerConfig: { messageMatchMode: "any" },
          actionData: { actionType: "whatsapp_template" },
          code: "whatsappTemplateRequired",
        },
      ]) {
        mockScenarioCreate.mockClear();
        mockEnsureCompanyScenarioCapacity.mockResolvedValueOnce({
          allowed: true,
        });
        mockScenarioCreate.mockImplementationOnce(async record => ({
          toObject: () => record,
        }));
        const nodes = [
          {
            id: "trigger",
            data: { kind: "trigger", triggerConfig: fixture.triggerConfig },
          },
          { id: "action", data: { kind: "action", ...fixture.actionData } },
        ];
        const response = await POST(
          createPostRequest({
            workspaceId: "11111111-1111-4111-8111-111111111111",
            name: "Unfinished scenario",
            status,
            nodes,
            edges: [{ source: "trigger", target: "action" }],
          })
        );

        if (status === "draft") {
          expect(response.status).toBe(201);
          expect(mockScenarioCreate).toHaveBeenCalledTimes(1);
        } else {
          expect(response.status).toBe(400);
          await expect(response.json()).resolves.toMatchObject({
            code: fixture.code,
          });
          expect(mockScenarioCreate).not.toHaveBeenCalled();
        }
      }
    }
  );

  it.each(["draft", "active"])(
    "persists a client-message graph as conversation when created %s with a stale bulk mode",
    async status => {
      mockEnsureCompanyScenarioCapacity.mockResolvedValueOnce({
        allowed: true,
      });
      mockScenarioCreate.mockImplementationOnce(async record => ({
        toObject: () => record,
      }));
      mockScenarioFindOne.mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue(null),
      });

      const response = await POST(
        createPostRequest({
          workspaceId: "11111111-1111-4111-8111-111111111111",
          name: "Client message",
          mode: "bulk_campaign",
          status,
          nodes: [
            {
              id: "trigger-1",
              data: {
                kind: "trigger",
                triggerConfig: { enabled: true, messageMatchMode: "any" },
              },
            },
            {
              id: "action-1",
              data: {
                kind: "action",
                actionType: "reply",
                actionReplyMode: "fixed",
                actionReplyText: "Hello",
              },
            },
          ],
          edges: [{ source: "trigger-1", target: "action-1" }],
        })
      );

      expect(response.status).toBe(201);
      expect(mockScenarioCreate.mock.calls[0]?.[0]).toMatchObject({
        mode: "conversation",
        status,
      });
      await expect(response.json()).resolves.toMatchObject({
        scenario: { mode: "conversation", status },
      });
    }
  );

  it("rejects scenario names above the shared limit before writing", async () => {
    const response = await POST(
      createPostRequest({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "x".repeat(121),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "scenario_name_too_long",
      maxLength: 120,
    });
    expect(mockRequireScenarioWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockScenarioCreate).not.toHaveBeenCalled();
  });

  it("blocks new scenario creation when the company conversation limit is exhausted", async () => {
    mockEnsureCompanyConversationCapacity.mockResolvedValueOnce({
      allowed: false,
      limit: {
        subscriptionType: "free",
        conversationLimit: 500,
        conversationCount: 500,
        conversationsRemaining: 0,
        exhausted: true,
        lockedCapabilities: [
          "new_conversations",
          "scenario_creation",
          "bulk_campaigns",
        ],
      },
    });

    const response = await POST(
      new Request("http://localhost/api/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "11111111-1111-4111-8111-111111111111",
          name: "Blocked scenario",
          nodes: [],
          edges: [],
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(402);
    expect(payload.code).toBe("company_conversation_limit_exceeded");
    expect(mockEnsureCompanyConversationCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ client: "supabase-admin" }),
      "11111111-1111-4111-8111-111111111111"
    );
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockScenarioCreate).not.toHaveBeenCalled();
  });

  it("blocks new scenario creation when the free scenario limit is exhausted", async () => {
    const response = await POST(
      new Request("http://localhost/api/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "11111111-1111-4111-8111-111111111111",
          name: "Blocked scenario",
          nodes: [],
          edges: [],
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(402);
    expect(payload.code).toBe("company_scenario_limit_exceeded");
    expect(mockEnsureCompanyScenarioCapacity).toHaveBeenCalledWith(
      expect.objectContaining({ client: "supabase-admin" }),
      "11111111-1111-4111-8111-111111111111"
    );
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockScenarioCreate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unsupported action run-condition versions",
      expectedCode: "unsupported_action_run_conditions_version",
      actionData: {
        actionRunConditions: {
          version: 99,
          vendorData: { untouched: true },
        },
      },
    },
    {
      name: "reserved node IDs",
      expectedCode: "reserved_persisted_node_id",
      triggerId: "__system:trigger",
      actionData: {},
    },
  ])("rejects $name before creating an active scenario", async fixture => {
    mockEnsureCompanyScenarioCapacity.mockResolvedValueOnce({
      allowed: true,
      limit: {
        subscriptionType: "free",
        scenarioLimit: 5,
        scenarioCount: 1,
        scenariosRemaining: 4,
        scenarioExhausted: false,
        lockedCapabilities: [],
      },
    });
    const triggerId = fixture.triggerId ?? "trigger-1";

    const response = await POST(
      createPostRequest({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "Invalid routing",
        status: "active",
        nodes: [
          {
            id: triggerId,
            data: {
              kind: "trigger",
              triggerType: "incoming_customer_message",
            },
          },
          {
            id: "action-1",
            data: {
              kind: "action",
              actionType: "reply",
              ...fixture.actionData,
            },
          },
        ],
        edges: [{ source: triggerId, target: "action-1" }],
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.code).toBe(fixture.expectedCode);
    expect(mockScenarioCreate).not.toHaveBeenCalled();
  });

  it("validates the canonical trigger graph that it will persist", async () => {
    mockEnsureCompanyScenarioCapacity.mockResolvedValueOnce({
      allowed: true,
      limit: {
        subscriptionType: "free",
        scenarioLimit: 5,
        scenarioCount: 1,
        scenariosRemaining: 4,
        scenarioExhausted: false,
        lockedCapabilities: [],
      },
    });
    mockValidateScenarioGraph.mockImplementationOnce(nodes => {
      const trigger = nodes[0]?.data;
      return trigger &&
        !Object.prototype.hasOwnProperty.call(trigger, "triggerType") &&
        trigger.triggerConfig?.enabled === false
        ? "reserved_persisted_node_id"
        : null;
    });

    const response = await POST(
      createPostRequest({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "Canonical validation",
        nodes: [
          {
            id: "trigger-1",
            data: {
              kind: "trigger",
              triggerType: "future_unknown_trigger",
              triggerConfig: { enabled: true },
            },
          },
          {
            id: "action-1",
            data: { kind: "action", actionType: "reply" },
          },
        ],
        edges: [{ source: "trigger-1", target: "action-1" }],
      })
    );

    expect(response.status).toBe(400);
    expect(mockValidateScenarioGraph).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: "trigger-1",
          data: expect.objectContaining({
            triggerConfig: expect.objectContaining({ enabled: false }),
          }),
        }),
        expect.objectContaining({ id: "action-1" }),
      ],
      [{ source: "trigger-1", target: "action-1" }],
      { mode: "draft" }
    );
    expect(
      mockValidateScenarioGraph.mock.calls[0]?.[0]?.[0]?.data
    ).not.toHaveProperty("triggerType");
    expect(mockScenarioCreate).not.toHaveBeenCalled();
  });

  it("rejects newly authored legacy no-reply assignments", async () => {
    mockEnsureCompanyScenarioCapacity.mockResolvedValueOnce({
      allowed: true,
      limit: {
        subscriptionType: "free",
        scenarioLimit: 5,
        scenarioCount: 1,
        scenariosRemaining: 4,
        scenarioExhausted: false,
        lockedCapabilities: [],
      },
    });

    const response = await POST(
      createPostRequest({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "Legacy assignment",
        nodes: [],
        edges: [
          {
            source: "action-1",
            target: "condition-1",
            sourceHandle: "right-source-interactive-no-reply",
          },
        ],
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Legacy no-reply assignments can no longer be created",
      code: "legacy_action_routing_new_assignment_forbidden",
    });
    expect(mockValidateScenarioGraph).not.toHaveBeenCalled();
    expect(mockScenarioCreate).not.toHaveBeenCalled();
  });

  it("rejects a newly authored generic Flow no-reply alias", async () => {
    mockEnsureCompanyScenarioCapacity.mockResolvedValueOnce({
      allowed: true,
      limit: {
        subscriptionType: "free",
        scenarioLimit: 5,
        scenarioCount: 1,
        scenariosRemaining: 4,
        scenarioExhausted: false,
        lockedCapabilities: [],
      },
    });

    const response = await POST(
      createPostRequest({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "Legacy Flow alias",
        nodes: [
          {
            id: "flow-action",
            data: {
              kind: "action",
              actionType: "reply",
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
            },
          },
          {
            id: "condition-1",
            data: {
              kind: "logic",
              logicType: "post_action_condition",
            },
          },
        ],
        edges: [
          {
            id: "legacy-flow-alias",
            source: "flow-action",
            target: "condition-1",
            sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
          },
          {
            id: "specific-flow-option",
            source: "flow-action",
            target: "condition-1",
            sourceHandle: buildFlowBranchSourceHandleId("plan", "one"),
          },
        ],
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Legacy no-reply assignments can no longer be created",
      code: "legacy_action_routing_new_assignment_forbidden",
    });
    expect(mockValidateScenarioGraph).not.toHaveBeenCalled();
    expect(mockScenarioCreate).not.toHaveBeenCalled();
  });

  it("writes the default entry policy and ignores retired request fields", async () => {
    mockEnsureCompanyScenarioCapacity.mockResolvedValueOnce({
      allowed: true,
      limit: {
        subscriptionType: "free",
        scenarioLimit: 5,
        scenarioCount: 1,
        scenariosRemaining: 4,
        scenarioExhausted: false,
        lockedCapabilities: [],
      },
    });
    const createdRecord = {
      _id: "65f000000000000000000001",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      name: "Canonical policy",
      description: "",
      status: "draft",
      mode: "conversation",
      timezone: "UTC",
      priority: 0,
      matchingRole: "default",
      entryPolicy: "once_per_conversation",
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: new Date("2026-07-30T00:00:00.000Z"),
      updatedAt: new Date("2026-07-30T00:00:00.000Z"),
    };
    mockScenarioCreate.mockResolvedValue({
      toObject: () => createdRecord,
    });
    mockScenarioFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue(createdRecord),
    });

    const response = await POST(
      createPostRequest({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "Canonical policy",
        loopScenario: true,
        journeyPoolKey: "retired",
        nodes: [
          {
            id: "trigger-1",
            data: {
              kind: "trigger",
              triggerConfig: {
                enabled: true,
                messageMatchMode: "any",
              },
            },
          },
          {
            id: "action-1",
            data: {
              kind: "action",
              actionType: "reply",
              actionReplyMode: "fixed",
              actionReplyText: "Hello",
            },
          },
        ],
        edges: [{ source: "trigger-1", target: "action-1" }],
      })
    );

    expect(response.status).toBe(201);
    const write = mockScenarioCreate.mock.calls[0]?.[0];
    expect(write).toEqual(
      expect.objectContaining({
        entryPolicy: "once_per_conversation",
      })
    );
    expect(write).not.toHaveProperty("loopScenario");
    expect(write).not.toHaveProperty("journeyPoolKey");
    const payload = await response.json();
    expect(payload.scenario.entryPolicy).toBe("once_per_conversation");
    expect(payload.scenario).not.toHaveProperty("loopScenario");
    expect(payload.scenario).not.toHaveProperty("journeyPoolKey");
    expect(payload.metadata).toEqual({
      linkedConditionParentCountByNodeId: {},
    });
    expect(mockCaptureFunnelEvent).toHaveBeenCalledWith({
      event: "scenario_created",
      userId: expect.any(String),
      workspaceId: "11111111-1111-4111-8111-111111111111",
      properties: {
        origin: "builder",
        status: "draft",
        has_bulk_root: false,
        node_count: 2,
      },
    });
  });

  it("strips browser-owned Flow provider bindings before creating a scenario", async () => {
    mockEnsureCompanyScenarioCapacity.mockResolvedValueOnce({
      allowed: true,
      limit: {
        subscriptionType: "free",
        scenarioLimit: 5,
        scenarioCount: 1,
        scenariosRemaining: 4,
        scenarioExhausted: false,
        lockedCapabilities: [],
      },
    });
    mockValidateScenarioGraph.mockReturnValueOnce(null);
    const createdRecord = {
      _id: "65f000000000000000000001",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      name: "Untrusted provider fields",
      status: "draft",
      mode: "conversation",
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    mockScenarioCreate.mockResolvedValue({
      toObject: () => createdRecord,
    });
    mockScenarioFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue(createdRecord),
    });

    const forgedProviderFields = {
      managedProvisioning: {
        operationId: "attacker-operation",
        sourceId: "attacker-source",
        contentRevision: 1,
        contentDigest: "a".repeat(64),
        flowId: "attacker-managed-flow",
        providerStatus: "PUBLISHED",
      },
      metaFlowId: "attacker-legacy-flow",
      metaFlowName: "Attacker",
      metaFlowStatus: "PUBLISHED",
    };
    const response = await POST(
      createPostRequest({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "Untrusted provider fields",
        nodes: [
          {
            id: "flat-action",
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              actionFlowConfig: {
                templateId: "flat-flow",
                ctaText: "Open",
                screens: [],
                ...forgedProviderFields,
              },
            },
          },
          {
            id: "nested-action",
            data: {
              kind: "action",
              actionType: "reply",
              actionWhatsAppServiceMessage: {
                version: 1,
                message: {
                  kind: "flow",
                  body: { mode: "fixed", text: "Open" },
                  flowConfig: {
                    templateId: "nested-flow",
                    ctaText: "Continue",
                    screens: [],
                    ...forgedProviderFields,
                  },
                },
              },
            },
          },
        ],
        edges: [],
      })
    );

    expect(response.status).toBe(201);
    const write = mockScenarioCreate.mock.calls[0]?.[0] as {
      nodes: Array<{ data: Record<string, unknown> }>;
    };
    const flatConfig = write.nodes[0]?.data.actionFlowConfig as Record<
      string,
      unknown
    >;
    const nestedConfig = (
      write.nodes[1]?.data.actionWhatsAppServiceMessage as {
        message: { flowConfig: Record<string, unknown> };
      }
    ).message.flowConfig;
    for (const config of [flatConfig, nestedConfig]) {
      expect(config).not.toHaveProperty("managedProvisioning");
      expect(config).not.toHaveProperty("metaFlowId");
      expect(config).not.toHaveProperty("metaFlowName");
      expect(config).not.toHaveProperty("metaFlowStatus");
    }
  });

  it("defers active WhatsApp QR creation to a draft until its placement is provisioned", async () => {
    mockEnsureCompanyScenarioCapacity.mockResolvedValueOnce({
      allowed: true,
      limit: {
        subscriptionType: "free",
        scenarioLimit: 5,
        scenarioCount: 1,
        scenariosRemaining: 4,
        scenarioExhausted: false,
        lockedCapabilities: [],
      },
    });
    const createdRecord = {
      _id: "65f000000000000000000001",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      name: "QR door",
      description: "",
      status: "draft",
      mode: "conversation",
      timezone: "UTC",
      priority: 0,
      matchingRole: "default",
      entryPolicy: "once_per_conversation",
      nodes: [
        {
          id: "trigger-qr",
          data: {
            kind: "trigger",
            triggerConfig: {
              enabled: true,
              entryPointType: "whatsapp_qr",
            },
          },
        },
        {
          id: "action-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Hello",
          },
        },
      ],
      edges: [{ source: "trigger-qr", target: "action-1" }],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: new Date("2026-08-07T00:00:00.000Z"),
      updatedAt: new Date("2026-08-07T00:00:00.000Z"),
    };
    mockScenarioCreate.mockResolvedValue({
      toObject: () => createdRecord,
    });
    mockScenarioFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue(createdRecord),
    });

    const response = await POST(
      createPostRequest({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "QR door",
        status: "active",
        nodes: createdRecord.nodes,
        edges: createdRecord.edges,
      })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      scenario: { status: "draft" },
    });
    expect(mockScenarioCreate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "draft" })
    );
    expect(mockValidateScenarioGraph).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      { mode: "draft" }
    );
    expect(mockLoadWhatsAppQrEntryPointReadiness).not.toHaveBeenCalled();
  });

  it.each([
    [
      "defers an active builder WhatsApp birthday creation to a draft so saving arms it",
      undefined,
      "whatsapp",
      "conversation",
      "draft",
    ],
    [
      "defers an active builder Telegram birthday creation to a draft so saving arms it",
      undefined,
      "telegram",
      "conversation",
      "draft",
    ],
    [
      "keeps an active legacy bulk_campaign birthday creation active",
      "bulk_campaign",
      "whatsapp",
      "bulk_campaign",
      "active",
    ],
  ] as const)(
    "%s",
    async (_label, requestedMode, channel, storedMode, storedStatus) => {
      mockEnsureCompanyScenarioCapacity.mockResolvedValueOnce({
        allowed: true,
        limit: {
          subscriptionType: "free",
          scenarioLimit: 5,
          scenarioCount: 1,
          scenariosRemaining: 4,
          scenarioExhausted: false,
          lockedCapabilities: [],
        },
      });
      const nodes = [
        {
          id: "bulk-root",
          data: {
            kind: "bulk",
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              channels: [channel],
              recipientAudienceSource: "customer_birthdays",
              ...(requestedMode !== "bulk_campaign"
                ? {
                    uploadedRecipients: [
                      {
                        phone: "+77011234567",
                        chatId: "123",
                        birthday: "01-01",
                      },
                    ],
                  }
                : {}),
              ...(channel === "telegram"
                ? { telegramSubscriberSourceId: "telegram-source-1" }
                : {}),
              scheduleConfig: {
                version: 2,
                mode: "recurring",
                timezone: "UTC",
                recurrence: { kind: "daily", time: "09:00" },
              },
            },
          },
        },
        channel === "telegram"
          ? {
              id: "birthday-message",
              data: {
                kind: "action",
                actionType: "reply",
                actionReplyChannel: "telegram",
                actionReplyMode: "fixed",
                actionReplyText: "Happy birthday!",
              },
            }
          : {
              id: "birthday-message",
              data: {
                kind: "action",
                actionType: "whatsapp_template",
                actionWhatsAppTemplateName: "birthday_greeting",
                actionWhatsAppTemplateLanguage: "en",
              },
            },
      ];
      const edges = [
        {
          id: "bulk-root-birthday-message",
          source: "bulk-root",
          sourceHandle: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
          target: "birthday-message",
        },
      ];
      const createdRecord = {
        _id: "65f000000000000000000001",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "Birthdays",
        description: "",
        status: storedStatus,
        mode: storedMode,
        timezone: "UTC",
        priority: 0,
        matchingRole: "default",
        entryPolicy: "once_per_conversation",
        nodes,
        edges,
        viewport: { x: 0, y: 0, zoom: 1 },
        createdAt: new Date("2026-08-07T00:00:00.000Z"),
        updatedAt: new Date("2026-08-07T00:00:00.000Z"),
      };
      mockScenarioCreate.mockResolvedValue({
        toObject: () => createdRecord,
      });
      mockScenarioInsertMany.mockResolvedValue([
        { toObject: () => createdRecord },
      ]);
      mockScenarioFindOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(createdRecord),
      });

      const response = await POST(
        createPostRequest({
          workspaceId: "11111111-1111-4111-8111-111111111111",
          name: "Birthdays",
          status: "active",
          ...(requestedMode ? { mode: requestedMode } : {}),
          nodes,
          edges,
        })
      );

      expect(response.status).toBe(201);
      if (storedMode === "bulk_campaign") {
        expect(mockScenarioInsertMany).toHaveBeenCalledWith(
          [expect.objectContaining({ status: storedStatus, mode: storedMode })],
          expect.objectContaining({ session: expect.anything(), ordered: true })
        );
        expect(mockEmitWorkspaceUsageDeltaBestEffort).toHaveBeenCalledTimes(1);
      } else {
        expect(mockScenarioCreate).toHaveBeenCalledWith(
          expect.objectContaining({ status: storedStatus, mode: storedMode })
        );
      }
      expect(mockValidateScenarioGraph).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Array),
        {
          mode: storedStatus === "active" ? "runnable" : "draft",
          ...(storedMode === "bulk_campaign"
            ? { scenarioMode: "bulk_campaign" }
            : {}),
        }
      );
    }
  );

  it.each(["import failure", "zero saved rows", "empty selected audience"])(
    "rejects requested-active birthday creation on %s and permits a successful retry",
    async failure => {
      mockEnsureCompanyScenarioCapacity.mockResolvedValue({
        allowed: true,
        limit: {},
      });
      const recipients = [{ chatId: "123", birthday: "01-01" }];
      const nodes = [
        {
          id: "birthday-root",
          data: {
            kind: "bulk",
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              channels: ["telegram"],
              telegramSubscriberSourceId: "telegram-source-1",
              recipientAudienceSource: "customer_birthdays",
              uploadedRecipients: recipients,
              scheduleConfig: {
                version: 2,
                mode: "recurring",
                timezone: "UTC",
                recurrence: { kind: "daily", time: "09:00" },
              },
            },
          },
        },
        {
          id: "birthday-message",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "telegram",
            actionReplyMode: "fixed",
            actionReplyText: "Happy birthday!",
          },
        },
      ];
      const edges = [
        {
          source: "birthday-root",
          sourceHandle: "right-source",
          target: "birthday-message",
        },
      ];
      const body = {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "Birthdays",
        status: "active",
        nodes,
        edges,
      };
      const createdRecord = {
        ...body,
        _id: "65f000000000000000000001",
        status: "draft",
        mode: "conversation",
      };
      mockScenarioCreate.mockResolvedValue({ toObject: () => createdRecord });
      mockScenarioFindOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(createdRecord),
      });
      if (failure === "import failure") {
        mockImportCustomerBirthdays.mockRejectedValueOnce(
          new Error("birthday import unavailable")
        );
      } else if (failure === "zero saved rows") {
        mockImportCustomerBirthdays.mockResolvedValueOnce({
          imported: 0,
          updated: 0,
        });
      } else {
        nodes[0]!.data.bulkRootConfig!.uploadedRecipients = [];
      }
      const response = await POST(createPostRequest(body));
      expect(response.status).toBe(failure === "import failure" ? 500 : 400);
      expect(mockScenarioCreate).not.toHaveBeenCalled();
      if (failure !== "import failure") {
        await expect(response.json()).resolves.toMatchObject({
          code: "birthdayRecipientsRequired",
        });
      }
      nodes[0]!.data.bulkRootConfig!.uploadedRecipients = recipients;
      const retry = await POST(createPostRequest(body));
      expect(retry.status).toBe(201);
      expect(mockScenarioCreate).toHaveBeenCalledWith(
        expect.objectContaining({ status: "draft" })
      );
    }
  );

  it.each(["success", "retry", "aborted", "conflict"])(
    "creates active legacy birthdays transactionally and emits usage only after %s",
    async outcome => {
      mockEnsureCompanyScenarioCapacity.mockResolvedValue({
        allowed: true,
        limit: {},
      });
      mockValidateScenarioGraph.mockReturnValue(null);
      const nodes = [
        {
          id: "birthday-root",
          data: {
            kind: "bulk",
            bulkRootConfig: {
              workflowKind: "bulk_campaign",
              channels: ["whatsapp"],
              recipientAudienceSource: "customer_birthdays",
              scheduleConfig: {
                version: 2,
                mode: "recurring",
                timezone: "UTC",
                recurrence: { kind: "daily", time: "09:00" },
              },
            },
          },
        },
        {
          id: "birthday-message",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "birthday_greeting",
            actionWhatsAppTemplateLanguage: "en",
          },
        },
      ];
      const edges = [
        {
          source: "birthday-root",
          sourceHandle: "right-source",
          target: "birthday-message",
        },
      ];
      const body = {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "Birthdays",
        status: "active",
        mode: "bulk_campaign",
        nodes,
        edges,
      };
      mockScenarioInsertMany.mockImplementation(async docs =>
        docs.map((doc: Record<string, unknown>) => ({ toObject: () => doc }))
      );
      mockScenarioFindOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });
      const session = {
        withTransaction: jest.fn(async callback => {
          const first = await callback();
          if (outcome === "retry") return callback();
          if (outcome === "aborted") throw new Error("transaction aborted");
          return first;
        }),
        endSession: jest.fn().mockResolvedValue(undefined),
      };
      mockBirthdayStartSession.mockResolvedValueOnce(session);
      if (outcome === "conflict") {
        const query = {
          select: jest.fn(),
          session: jest.fn(),
          lean: jest.fn().mockResolvedValue([{ ...body, _id: "other" }]),
        };
        query.select.mockReturnValue(query);
        query.session.mockReturnValue(query);
        mockScenarioFind.mockReturnValue(query);
      }
      const response = await POST(createPostRequest(body));
      expect(response.status).toBe(
        outcome === "aborted" ? 500 : outcome === "conflict" ? 409 : 201
      );
      expect(mockScenarioCreate).not.toHaveBeenCalled();
      if (outcome === "aborted" || outcome === "conflict") {
        expect(mockEmitWorkspaceUsageDeltaBestEffort).not.toHaveBeenCalled();
      } else {
        expect(mockEmitWorkspaceUsageDeltaBestEffort).toHaveBeenCalledTimes(1);
        const insertedId =
          mockScenarioInsertMany.mock.calls[0]![0][0]._id.toString();
        expect(mockEmitWorkspaceUsageDeltaBestEffort).toHaveBeenCalledWith(
          expect.objectContaining({
            objectId: insertedId,
            metric: "scenario_count",
            delta: 1,
            source: "scenario_model",
          }),
          { logContext: "Scenario.postSave" }
        );
        if (outcome === "retry") {
          expect(mockScenarioInsertMany).toHaveBeenCalledTimes(2);
          expect(
            mockScenarioInsertMany.mock.calls[1]![0][0]._id.toString()
          ).toBe(insertedId);
        }
      }
    }
  );

  it("rejects active Flow creation after stripping forged legacy provider bindings", async () => {
    mockEnsureCompanyScenarioCapacity.mockResolvedValueOnce({
      allowed: true,
      limit: {
        subscriptionType: "free",
        scenarioLimit: 5,
        scenarioCount: 1,
        scenariosRemaining: 4,
        scenarioExhausted: false,
        lockedCapabilities: [],
      },
    });
    const forgedLegacyProviderFields = {
      metaFlowId: "attacker-legacy-flow",
      metaFlowName: "Attacker",
      metaFlowStatus: "PUBLISHED",
    };
    const editableFlow = {
      ctaText: "Open",
      flowNavigationMode: "data_endpoint",
      screens: [
        { id: "DETAILS", title: "Details", fields: [] },
        { id: "CONFIRM", title: "Confirm", fields: [] },
      ],
      screenRoutes: { DETAILS: ["CONFIRM"], CONFIRM: [] },
    };

    const response = await POST(
      createPostRequest({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "Forged active Flow",
        status: "active",
        nodes: [
          {
            id: "trigger-1",
            data: {
              kind: "trigger",
              triggerType: "incoming_customer_message",
            },
          },
          {
            id: "flat-action",
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              actionWhatsAppTemplateName: "approved_template",
              actionFlowConfig: {
                ...editableFlow,
                templateId: "flat-flow",
                ...forgedLegacyProviderFields,
              },
            },
          },
          {
            id: "nested-action",
            data: {
              kind: "action",
              actionType: "reply",
              actionWhatsAppServiceMessage: {
                version: 1,
                message: {
                  kind: "flow",
                  body: { mode: "fixed", text: "Open" },
                  flowConfig: {
                    ...editableFlow,
                    templateId: "nested-flow",
                    ...forgedLegacyProviderFields,
                  },
                },
              },
            },
          },
        ],
        edges: [
          { source: "trigger-1", target: "flat-action" },
          { source: "flat-action", target: "nested-action" },
        ],
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "whatsappServiceMessageInvalid",
    });
    expect(mockScenarioCreate).not.toHaveBeenCalled();
  });
});
