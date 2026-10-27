const mockConnectDB = jest.fn();
const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockNormalizeScenarioNodesForPersistence = jest.fn();
const mockSerializeScenario = jest.fn();
const mockValidateScenarioGraph = jest.fn();
const mockBuildScenarioGeneratorGraph = jest.fn();
const mockScenarioCreate = jest.fn();
const mockScenarioStartSession = jest.fn();
const mockSessionWithTransaction = jest.fn();
const mockSessionEndSession = jest.fn();
const mockConversationFind = jest.fn();
const mockConversationSelect = jest.fn();
const mockJobCreate = jest.fn();
const mockJobFindByIdAndUpdate = jest.fn();
const mockMediaInsertMany = jest.fn();
const mockRecipientMessageInsertMany = jest.fn();
const mockIsVertexVideoConfigured = jest.fn();
const mockStartVertexVideoGeneration = jest.fn();
const mockChatCompletionWithFallback = jest.fn();
const mockEnsureCompanyConversationCapacity = jest.fn();
const mockEnsureCompanyScenarioCapacity = jest.fn();
const mockEnsureCompanyStudioChatCapacity = jest.fn();
const mockRecordCreativeStudioChat = jest.fn();
const mockEnsureScenarioGeneratedRecipientMessageIndexes = jest.fn();
const mockMongoSession = {
  withTransaction: (...args: unknown[]) => mockSessionWithTransaction(...args),
  endSession: (...args: unknown[]) => mockSessionEndSession(...args),
};

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

const mockCaptureFunnelEvent = jest.fn();
jest.mock("@/lib/funnel-analytics", () => ({
  captureFunnelEvent: (...args: unknown[]) => mockCaptureFunnelEvent(...args),
}));

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/lib/scenarios/scenario-graph-persistence", () => ({
  ...jest.requireActual("@/lib/scenarios/scenario-graph-persistence"),
  normalizeScenarioNodesForPersistence: (...args: unknown[]) =>
    mockNormalizeScenarioNodesForPersistence(...args),
}));

jest.mock("@/lib/scenarios/scenario-serialization", () => ({
  ...jest.requireActual("@/lib/scenarios/scenario-serialization"),
  serializeScenario: (...args: unknown[]) => mockSerializeScenario(...args),
}));

jest.mock("@/lib/scenarios/graph-validation", () => ({
  validateScenarioGraph: (...args: unknown[]) =>
    mockValidateScenarioGraph(...args),
}));

jest.mock("@/lib/scenario-generator/graph-builder", () => ({
  buildScenarioGeneratorGraph: (...args: unknown[]) =>
    mockBuildScenarioGeneratorGraph(...args),
}));

jest.mock("@/lib/ai/vertex-video", () => ({
  isVertexVideoConfigured: (...args: unknown[]) =>
    mockIsVertexVideoConfigured(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanyConversationCapacity: (...args: unknown[]) =>
    mockEnsureCompanyConversationCapacity(...args),
  ensureCompanyScenarioCapacity: (...args: unknown[]) =>
    mockEnsureCompanyScenarioCapacity(...args),
  ensureCompanyStudioChatCapacity: (...args: unknown[]) =>
    mockEnsureCompanyStudioChatCapacity(...args),
  recordCreativeStudioChat: (...args: unknown[]) =>
    mockRecordCreativeStudioChat(...args),
  buildCompanyLimitExceededResponse: (limit: unknown) =>
    Response.json(
      { code: "company_conversation_limit_exceeded", error: "locked", limit },
      { status: 402 }
    ),
  buildCompanyScenarioLimitExceededResponse: (limit: unknown) =>
    Response.json(
      { code: "company_scenario_limit_exceeded", error: "locked", limit },
      { status: 402 }
    ),
  buildCompanyStudioChatLimitExceededResponse: (limit: unknown) =>
    Response.json(
      { code: "company_studio_chat_limit_exceeded", error: "locked", limit },
      { status: 402 }
    ),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { client: "supabase-admin" },
}));

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletionWithFallback(...args),
  getReasoningTextModel: () => "reasoning-text-model",
}));

jest.mock("@/lib/scenario-generator/generated-send-command", () => ({
  ensureScenarioGeneratedRecipientMessageIndexes: (...args: unknown[]) =>
    mockEnsureScenarioGeneratedRecipientMessageIndexes(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    create: (...args: unknown[]) => mockScenarioCreate(...args),
    startSession: (...args: unknown[]) => mockScenarioStartSession(...args),
  },
}));

jest.mock("@/models/scenario-generated-media-asset", () => ({
  ScenarioGeneratedMediaAsset: {
    insertMany: (...args: unknown[]) => mockMediaInsertMany(...args),
  },
}));

jest.mock("@/models/scenario-generated-recipient-message", () => ({
  ScenarioGeneratedRecipientMessage: {
    insertMany: (...args: unknown[]) => mockRecipientMessageInsertMany(...args),
  },
}));

jest.mock("@/models/scenario-generation-job", () => ({
  ScenarioGenerationJob: {
    create: (...args: unknown[]) => mockJobCreate(...args),
    findByIdAndUpdate: (...args: unknown[]) =>
      mockJobFindByIdAndUpdate(...args),
  },
}));

import { CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS } from "@icecore/shared/lib/conversation-classification-freshness";
import { ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID } from "@icecore/scenario-contracts";

import { maxDuration, POST } from "./route";

function createRequest(body: Record<string, unknown>) {
  return new Request(
    "http://localhost/api/workspaces/workspace-1/scenario-generator/create",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function createBulkGraph({
  channels = ["whatsapp"],
  campaignName = "VIP Reactivation",
  recipientSourceSummary = "CSV upload",
}: {
  channels?: string[];
  campaignName?: string;
  recipientSourceSummary?: string;
} = {}) {
  return {
    nodes: [
      {
        id: "node-bulk-root",
        type: "bulkNode",
        position: { x: 0, y: 0 },
        data: {
          kind: "bulk",
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels,
            campaignName,
            recipientSourceSummary,
            generationStatus: "queued",
          },
        },
      },
      {
        id: "action-generated-audience",
        type: "actionNode",
        position: { x: 240, y: 0 },
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyText: "Generated message",
          bulkRecipientBranchId: "generated-audience",
        },
      },
    ],
    edges: [],
  };
}

function createScenarioDocument() {
  return {
    toObject: () => ({
      _id: "scenario-1",
      workspaceId: "workspace-1",
      name: "VIP Reactivation",
      description: "Generate a VIP reactivation campaign",
      nodes: [],
      edges: [],
    }),
  };
}

function getScenarioCreateInput() {
  const input = mockScenarioCreate.mock.calls[0]?.[0];
  return Array.isArray(input) ? input[0] : input;
}

function mockConversationRows(rows: unknown[]) {
  const query = {
    sort: jest.fn(),
    limit: jest.fn(),
    select: jest.fn(),
    lean: jest.fn(),
  };
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.select.mockImplementation((fields: string) => {
    mockConversationSelect(fields);
    return query;
  });
  query.lean.mockResolvedValue(rows);
  mockConversationFind.mockReturnValue(query);
}

function currentClassificationProjection(
  classification: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  return {
    classification,
    is_classified: true,
    classification_revision: 11,
    classification_state: {
      contractVersion: 2,
      status: "ready",
      requestedRevision: 11,
      appliedRevision: 11,
    },
    classification_meta: {
      source_revision: 11,
      provenance_kind: "v2",
      analysis_revision_id: "analysis-current",
    },
    ...overrides,
  };
}

function expectConversationSelectContainsCanonicalFreshness() {
  const selected = String(mockConversationSelect.mock.calls[0]?.[0] || "")
    .split(/\s+/u)
    .filter(Boolean);
  for (const path of CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT_PATHS) {
    expect(selected.filter(value => value === path)).toHaveLength(1);
  }
}

describe("POST /api/workspaces/[workspaceId]/scenario-generator/create", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      supabase: {},
    });
    mockEnsureCompanyConversationCapacity.mockResolvedValue({
      allowed: true,
      limit: {},
    });
    mockEnsureCompanyScenarioCapacity.mockResolvedValue({
      allowed: true,
      limit: {},
    });
    mockEnsureCompanyStudioChatCapacity.mockResolvedValue({
      allowed: true,
      limit: {},
    });
    mockRecordCreativeStudioChat.mockResolvedValue(undefined);
    mockEnsureScenarioGeneratedRecipientMessageIndexes.mockResolvedValue(
      undefined
    );
    mockBuildScenarioGeneratorGraph.mockReturnValue({
      nodes: [
        {
          id: "trigger-1",
          type: "scenarioNode",
          position: { x: 0, y: 0 },
          data: { kind: "trigger" },
        },
        {
          id: "action-1",
          type: "scenarioNode",
          position: { x: 240, y: 0 },
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyText: "Generated message",
          },
        },
      ],
      edges: [],
    });
    mockNormalizeScenarioNodesForPersistence.mockImplementation(
      (nodes: unknown) => nodes
    );
    mockValidateScenarioGraph.mockReturnValue(null);
    mockJobCreate.mockResolvedValue({ _id: "job-1" });
    mockConversationRows([]);
    mockIsVertexVideoConfigured.mockReturnValue(false);
    mockStartVertexVideoGeneration.mockResolvedValue({ name: "operation-1" });
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        branches: [
          {
            cohortId: "generated-audience",
            actions: [
              {
                id: "generated-message",
                label: "Generated message",
                text: "Generated message",
                cta: { type: "none" },
                media: { assetUrls: [] },
              },
            ],
          },
        ],
      }),
    });
    mockScenarioCreate.mockResolvedValue([createScenarioDocument()]);
    mockSessionWithTransaction.mockImplementation(
      async (callback: () => Promise<unknown>) => callback()
    );
    mockSessionEndSession.mockResolvedValue(undefined);
    mockScenarioStartSession.mockResolvedValue(mockMongoSession);
    mockSerializeScenario.mockImplementation((scenario: unknown) => scenario);
    mockJobFindByIdAndUpdate.mockResolvedValue({});
  });

  it("returns 402 before creating generated scenarios when the scenario limit is exhausted", async () => {
    mockEnsureCompanyScenarioCapacity.mockResolvedValueOnce({
      allowed: false,
      limit: { scenarioLimit: 5, scenarioCount: 5 },
    });

    const response = await POST(
      createRequest({
        prompt: "Generate a VIP reactivation campaign",
        workflowKind: "follow_up_workflow",
        sendMode: "trigger",
        channels: ["email"],
        campaignName: "VIP Reactivation",
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(402);
    expect(payload.code).toBe("company_scenario_limit_exceeded");
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockScenarioCreate).not.toHaveBeenCalled();
  });

  it("does not forward a retired trigger strategy from an old create payload", async () => {
    const response = await POST(
      createRequest({
        prompt: "Create an inbound support workflow",
        workflowKind: "follow_up_workflow",
        sendMode: "trigger",
        channels: ["whatsapp"],
        campaignName: "Support intake",
        triggerStrategy: "customer_intent_or_classification",
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    const graphInput = mockBuildScenarioGeneratorGraph.mock.calls[0]?.[0];
    expect(graphInput).not.toHaveProperty("triggerStrategy");
    expect(mockCaptureFunnelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "scenario_created",
        workspaceId: "workspace-1",
        properties: expect.objectContaining({ origin: "generator" }),
      })
    );
  });

  it("rejects a generated graph that introduces a legacy action-routing assignment", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce({
      nodes: [
        {
          id: "action-1",
          type: "scenarioNode",
          position: { x: 0, y: 0 },
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyText: "Generated message",
          },
        },
        {
          id: "condition-1",
          type: "scenarioNode",
          position: { x: 240, y: 0 },
          data: {
            kind: "logic",
            logicType: "post_action_condition",
          },
        },
      ],
      edges: [
        {
          id: "new-legacy-edge",
          source: "action-1",
          target: "condition-1",
          sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
        },
      ],
    });

    const response = await POST(
      createRequest({
        prompt: "Create an inbound support workflow",
        workflowKind: "follow_up_workflow",
        sendMode: "trigger",
        channels: ["whatsapp"],
        campaignName: "Support intake",
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Legacy no-reply assignments can no longer be created",
      code: "legacy_action_routing_new_assignment_forbidden",
    });
    expect(mockJobFindByIdAndUpdate).toHaveBeenCalledWith("job-1", {
      status: "failed",
      error: "legacy_action_routing_new_assignment_forbidden",
    });
    expect(mockValidateScenarioGraph).not.toHaveBeenCalled();
    expect(mockScenarioStartSession).not.toHaveBeenCalled();
    expect(mockScenarioCreate).not.toHaveBeenCalled();
  });

  it("rejects oversized recipient requests instead of truncating them", async () => {
    const response = await POST(
      createRequest({
        prompt: "Generate a bounded bulk campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        recipients: Array.from({ length: 1001 }, (_, index) => ({
          phone: `+1555${String(index).padStart(7, "0")}`,
        })),
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual(
      expect.objectContaining({
        code: "scenario_generator_recipient_limit_exceeded",
        limit: 1000,
        requested: 1001,
      })
    );
    expect(mockJobCreate).not.toHaveBeenCalled();
    expect(mockScenarioCreate).not.toHaveBeenCalled();
  });

  it("accepts the full bounded audience across every supported channel", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce(
      createBulkGraph({ channels: ["whatsapp", "telegram", "email"] })
    );
    const response = await POST(
      createRequest({
        prompt: "Generate a bounded cross-channel campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp", "telegram", "email"],
        recipients: Array.from({ length: 1000 }, (_, index) => ({
          phone: `+1555${String(index).padStart(7, "0")}`,
          chatId: `telegram-${index}`,
          email: `recipient-${index}@example.com`,
        })),
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.generatedRecipientCount).toBe(3000);
    expect(mockRecipientMessageInsertMany).toHaveBeenCalledTimes(6);
    expect(mockScenarioCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized selected-source scope instead of building an unbounded query", async () => {
    const response = await POST(
      createRequest({
        prompt: "Generate a source-scoped campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        sourceIds: Array.from({ length: 101 }, (_, index) => `source-${index}`),
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual(
      expect.objectContaining({
        code: "scenario_generator_source_limit_exceeded",
        limit: 100,
        requested: 101,
      })
    );
    expect(mockJobCreate).not.toHaveBeenCalled();
  });

  it("rejects oversized source context instead of silently truncating it", async () => {
    const response = await POST(
      createRequest({
        prompt: "Generate a source-scoped campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        sourceContext: Array.from({ length: 101 }, (_, index) => ({
          id: `source-${index}`,
          type: "whatsapp",
          role: "delivery",
        })),
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual(
      expect.objectContaining({
        code: "scenario_generator_source_context_limit_exceeded",
        limit: 100,
        requested: 101,
      })
    );
    expect(mockJobCreate).not.toHaveBeenCalled();
  });

  it("rejects oversized generated-media requests before fan-out", async () => {
    const response = await POST(
      createRequest({
        prompt: "Generate a media campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        assetRefs: Array.from({ length: 101 }, (_, index) => ({
          id: `asset-${index}`,
          url: `https://cdn.example.com/asset-${index}.png`,
          mimeType: "image/png",
        })),
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual(
      expect.objectContaining({
        code: "scenario_generator_asset_limit_exceeded",
        limit: 100,
        requested: 101,
      })
    );
    expect(mockJobCreate).not.toHaveBeenCalled();
    expect(mockMediaInsertMany).not.toHaveBeenCalled();
  });

  it("rejects oversized Canva template context before prompt expansion", async () => {
    const response = await POST(
      createRequest({
        prompt: "Generate a Canva-inspired campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        selectedCanvaTemplates: Array.from({ length: 51 }, (_, index) => ({
          id: `canva-template-${index}`,
          title: `Template ${index}`,
        })),
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual(
      expect.objectContaining({
        code: "scenario_generator_canva_template_limit_exceeded",
        limit: 50,
        requested: 51,
      })
    );
    expect(mockJobCreate).not.toHaveBeenCalled();
  });

  it("preserves selected Canva templates in the generation job metadata", async () => {
    const response = await POST(
      createRequest({
        prompt: "Generate a VIP reactivation campaign",
        workflowKind: "follow_up_workflow",
        sendMode: "trigger",
        channels: ["email"],
        campaignName: "VIP Reactivation",
        recipientSourceSummary: "Triggered audience",
        selectedCanvaTemplates: [
          {
            id: "template-1",
            title: "VIP Reel",
            thumbnailUrl: "https://cdn.canva.com/vip.png",
            createUrl: "https://www.canva.com/create/template-1",
            source: "canva_brand_template",
          },
          {
            id: "template-1",
            title: "Duplicate should be removed",
            source: "canva_brand_template",
          },
        ],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    expect(mockJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedCanvaTemplates: [
          expect.objectContaining({
            id: "template-1",
            title: "VIP Reel",
            thumbnailUrl: "https://cdn.canva.com/vip.png",
            createUrl: "https://www.canva.com/create/template-1",
          }),
        ],
        prompt: expect.stringContaining("Canva brand template inspiration:"),
      })
    );
    expect(mockBuildScenarioGeneratorGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("VIP Reel"),
      })
    );
  });

  it("does not launch platform videos implicitly when scenario creation succeeds", async () => {
    mockIsVertexVideoConfigured.mockReturnValue(true);
    const response = await POST(
      createRequest({
        prompt: "Generate a VIP reactivation campaign",
        workflowKind: "follow_up_workflow",
        sendMode: "trigger",
        channels: ["email"],
        campaignName: "VIP Reactivation",
        recipientSourceSummary: "Triggered audience",
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    expect(response.status).toBe(201);
    expect(mockStartVertexVideoGeneration).not.toHaveBeenCalled();
    expect(mockMediaInsertMany).not.toHaveBeenCalled();
    expect(mockJobFindByIdAndUpdate).toHaveBeenLastCalledWith("job-1", {
      scenarioId: expect.any(String),
      status: "complete",
    });
  });
  it("deduplicates generated recipient message docs before inserting", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce(createBulkGraph());

    const response = await POST(
      createRequest({
        prompt: "Generate a VIP reactivation campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        sourceIds: ["source-selected"],
        campaignName: "VIP Reactivation",
        recipientSourceSummary: "CSV upload",
        recipients: [
          { phone: "+1 555 123 4567", name: "Aibek" },
          { phone: "15551234567", name: "Aibek duplicate" },
        ],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    expect(mockRecipientMessageInsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          nodeId: "action-generated-audience",
          channel: "whatsapp",
          recipient: "15551234567",
          sourceId: "source-selected",
        }),
      ],
      { ordered: false, session: mockMongoSession }
    );
    const createInput = getScenarioCreateInput();
    const bulkRoot = createInput.nodes.find(
      (node: { data?: { kind?: string } }) => node.data?.kind === "bulk"
    );
    expect(bulkRoot.data.bulkRootConfig.generatedRecipientCount).toBe(1);
  });

  it("chunks bounded generated recipient inserts within the scenario transaction", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce(createBulkGraph());

    const response = await POST(
      createRequest({
        prompt: "Generate a bounded subscriber campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        sourceIds: ["source-selected"],
        sourceContext: [
          {
            id: "source-selected",
            type: "whatsapp",
            role: "delivery",
          },
        ],
        recipients: Array.from({ length: 501 }, (_, index) => ({
          phone: `+1555${String(index).padStart(7, "0")}`,
        })),
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    expect(mockRecipientMessageInsertMany).toHaveBeenCalledTimes(2);
    expect(mockRecipientMessageInsertMany.mock.calls[0]?.[0]).toHaveLength(500);
    expect(mockRecipientMessageInsertMany.mock.calls[1]?.[0]).toHaveLength(1);
    expect(mockRecipientMessageInsertMany.mock.calls[0]?.[1]).toEqual({
      ordered: false,
      session: mockMongoSession,
    });
    expect(mockRecipientMessageInsertMany.mock.calls[1]?.[1]).toEqual({
      ordered: false,
      session: mockMongoSession,
    });
    const createInput = getScenarioCreateInput();
    const bulkRoot = createInput.nodes.find(
      (node: { data?: { kind?: string } }) => node.data?.kind === "bulk"
    );
    expect(bulkRoot.data.bulkRootConfig.generatedRecipientCount).toBe(501);
  });

  it("materializes canonical generated-recipient indexes before starting the write transaction", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce(createBulkGraph());

    const response = await POST(
      createRequest({
        prompt: "Generate an indexed subscriber campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        sourceIds: ["source-selected"],
        recipients: [{ phone: "+15551234567" }],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    expect(
      mockEnsureScenarioGeneratedRecipientMessageIndexes
    ).toHaveBeenCalledTimes(1);
    const indexReadyOrder =
      mockEnsureScenarioGeneratedRecipientMessageIndexes.mock
        .invocationCallOrder[0];
    expect(indexReadyOrder).toBeLessThan(
      mockScenarioStartSession.mock.invocationCallOrder[0]
    );
    expect(indexReadyOrder).toBeLessThan(
      mockRecipientMessageInsertMany.mock.invocationCallOrder[0]
    );
  });

  it("keeps the same normalized recipient on distinct sources as distinct drafts", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce(
      createBulkGraph({ recipientSourceSummary: "Selected sources" })
    );

    const response = await POST(
      createRequest({
        prompt: "Generate a source-aware reactivation campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        sourceIds: ["source-a", "source-b"],
        sourceContext: [
          { id: "source-a", type: "whatsapp", role: "delivery" },
          { id: "source-b", type: "whatsapp", role: "delivery" },
        ],
        campaignName: "VIP Reactivation",
        recipientSourceSummary: "Selected sources",
        recipients: [
          { phone: "+1 555 123 4567", sourceId: " source-a " },
          { phone: "15551234567", sourceId: "source-a" },
          { phone: "+1 (555) 123-4567", sourceId: "source-b" },
        ],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    expect(mockRecipientMessageInsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          nodeId: "action-generated-audience",
          channel: "whatsapp",
          recipient: "15551234567",
          sourceId: "source-a",
          generationJobId: "job-1",
        }),
        expect.objectContaining({
          nodeId: "action-generated-audience",
          channel: "whatsapp",
          recipient: "15551234567",
          sourceId: "source-b",
          generationJobId: "job-1",
        }),
      ],
      { ordered: false, session: mockMongoSession }
    );
    const payload = await response.json();
    expect(payload.generatedRecipientCount).toBe(2);
  });

  it("assigns the single selected Telegram delivery source to Telegram drafts", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce(
      createBulkGraph({
        channels: ["telegram"],
        recipientSourceSummary: "Telegram subscribers",
      })
    );

    const response = await POST(
      createRequest({
        prompt: "Generate a Telegram subscriber campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["telegram"],
        sourceContext: [
          {
            id: "telegram-source",
            type: "telegram",
            role: "delivery",
          },
        ],
        campaignName: "Telegram Subscribers",
        recipientSourceSummary: "Telegram subscribers",
        recipients: [{ chatId: "telegram-chat-1", name: "Aida" }],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    const insertedDocs = mockRecipientMessageInsertMany.mock.calls[0]?.[0];
    expect(insertedDocs).toEqual([
      expect.objectContaining({
        channel: "telegram",
        recipient: "telegram-chat-1",
        sourceId: "telegram-source",
      }),
    ]);
  });

  it("keeps selected WhatsApp and Telegram delivery sources isolated in mixed drafts", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce(
      createBulkGraph({
        channels: ["whatsapp", "telegram"],
        recipientSourceSummary: "Selected delivery sources",
      })
    );

    const response = await POST(
      createRequest({
        prompt: "Generate a cross-channel subscriber campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp", "telegram"],
        sourceContext: [
          {
            id: "whatsapp-source",
            type: "whatsapp",
            role: "delivery",
          },
          {
            id: "telegram-unselected",
            type: "telegram",
            role: "context",
          },
          {
            id: "telegram-source",
            type: "telegram",
            role: "delivery",
          },
        ],
        campaignName: "Cross-channel Subscribers",
        recipientSourceSummary: "Selected delivery sources",
        recipients: [
          {
            phone: "+77000000001",
            chatId: "telegram-chat-1",
            sourceId: "whatsapp-source",
          },
        ],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    const insertedDocs = mockRecipientMessageInsertMany.mock.calls[0]?.[0];
    expect(insertedDocs).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        recipient: "77000000001",
        sourceId: "whatsapp-source",
      }),
      expect.objectContaining({
        channel: "telegram",
        recipient: "telegram-chat-1",
        sourceId: "telegram-source",
      }),
    ]);
  });

  it("does not copy an untyped legacy source across mixed delivery channels", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce(
      createBulkGraph({ channels: ["whatsapp", "telegram"] })
    );

    const response = await POST(
      createRequest({
        prompt: "Generate a mixed-channel campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp", "telegram"],
        sourceIds: ["legacy-source"],
        recipients: [
          {
            phone: "+77000000001",
            chatId: "telegram-chat-1",
          },
        ],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    const insertedDocs = mockRecipientMessageInsertMany.mock.calls[0]?.[0];
    expect(insertedDocs).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        sourceId: null,
      }),
      expect.objectContaining({
        channel: "telegram",
        sourceId: null,
      }),
    ]);
  });

  it("aborts scenario persistence when generated recipient insertion writes nothing", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce(createBulkGraph());
    mockScenarioCreate.mockResolvedValueOnce([createScenarioDocument()]);
    mockRecipientMessageInsertMany.mockRejectedValueOnce(
      Object.assign(new Error("recipient insert failed before writing"), {
        insertedDocs: [],
      })
    );

    await expect(
      POST(
        createRequest({
          prompt: "Generate a source-aware reactivation campaign",
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          sourceIds: ["source-a"],
          sourceContext: [
            { id: "source-a", type: "whatsapp", role: "delivery" },
          ],
          campaignName: "VIP Reactivation",
          recipientSourceSummary: "Selected sources",
          recipients: [{ phone: "+1 555 123 4567" }],
        }) as never,
        { params: Promise.resolve({ workspaceId: "workspace-1" }) }
      )
    ).rejects.toThrow("recipient insert failed before writing");

    expect(mockScenarioStartSession).toHaveBeenCalledTimes(1);
    expect(mockSessionWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecipientMessageInsertMany).toHaveBeenCalledWith(
      [expect.objectContaining({ generationJobId: "job-1" })],
      { ordered: false, session: mockMongoSession }
    );
    expect(mockScenarioCreate).not.toHaveBeenCalled();
    expect(mockSessionEndSession).toHaveBeenCalledTimes(1);
  });

  it("aborts scenario persistence when generated recipient insertion reports partial writes", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce(createBulkGraph());
    mockScenarioCreate.mockResolvedValueOnce([createScenarioDocument()]);
    mockRecipientMessageInsertMany.mockRejectedValueOnce(
      Object.assign(new Error("recipient insert failed after partial write"), {
        insertedDocs: [{ recipient: "15551234567" }],
      })
    );

    await expect(
      POST(
        createRequest({
          prompt: "Generate a source-aware reactivation campaign",
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          sourceIds: ["source-a"],
          sourceContext: [
            { id: "source-a", type: "whatsapp", role: "delivery" },
          ],
          campaignName: "VIP Reactivation",
          recipientSourceSummary: "Selected sources",
          recipients: [
            { phone: "+1 555 123 4567" },
            { phone: "+1 555 123 4568" },
          ],
        }) as never,
        { params: Promise.resolve({ workspaceId: "workspace-1" }) }
      )
    ).rejects.toThrow("recipient insert failed after partial write");

    expect(mockScenarioStartSession).toHaveBeenCalledTimes(1);
    expect(mockSessionWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecipientMessageInsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({ recipient: "15551234567" }),
        expect.objectContaining({ recipient: "15551234568" }),
      ],
      { ordered: false, session: mockMongoSession }
    );
    expect(mockScenarioCreate).not.toHaveBeenCalled();
    expect(mockSessionEndSession).toHaveBeenCalledTimes(1);
  });

  it("stores generated WhatsApp action copy as draft template body for human review", async () => {
    const imageAsset = {
      id: " asset-1 ",
      kind: "image",
      source: "uploaded",
      url: "https://cdn.example.com/booking-reminder.png",
      mimeType: "image/png",
      fileName: "booking-reminder.png",
      status: "complete",
    };
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce({
      nodes: [
        {
          id: "node-trigger-root",
          type: "triggerNode",
          position: { x: 0, y: 0 },
          data: {
            kind: "trigger",
            triggerConfig: { enabled: true, messageMatchMode: "any" },
          },
        },
        {
          id: "node-booking-confirm",
          type: "actionNode",
          position: { x: 240, y: 0 },
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyText:
              "Hi {{1}}, your appointment is tomorrow at 10:00. Tap Confirm if the time still works, or reply here and we will help reschedule.",
            actionReplyCtaType: "none",
            actionReplyCtaLabel: "Confirm",
            actionImageUrls: [imageAsset.url],
            actionMediaAssets: [imageAsset, { ...imageAsset, id: "asset-1" }],
            bulkRecipientBranchId: "generated-audience",
          },
        },
      ],
      edges: [
        {
          id: "edge-1",
          source: "node-trigger-root",
          target: "node-booking-confirm",
        },
      ],
    });

    const response = await POST(
      createRequest({
        prompt: "Create a booking reminder and no-show recovery workflow",
        workflowKind: "follow_up_workflow",
        sendMode: "trigger",
        channels: ["whatsapp"],
        campaignName: "Booking Reminder",
        recipientSourceSummary: "Calendar customers",
        sourceIds: ["source-selected"],
        recipients: [{ phone: "+77000000001", name: "Aida" }],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    const createInput = getScenarioCreateInput();
    const actionNode = createInput.nodes.find(
      (node: { id?: string }) => node.id === "node-booking-confirm"
    );

    expect(actionNode.data).toMatchObject({
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: expect.stringMatching(/^booking_reminder_/),
      actionWhatsAppTemplateLanguage: "en",
      generatedTemplateDraft: expect.objectContaining({
        status: "draft",
        category: "MARKETING",
        headerMediaUrl: imageAsset.url,
        headerMediaFormat: "IMAGE",
      }),
    });
    expect(actionNode.data.actionWhatsAppTemplateComponents).toEqual([
      {
        type: "HEADER",
        format: "IMAGE",
        example: { header_handle: [imageAsset.url] },
      },
      {
        type: "BODY",
        text: "Hi {{1}}, your appointment is tomorrow at 10:00. Tap Confirm if the time still works, or reply here and we will help reschedule.",
        example: { body_text: [["Customer"]] },
      },
      {
        type: "BUTTONS",
        buttons: [{ type: "QUICK_REPLY", text: "Confirm" }],
      },
    ]);
    expect(actionNode.data.generatedTemplateDraft.components).toEqual(
      actionNode.data.actionWhatsAppTemplateComponents
    );
    expect(mockRecipientMessageInsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          templateDraftId: actionNode.data.generatedTemplateDraft.id,
          mediaAssetIds: ["asset-1"],
        }),
      ],
      { ordered: false, session: mockMongoSession }
    );
  });

  it("allows draft bulk campaign graphs before recipients are imported", async () => {
    const response = await POST(
      createRequest({
        prompt: "Launch the creative assets product on WhatsApp.",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "Creative Assets Launch",
        recipientSourceSummary: "WhatsApp launch audience",
        sourceIds: ["source-selected"],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    expect(mockValidateScenarioGraph).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      { mode: "graph" }
    );
    expect(mockBuildScenarioGeneratorGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        recipientSourceSummary: "WhatsApp launch audience",
      })
    );
  });

  it("rejects an unfinished generated graph even though generation creates a draft", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce({
      nodes: [],
      edges: [],
    });
    const { validateScenarioGraph } = jest.requireActual(
      "@/lib/scenarios/graph-validation"
    ) as typeof import("@/lib/scenarios/graph-validation");
    mockValidateScenarioGraph.mockImplementation(validateScenarioGraph);

    const response = await POST(
      createRequest({
        prompt: "Create a conversation scenario",
        workflowKind: "conversation",
        channels: ["whatsapp"],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "oneTriggerRequired",
    });
    expect(mockScenarioCreate).not.toHaveBeenCalled();
  });

  it("preserves 25 typed source identities in generated recipient rows", async () => {
    const sourceIds = Array.from(
      { length: 25 },
      (_, index) => `source-${index + 1}`
    );
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce(
      createBulkGraph({
        campaignName: "All Sources",
        recipientSourceSummary: "Selected sources",
      })
    );

    const response = await POST(
      createRequest({
        prompt: "Create one generated campaign for every selected source",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "All Sources",
        recipientSourceSummary: "Selected sources",
        sourceIds: [...sourceIds.map(sourceId => ` ${sourceId} `), "source-1"],
        sourceContext: sourceIds.map(sourceId => ({
          id: sourceId,
          type: "whatsapp",
          role: "delivery",
        })),
        recipients: sourceIds.map(sourceId => ({
          phone: "+15551234567",
          sourceId,
        })),
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    expect(mockJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds })
    );
    const createInput = getScenarioCreateInput();
    const bulkRoot = createInput.nodes.find(
      (node: { data?: { kind?: string } }) => node.data?.kind === "bulk"
    );
    expect(bulkRoot.data.bulkRootConfig.sourceIds).toEqual(sourceIds);
    const insertedDocs = mockRecipientMessageInsertMany.mock.calls[0]?.[0];
    expect(insertedDocs).toHaveLength(25);
    expect(
      insertedDocs.map(
        (document: { sourceId?: string | null }) => document.sourceId
      )
    ).toEqual(sourceIds);
    expect(
      insertedDocs.every(
        (document: { generationJobId?: string }) =>
          document.generationJobId === "job-1"
      )
    ).toBe(true);
  });

  it("expands the complete imported audience across every selected channel without Meta preflight", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce(
      createBulkGraph({
        channels: ["whatsapp", "email"],
        recipientSourceSummary: "XLSX upload",
      })
    );

    const response = await POST(
      createRequest({
        prompt: "Generate a VIP reactivation campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp", "email"],
        sourceIds: ["source-selected"],
        sourceContext: [
          { id: "source-selected", type: "whatsapp", role: "delivery" },
        ],
        campaignName: "VIP Reactivation",
        recipientSourceSummary: "XLSX upload",
        recipients: [
          {
            phone: "+77000000001",
            name: "Жулдыз",
            email: "CLIENT@EXAMPLE.COM",
            sourceId: "source-selected",
          },
          {
            phone: "+77000000002",
            name: "Samat",
            email: "samat@example.com",
          },
        ],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    expect(mockRecipientMessageInsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          channel: "whatsapp",
          recipient: "77000000001",
          recipientName: "Жулдыз",
          recipientEmail: "client@example.com",
          sourceId: "source-selected",
        }),
        expect.objectContaining({
          channel: "email",
          recipient: "client@example.com",
          sourceId: null,
        }),
        expect.objectContaining({
          channel: "whatsapp",
          recipient: "77000000002",
          recipientName: "Samat",
          recipientEmail: "samat@example.com",
          sourceId: "source-selected",
        }),
        expect.objectContaining({
          channel: "email",
          recipient: "samat@example.com",
          recipientName: "Samat",
          sourceId: null,
        }),
      ],
      { ordered: false, session: mockMongoSession }
    );
    const payload = await response.json();
    expect(payload.generatedRecipientCount).toBe(4);
    expect(payload).not.toHaveProperty("recipientLimit");
  });

  it("persists preset metadata when generation is seeded from an Airi Create preset", async () => {
    const response = await POST(
      createRequest({
        prompt: "Use the lead generation workflow template for WhatsApp",
        workflowKind: "follow_up_workflow",
        sendMode: "trigger",
        channels: ["whatsapp"],
        campaignName: "Lead Generation Sequence",
        recipientSourceSummary: "Triggered audience",
        presetSeed: {
          id: "lead_generation",
          version: "1",
          segmentKey: "lead_generation",
          title: "Lead Generation Sequence",
          description: "Capture new inbound leads and qualify them.",
          segmentLabel: "Lead Generation",
        },
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    expect(mockScenarioCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          presetId: "lead_generation",
          presetVersion: "1",
          segmentKey: "lead_generation",
          graphSchemaVersion: 1,
        }),
      ],
      { session: mockMongoSession }
    );
    expect(mockJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        presetSeed: expect.objectContaining({
          id: "lead_generation",
          title: "Lead Generation Sequence",
        }),
      })
    );
  });

  it("passes preset and conversation context into final action graph generation", async () => {
    mockConversationRows([
      {
        _id: "conversation-1",
        channel: "whatsapp",
        sourceId: "source-selected",
        chat: "wa_77000000001",
        history_summary: "Asked about enterprise onboarding.",
        ...currentClassificationProjection({
          category: "lead_generation",
          summary: "High-intent lead",
        }),
        internal_labels: ["vip", "b2b"],
        lastMessageAt: new Date("2026-06-01T10:00:00.000Z"),
      },
    ]);

    const response = await POST(
      createRequest({
        prompt: "Use workspace context for lead qualification",
        workflowKind: "follow_up_workflow",
        sendMode: "trigger",
        channels: ["whatsapp"],
        sourceIds: ["source-selected"],
        campaignName: "Lead Generation Sequence",
        recipientSourceSummary: "Triggered audience",
        presetSeed: {
          id: "lead_generation",
          version: "1",
          segmentKey: "lead_generation",
          title: "Lead Generation Sequence",
          description: "Capture new inbound leads and qualify them.",
          segmentLabel: "Lead Generation",
        },
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    expect(mockBuildScenarioGeneratorGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        presetSeed: expect.objectContaining({
          id: "lead_generation",
          segmentKey: "lead_generation",
        }),
      })
    );
    expect(mockChatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Lead Generation Sequence"),
          }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining(
              "Asked about enterprise onboarding."
            ),
          }),
        ]),
      })
    );
    const aiPayload = String(
      mockChatCompletionWithFallback.mock.calls[0]?.[0]?.messages?.find(
        (message: { role?: string }) => message.role === "user"
      )?.content || ""
    );
    expect(aiPayload).toContain('"classificationCategory":"lead_generation"');
    expect(aiPayload).toContain('"classificationSummary":"High-intent lead"');
    expectConversationSelectContainsCanonicalFreshness();
  });

  it("omits stale classification from AI and generated messages while retaining history, labels, and cohort fallback", async () => {
    mockBuildScenarioGeneratorGraph.mockReturnValueOnce(createBulkGraph());
    mockConversationRows([
      {
        _id: "conversation-stale",
        channel: "whatsapp",
        sourceId: "source-selected",
        chat: "wa_15551234567",
        history_summary: "Retained purchase history summary.",
        ...currentClassificationProjection(
          {
            category: "stale-churn",
            summary: "Stale classification summary",
          },
          { is_classified: false }
        ),
        internal_labels: ["vip", "stage:active"],
        lastMessageAt: new Date("2026-06-02T10:00:00.000Z"),
      },
      {
        _id: "conversation-stale-without-history",
        channel: "whatsapp",
        sourceId: "source-selected",
        chat: "wa_15550000000",
        ...currentClassificationProjection(
          {
            category: "stale-pricing",
            summary: "Stale summary without history",
          },
          { is_classified: false }
        ),
        internal_labels: ["manual-label"],
        lastMessageAt: new Date("2026-06-01T10:00:00.000Z"),
      },
    ]);

    const response = await POST(
      createRequest({
        prompt: "Generate a retention campaign",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        sourceIds: ["source-selected"],
        campaignName: "Retention",
        recipientSourceSummary: "Selected customers",
        recipients: [{ phone: "+1 555 123 4567", name: "Aibek" }],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    const aiPayload = String(
      mockChatCompletionWithFallback.mock.calls[0]?.[0]?.messages?.find(
        (message: { role?: string }) => message.role === "user"
      )?.content || ""
    );
    expect(aiPayload).toContain("Retained purchase history summary.");
    expect(aiPayload).toContain('"labels":["vip","stage:active"]');
    expect(aiPayload).not.toContain("stale-churn");
    expect(aiPayload).not.toContain("stale-pricing");
    expect(aiPayload).not.toContain("Stale classification summary");
    expect(aiPayload).not.toContain("Stale summary without history");
    expect(mockRecipientMessageInsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          taxonomyCategory: "Generated audience",
          internalLabels: ["vip", "stage:active"],
          text: expect.stringContaining("Retained purchase history summary."),
        }),
      ],
      { ordered: false, session: mockMongoSession }
    );
    const insertedMessage =
      mockRecipientMessageInsertMany.mock.calls[0]?.[0]?.[0];
    expect(insertedMessage.text).not.toContain("stale-churn");
    expectConversationSelectContainsCanonicalFreshness();
  });

  it("uses the LLM final action plan instead of fixed generated action nodes", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce({
      content: JSON.stringify({
        branches: [
          {
            cohortId: "generated-audience",
            actions: [
              {
                id: "intro",
                label: "Intro CTA",
                text: "Hi {{name}}, the premium collection is live.",
                cta: {
                  type: "link",
                  label: "Shop now",
                  url: "https://shop.example.com/premium",
                },
                media: {
                  assetUrls: ["https://cdn.example.com/premium.jpg"],
                },
              },
              {
                id: "video-proof",
                label: "Video proof",
                text: "Here is a quick styling video for the new collection.",
                cta: { type: "none" },
                media: {
                  assetUrls: ["https://cdn.example.com/lookbook.mp4"],
                },
              },
            ],
          },
        ],
      }),
    });

    const response = await POST(
      createRequest({
        prompt:
          "Generate a premium collection WhatsApp campaign. Use https://shop.example.com/premium for the CTA.",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "Premium Collection",
        recipientSourceSummary: "CSV upload",
        recipients: [{ phone: "+77000000001", name: "Aibek" }],
        assetRefs: [
          {
            url: "https://cdn.example.com/premium.jpg",
            mimeType: "image/jpeg",
            fileName: "premium.jpg",
          },
          {
            id: "higgsfield-video-1",
            kind: "video",
            source: "higgsfield",
            url: "https://cdn.example.com/lookbook.mp4",
            mimeType: "video/mp4",
            fileName: "lookbook.mp4",
          },
        ],
        sourceContext: [
          {
            type: "google_calendar",
            label: "Google Calendar",
            role: "context",
          },
        ],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    expect(mockChatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        responseFormat: { type: "json_object" },
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Never invent external booking"),
          }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("google_calendar"),
          }),
        ]),
      })
    );
    const actionGraphRequest = mockChatCompletionWithFallback.mock.calls[0][0];
    expect(actionGraphRequest.model).toBe("reasoning-text-model");
    expect(actionGraphRequest.resilience.timeoutMs).toBeGreaterThanOrEqual(
      120_000
    );
    expect(actionGraphRequest.resilience.timeoutMs).toBeLessThan(
      maxDuration * 1000
    );
    expect(mockBuildScenarioGeneratorGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        generatedBranches: [
          expect.objectContaining({
            cohortId: "generated-audience",
            actions: [
              expect.objectContaining({
                id: "intro",
                text: "Hi {{name}}, the premium collection is live.",
                cta: expect.objectContaining({
                  type: "link",
                  label: "Shop now",
                  url: "https://shop.example.com/premium",
                }),
                media: expect.objectContaining({
                  assetUrls: ["https://cdn.example.com/premium.jpg"],
                }),
              }),
              expect.objectContaining({
                id: "video-proof",
                media: expect.objectContaining({
                  assetUrls: ["https://cdn.example.com/lookbook.mp4"],
                }),
              }),
            ],
          }),
        ],
        assets: expect.arrayContaining([
          expect.objectContaining({
            kind: "image",
            url: "https://cdn.example.com/premium.jpg",
          }),
          expect.objectContaining({
            kind: "video",
            id: "higgsfield-video-1",
            source: "higgsfield",
            url: "https://cdn.example.com/lookbook.mp4",
          }),
        ]),
      })
    );
    expect(mockMediaInsertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          source: "higgsfield",
          url: "https://cdn.example.com/lookbook.mp4",
        }),
      ]),
      { ordered: false }
    );
  });

  it("removes invented booking links from the final action plan", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce({
      content: JSON.stringify({
        branches: [
          {
            cohortId: "generated-audience",
            actions: [
              {
                id: "booking-demo",
                label: "Booking demo",
                text: "Let's get you set up. Reply and our team will use calendar availability to find the right demo time.",
                cta: {
                  type: "link",
                  label: "Book Product Demo",
                  url: "https://calendly.com/waba-creative-assets",
                },
                media: { assetUrls: [] },
              },
            ],
          },
        ],
      }),
    });

    const response = await POST(
      createRequest({
        prompt: "Create a booking reminder and no-show recovery workflow",
        workflowKind: "follow_up_workflow",
        sendMode: "trigger",
        channels: ["whatsapp"],
        campaignName: "Booking Reminder",
        recipientSourceSummary: "Calendar demo leads",
        sourceContext: [
          {
            type: "google_calendar",
            label: "Google Calendar",
            role: "context",
          },
        ],
      }) as never,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(201);
    expect(mockBuildScenarioGeneratorGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        generatedBranches: [
          expect.objectContaining({
            actions: [
              expect.objectContaining({
                id: "booking-demo",
                cta: {
                  type: "none",
                  label: "Book Product Demo",
                },
              }),
            ],
          }),
        ],
      })
    );
  });
});
