const mockConnectDB = jest.fn();
const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockFindOneAndDelete = jest.fn();
const mockScenarioFind = jest.fn();
const mockScenarioCollectionFindOne = jest.fn();
const mockScenarioCollectionFindOneAndUpdate = jest.fn();
const mockDetachScenarioLinkedConditions = jest.fn();
const mockReconcileCampaignScenarioSchedules = jest.fn();
const mockRetireCampaignScenarioSchedules = jest.fn();
const mockRetireCampaignDeliveryTasksForScenario = jest.fn();
const mockValidateScenarioGraph = jest.fn();
const mockStartSession = jest.fn();
const mockBirthdaySettingsUpdateOne = jest.fn();
const mockBirthdaySettingsCreateIndex = jest.fn();
const mockImportCustomerBirthdays = jest.fn();
const mockBirthdayQrCodeUpdateOne = jest.fn();
const mockSyncScenarioLinkedConditions = jest.fn();
const mockLoadLinkedConditionParentCountByNodeId = jest.fn();
const mockFindWhatsAppFlowProvisioningOperations = jest.fn();
const mockLoadCurrentWhatsAppSourceWabaBindings = jest.fn();
const mockLoadWhatsAppQrEntryPointReadinessByBindings = jest.fn();
const mockListWhatsAppQrScenarioSummaries = jest.fn();
const mockDetachWhatsAppQrEntryPointsForRemovedNodes = jest.fn();
const mockDetachWhatsAppQrEntryPointsForScenarioDeletion = jest.fn();
const mockMarkWhatsAppQrDetachPendingNodes = jest.fn();
const mockReconcileWhatsAppQrDetachPendingForScenario = jest.fn();
const mockConversationFind = jest.fn();
const mockConversationUpdateMany = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockConversationListIndexes = jest.fn();
const mockConversationCollectionFind = jest.fn();
const mockLinkedConditionFind = jest.fn();
const mockLinkedConditionUpdateOne = jest.fn();
const mockLinkedConditionCollectionFind = jest.fn();
const mockLinkedConditionCollectionUpdateOne = jest.fn();
const mockAssertTimerReplanIngressIndexes = jest.fn();
const mockEnqueueTimerReplanIngress = jest.fn();
const mockProcessTimerReplanIngressKeys = jest.fn();
const mockEmitWorkspaceUsageDeltaBestEffort = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));
const mockCaptureFunnelEvent = jest.fn();
jest.mock("@/lib/funnel-analytics", () => ({
  captureFunnelEvent: (...args: unknown[]) => mockCaptureFunnelEvent(...args),
}));
const mockEnrichScenarioNodesMediaDisplayUrls = jest.fn();
const mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget = jest.fn();
const mockAttachLinkedParentScenarioIds = jest.fn();
const mockListOutstandingTimerReplanIngressForScenario = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

// GET runs the real access helper against this session client.
const mockCreateSupabaseClient = jest.fn();
const mockGetSessionUser = jest.fn();
const mockMembershipLookup = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  ...jest.requireActual("@/lib/supabase/server"),
  createClient: () => mockCreateSupabaseClient(),
}));

jest.mock("@/lib/scenarios/scenario-serialization", () => ({
  ...jest.requireActual("@/lib/scenarios/scenario-serialization"),
  serializeScenario: (scenario: unknown) => scenario,
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    collection: {
      findOne: (...args: unknown[]) => mockScenarioCollectionFindOne(...args),
      findOneAndUpdate: (...args: unknown[]) =>
        mockScenarioCollectionFindOneAndUpdate(...args),
    },
    find: (...args: unknown[]) => mockScenarioFind(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    findOneAndDelete: (...args: unknown[]) => mockFindOneAndDelete(...args),
    startSession: (...args: unknown[]) => mockStartSession(...args),
  },
}));

jest.mock("@/models/workspace-airi-settings", () => ({
  __esModule: true,
  default: {
    startSession: (...args: unknown[]) => mockStartSession(...args),
    updateOne: (...args: unknown[]) => mockBirthdaySettingsUpdateOne(...args),
    collection: {
      createIndex: (...args: unknown[]) =>
        mockBirthdaySettingsCreateIndex(...args),
    },
  },
}));

jest.mock("@/lib/customers/customer-birthday-import", () => ({
  importCustomerBirthdays: (...args: unknown[]) =>
    mockImportCustomerBirthdays(...args),
}));

jest.mock("@/models/whatsapp-qr-code", () => ({
  WhatsAppQrCode: {
    updateOne: (...args: unknown[]) => mockBirthdayQrCodeUpdateOne(...args),
  },
}));

jest.mock("@/models/conversation", () => ({
  CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME:
    "conversations_workspace_scenario_pending_wait_v2",
  CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_KEYS: {
    workspaceId: 1,
    "airi_scenario_state.lockedScenarioId": 1,
    "airi_scenario_state.pendingConditionNodeId": 1,
    "airi_scenario_state.pendingSourceActionNodeId": 1,
  },
  CONVERSATION_SCENARIO_PENDING_WAIT_PARTIAL_FILTER: {
    "airi_scenario_state.lockedScenarioId": { $type: "string" },
    "airi_scenario_state.pendingConditionNodeId": { $type: "string" },
  },
  Conversation: {
    collection: {
      listIndexes: (...args: unknown[]) => mockConversationListIndexes(...args),
      find: (...args: unknown[]) => mockConversationCollectionFind(...args),
    },
    find: (...args: unknown[]) => mockConversationFind(...args),
    updateMany: (...args: unknown[]) => mockConversationUpdateMany(...args),
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
  },
}));

jest.mock("@/models/scenario-linked-condition", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockLinkedConditionFind(...args),
    updateOne: (...args: unknown[]) => mockLinkedConditionUpdateOne(...args),
    collection: {
      find: (...args: unknown[]) => mockLinkedConditionCollectionFind(...args),
      updateOne: (...args: unknown[]) =>
        mockLinkedConditionCollectionUpdateOne(...args),
    },
  },
}));

jest.mock("@/models/whatsapp-flow-provisioning-operation", () => ({
  WhatsAppFlowProvisioningOperation: {
    find: (...args: unknown[]) =>
      mockFindWhatsAppFlowProvisioningOperations(...args),
  },
}));

jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  loadCurrentWhatsAppSourceWabaBindings: (...args: unknown[]) =>
    mockLoadCurrentWhatsAppSourceWabaBindings(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/queries", () => ({
  loadWhatsAppQrEntryPointReadinessByBindings: (...args: unknown[]) =>
    mockLoadWhatsAppQrEntryPointReadinessByBindings(...args),
  listWhatsAppQrScenarioSummaries: (...args: unknown[]) =>
    mockListWhatsAppQrScenarioSummaries(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/lifecycle", () => ({
  WhatsAppQrDetachError: class WhatsAppQrDetachError extends Error {},
  detachWhatsAppQrEntryPointsForRemovedNodes: (...args: unknown[]) =>
    mockDetachWhatsAppQrEntryPointsForRemovedNodes(...args),
  detachWhatsAppQrEntryPointsForScenarioDeletion: (...args: unknown[]) =>
    mockDetachWhatsAppQrEntryPointsForScenarioDeletion(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/cleanup-retry", () => ({
  ...jest.requireActual("@/lib/whatsapp/qr-entry-points/cleanup-retry"),
  markWhatsAppQrDetachPendingNodes: (...args: unknown[]) =>
    mockMarkWhatsAppQrDetachPendingNodes(...args),
  reconcileWhatsAppQrDetachPendingForScenario: (...args: unknown[]) =>
    mockReconcileWhatsAppQrDetachPendingForScenario(...args),
}));

jest.mock("@/lib/scenarios/linked-conditions", () => ({
  loadLinkedConditionParentCountByNodeId: (...args: unknown[]) =>
    mockLoadLinkedConditionParentCountByNodeId(...args),
  detachScenarioLinkedConditionsForScenarioDeletion: (...args: unknown[]) =>
    mockDetachScenarioLinkedConditions(...args),
  LINKED_CONDITION_ERROR_CODES: {
    conflictingChildReuse: "conflicting_child_reuse",
    missingChildTrigger: "missing_child_trigger",
    revisionConflict: "linked_condition_revision_conflict",
  },
  isLinkedConditionRevisionConflict: (error: unknown) =>
    error instanceof Error &&
    error.message === "linked_condition_revision_conflict",
  syncScenarioLinkedConditions: (...args: unknown[]) =>
    mockSyncScenarioLinkedConditions(...args),
  validateConditionalScenarioLinks: jest.fn(async () => []),
}));

jest.mock("@/lib/scenarios/scenario-asset-media-enrichment", () => ({
  enrichScenarioNodesMediaDisplayUrls: (...args: unknown[]) =>
    mockEnrichScenarioNodesMediaDisplayUrls(...args),
  enrichScenarioNodesMediaDisplayUrlsWithinBudget: (...args: unknown[]) =>
    mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget(...args),
}));

jest.mock("@/lib/scenarios/linked-parent-summaries", () => ({
  attachLinkedParentScenarioIds: (...args: unknown[]) =>
    mockAttachLinkedParentScenarioIds(...args),
}));

jest.mock("@/lib/airi/scenario/timer-recovery/ingress", () => ({
  assertTimerReplanIngressIndexes: (...args: unknown[]) =>
    mockAssertTimerReplanIngressIndexes(...args),
  enqueueTimerReplanIngress: (...args: unknown[]) =>
    mockEnqueueTimerReplanIngress(...args),
  processTimerReplanIngressKeys: (...args: unknown[]) =>
    mockProcessTimerReplanIngressKeys(...args),
  listOutstandingTimerReplanIngressForScenario: (...args: unknown[]) =>
    mockListOutstandingTimerReplanIngressForScenario(...args),
}));

jest.mock("@/lib/scenarios/subscenario-linking", () => ({
  resolveSubscenarioLinkSummary: jest.fn(() => ({ errors: [] })),
}));

jest.mock("@/lib/scenarios/graph-validation", () => ({
  ...jest.requireActual("@/lib/scenarios/graph-validation"),
  validateScenarioGraph: (...args: unknown[]) =>
    mockValidateScenarioGraph(...args),
}));

jest.mock("@/lib/campaign/campaign-control", () => ({
  retireCampaignDeliveryTasksForScenario: (...args: unknown[]) =>
    mockRetireCampaignDeliveryTasksForScenario(...args),
}));

jest.mock("@/lib/campaign/campaign-node-schedules", () => ({
  reconcileCampaignScenarioSchedules: (...args: unknown[]) =>
    mockReconcileCampaignScenarioSchedules(...args),
  retireCampaignScenarioSchedules: (...args: unknown[]) =>
    mockRetireCampaignScenarioSchedules(...args),
}));

jest.mock("@/lib/temporal/campaign-schedule-reconcile", () => ({
  startCampaignScheduleReconcileWorkflow: jest.fn(),
}));

jest.mock("@/lib/temporal/client", () => ({
  isTemporalConfigured: jest.fn(() => false),
}));

jest.mock("@/lib/limits/company-usage-events", () => ({
  emitWorkspaceUsageDeltaBestEffort: (...args: unknown[]) =>
    mockEmitWorkspaceUsageDeltaBestEffort(...args),
}));

import { normalizeScenarioNodesForPersistence } from "@/lib/scenarios/scenario-graph-persistence";
import { getPostActionConditionHandleId } from "@icecore/scenario-contracts";
import { createWhatsAppFlowEditableContentDigest } from "@/lib/scenarios/whatsapp-flow-projection";
import { resolveScenarioWhatsAppInteractiveFlowTarget } from "@/lib/scenarios/whatsapp-service-message";
import {
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  buildFlowBranchSourceHandleId,
  createDefaultScenarioWhatsAppServiceMessage,
  SCENARIO_WHATSAPP_SERVICE_MESSAGE_KINDS,
} from "@icecore/scenario-contracts";
import { Types } from "mongoose";
import { DELETE, GET, PATCH } from "./route";

const scenarioId = "65f000000000000000000001";

function createDeleteRequest(body?: Record<string, unknown>) {
  return new Request(
    `http://localhost/api/scenarios/${scenarioId}?workspaceId=workspace-1`,
    {
      method: "DELETE",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }
  );
}

function createPatchRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/scenarios/${scenarioId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchScenario(body: Record<string, unknown>) {
  return PATCH(createPatchRequest(body), {
    params: Promise.resolve({ scenarioId }),
  });
}

// Converts action-1's legacy post_action_condition routing (condition-1).
function patchConvertLegacy() {
  return patchScenario({
    operation: "convert_legacy_action_routing",
    workspaceId: "workspace-1",
    expectedUpdatedAt: "2026-05-04T07:26:11.684Z",
    sourceActionNodeId: "action-1",
    sourceNodeId: "condition-1",
    sourceKind: "post_action_condition",
  });
}

// trigger-1 → action-1 → legacy condition-1, whose no-reply branch routes to
// target-1.
function legacyConversionScenario() {
  return {
    _id: scenarioId,
    workspaceId: "workspace-1",
    name: "Conversation",
    mode: "conversation",
    status: "draft",
    updatedAt: new Date("2026-05-04T07:26:11.684Z"),
    nodes: [
      { id: "trigger-1", data: { kind: "trigger" } },
      { id: "action-1", data: { kind: "action", actionType: "reply" } },
      {
        id: "condition-1",
        data: {
          kind: "logic",
          logicType: "post_action_condition",
          conditionBranches: [
            { id: "timeout", type: "no_reply_timeout", timeoutMinutes: 30 },
          ],
        },
      },
      { id: "target-1", data: { kind: "action", actionType: "reply" } },
    ],
    edges: [
      { id: "entry", source: "trigger-1", target: "action-1" },
      { id: "input", source: "action-1", target: "condition-1" },
      {
        id: "timeout",
        source: "condition-1",
        sourceHandle: getPostActionConditionHandleId("no_reply_timeout"),
        target: "target-1",
      },
    ],
  };
}

// The editable part of a managed two-screen Flow (DETAILS → CONFIRM).
function editableTwoScreenFlow(
  flowNavigationMode: "data_endpoint" | "linear" = "data_endpoint"
) {
  return {
    templateId: "flow-local-1",
    ctaText: "Open",
    flowNavigationMode,
    screens: [
      { id: "DETAILS", title: "Details", fields: [] },
      { id: "CONFIRM", title: "Confirm", fields: [] },
    ],
    screenRoutes: { DETAILS: ["CONFIRM"], CONFIRM: [] },
  };
}

function leanResult<T>(value: T) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

function scenarioQuery<T>(value: T) {
  const query = {
    lean: jest.fn().mockResolvedValue(value),
    select: jest.fn(),
    session: jest.fn(),
  };
  query.select.mockReturnValue(query);
  query.session.mockReturnValue(query);
  return query;
}

function transactionSession() {
  return {
    withTransaction: jest.fn(async (callback: () => Promise<void>) =>
      callback()
    ),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
}

function arrangeNativeRoutingConversionState(params: {
  scenario: Record<string, unknown>;
  updatedScenario?: Record<string, unknown>;
  pendingConversations?: Array<Record<string, unknown>>;
  linkedConditions?: Array<Record<string, unknown>>;
}) {
  const rawScenario = {
    ...params.scenario,
    _id: new Types.ObjectId(scenarioId),
  };
  const rawUpdatedScenario = {
    ...(params.updatedScenario ?? params.scenario),
    _id: new Types.ObjectId(scenarioId),
  };
  mockScenarioCollectionFindOne.mockResolvedValue(rawScenario);
  mockScenarioCollectionFindOneAndUpdate.mockResolvedValue(rawUpdatedScenario);
  mockConversationCollectionFind.mockReturnValue({
    toArray: jest.fn().mockResolvedValue(params.pendingConversations ?? []),
  });
  mockLinkedConditionCollectionFind.mockReturnValue({
    toArray: jest.fn().mockResolvedValue(params.linkedConditions ?? []),
  });
  mockLinkedConditionCollectionUpdateOne.mockResolvedValue({
    matchedCount: 1,
    modifiedCount: 1,
  });
  return { rawScenario, rawUpdatedScenario };
}

function createDetailGetRequest(extraQuery = "") {
  return new Request(
    `http://localhost/api/scenarios/${scenarioId}?workspaceId=workspace-1${extraQuery}`
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flushAsyncWork() {
  for (let round = 0; round < 5; round += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

describe("GET /api/scenarios/[scenarioId]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const membershipQuery = {
      select: () => membershipQuery,
      eq: () => membershipQuery,
      maybeSingle: () => mockMembershipLookup(),
    };
    mockCreateSupabaseClient.mockResolvedValue({
      auth: {
        getUser: () => mockGetSessionUser(),
        getSession: async () => ({ data: { session: null } }),
      },
      from: () => membershipQuery,
    });
    mockGetSessionUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mockMembershipLookup.mockResolvedValue({
      data: { user_id: "user-1" },
      error: null,
    });
    mockEnrichScenarioNodesMediaDisplayUrls.mockImplementation(
      async ({ nodes }) => nodes
    );
    mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget.mockImplementation(
      async ({ nodes }) => ({ nodes, pending: false })
    );
    mockAttachLinkedParentScenarioIds.mockImplementation(
      async scenario => scenario
    );
    mockListOutstandingTimerReplanIngressForScenario.mockResolvedValue({
      status: null,
      affectedConversationIds: [],
      hasMore: false,
    });
  });

  it("returns linked-condition parent counts as response metadata, not node data", async () => {
    const scenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Child scenario",
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            linkedConditionId: "condition-1",
          },
        },
      ],
      edges: [],
    };
    mockConnectDB.mockResolvedValue(undefined);
    mockFindOne.mockReturnValue(leanResult(scenario));
    mockLoadLinkedConditionParentCountByNodeId.mockResolvedValue({
      "trigger-1": 2,
    });

    const response = await GET(
      new Request(
        `http://localhost/api/scenarios/${scenarioId}?workspaceId=workspace-1`
      ),
      { params: Promise.resolve({ scenarioId }) }
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.scenario.nodes[0].data).not.toHaveProperty(
      "uiLinkedConditionParentCount"
    );
    expect(payload.metadata).toEqual({
      linkedConditionParentCountByNodeId: {
        "trigger-1": 2,
      },
    });
  });

  it("surfaces durable timer recovery after a response is lost or the scenario is reopened", async () => {
    const scenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Recovered scenario",
      nodes: [],
      edges: [],
    };
    mockConnectDB.mockResolvedValue(undefined);
    mockFindOne.mockReturnValue(leanResult(scenario));
    mockLoadLinkedConditionParentCountByNodeId.mockResolvedValue({});
    mockListOutstandingTimerReplanIngressForScenario.mockResolvedValue({
      status: "pending",
      affectedConversationIds: ["conversation-1", "conversation-2"],
      hasMore: false,
    });

    const response = await GET(
      new Request(
        `http://localhost/api/scenarios/${scenarioId}?workspaceId=workspace-1`
      ),
      { params: Promise.resolve({ scenarioId }) }
    );

    await expect(response.json()).resolves.toMatchObject({
      metadata: {
        warnings: [
          {
            code: "legacy_action_routing_timer_replan_failed",
            recoveryStatus: "pending",
            affectedConversationIds: ["conversation-1", "conversation-2"],
            retryable: false,
          },
        ],
      },
    });
  });

  it("starts reading the scenario while the membership check is still running", async () => {
    const membership = deferred<{
      data: { user_id: string };
      error: null;
    }>();
    mockConnectDB.mockResolvedValue(undefined);
    mockMembershipLookup.mockReturnValueOnce(membership.promise);
    mockFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: scenarioId,
        workspaceId: "workspace-1",
        nodes: [],
        edges: [],
      }),
    });
    mockLoadLinkedConditionParentCountByNodeId.mockResolvedValue({});

    const responsePromise = GET(createDetailGetRequest(), {
      params: Promise.resolve({ scenarioId }),
    });
    await flushAsyncWork();

    expect(mockFindOne).toHaveBeenCalledWith({
      _id: scenarioId,
      workspaceId: "workspace-1",
      deletedAt: null,
    });
    // Nothing is serialized before access passes.
    expect(mockEnrichScenarioNodesMediaDisplayUrls).not.toHaveBeenCalled();
    expect(
      mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget
    ).not.toHaveBeenCalled();
    expect(mockLoadLinkedConditionParentCountByNodeId).not.toHaveBeenCalled();
    expect(
      mockListOutstandingTimerReplanIngressForScenario
    ).not.toHaveBeenCalled();

    membership.resolve({ data: { user_id: "user-1" }, error: null });
    const response = await responsePromise;
    expect(response.status).toBe(200);
  });

  it("reads nothing for a caller who is not signed in", async () => {
    mockGetSessionUser.mockResolvedValueOnce({ data: { user: null } });

    const response = await GET(createDetailGetRequest(), {
      params: Promise.resolve({ scenarioId }),
    });
    await flushAsyncWork();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockMembershipLookup).not.toHaveBeenCalled();
  });

  it("waits for the signed-in user before reading the scenario", async () => {
    const sessionUser = deferred<{ data: { user: { id: string } } }>();
    mockConnectDB.mockResolvedValue(undefined);
    mockGetSessionUser.mockReturnValueOnce(sessionUser.promise);
    mockFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: scenarioId,
        workspaceId: "workspace-1",
        nodes: [],
        edges: [],
      }),
    });
    mockLoadLinkedConditionParentCountByNodeId.mockResolvedValue({});

    const responsePromise = GET(createDetailGetRequest(), {
      params: Promise.resolve({ scenarioId }),
    });
    await flushAsyncWork();
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockFindOne).not.toHaveBeenCalled();

    sessionUser.resolve({ data: { user: { id: "user-1" } } });
    expect((await responsePromise).status).toBe(200);
    expect(mockFindOne).toHaveBeenCalledTimes(1);
  });

  it("returns the access denial unchanged and swallows the overlapping read", async () => {
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    try {
      mockConnectDB.mockResolvedValue(undefined);
      mockMembershipLookup.mockResolvedValueOnce({ data: null, error: null });
      mockFindOne.mockReturnValue({
        lean: jest.fn().mockRejectedValue(new Error("Mongo unavailable")),
      });

      const response = await GET(createDetailGetRequest(), {
        params: Promise.resolve({ scenarioId }),
      });
      await flushAsyncWork();

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
      expect(unhandled).not.toHaveBeenCalled();
      expect(mockLoggerError).not.toHaveBeenCalled();
      expect(mockEnrichScenarioNodesMediaDisplayUrls).not.toHaveBeenCalled();
      expect(
        mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget
      ).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("keeps 404 for a missing scenario and 500 for a failed read after access passes", async () => {
    mockConnectDB.mockResolvedValue(undefined);
    mockFindOne.mockReturnValueOnce(leanResult(null));

    const missing = await GET(createDetailGetRequest(), {
      params: Promise.resolve({ scenarioId }),
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: "Scenario not found",
    });

    const failure = new Error("Mongo unavailable");
    mockFindOne.mockReturnValueOnce({
      lean: jest.fn().mockRejectedValue(failure),
    });
    const failed = await GET(createDetailGetRequest(), {
      params: Promise.resolve({ scenarioId }),
    });
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({
      error: "Failed to load scenario",
    });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "scenario.load_failed",
      failure
    );
  });

  it("loads linked parents alongside media signing instead of after it", async () => {
    const media = deferred<unknown>();
    mockConnectDB.mockResolvedValue(undefined);
    mockFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: scenarioId,
        workspaceId: "workspace-1",
        nodes: [],
        edges: [],
      }),
    });
    mockLoadLinkedConditionParentCountByNodeId.mockResolvedValue({});
    mockEnrichScenarioNodesMediaDisplayUrls.mockReturnValue(media.promise);
    mockAttachLinkedParentScenarioIds.mockImplementation(async scenario => ({
      ...scenario,
      linkedParentScenarioIds: ["parent-1"],
    }));

    const responsePromise = GET(createDetailGetRequest(), {
      params: Promise.resolve({ scenarioId }),
    });
    await flushAsyncWork();
    expect(mockAttachLinkedParentScenarioIds).toHaveBeenCalledWith(
      expect.objectContaining({ _id: scenarioId }),
      "workspace-1"
    );

    media.resolve([{ id: "signed" }]);
    const payload = await (await responsePromise).json();
    expect(payload.scenario).toEqual(
      expect.objectContaining({
        nodes: [{ id: "signed" }],
        linkedParentScenarioIds: ["parent-1"],
      })
    );
    expect(payload.metadata).toEqual({
      linkedConditionParentCountByNodeId: {},
    });
  });

  it("time-boxes media signing for a deferred read and flags media that is still signing", async () => {
    const durable = {
      url: "gcs://media/workspaces/workspace-1/creative-assets/image/card.png",
      bucket: "media",
      path: "workspaces/workspace-1/creative-assets/image/card.png",
    };
    const nodes = [{ id: "action-1", data: { actionAttachments: [durable] } }];
    mockConnectDB.mockResolvedValue(undefined);
    mockFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: scenarioId,
        workspaceId: "workspace-1",
        nodes,
        edges: [],
      }),
    });
    mockLoadLinkedConditionParentCountByNodeId.mockResolvedValue({});
    mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget.mockImplementation(
      async (params: { nodes: unknown }) => ({
        nodes: params.nodes,
        pending: true,
      })
    );

    const response = await GET(
      createDetailGetRequest("&mediaSigning=deferred"),
      { params: Promise.resolve({ scenarioId }) }
    );
    const payload = await response.json();

    expect(
      mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      nodes,
      budgetMs: 1_500,
    });
    expect(mockEnrichScenarioNodesMediaDisplayUrls).not.toHaveBeenCalled();
    expect(payload.scenario.nodes[0].data.actionAttachments[0]).toEqual(
      durable
    );
    expect(payload.metadata).toEqual({
      linkedConditionParentCountByNodeId: {},
      mediaDisplayUrlsPending: true,
    });
  });

  it.each(["", "&mediaSigning=complete", "&mediaSigning=DEFERRED"])(
    "waits for every signed URL unless the reader asks for deferred media (%p)",
    async extraQuery => {
      const mediaPath = "workspaces/workspace-1/creative-assets/image/card.png";
      const nodes = [
        {
          id: "action-1",
          data: {
            actionAttachments: [
              {
                url: `gcs://media/${mediaPath}`,
                bucket: "media",
                path: mediaPath,
              },
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
      mockConnectDB.mockResolvedValue(undefined);
      mockFindOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: scenarioId,
          workspaceId: "workspace-1",
          nodes,
          edges: [],
        }),
      });
      mockLoadLinkedConditionParentCountByNodeId.mockResolvedValue({});
      mockEnrichScenarioNodesMediaDisplayUrls.mockResolvedValue(signedNodes);

      const response = await GET(createDetailGetRequest(extraQuery), {
        params: Promise.resolve({ scenarioId }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(mockEnrichScenarioNodesMediaDisplayUrls).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        nodes,
      });
      expect(
        mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget
      ).not.toHaveBeenCalled();
      expect(payload.scenario.nodes).toEqual(signedNodes);
      expect(payload.metadata).toEqual({
        linkedConditionParentCountByNodeId: {},
      });
    }
  );
});

describe("PATCH /api/scenarios/[scenarioId]", () => {
  it.each(["draft save", "activation", "active edit"])(
    "keeps business-event configuration inert on %s",
    async operation => {
      const triggerConfig = {
        entryPointType: "business_event",
        businessEvent: {
          integrationId: "forte-market",
          eventId: "order.status_changed",
          filters: [{ field: "status", operator: "equals", value: "shipped" }],
        },
      };
      const nodes = [
        { id: "trigger", data: { kind: "trigger", triggerConfig } },
        {
          id: "action",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyMode: "fixed",
            actionReplyText: "Order shipped",
          },
        },
      ];
      const edges = [{ source: "trigger", target: "action" }];
      const existingScenario = {
        _id: scenarioId,
        workspaceId: "workspace-1",
        status: operation === "active edit" ? "active" : "draft",
        updatedAt: new Date("2026-05-04T07:26:11.684Z"),
        nodes:
          operation === "active edit"
            ? nodes.map(node =>
                node.id === "trigger"
                  ? {
                      ...node,
                      data: {
                        kind: "trigger",
                        triggerConfig: { entryPointType: "message" },
                      },
                    }
                  : node
              )
            : nodes,
        edges,
      };
      mockFindOne.mockReturnValue(scenarioQuery(existingScenario));
      mockFindOneAndUpdate.mockImplementation((_query, mutation) => {
        const updated = { ...existingScenario, ...mutation.$set };
        mockFindOne.mockReturnValue(scenarioQuery(updated));
        return scenarioQuery(updated);
      });
      const response = await patchScenario({
        workspaceId: "workspace-1",
        ...(operation === "activation"
          ? { status: "active" }
          : { nodes, edges }),
      });
      if (operation === "draft save") {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          scenario: {
            status: "draft",
            nodes: [
              { id: "trigger", data: { triggerConfig } },
              { id: "action" },
            ],
          },
        });
      } else {
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          code: "businessEventIntegrationPending",
          nodeIds: ["trigger"],
        });
        expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      }
    }
  );
  beforeEach(() => {
    jest.clearAllMocks();
    mockBirthdaySettingsCreateIndex.mockResolvedValue("workspaceId_1");
    mockBirthdaySettingsUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockImportCustomerBirthdays.mockResolvedValue({ imported: 1, updated: 0 });
    mockConnectDB.mockResolvedValue(undefined);
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mockReconcileCampaignScenarioSchedules.mockResolvedValue(undefined);
    mockRetireCampaignScenarioSchedules.mockResolvedValue(undefined);
    mockRetireCampaignDeliveryTasksForScenario.mockResolvedValue(undefined);
    mockSyncScenarioLinkedConditions.mockResolvedValue(undefined);
    mockEnrichScenarioNodesMediaDisplayUrls.mockImplementation(
      async ({ nodes }) => nodes
    );
    mockAttachLinkedParentScenarioIds.mockImplementation(
      async scenario => scenario
    );
    mockLoadLinkedConditionParentCountByNodeId.mockResolvedValue({});
    mockListOutstandingTimerReplanIngressForScenario.mockResolvedValue({
      status: null,
      affectedConversationIds: [],
      hasMore: false,
    });
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
    mockLoadCurrentWhatsAppSourceWabaBindings.mockResolvedValue({
      "source-1": "waba-1",
    });
    mockLoadWhatsAppQrEntryPointReadinessByBindings.mockResolvedValue({});
    mockStartSession.mockResolvedValue(transactionSession());
    mockListWhatsAppQrScenarioSummaries.mockResolvedValue({});
    mockDetachWhatsAppQrEntryPointsForRemovedNodes.mockResolvedValue(undefined);
    mockReconcileWhatsAppQrDetachPendingForScenario.mockResolvedValue({
      attemptedNodeIds: [],
      failedNodeIds: [],
    });
    mockDetachWhatsAppQrEntryPointsForScenarioDeletion.mockResolvedValue(
      undefined
    );
    mockMarkWhatsAppQrDetachPendingNodes.mockResolvedValue(undefined);
    mockReconcileWhatsAppQrDetachPendingForScenario.mockResolvedValue({
      attemptedNodeIds: [],
      failedNodeIds: [],
    });
    mockFindWhatsAppFlowProvisioningOperations.mockReturnValue({
      select: jest.fn(() => ({
        lean: jest.fn().mockResolvedValue([]),
      })),
    });
    mockConversationFind.mockReturnValue({
      select: jest.fn(() => ({
        hint: jest.fn(() => ({
          session: jest.fn(() => ({
            lean: jest.fn().mockResolvedValue([]),
          })),
        })),
      })),
    });
    mockConversationUpdateMany.mockResolvedValue({
      matchedCount: 0,
      modifiedCount: 0,
    });
    mockConversationUpdateOne.mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    });
    mockConversationListIndexes.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        {
          name: "conversations_workspace_scenario_pending_wait_v2",
          key: {
            workspaceId: 1,
            "airi_scenario_state.lockedScenarioId": 1,
            "airi_scenario_state.pendingConditionNodeId": 1,
            "airi_scenario_state.pendingSourceActionNodeId": 1,
          },
          partialFilterExpression: {
            "airi_scenario_state.lockedScenarioId": { $type: "string" },
            "airi_scenario_state.pendingConditionNodeId": { $type: "string" },
          },
        },
      ]),
    });
    mockLinkedConditionFind.mockReturnValue({
      select: jest.fn(() => ({
        session: jest.fn(() => ({
          lean: jest.fn().mockResolvedValue([]),
        })),
        lean: jest.fn().mockResolvedValue([]),
      })),
    });
    mockLinkedConditionUpdateOne.mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    });
    const { validateScenarioGraph } = jest.requireActual(
      "@/lib/scenarios/graph-validation"
    ) as typeof import("@/lib/scenarios/graph-validation");
    mockValidateScenarioGraph.mockImplementation(validateScenarioGraph);
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
  ])("rejects $label before updating a scenario", async ({ graph }) => {
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Original graph",
      status: "draft",
      nodes: [],
      edges: [],
    };
    mockFindOne.mockReturnValue(scenarioQuery(existingScenario));
    mockFindOneAndUpdate.mockImplementation((_query, mutation) =>
      scenarioQuery({ ...existingScenario, ...mutation.$set })
    );

    const response = await patchScenario({
      workspaceId: "workspace-1",
      name: "Malformed graph",
      ...graph,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid scenario graph payload",
      code: "scenario_graph_invalid",
    });
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockValidateScenarioGraph).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    { label: "object nodes", graph: { nodes: {} } },
    { label: "null node data", graph: { nodes: [{ id: "a", data: null }] } },
    { label: "object edges", graph: { edges: {} } },
    { label: "missing edge target", graph: { edges: [{ source: "a" }] } },
    {
      label: "duplicate node IDs",
      graph: {
        nodes: [
          { id: "a", data: { kind: "action" } },
          { id: "a", data: { kind: "action" } },
        ],
      },
    },
  ])(
    "rejects stored $label before merging a replacement graph",
    async ({ graph }) => {
      const existingScenario = {
        _id: scenarioId,
        workspaceId: "workspace-1",
        name: "Malformed stored graph",
        status: "draft",
        nodes: [],
        edges: [],
        ...graph,
      };
      mockFindOne.mockReturnValue(scenarioQuery(existingScenario));
      mockFindOneAndUpdate.mockImplementation((_query, mutation) =>
        scenarioQuery({ ...existingScenario, ...mutation.$set })
      );

      const response = await patchScenario({
        workspaceId: "workspace-1",
        nodes: [],
        edges: [],
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid scenario graph payload",
        code: "scenario_graph_invalid",
      });
      expect(mockLoadCurrentWhatsAppSourceWabaBindings).not.toHaveBeenCalled();
      expect(mockValidateScenarioGraph).not.toHaveBeenCalled();
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  it.each(["viewport replacement", "deactivation"])(
    "allows %s when the stored viewport is null",
    async operation => {
      const existingScenario = {
        _id: scenarioId,
        workspaceId: "workspace-1",
        name: "Historic viewport",
        mode: "conversation",
        status: "active",
        viewport: null,
        nodes: [
          { id: "trigger-1", data: { kind: "trigger" } },
          { id: "action-1", data: { kind: "action", actionType: "reply" } },
        ],
        edges: [{ source: "trigger-1", target: "action-1" }],
      };
      const viewport = { x: 120, y: -30, zoom: 0.8 };
      mockFindOne.mockReturnValue(scenarioQuery(existingScenario));
      mockFindOneAndUpdate.mockImplementation((_query, mutation) =>
        scenarioQuery({ ...existingScenario, ...mutation.$set })
      );

      const response = await patchScenario({
        workspaceId: "workspace-1",
        ...(operation === "viewport replacement"
          ? { viewport }
          : { status: "draft" }),
      });

      expect(response.status).toBe(200);
      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
      await expect(response.json()).resolves.toMatchObject({
        scenario: {
          status: operation === "deactivation" ? "draft" : "active",
          ...(operation === "viewport replacement" ? { viewport } : {}),
        },
      });
      if (operation === "deactivation") {
        expect(mockFindOneAndUpdate.mock.calls[0]?.[1].$set).not.toHaveProperty(
          "viewport"
        );
      }
    }
  );

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
      const existingScenario = {
        _id: scenarioId,
        workspaceId: "workspace-1",
        name: "Unfinished graph",
        mode: "conversation",
        status: "draft",
        updatedAt: new Date("2026-05-04T07:26:11.684Z"),
        nodes: [{ id: "previous", data: { kind: "trigger" } }],
        edges: [],
      };
      mockFindOne.mockReturnValue(scenarioQuery(existingScenario));
      mockFindOneAndUpdate.mockImplementation((_query, mutation) => {
        const updated = { ...existingScenario, ...mutation.$set };
        mockFindOne.mockReturnValue(scenarioQuery(updated));
        return scenarioQuery(updated);
      });

      const response = await patchScenario({
        workspaceId: "workspace-1",
        status,
        nodes,
        edges,
      });

      if (status === "draft") {
        expect(response.status).toBe(200);
        expect(mockFindOneAndUpdate.mock.calls[0]?.[1]).toMatchObject({
          $set: { status, nodes, edges },
        });
        await expect(response.json()).resolves.toMatchObject({
          scenario: { status, nodes, edges },
        });
      } else {
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          code:
            graphKind === "empty" ? "oneTriggerRequired" : "singleFlowRequired",
          // The disconnected block is carried back so the editor can reveal it.
          ...(graphKind === "empty" ? {} : { nodeIds: ["unfinished"] }),
        });
        expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      }
    }
  );

  it.each(
    SCENARIO_WHATSAPP_SERVICE_MESSAGE_KINDS.flatMap(kind =>
      (["draft save", "activation", "active edit"] as const).map(operation => ({
        kind,
        operation,
      }))
    )
  )(
    "handles unfinished WhatsApp $kind on $operation",
    async ({ kind, operation }) => {
      const config = createDefaultScenarioWhatsAppServiceMessage(kind);
      const nodes = [
        { id: "trigger", data: { kind: "trigger" } },
        {
          id: "action",
          data: {
            kind: "action",
            actionType: "reply",
            actionWhatsAppServiceMessage: config,
          },
        },
      ];
      const edges = [{ source: "trigger", target: "action" }];
      const existingScenario = {
        _id: scenarioId,
        workspaceId: "workspace-1",
        name: "Unfinished WhatsApp action",
        status: operation === "active edit" ? "active" : "draft",
        updatedAt: new Date("2026-05-04T07:26:11.684Z"),
        nodes,
        edges,
      };
      mockFindOne.mockReturnValue(scenarioQuery(existingScenario));
      mockFindOneAndUpdate.mockImplementation((_query, mutation) => {
        const updated = { ...existingScenario, ...mutation.$set };
        mockFindOne.mockReturnValue(scenarioQuery(updated));
        return scenarioQuery(updated);
      });

      const response = await patchScenario({
        workspaceId: "workspace-1",
        ...(operation === "activation"
          ? { status: "active" }
          : { nodes, edges }),
      });

      if (operation === "draft save") {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          scenario: { nodes, edges },
        });
        expect(mockFindOneAndUpdate.mock.calls[0]?.[1]).toMatchObject({
          $set: { nodes, edges },
        });
      } else {
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          code: "whatsappServiceMessageInvalid",
        });
        expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      }
    }
  );

  it.each(
    [
      {
        label: "empty exact trigger",
        triggerConfig: { messageMatchMode: "exact", keywordPattern: "" },
        actionData: { actionType: "reply" },
        code: "messageTriggerIncomplete",
      },
      {
        label: "malformed trigger regex",
        triggerConfig: {
          messageMatchMode: "contains",
          keywordMatchMode: "regex",
          keywordPattern: "[",
        },
        actionData: { actionType: "reply" },
        code: "messageTriggerIncomplete",
      },
      {
        label: "unselected template",
        triggerConfig: { messageMatchMode: "any" },
        actionData: { actionType: "whatsapp_template" },
        code: "whatsappTemplateRequired",
      },
      {
        label: "unfinished handoff email",
        triggerConfig: { messageMatchMode: "any" },
        actionData: {
          actionType: "assign_human",
          actionHandoffNotifyEmail: "name@",
        },
        code: "handoffNotificationInvalid",
      },
      {
        label: "unfinished handoff WhatsApp number",
        triggerConfig: { messageMatchMode: "any" },
        actionData: {
          actionType: "assign_human",
          actionHandoffNotifyWhatsapp: "+",
        },
        code: "handoffNotificationInvalid",
      },
    ].flatMap(fixture =>
      (["draft save", "activation", "active edit"] as const).map(operation => ({
        ...fixture,
        operation,
      }))
    )
  )(
    "handles $label on $operation",
    async ({ triggerConfig, actionData, code, operation }) => {
      const nodes = [
        { id: "trigger", data: { kind: "trigger", triggerConfig } },
        { id: "action", data: { kind: "action", ...actionData } },
      ];
      const edges = [{ source: "trigger", target: "action" }];
      const existingScenario = {
        _id: scenarioId,
        workspaceId: "workspace-1",
        status: operation === "active edit" ? "active" : "draft",
        updatedAt: new Date("2026-05-04T07:26:11.684Z"),
        nodes,
        edges,
      };
      mockFindOne.mockReturnValue(scenarioQuery(existingScenario));
      mockFindOneAndUpdate.mockImplementation((_query, mutation) => {
        const updated = { ...existingScenario, ...mutation.$set };
        mockFindOne.mockReturnValue(scenarioQuery(updated));
        return scenarioQuery(updated);
      });

      const response = await patchScenario({
        workspaceId: "workspace-1",
        ...(operation === "activation"
          ? { status: "active" }
          : { nodes, edges }),
      });

      if (operation === "draft save") {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          scenario: {
            nodes: [
              {
                id: "trigger",
                data: {
                  triggerConfig:
                    triggerConfig.keywordPattern === ""
                      ? { messageMatchMode: "exact" }
                      : triggerConfig,
                },
              },
              { id: "action", data: actionData },
            ],
            edges,
          },
        });
      } else {
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ code });
        expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    {
      version: 1,
      message: {
        kind: "cta_url",
        body: { mode: "fixed", text: "Still typing" },
        buttonLabel: "Open",
        urlSource: { kind: "fixed", url: "https://" },
      },
    },
    {
      version: 1,
      message: {
        kind: "contacts",
        contacts: [
          { version: 1, firstName: "Still typing", phones: [{ phone: "+" }] },
        ],
      },
    },
  ])("round-trips partially typed WhatsApp draft values: %j", async config => {
    const nodes = [
      { id: "trigger", data: { kind: "trigger" } },
      {
        id: "action",
        data: { kind: "action", actionWhatsAppServiceMessage: config },
      },
    ];
    const edges = [{ source: "trigger", target: "action" }];
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      status: "draft",
      nodes,
      edges,
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
    };
    mockFindOne.mockReturnValue(scenarioQuery(existingScenario));
    mockFindOneAndUpdate.mockImplementation((_query, mutation) => {
      const updated = { ...existingScenario, ...mutation.$set };
      mockFindOne.mockReturnValue(scenarioQuery(updated));
      return scenarioQuery(updated);
    });

    const response = await patchScenario({
      workspaceId: "workspace-1",
      nodes,
      edges,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scenario: { nodes },
    });
    expect(mockFindOneAndUpdate.mock.calls[0]?.[1]).toMatchObject({
      $set: { nodes },
    });
  });

  it.each(["graph save", "activation", "mode-only update"])(
    "repairs stale bulk mode for a client-message graph on %s",
    async operation => {
      const nodes = [
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
            actionWhatsAppServiceMessage: {
              version: 1,
              message: {
                kind: "reply_buttons",
                body: { mode: "fixed", text: "Choose" },
                options: [{ id: "yes", label: "Yes" }],
              },
            },
          },
        },
      ];
      const edges = [{ source: "trigger-1", target: "action-1" }];
      const existingScenario = {
        _id: scenarioId,
        workspaceId: "workspace-1",
        name: "Client message",
        mode: "bulk_campaign",
        status: "draft",
        updatedAt: new Date("2026-05-04T07:26:11.684Z"),
        nodes:
          operation === "graph save"
            ? [{ id: "removed-bulk-root", data: { kind: "bulk" } }]
            : nodes,
        edges,
      };
      mockFindOne.mockReturnValue(scenarioQuery(existingScenario));
      mockFindOneAndUpdate.mockImplementationOnce((_query, mutation) => {
        const updated = { ...existingScenario, ...mutation.$set };
        mockFindOne.mockReturnValue(scenarioQuery(updated));
        return scenarioQuery(updated);
      });

      const response = await patchScenario({
        workspaceId: "workspace-1",
        ...(operation === "activation"
          ? { status: "active" }
          : operation === "mode-only update"
            ? { mode: "bulk_campaign" }
            : { nodes, edges }),
      });

      expect(response.status).toBe(200);
      expect(mockFindOneAndUpdate.mock.calls[0]?.[1]).toMatchObject({
        $set: { mode: "conversation" },
      });
      await expect(response.json()).resolves.toMatchObject({
        scenario: {
          mode: "conversation",
          status: operation === "activation" ? "active" : "draft",
        },
      });
      expect(mockRetireCampaignScenarioSchedules).toHaveBeenCalledTimes(1);
      expect(mockRetireCampaignScenarioSchedules.mock.calls[0]?.[0]).toEqual({
        workspaceId: "workspace-1",
        scenarioId,
        timezone: undefined,
        now: expect.any(Date),
      });
      expect(mockReconcileCampaignScenarioSchedules).not.toHaveBeenCalled();
    }
  );

  function arrangeActiveManagedFlowRoutingConversion(
    evidenceMode: "exact" | "missing" | "mismatched"
  ) {
    const session = transactionSession();
    const editableFlow = editableTwoScreenFlow();
    const contentDigest = createWhatsAppFlowEditableContentDigest(editableFlow);
    const projection = {
      operationId: "operation-complete",
      sourceId: "source-1",
      wabaId: "waba-1",
      contentRevision: 2,
      contentDigest,
      flowId: "provider-flow-1",
      providerStatus: "PUBLISHED" as const,
    };
    const evidence = {
      operationId: projection.operationId,
      nodeId: "action-1",
      sourceId: projection.sourceId,
      wabaId: projection.wabaId,
      contentDigest,
      providerFlowId: projection.flowId,
      status: "COMPLETED" as const,
      stage: "COMPLETED" as const,
    };
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Active managed Flow",
      mode: "conversation",
      status: "active",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes: [
        { id: "trigger-1", data: { kind: "trigger" } },
        {
          id: "action-1",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateName: "managed_flow_template",
            actionWhatsAppTemplateComponents: [
              {
                type: "BUTTONS",
                buttons: [
                  {
                    type: "FLOW",
                    text: "Open",
                    flow_id: projection.flowId,
                  },
                ],
              },
            ],
            actionFlowConfig: {
              ...editableFlow,
              managedProvisioning: projection,
            },
          },
        },
        {
          id: "condition-1",
          data: {
            kind: "logic",
            logicType: "post_action_condition",
            conditionBranches: [{ id: "reply", type: "user_replied" }],
          },
        },
        {
          id: "target-1",
          data: { kind: "action", actionType: "reply" },
        },
      ],
      edges: [
        { id: "entry", source: "trigger-1", target: "action-1" },
        { id: "input", source: "action-1", target: "condition-1" },
        {
          id: "reply",
          source: "condition-1",
          sourceHandle: getPostActionConditionHandleId("user_replied"),
          target: "target-1",
        },
      ],
    };
    const updatedScenario = {
      ...existingScenario,
      updatedAt: new Date("2026-05-04T07:30:00.000Z"),
    };
    const evidenceRows =
      evidenceMode === "missing"
        ? []
        : [
            evidenceMode === "mismatched"
              ? { ...evidence, sourceId: "source-other" }
              : evidence,
          ];
    const evidenceLean = jest.fn().mockResolvedValue(evidenceRows);
    const evidenceSession = jest.fn(() => ({ lean: evidenceLean }));
    const evidenceSelect = jest.fn(() => ({
      lean: evidenceLean,
      session: evidenceSession,
    }));

    mockStartSession.mockResolvedValue(session);
    mockFindOne.mockReturnValueOnce(leanResult(existingScenario));
    mockFindWhatsAppFlowProvisioningOperations.mockReturnValue({
      select: evidenceSelect,
    });
    arrangeNativeRoutingConversionState({
      scenario: existingScenario,
      updatedScenario,
    });

    return { evidence, evidenceSession, session };
  }

  it("rejects scenario names above the shared limit before writing", async () => {
    const response = await patchScenario({
      workspaceId: "workspace-1",
      name: "x".repeat(121),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "scenario_name_too_long",
      maxLength: 120,
    });
    expect(mockRequireScenarioWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects a newly authored legacy action-routing edge before graph validation or persistence", async () => {
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Canonical routing",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes: [],
      edges: [],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));

    const response = await patchScenario({
      workspaceId: "workspace-1",
      edges: [
        {
          id: "new-legacy-edge",
          source: "action-1",
          target: "condition-1",
          sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
        },
      ],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Legacy no-reply assignments can no longer be created",
      code: "legacy_action_routing_new_assignment_forbidden",
    });
    expect(mockValidateScenarioGraph).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("allows a preexisting legacy assignment to survive an edge-id-only graph save", async () => {
    const legacyEdge = {
      id: "legacy-edge",
      source: "action-1",
      target: "condition-1",
      sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
    };
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Legacy routing",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes: [],
      edges: [legacyEdge],
    };
    const normalizedEdge = { ...legacyEdge, id: "normalized-edge" };
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ...existingScenario,
        edges: [normalizedEdge],
      }),
    });
    mockValidateScenarioGraph.mockReturnValue(null);

    const response = await patchScenario({
      workspaceId: "workspace-1",
      edges: [normalizedEdge],
    });

    expect(response.status).toBe(200);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: scenarioId }),
      {
        $set: expect.objectContaining({ edges: [normalizedEdge] }),
      },
      { new: true }
    );
  });

  it("allows a stored generic Flow alias to survive client handle normalization", async () => {
    const nodes = [
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
    ];
    const specificFlowEdge = {
      id: "specific-flow-option",
      source: "flow-action",
      target: "condition-1",
      sourceHandle: buildFlowBranchSourceHandleId("plan", "one"),
    };
    const storedAlias = {
      id: "legacy-flow-alias",
      source: "flow-action",
      target: "condition-1",
      sourceHandle: ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
    };
    const normalizedAlias = {
      ...storedAlias,
      id: "normalized-flow-alias",
      sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
    };
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Legacy Flow routing",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes,
      edges: [storedAlias, specificFlowEdge],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ...existingScenario,
        edges: [normalizedAlias, specificFlowEdge],
      }),
    });
    mockValidateScenarioGraph.mockReturnValue(null);

    const response = await patchScenario({
      workspaceId: "workspace-1",
      edges: [normalizedAlias, specificFlowEdge],
    });

    expect(response.status).toBe(200);
    expect(mockValidateScenarioGraph).toHaveBeenCalled();
    expect(mockFindOneAndUpdate).toHaveBeenCalled();
  });

  it("converts legacy action routing atomically without dispatch side effects", async () => {
    const session = transactionSession();
    mockStartSession.mockResolvedValue(session);
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Conversation",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes: [
        {
          id: "trigger-1",
          data: { kind: "trigger", triggerType: "message" },
        },
        {
          id: "action-1",
          data: { kind: "action", actionType: "reply" },
        },
        {
          id: "condition-1",
          data: {
            kind: "logic",
            logicType: "post_action_condition",
            conditionBranches: [
              { id: "reply", type: "user_replied" },
              {
                id: "timeout",
                type: "no_reply_timeout",
                timeoutMinutes: 30,
              },
            ],
          },
        },
        {
          id: "target-1",
          data: { kind: "action", actionType: "reply" },
        },
      ],
      edges: [
        { id: "entry", source: "trigger-1", target: "action-1" },
        { id: "input", source: "action-1", target: "condition-1" },
        {
          id: "reply",
          source: "condition-1",
          sourceHandle: getPostActionConditionHandleId("user_replied"),
          target: "target-1",
        },
      ],
    };
    const updatedScenario = {
      ...existingScenario,
      updatedAt: new Date("2026-05-04T07:30:00.000Z"),
    };
    mockFindOne.mockReturnValueOnce(leanResult(existingScenario));
    arrangeNativeRoutingConversionState({
      scenario: existingScenario,
      updatedScenario,
    });

    const response = await patchConvertLegacy();

    expect(response.status).toBe(200);
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(session.endSession).toHaveBeenCalledTimes(1);
    expect(mockScenarioCollectionFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: new Types.ObjectId(scenarioId) }),
      expect.objectContaining({
        $set: expect.objectContaining({
          graphSchemaVersion: 1,
          nodes: expect.not.arrayContaining([
            expect.objectContaining({ id: "condition-1" }),
          ]),
          edges: expect.arrayContaining([
            expect.objectContaining({
              id: "reply",
              source: "action-1",
            }),
          ]),
        }),
      }),
      expect.objectContaining({
        returnDocument: "after",
        includeResultMetadata: false,
        session,
      })
    );
    expect(mockSyncScenarioLinkedConditions).not.toHaveBeenCalled();
    expect(mockReconcileCampaignScenarioSchedules).not.toHaveBeenCalled();
    expect(mockRetireCampaignScenarioSchedules).not.toHaveBeenCalled();
    expect(mockRetireCampaignDeliveryTasksForScenario).not.toHaveBeenCalled();
    expect(mockFindWhatsAppFlowProvisioningOperations).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("logs a rejected legacy conversion once with its code and source", async () => {
    const existingScenario = legacyConversionScenario();
    mockFindOne.mockReturnValueOnce(leanResult(existingScenario));
    arrangeNativeRoutingConversionState({
      scenario: existingScenario,
      pendingConversations: [
        {
          _id: "conversation-1",
          workspaceId: "workspace-1",
          updatedAt: new Date("2026-05-04T07:04:00.000Z"),
          __v: 0,
          // No outbound anchor: the waiting timer cannot be remapped losslessly.
          airi_scenario_state: {
            lockedScenarioId: scenarioId,
            pendingConditionNodeId: "condition-1",
            pendingSourceActionNodeId: "action-1",
            pendingStartedAt: new Date("2026-05-04T07:05:00.000Z"),
          },
        },
      ],
    });

    const response = await patchConvertLegacy();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "legacy_action_routing_pending_timer_identity_invalid",
    });
    expect(mockLoggerWarn.mock.calls).toEqual([
      [
        "scenario.legacy_routing_conversion_failed",
        {
          code: "legacy_action_routing_pending_timer_identity_invalid",
          status: 409,
          scenarioId,
          workspaceId: "workspace-1",
          sourceActionNodeId: "action-1",
          sourceKind: "post_action_condition",
        },
      ],
    ]);
    expect(mockLoggerError).not.toHaveBeenCalled();
    expect(mockScenarioCollectionFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "immediate timer delivery",
      endSessionError: null,
      timerReplanError: new Error("temporal unavailable"),
      enrichmentError: null,
      outstandingRecovery: {
        status: "pending" as const,
        affectedConversationIds: ["conversation-2"],
        hasMore: false,
      },
      expectedWarnings: [
        {
          code: "legacy_action_routing_timer_replan_failed",
          affectedConversationIds: ["conversation-2"],
          recoveryStatus: "pending",
          retryable: false,
        },
      ],
    },
    {
      label: "timer delivery completed concurrently",
      endSessionError: null,
      timerReplanError: new Error("temporal unavailable"),
      enrichmentError: null,
      outstandingRecovery: {
        status: null,
        affectedConversationIds: [],
        hasMore: false,
      },
      expectedWarnings: [],
    },
    {
      label: "session cleanup",
      endSessionError: new Error("session cleanup unavailable"),
      timerReplanError: null,
      enrichmentError: null,
      outstandingRecovery: null,
      expectedWarnings: [
        {
          code: "legacy_action_routing_session_cleanup_failed",
          affectedConversationIds: [],
        },
      ],
    },
    {
      label: "response enrichment after commit",
      endSessionError: null,
      timerReplanError: null,
      enrichmentError: new Error("linked metadata unavailable"),
      outstandingRecovery: null,
      expectedWarnings: [{ code: "scenario_detail_enrichment_failed" }],
    },
    {
      label: "timer delivery, session cleanup, and response enrichment",
      endSessionError: new Error("session cleanup unavailable"),
      timerReplanError: new Error("temporal unavailable"),
      enrichmentError: new Error("linked metadata unavailable"),
      outstandingRecovery: {
        status: null,
        affectedConversationIds: [],
        hasMore: false,
      },
      expectedWarnings: [
        {
          code: "legacy_action_routing_session_cleanup_failed",
          affectedConversationIds: [],
        },
        { code: "scenario_detail_enrichment_failed" },
      ],
    },
  ])(
    "returns the committed scenario with a typed warning when $label fails",
    async testCase => {
      const consoleError = testCase.enrichmentError
        ? jest.spyOn(console, "error").mockImplementation(() => undefined)
        : null;
      const session = {
        withTransaction: jest.fn(async callback => callback()),
        endSession: testCase.endSessionError
          ? jest.fn().mockRejectedValue(testCase.endSessionError)
          : jest.fn().mockResolvedValue(undefined),
      };
      mockStartSession.mockResolvedValue(session);
      const existingScenario = legacyConversionScenario();
      const updatedScenario = {
        ...existingScenario,
        updatedAt: new Date("2026-05-04T07:30:00.000Z"),
      };
      mockFindOne.mockReturnValueOnce(leanResult(existingScenario));
      arrangeNativeRoutingConversionState({
        scenario: existingScenario,
        updatedScenario,
        pendingConversations: [
          {
            _id: "conversation-1",
            workspaceId: "workspace-1",
            updatedAt: new Date("2026-05-04T07:04:00.000Z"),
            __v: 0,
            airi_scenario_state: {
              lockedScenarioId: scenarioId,
              pendingConditionNodeId: "condition-1",
              pendingSourceActionNodeId: "action-1",
              pendingStartedAt: new Date("2026-05-04T07:05:00.000Z"),
              pendingLastOutboundMessageId: "outbound-1",
            },
          },
        ],
      });
      mockConversationUpdateMany.mockResolvedValue({
        matchedCount: 1,
        modifiedCount: 1,
      });
      if (testCase.timerReplanError) {
        mockProcessTimerReplanIngressKeys.mockRejectedValueOnce(
          testCase.timerReplanError
        );
      }
      if (testCase.outstandingRecovery) {
        mockListOutstandingTimerReplanIngressForScenario.mockResolvedValue(
          testCase.outstandingRecovery
        );
      }
      if (testCase.enrichmentError) {
        mockLoadLinkedConditionParentCountByNodeId.mockRejectedValueOnce(
          testCase.enrichmentError
        );
      }

      const response = await patchConvertLegacy();

      expect(response.status).toBe(200);
      const responsePayload = await response.json();
      expect(responsePayload).toMatchObject({
        scenario: {
          _id: scenarioId,
          updatedAt: "2026-05-04T07:30:00.000Z",
        },
      });
      expect(responsePayload.metadata.warnings ?? []).toEqual(
        testCase.expectedWarnings.map(warning =>
          expect.objectContaining(warning)
        )
      );
      expect(mockScenarioCollectionFindOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).not.toHaveBeenCalled();
      if (consoleError) {
        expect(consoleError).toHaveBeenCalledWith(
          "[Scenarios API] Scenario committed but detail enrichment failed:",
          testCase.enrichmentError
        );
        consoleError.mockRestore();
      }
    }
  );

  it("converts an active managed Flow only with exact transaction-bound provisioning evidence", async () => {
    const { evidence, evidenceSession, session } =
      arrangeActiveManagedFlowRoutingConversion("exact");

    const response = await patchConvertLegacy();

    expect(response.status).toBe(200);
    expect(mockFindWhatsAppFlowProvisioningOperations).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
      operationId: { $in: [evidence.operationId] },
      status: "COMPLETED",
      stage: "COMPLETED",
    });
    expect(evidenceSession).toHaveBeenCalledWith(session);
    expect(mockValidateScenarioGraph).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      {
        mode: "runnable",
        completedWhatsAppFlowProvisioningOperations: [evidence],
        currentWhatsAppSourceWabaBindings: { "source-1": "waba-1" },
        whatsappQrEntryPointReadiness: {},
      }
    );
    expect(mockScenarioCollectionFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", "missing"],
    ["mismatched", "mismatched"],
  ] as const)(
    "rejects an active managed Flow conversion when provisioning evidence is %s",
    async (_label, evidenceMode) => {
      const { evidenceSession, session } =
        arrangeActiveManagedFlowRoutingConversion(evidenceMode);

      const response = await patchConvertLegacy();

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "whatsappServiceMessageInvalid",
      });
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "scenario.legacy_routing_conversion_failed",
        expect.objectContaining({
          code: "whatsappServiceMessageInvalid",
          status: 400,
        })
      );
      expect(evidenceSession).toHaveBeenCalledWith(session);
      expect(mockScenarioCollectionFindOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  it("folds an eligible audience gate through the same transaction", async () => {
    const session = transactionSession();
    mockStartSession.mockResolvedValue(session);
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Audience",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes: [
        { id: "trigger-1", data: { kind: "trigger" } },
        {
          id: "gate-1",
          data: {
            kind: "logic",
            logicType: "audience_filter",
            audienceMode: "internalLabel",
            internalLabel: "vip",
          },
        },
        {
          id: "action-1",
          data: { kind: "action", actionType: "reply" },
        },
      ],
      edges: [
        { id: "entry", source: "trigger-1", target: "gate-1" },
        { id: "gate-action", source: "gate-1", target: "action-1" },
      ],
    };
    mockFindOne.mockReturnValueOnce(leanResult(existingScenario));
    arrangeNativeRoutingConversionState({
      scenario: existingScenario,
      updatedScenario: {
        ...existingScenario,
        updatedAt: new Date("2026-05-04T07:30:00.000Z"),
      },
    });

    const response = await patchScenario({
      operation: "convert_legacy_action_routing",
      workspaceId: "workspace-1",
      expectedUpdatedAt: "2026-05-04T07:26:11.684Z",
      sourceActionNodeId: "action-1",
      sourceNodeId: "gate-1",
      sourceKind: "audience_filter",
    });

    expect(response.status).toBe(200);
    expect(mockScenarioCollectionFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: new Types.ObjectId(scenarioId) }),
      expect.objectContaining({
        $set: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: "action-1",
              data: expect.objectContaining({
                actionRunConditions: expect.objectContaining({
                  conditions: [
                    expect.objectContaining({
                      type: "internal_label",
                      label: "vip",
                    }),
                  ],
                }),
              }),
            }),
          ]),
          edges: [
            expect.objectContaining({
              id: "entry",
              source: "trigger-1",
              target: "action-1",
            }),
          ],
        }),
      }),
      expect.objectContaining({
        returnDocument: "after",
        includeResultMetadata: false,
        session,
      })
    );
    expect(mockSyncScenarioLinkedConditions).not.toHaveBeenCalled();
    expect(mockReconcileCampaignScenarioSchedules).not.toHaveBeenCalled();
    expect(mockRetireCampaignDeliveryTasksForScenario).not.toHaveBeenCalled();
  });

  it("returns the saved bulk campaign without waiting for inline schedule reconciliation", async () => {
    mockValidateScenarioGraph.mockReturnValue(null);
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Bulk campaign",
      mode: "bulk_campaign",
      status: "draft",
      updatedAt: "2026-05-04T07:26:11.684Z",
      nodes: [],
      edges: [],
    };
    const updatedScenario = {
      ...existingScenario,
      updatedAt: "2026-05-04T08:00:00.000Z",
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue(updatedScenario),
    });
    mockReconcileCampaignScenarioSchedules.mockImplementation(
      () => new Promise(() => {})
    );

    const response = await Promise.race([
      patchScenario({
        workspaceId: "workspace-1",
        expectedUpdatedAt: "2026-05-04T07:26:11.684Z",
        name: "Bulk campaign",
        status: "draft",
        mode: "bulk_campaign",
        nodes: [],
        edges: [],
      }),
      new Promise<"timed-out">(resolve =>
        setTimeout(() => resolve("timed-out"), 50)
      ),
    ]);

    expect(response).not.toBe("timed-out");
    expect(response).toHaveProperty("status", 200);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: scenarioId }),
      {
        $set: expect.objectContaining({
          graphSchemaVersion: 1,
          nodes: [],
          edges: [],
        }),
      },
      { new: true }
    );
    expect(mockReconcileCampaignScenarioSchedules).toHaveBeenCalledTimes(1);
    // Saves still wait for every signed URL; only reads are time-boxed.
    expect(mockEnrichScenarioNodesMediaDisplayUrls).toHaveBeenCalledTimes(1);
    expect(
      mockEnrichScenarioNodesMediaDisplayUrlsWithinBudget
    ).not.toHaveBeenCalled();
  });

  describe("builder birthday schedules", () => {
    // The builder keeps Scenario.mode "conversation"; its bulk root decides
    // whether a save owns campaign schedules.
    function builderRootNode(recipientAudienceSource: string) {
      return {
        id: "bulk-root",
        data: {
          kind: "bulk",
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            channels: ["whatsapp"],
            recipientAudienceSource,
            uploadedRecipients: [{ phone: "+77011234567", birthday: "01-01" }],
            scheduleConfig: {
              version: 2,
              mode: "recurring",
              timezone: "UTC",
              recurrence: { kind: "daily", time: "09:00" },
            },
          },
        },
      };
    }

    const templateNode = {
      id: "template-1",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "birthday_offer",
        actionWhatsAppTemplateLanguage: "en",
      },
    };
    const rootEdges = [
      {
        id: "root-template",
        source: "bulk-root",
        sourceHandle: "right-source",
        target: "template-1",
      },
    ];

    function telegramBirthdayNodes(sourceId = "telegram-source-1") {
      const root = builderRootNode("customer_birthdays");
      return [
        {
          ...root,
          data: {
            ...root.data,
            bulkRootConfig: {
              ...root.data.bulkRootConfig,
              channels: ["telegram"],
              telegramSubscriberSourceId: sourceId,
              uploadedRecipients: [{ chatId: "123", birthday: "01-01" }],
            },
          },
        },
        {
          id: "template-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "telegram",
            actionReplyMode: "fixed",
            actionReplyText: "Happy birthday!",
          },
        },
      ];
    }

    function arrangeBuilderSave(existing: {
      status: string;
      nodes: unknown[];
      edges: unknown[];
    }) {
      mockValidateScenarioGraph.mockReturnValue(null);
      const existingScenario = {
        _id: scenarioId,
        workspaceId: "workspace-1",
        name: "Birthday builder",
        mode: "conversation",
        updatedAt: "2026-05-04T07:26:11.684Z",
        ...existing,
      };
      mockFindOne.mockReturnValue(scenarioQuery(existingScenario));
      mockFindOneAndUpdate.mockImplementation((_query, mutation) => {
        const updated = { ...existingScenario, ...mutation.$set };
        mockFindOne.mockReturnValue(scenarioQuery(updated));
        return scenarioQuery(updated);
      });
    }

    async function patchBuilder(body: Record<string, unknown>) {
      const response = await patchScenario({
        workspaceId: "workspace-1",
        ...body,
      });
      expect(response.status).toBe(200);
      return response;
    }

    it("reconciles schedules when a draft saves a birthday root", async () => {
      arrangeBuilderSave({ status: "draft", nodes: [], edges: [] });

      await patchBuilder({
        nodes: [builderRootNode("customer_birthdays"), templateNode],
        edges: rootEdges,
      });

      expect(mockReconcileCampaignScenarioSchedules).toHaveBeenCalledTimes(1);
      expect(
        mockReconcileCampaignScenarioSchedules.mock.calls[0]?.[0]
      ).toMatchObject({ mode: "conversation", status: "draft" });
      expect(mockRetireCampaignScenarioSchedules).not.toHaveBeenCalled();
      expect(mockRetireCampaignDeliveryTasksForScenario).toHaveBeenCalledTimes(
        1
      );
      expect(mockFindOneAndUpdate.mock.calls[0]?.[1]).not.toHaveProperty(
        "$set.mode",
        "bulk_campaign"
      );
    });

    it("starts nothing for an uploaded-audience builder root", async () => {
      arrangeBuilderSave({ status: "draft", nodes: [], edges: [] });

      await patchBuilder({
        nodes: [builderRootNode("uploaded"), templateNode],
        edges: rootEdges,
      });

      expect(mockReconcileCampaignScenarioSchedules).not.toHaveBeenCalled();
      expect(mockRetireCampaignScenarioSchedules).not.toHaveBeenCalled();
      expect(mockRetireCampaignDeliveryTasksForScenario).not.toHaveBeenCalled();
    });

    it("reconciles schedules when the birthday root is removed", async () => {
      arrangeBuilderSave({
        status: "draft",
        nodes: [builderRootNode("customer_birthdays"), templateNode],
        edges: rootEdges,
      });

      await patchBuilder({ nodes: [templateNode], edges: [] });

      expect(mockReconcileCampaignScenarioSchedules).toHaveBeenCalledTimes(1);
      expect(
        mockReconcileCampaignScenarioSchedules.mock.calls[0]?.[0]
      ).toMatchObject({
        nodes: [expect.objectContaining({ id: "template-1" })],
      });
    });

    it("reconciles and retires delivery tasks when an active birthday scenario is paused", async () => {
      arrangeBuilderSave({
        status: "active",
        nodes: [builderRootNode("customer_birthdays"), templateNode],
        edges: rootEdges,
      });

      await patchBuilder({ status: "draft" });

      expect(mockReconcileCampaignScenarioSchedules).toHaveBeenCalledTimes(1);
      expect(
        mockReconcileCampaignScenarioSchedules.mock.calls[0]?.[0]
      ).toMatchObject({ status: "draft" });
      expect(mockRetireCampaignDeliveryTasksForScenario).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        scenarioId,
        reason: "scenario_inactive",
        now: expect.any(Date),
      });
    });

    // The birthday guard reads the other active scenarios that may hold a
    // birthday schedule.
    function activeBirthdayCandidates(rows: unknown[]) {
      mockScenarioFind.mockReturnValue(scenarioQuery(rows));
    }

    async function patchBuilderExpectingConflict() {
      const response = await patchScenario({
        workspaceId: "workspace-1",
        status: "active",
      });
      expect(response.status).toBe(409);
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockReconcileCampaignScenarioSchedules).not.toHaveBeenCalled();
      return response.json();
    }

    it("arms the schedule when a draft birthday scenario is activated", async () => {
      arrangeBuilderSave({
        status: "draft",
        nodes: [builderRootNode("customer_birthdays"), templateNode],
        edges: rootEdges,
      });
      activeBirthdayCandidates([]);

      await patchBuilder({ status: "active" });

      expect(mockScenarioFind).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "workspace-1",
          $or: expect.arrayContaining([{ mode: "bulk_campaign" }]),
          status: "active",
          deletedAt: null,
          _id: { $ne: scenarioId },
        })
      );
      expect(mockReconcileCampaignScenarioSchedules).toHaveBeenCalledTimes(1);
      expect(
        mockReconcileCampaignScenarioSchedules.mock.calls[0]?.[0]
      ).toMatchObject({ mode: "conversation", status: "active" });
      expect(mockRetireCampaignDeliveryTasksForScenario).not.toHaveBeenCalled();
      expect(mockCaptureFunnelEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "scenario_activated",
          workspaceId: "workspace-1",
          properties: expect.objectContaining({ scenario_id: scenarioId }),
        })
      );
    });

    it("rejects activation while another builder birthday scenario is active", async () => {
      arrangeBuilderSave({
        status: "draft",
        nodes: [builderRootNode("customer_birthdays"), templateNode],
        edges: rootEdges,
      });
      const otherScenarioId = "65f000000000000000000002";
      activeBirthdayCandidates([
        {
          _id: otherScenarioId,
          name: "Other birthdays",
          mode: "conversation",
          status: "active",
          nodes: [builderRootNode("customer_birthdays"), templateNode],
          edges: rootEdges,
        },
      ]);

      await expect(patchBuilderExpectingConflict()).resolves.toMatchObject({
        code: "birthday_scenario_already_active",
        conflictScenarioId: otherScenarioId,
        conflictScenarioName: "Other birthdays",
      });
      expect(mockCaptureFunnelEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "scenario_activation_blocked",
          workspaceId: "workspace-1",
          properties: { code: "birthday_conflict" },
        })
      );
      expect(mockCaptureFunnelEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "scenario_activated" })
      );
    });

    it("rejects activating two WhatsApp birthday roots in one scenario", async () => {
      const secondRoot = {
        ...builderRootNode("customer_birthdays"),
        id: "bulk-root-2",
      };
      const secondTemplate = { ...templateNode, id: "template-2" };
      arrangeBuilderSave({
        status: "draft",
        nodes: [
          builderRootNode("customer_birthdays"),
          templateNode,
          secondRoot,
          secondTemplate,
        ],
        edges: [
          ...rootEdges,
          {
            id: "root2-template2",
            source: "bulk-root-2",
            sourceHandle: "right-source",
            target: "template-2",
          },
        ],
      });
      activeBirthdayCandidates([]);

      await expect(patchBuilderExpectingConflict()).resolves.toMatchObject({
        code: "birthday_scenario_already_active",
        conflictScenarioId: scenarioId,
      });
      expect(mockScenarioFind).not.toHaveBeenCalled();
    });

    it("arms the selected bot schedule when a Telegram birthday draft is activated", async () => {
      arrangeBuilderSave({
        status: "draft",
        nodes: telegramBirthdayNodes(),
        edges: rootEdges,
      });
      activeBirthdayCandidates([]);
      await patchBuilder({ status: "active" });
      expect(mockScenarioFind).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "active",
          workspaceId: "workspace-1",
        })
      );
      expect(mockReconcileCampaignScenarioSchedules).toHaveBeenCalledTimes(1);
      expect(
        mockReconcileCampaignScenarioSchedules.mock.calls[0]?.[0]
      ).toMatchObject({ mode: "conversation", status: "active" });
    });

    it("rejects activation when another Telegram birthday scenario uses the same bot", async () => {
      arrangeBuilderSave({
        status: "draft",
        nodes: telegramBirthdayNodes(),
        edges: rootEdges,
      });
      activeBirthdayCandidates([
        {
          _id: "65f000000000000000000002",
          mode: "conversation",
          status: "active",
          nodes: telegramBirthdayNodes(),
          edges: rootEdges,
        },
      ]);
      await expect(patchBuilderExpectingConflict()).resolves.toMatchObject({
        code: "birthday_scenario_already_active",
      });
    });

    it("allows Telegram birthday activation when the existing campaign uses another bot", async () => {
      arrangeBuilderSave({
        status: "draft",
        nodes: telegramBirthdayNodes(),
        edges: rootEdges,
      });
      activeBirthdayCandidates([
        {
          _id: "65f000000000000000000002",
          mode: "conversation",
          status: "active",
          nodes: telegramBirthdayNodes("telegram-source-2"),
          edges: rootEdges,
        },
      ]);
      await patchBuilder({ status: "active" });
      expect(mockReconcileCampaignScenarioSchedules).toHaveBeenCalledTimes(1);
    });

    it("pauses Telegram birthday schedules and retires pending delivery tasks", async () => {
      arrangeBuilderSave({
        status: "active",
        nodes: telegramBirthdayNodes(),
        edges: rootEdges,
      });
      await patchBuilder({ status: "draft" });
      expect(
        mockReconcileCampaignScenarioSchedules.mock.calls[0]?.[0]
      ).toMatchObject({ status: "draft" });
      expect(mockRetireCampaignDeliveryTasksForScenario).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        scenarioId,
        reason: "scenario_inactive",
        now: expect.any(Date),
      });
    });

    it.each(["import failure", "zero saved rows"])(
      "rejects activation on %s before commit and can activate after a retry",
      async failure => {
        arrangeBuilderSave({
          status: "draft",
          nodes: telegramBirthdayNodes(),
          edges: rootEdges,
        });
        activeBirthdayCandidates([]);
        if (failure === "import failure") {
          mockImportCustomerBirthdays.mockRejectedValueOnce(
            new Error("birthday import unavailable")
          );
        } else {
          mockImportCustomerBirthdays.mockResolvedValueOnce({
            imported: 0,
            updated: 0,
          });
        }
        const response = await patchScenario({
          workspaceId: "workspace-1",
          status: "active",
        });
        expect(response.status).toBe(failure === "import failure" ? 500 : 400);
        expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
        expect(mockReconcileCampaignScenarioSchedules).not.toHaveBeenCalled();
        if (failure === "zero saved rows") {
          await expect(response.json()).resolves.toMatchObject({
            code: "birthdayRecipientsRequired",
          });
        }
        await patchBuilder({ status: "active" });
        expect(mockImportCustomerBirthdays).toHaveBeenCalledWith({
          workspaceId: "workspace-1",
          channel: "telegram",
          sourceId: "telegram-source-1",
          recipients: [{ chatId: "123", birthday: "01-01" }],
        });
      }
    );

    it("fences unchanged-audience graph edits without overwriting birthday profiles", async () => {
      arrangeBuilderSave({
        status: "active",
        nodes: telegramBirthdayNodes(),
        edges: rootEdges,
      });
      activeBirthdayCandidates([]);
      const session = transactionSession();
      mockStartSession.mockResolvedValueOnce(session);
      await patchBuilder({ nodes: telegramBirthdayNodes(), edges: rootEdges });
      expect(mockImportCustomerBirthdays).not.toHaveBeenCalled();
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { new: true, session }
      );
      expect(session.withTransaction).toHaveBeenCalledTimes(1);
      expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    it("does not overwrite customer birthdays during metadata-only edits", async () => {
      arrangeBuilderSave({
        status: "active",
        nodes: telegramBirthdayNodes(),
        edges: rootEdges,
      });
      activeBirthdayCandidates([]);
      await patchBuilder({ name: "Birthday greeting renamed" });
      expect(mockImportCustomerBirthdays).not.toHaveBeenCalled();
    });

    it("does not overwrite customer birthdays when only node placement or message text changes", async () => {
      arrangeBuilderSave({
        status: "active",
        nodes: telegramBirthdayNodes(),
        edges: rootEdges,
      });
      activeBirthdayCandidates([]);
      const nodes = telegramBirthdayNodes().map(node => ({
        ...node,
        position: { x: 200, y: 100 },
        data:
          node.data.kind === "action"
            ? { ...node.data, actionReplyText: "Happy birthday again!" }
            : node.data,
      }));
      await patchBuilder({ nodes, edges: rootEdges });
      expect(mockImportCustomerBirthdays).not.toHaveBeenCalled();
    });

    it.each(["uploaded audience", "selected bot", "channel"])(
      "imports changed birthday %s before committing an active graph edit",
      async change => {
        arrangeBuilderSave({
          status: "active",
          nodes: telegramBirthdayNodes(),
          edges: rootEdges,
        });
        activeBirthdayCandidates([]);
        const nodes: Array<{ id: string; data: Record<string, unknown> }> =
          change === "channel"
            ? [builderRootNode("customer_birthdays"), templateNode]
            : telegramBirthdayNodes(
                change === "selected bot"
                  ? "telegram-source-2"
                  : "telegram-source-1"
              );
        if (change === "uploaded audience") {
          const rootConfig = nodes[0]!.data.bulkRootConfig as Record<
            string,
            unknown
          >;
          rootConfig.uploadedRecipients = [
            { chatId: "456", birthday: "02-02" },
          ];
        }
        await patchBuilder({ nodes, edges: rootEdges });
        expect(mockImportCustomerBirthdays).toHaveBeenCalledTimes(1);
        expect(mockImportCustomerBirthdays).toHaveBeenCalledWith(
          expect.objectContaining(
            change === "selected bot"
              ? { sourceId: "telegram-source-2" }
              : change === "channel"
                ? {
                    channel: "whatsapp",
                    recipients: [{ phone: "+77011234567", birthday: "01-01" }],
                  }
                : { recipients: [{ chatId: "456", birthday: "02-02" }] }
          )
        );
      }
    );

    it("activates an audience already imported by the UI when every row is updated", async () => {
      arrangeBuilderSave({
        status: "draft",
        nodes: telegramBirthdayNodes(),
        edges: rootEdges,
      });
      activeBirthdayCandidates([]);
      mockImportCustomerBirthdays.mockResolvedValueOnce({
        imported: 0,
        updated: 1,
      });
      await patchBuilder({ status: "active" });
      expect(mockReconcileCampaignScenarioSchedules).toHaveBeenCalledTimes(1);
    });

    it("shares the birthday transaction session with QR activation fences", async () => {
      const qrNode = {
        id: "qr-trigger",
        data: {
          kind: "trigger",
          triggerConfig: {
            entryPointType: "whatsapp_qr",
            entryPointId: "qr-1",
          },
        },
      };
      arrangeBuilderSave({
        status: "draft",
        nodes: [...telegramBirthdayNodes(), qrNode],
        edges: rootEdges,
      });
      activeBirthdayCandidates([]);
      const session = transactionSession();
      mockStartSession.mockResolvedValueOnce(session);
      mockLoadWhatsAppQrEntryPointReadinessByBindings.mockResolvedValue({
        "qr-trigger": {
          entryPointId: "qr-1",
          ready: true,
          currentCodeId: "code-1",
          currentCodeVersion: 1,
        },
      });
      mockBirthdayQrCodeUpdateOne.mockResolvedValue({ matchedCount: 1 });
      await patchBuilder({ status: "active" });
      expect(mockStartSession).toHaveBeenCalledTimes(1);
      expect(session.withTransaction).toHaveBeenCalledTimes(1);
      expect(mockBirthdayQrCodeUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({ codeId: "code-1" }),
        expect.anything(),
        { session, runValidators: true }
      );
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { new: true, session }
      );
    });
  });

  it("preserves the stored entry policy on unrelated patches and ignores retired fields", async () => {
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Repeatable",
      mode: "conversation",
      status: "draft",
      entryPolicy: "repeatable",
      updatedAt: "2026-05-04T07:26:11.684Z",
      nodes: [],
      edges: [],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ...existingScenario,
        name: "Renamed",
      }),
    });
    mockValidateScenarioGraph.mockReturnValue(null);

    const response = await patchScenario({
      workspaceId: "workspace-1",
      name: "Renamed",
      loopScenario: false,
      journeyPoolKey: "retired",
    });

    expect(response.status).toBe(200);
    const update = mockFindOneAndUpdate.mock.calls[0]?.[1] as {
      $set: Record<string, unknown>;
    };
    expect(update.$set.name).toBe("Renamed");
    expect(update.$set).not.toHaveProperty("entryPolicy");
    expect(update.$set).not.toHaveProperty("loopScenario");
    expect(update.$set).not.toHaveProperty("journeyPoolKey");
  });

  it("keeps the current server projection when a stale full-graph save is otherwise unchanged", async () => {
    const editableFlow = editableTwoScreenFlow();
    const currentProjection = {
      operationId: "operation-current",
      sourceId: "source-1",
      wabaId: "waba-1",
      contentRevision: 4,
      contentDigest: createWhatsAppFlowEditableContentDigest(editableFlow),
      flowId: "provider-flow-current",
      providerStatus: "PUBLISHED" as const,
    };
    const staleProjection = {
      ...currentProjection,
      operationId: "operation-stale",
      contentRevision: 3,
      flowId: "provider-flow-stale",
    };
    const trigger = { id: "trigger-1", data: { kind: "trigger" } };
    const storedAction = {
      id: "action-1",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionFlowConfig: {
          ...editableFlow,
          managedProvisioning: currentProjection,
        },
      },
    };
    const incomingAction = {
      ...storedAction,
      data: {
        ...storedAction.data,
        actionFlowConfig: {
          ...editableFlow,
          managedProvisioning: staleProjection,
        },
      },
    };
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Managed Flow",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes: [trigger, storedAction],
      edges: [{ source: "trigger-1", target: "action-1" }],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockImplementation(async () => ({
        ...existingScenario,
        nodes: mockFindOneAndUpdate.mock.calls[0]?.[1]?.$set?.nodes,
      })),
    });

    const response = await patchScenario({
      workspaceId: "workspace-1",
      nodes: [trigger, incomingAction],
      edges: existingScenario.edges,
    });

    expect(response.status).toBe(200);
    const savedNodes = mockFindOneAndUpdate.mock.calls[0]?.[1]?.$set
      ?.nodes as Array<{
      data: import("@icecore/scenario-contracts").ScenarioNodeData;
    }>;
    const savedAction = savedNodes.find(node =>
      Boolean(resolveScenarioWhatsAppInteractiveFlowTarget(node.data))
    );
    const savedTarget = resolveScenarioWhatsAppInteractiveFlowTarget(
      savedAction!.data
    );
    expect(savedTarget?.config).toEqual({
      ...editableFlow,
      managedProvisioning: currentProjection,
    });
  });

  it("returns an atomic conflict when the observed updatedAt loses the final write race", async () => {
    const observedUpdatedAt = new Date("2026-05-04T07:26:11.684Z");
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Concurrent edit",
      mode: "conversation",
      status: "draft",
      updatedAt: observedUpdatedAt,
      nodes: [],
      edges: [],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });
    mockValidateScenarioGraph.mockReturnValue(null);

    const response = await patchScenario({
      workspaceId: "workspace-1",
      name: "Lost write",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "scenario_updated_conflict",
      currentUpdatedAt: observedUpdatedAt.toISOString(),
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: scenarioId,
        workspaceId: "workspace-1",
        deletedAt: null,
        updatedAt: observedUpdatedAt,
      },
      expect.any(Object),
      { new: true }
    );
  });

  it.each([false, true])(
    "returns the full reconciled graph and revision after a committed save (pending=%s)",
    async pending => {
      const observedUpdatedAt = new Date("2026-05-04T07:26:11.684Z");
      const committedUpdatedAt = new Date("2026-05-04T07:30:00.000Z");
      const reconciledUpdatedAt = new Date("2026-05-04T07:30:00.001Z");
      const existing = {
        _id: scenarioId,
        workspaceId: "workspace-1",
        name: "Linked parent",
        mode: "conversation",
        status: "draft",
        updatedAt: observedUpdatedAt,
        nodes: [
          {
            id: "condition-1",
            data: {
              kind: "logic",
              logicType: "post_action_condition",
              conditionBranches: [{ id: "reply", type: "user_replied" }],
            },
          },
        ],
        edges: [],
      };
      const committed = { ...existing, updatedAt: committedUpdatedAt };
      const reconciled = {
        ...existing,
        updatedAt: reconciledUpdatedAt,
        nodes: [
          {
            ...existing.nodes[0],
            data: {
              ...existing.nodes[0].data,
              conditionBranches: [
                {
                  id: "reply",
                  type: "user_replied",
                  linkedConditionId: "linked-condition-1",
                },
              ],
            },
          },
        ],
      };
      let persisted = existing;
      mockFindOne.mockImplementation(() => scenarioQuery(persisted));
      mockFindOneAndUpdate.mockImplementation(() => {
        persisted = committed;
        return scenarioQuery(committed);
      });
      mockValidateScenarioGraph.mockReturnValue(null);
      mockSyncScenarioLinkedConditions.mockImplementation(async () => {
        persisted = reconciled;
        if (pending) throw new Error("linked_condition_revision_conflict");
      });

      const response = await patchScenario({
        workspaceId: "workspace-1",
        nodes: existing.nodes,
        edges: [],
      });

      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.scenario.updatedAt).toBe(
        reconciledUpdatedAt.toISOString()
      );
      expect(payload.scenario.nodes).toEqual(reconciled.nodes);
      expect(mockSyncScenarioLinkedConditions).toHaveBeenCalledTimes(
        pending ? 2 : 1
      );
      if (pending) {
        expect(payload.metadata.warnings).toEqual([
          expect.objectContaining({
            code: "linked_condition_reconciliation_pending",
          }),
        ]);
      } else {
        expect(payload.metadata.warnings).toBeUndefined();
      }
    }
  );

  it.each([
    ["media", mockEnrichScenarioNodesMediaDisplayUrls],
    ["linked condition counts", mockLoadLinkedConditionParentCountByNodeId],
    ["linked parents", mockAttachLinkedParentScenarioIds],
    ["timer recovery", mockListOutstandingTimerReplanIngressForScenario],
  ])(
    "acknowledges an ordinary committed graph save when %s enrichment fails",
    async (_label, enrich) => {
      const failure = new Error("Fixture detail enrichment unavailable");
      const consoleError = jest.spyOn(console, "error").mockImplementation();
      const existing = {
        _id: scenarioId,
        workspaceId: "workspace-1",
        name: "Ordinary save",
        mode: "conversation",
        status: "draft",
        updatedAt: new Date("2026-05-04T07:26:11.684Z"),
        nodes: [
          { id: "action-1", data: { kind: "action", actionType: "reply" } },
        ],
        edges: [],
      };
      const committed = {
        ...existing,
        updatedAt: new Date("2026-05-04T07:30:00.000Z"),
      };
      let persisted = existing;
      mockFindOne.mockImplementation(() => scenarioQuery(persisted));
      mockFindOneAndUpdate.mockImplementation(() => {
        persisted = committed;
        return scenarioQuery(committed);
      });
      mockValidateScenarioGraph.mockReturnValue(null);
      mockSyncScenarioLinkedConditions.mockRejectedValue(
        new Error("linked_condition_revision_conflict")
      );
      enrich.mockRejectedValueOnce(failure);
      if (enrich === mockListOutstandingTimerReplanIngressForScenario) {
        // The fallback also tolerates a still-unavailable recovery service.
        enrich.mockRejectedValueOnce(failure);
      }

      try {
        const response = await patchScenario({
          workspaceId: "workspace-1",
          nodes: existing.nodes,
          edges: [],
        });

        expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.scenario).toEqual({
          ...committed,
          updatedAt: committed.updatedAt.toISOString(),
        });
        expect(payload.metadata).toEqual({
          linkedConditionParentCountByNodeId: {},
          warnings: [
            expect.objectContaining({
              code: "linked_condition_reconciliation_pending",
            }),
            expect.objectContaining({
              code: "scenario_detail_enrichment_failed",
            }),
          ],
        });
        expect(consoleError).toHaveBeenCalledWith(
          "[Scenarios API] Scenario committed but detail enrichment failed:",
          failure
        );
      } finally {
        enrich.mockReset();
        consoleError.mockRestore();
      }
    }
  );

  it("retries linked-condition reconciliation from fresh Scenario truth after the primary save commits", async () => {
    const observedUpdatedAt = new Date("2026-05-04T07:26:11.684Z");
    const updatedAt = new Date("2026-05-04T07:30:00.000Z");
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Linked parent",
      mode: "conversation",
      status: "draft",
      updatedAt: observedUpdatedAt,
      nodes: [],
      edges: [],
    };
    mockFindOne
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue(existingScenario),
      })
      .mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          ...existingScenario,
          updatedAt,
        }),
      });
    mockConversationUpdateOne.mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    });
    mockLinkedConditionFind.mockReturnValue({
      select: jest.fn(() => ({
        session: jest.fn(() => ({
          lean: jest.fn().mockResolvedValue([]),
        })),
        lean: jest.fn().mockResolvedValue([]),
      })),
    });
    mockLinkedConditionUpdateOne.mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    });
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ...existingScenario,
        updatedAt,
      }),
    });
    mockValidateScenarioGraph.mockReturnValue(null);
    mockSyncScenarioLinkedConditions.mockRejectedValueOnce(
      new Error("linked_condition_revision_conflict")
    );

    const response = await patchScenario({
      workspaceId: "workspace-1",
      nodes: [],
      edges: [],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scenario: expect.objectContaining({
        _id: scenarioId,
        updatedAt: updatedAt.toISOString(),
      }),
      metadata: { linkedConditionParentCountByNodeId: {} },
    });
    expect(mockSyncScenarioLinkedConditions).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      scenarioId,
      scenario: expect.objectContaining({ updatedAt }),
    });
  });

  it("acknowledges the committed save with a warning when bounded linked reconciliation cannot converge", async () => {
    const observedUpdatedAt = new Date("2026-05-04T07:26:11.684Z");
    const updatedAt = new Date("2026-05-04T07:30:00.000Z");
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Linked parent",
      mode: "conversation",
      status: "draft",
      updatedAt: observedUpdatedAt,
      nodes: [],
      edges: [],
    };
    mockFindOne
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue(existingScenario),
      })
      .mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          ...existingScenario,
          updatedAt,
        }),
      });
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ ...existingScenario, updatedAt }),
    });
    mockValidateScenarioGraph.mockReturnValue(null);
    mockSyncScenarioLinkedConditions.mockRejectedValue(
      new Error("linked_condition_revision_conflict")
    );

    const response = await patchScenario({
      workspaceId: "workspace-1",
      nodes: [],
      edges: [],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scenario: expect.objectContaining({
        _id: scenarioId,
        updatedAt: updatedAt.toISOString(),
      }),
      metadata: {
        linkedConditionParentCountByNodeId: {},
        warnings: [
          {
            code: "linked_condition_reconciliation_pending",
            affectedScenarioIds: [scenarioId],
          },
        ],
      },
    });
    expect(mockSyncScenarioLinkedConditions).toHaveBeenCalledTimes(2);
  });

  it("loads bounded completed operation evidence before activating a managed linear Flow", async () => {
    const editableFlow = editableTwoScreenFlow("linear");
    const contentDigest = createWhatsAppFlowEditableContentDigest(editableFlow);
    const projection = {
      operationId: "operation-complete",
      sourceId: "source-1",
      wabaId: "waba-1",
      contentRevision: 2,
      contentDigest,
      flowId: "provider-flow-1",
      providerStatus: "PUBLISHED" as const,
    };
    const nodes = [
      { id: "trigger-1", data: { kind: "trigger" } },
      {
        id: "action-1",
        data: {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "managed_flow_template",
          actionWhatsAppTemplateComponents: [
            {
              type: "BUTTONS",
              buttons: [
                {
                  type: "FLOW",
                  text: "Open",
                  flow_id: projection.flowId,
                },
              ],
            },
          ],
          actionFlowConfig: {
            ...editableFlow,
            managedProvisioning: projection,
          },
        },
      },
    ];
    const evidence = {
      operationId: projection.operationId,
      nodeId: "action-1",
      sourceId: projection.sourceId,
      wabaId: projection.wabaId,
      contentDigest,
      providerFlowId: projection.flowId,
      status: "COMPLETED",
      stage: "COMPLETED",
    };
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Managed Flow",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes,
      edges: [{ source: "trigger-1", target: "action-1" }],
    };
    mockFindOne.mockReturnValue(scenarioQuery(existingScenario));
    const lean = jest.fn().mockResolvedValue([evidence]);
    const select = jest.fn(() => ({ lean }));
    mockFindWhatsAppFlowProvisioningOperations.mockReturnValue({ select });
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ...existingScenario,
        status: "active",
      }),
    });

    const response = await patchScenario({
      workspaceId: "workspace-1",
      status: "active",
    });

    expect(response.status).toBe(200);
    expect(mockFindWhatsAppFlowProvisioningOperations).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
      operationId: { $in: [projection.operationId] },
      status: "COMPLETED",
      stage: "COMPLETED",
    });
    expect(mockValidateScenarioGraph).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      {
        mode: "runnable",
        completedWhatsAppFlowProvisioningOperations: [evidence],
        currentWhatsAppSourceWabaBindings: { "source-1": "waba-1" },
        whatsappQrEntryPointReadiness: {},
      }
    );
  });

  it("loads live source evidence before activating a published provider reference", async () => {
    const nodes = [
      { id: "trigger-1", data: { kind: "trigger" } },
      {
        id: "action-1",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "whatsapp",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "flow",
              body: { mode: "fixed", text: "Open the Flow" },
              flowConfig: {
                templateId: "provider-reference",
                ctaText: "Open",
                screens: [{ id: "START", title: "Start", fields: [] }],
                providerReference: {
                  flowId: "provider-flow-1",
                  sourceId: "source-reference",
                  wabaId: "waba-reference",
                  providerStatus: "PUBLISHED",
                  jsonVersion: "7.3",
                },
              },
            },
          },
        },
      },
    ];
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Provider Flow",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes,
      edges: [{ source: "trigger-1", target: "action-1" }],
    };
    mockFindOne.mockReturnValue(scenarioQuery(existingScenario));
    mockLoadCurrentWhatsAppSourceWabaBindings.mockResolvedValueOnce({
      "source-reference": "waba-reference",
    });
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ...existingScenario,
        status: "active",
      }),
    });

    const response = await patchScenario({
      workspaceId: "workspace-1",
      status: "active",
    });

    expect(response.status).toBe(200);
    expect(mockLoadCurrentWhatsAppSourceWabaBindings).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceIds: ["source-reference"],
    });
    expect(mockValidateScenarioGraph).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      expect.objectContaining({
        currentWhatsAppSourceWabaBindings: {
          "source-reference": "waba-reference",
        },
      })
    );
  });

  it("blocks activation when WhatsApp QR triggers lack usable readiness", async () => {
    const nodes = [
      {
        id: "trigger-qr",
        data: {
          kind: "trigger",
          triggerConfig: { entryPointType: "whatsapp_qr" },
        },
      },
      {
        id: "action-1",
        data: { kind: "action", actionType: "reply" },
      },
    ];
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "QR scenario",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes,
      edges: [{ source: "trigger-qr", target: "action-1" }],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockLoadWhatsAppQrEntryPointReadinessByBindings.mockResolvedValueOnce({});

    const response = await patchScenario({
      workspaceId: "workspace-1",
      status: "active",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "whatsappQrEntryPointIncomplete",
    });
    expect(
      mockLoadWhatsAppQrEntryPointReadinessByBindings
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
      bindings: [{ nodeId: "trigger-qr", entryPointId: null }],
    });
    expect(mockValidateScenarioGraph).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      expect.objectContaining({
        mode: "runnable",
        whatsappQrEntryPointReadiness: {},
      })
    );
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("detaches WhatsApp QR entry points when graph nodes are removed", async () => {
    mockValidateScenarioGraph.mockReturnValue(null);
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "QR scenario",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes: [
        {
          id: "trigger-qr",
          data: {
            kind: "trigger",
            triggerConfig: { entryPointType: "whatsapp_qr" },
          },
        },
        {
          id: "trigger-keep",
          data: { kind: "trigger" },
        },
        {
          id: "action-1",
          data: { kind: "action", actionType: "reply" },
        },
      ],
      edges: [
        { source: "trigger-qr", target: "action-1" },
        { source: "trigger-keep", target: "action-1" },
      ],
    };
    const nextNodes = [
      {
        id: "trigger-keep",
        data: { kind: "trigger" },
      },
      {
        id: "action-1",
        data: { kind: "action", actionType: "reply" },
      },
    ];
    const nextEdges = [{ source: "trigger-keep", target: "action-1" }];
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ...existingScenario,
        nodes: nextNodes,
        edges: nextEdges,
      }),
    });

    const response = await patchScenario({
      workspaceId: "workspace-1",
      nodes: nextNodes,
      edges: nextEdges,
    });

    expect(response.status).toBe(200);
    expect(
      mockReconcileWhatsAppQrDetachPendingForScenario
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
    });
  });

  it("returns the committed scenario with a warning when removed QR entry points cannot be detached", async () => {
    mockValidateScenarioGraph.mockReturnValue(null);
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "QR scenario",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes: [
        {
          id: "trigger-qr",
          data: {
            kind: "trigger",
            triggerConfig: { entryPointType: "whatsapp_qr" },
          },
        },
      ],
      edges: [],
    };
    const updatedScenario = {
      ...existingScenario,
      nodes: [],
      updatedAt: new Date("2026-05-04T07:30:00.000Z"),
    };
    mockFindOne
      .mockReturnValueOnce(scenarioQuery(existingScenario))
      .mockReturnValue(scenarioQuery(updatedScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue(updatedScenario),
    });
    mockReconcileWhatsAppQrDetachPendingForScenario.mockResolvedValueOnce({
      attemptedNodeIds: ["trigger-qr"],
      failedNodeIds: ["trigger-qr"],
    });

    const response = await patchScenario({
      workspaceId: "workspace-1",
      nodes: [],
      edges: [],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scenario: expect.objectContaining({ _id: scenarioId, nodes: [] }),
      metadata: {
        warnings: [
          {
            code: "whatsapp_qr_entry_point_detach_pending",
            affectedNodeIds: ["trigger-qr"],
          },
        ],
      },
    });
    expect(
      mockReconcileWhatsAppQrDetachPendingForScenario
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: scenarioId,
        workspaceId: "workspace-1",
      }),
      {
        $set: expect.objectContaining({
          whatsappQrDetachPendingNodeIds: ["trigger-qr"],
          whatsappQrDetachNextRetryAt: expect.any(Date),
        }),
      },
      { new: true }
    );
  });

  it("retains pending QR cleanup until reconciliation verifies the re-added trigger", async () => {
    mockValidateScenarioGraph.mockReturnValue(null);
    const qrNode = {
      id: "trigger-qr",
      data: {
        kind: "trigger",
        triggerConfig: { entryPointType: "whatsapp_qr" },
      },
    };
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "QR scenario",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes: [],
      edges: [],
      whatsappQrDetachPendingNodeIds: ["trigger-qr"],
      whatsappQrDetachNextRetryAt: new Date("2026-05-04T07:31:00.000Z"),
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ...existingScenario,
        nodes: [qrNode],
      }),
    });

    const response = await patchScenario({
      workspaceId: "workspace-1",
      nodes: [qrNode],
      edges: [],
    });

    expect(response.status).toBe(200);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: scenarioId,
        workspaceId: "workspace-1",
      }),
      {
        $set: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({ id: "trigger-qr" }),
          ]),
          whatsappQrDetachPendingNodeIds: ["trigger-qr"],
          whatsappQrDetachNextRetryAt: expect.any(Date),
        }),
      },
      { new: true }
    );
    expect(
      mockReconcileWhatsAppQrDetachPendingForScenario
    ).toHaveBeenCalledWith({ workspaceId: "workspace-1", scenarioId });
  });

  it("detaches WhatsApp QR entry points when a retained node changes to a normal message trigger", async () => {
    mockValidateScenarioGraph.mockReturnValue(null);
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "QR scenario",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes: [
        {
          id: "trigger-qr",
          data: {
            kind: "trigger",
            triggerConfig: { entryPointType: "whatsapp_qr" },
          },
        },
        {
          id: "action-1",
          data: { kind: "action", actionType: "reply" },
        },
      ],
      edges: [{ source: "trigger-qr", target: "action-1" }],
    };
    const nextNodes = [
      {
        id: "trigger-qr",
        data: {
          kind: "trigger",
          triggerConfig: { entryPointType: "message" },
        },
      },
      {
        id: "action-1",
        data: { kind: "action", actionType: "reply" },
      },
    ];
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest
        .fn()
        .mockResolvedValue({ ...existingScenario, nodes: nextNodes }),
    });

    const response = await patchScenario({
      workspaceId: "workspace-1",
      nodes: nextNodes,
      edges: existingScenario.edges,
    });

    expect(response.status).toBe(200);
    expect(
      mockReconcileWhatsAppQrDetachPendingForScenario
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
    });
  });

  it("rejects editable Flow changes while a scenario remains active", async () => {
    const originalFlow = {
      templateId: "flow-local-1",
      ctaText: "Open",
      flowNavigationMode: "linear" as const,
      screens: [{ id: "DETAILS", title: "Details", fields: [] }],
      metaFlowId: "provider-flow-1",
      metaFlowStatus: "PUBLISHED",
    };
    const trigger = { id: "trigger-1", data: { kind: "trigger" } };
    const action = {
      id: "action-1",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "managed_flow_template",
        actionFlowConfig: originalFlow,
      },
    };
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Active Flow",
      mode: "conversation",
      status: "active",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes: [trigger, action],
      edges: [{ source: "trigger-1", target: "action-1" }],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));

    const response = await patchScenario({
      workspaceId: "workspace-1",
      expectedUpdatedAt: "2026-05-04T07:26:11.684Z",
      nodes: [
        trigger,
        {
          ...action,
          data: {
            ...action.data,
            actionFlowConfig: { ...originalFlow, ctaText: "Changed" },
          },
        },
      ],
      edges: existingScenario.edges,
    });

    expect(response.status).toBe(400);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects activation when a new endpoint node forges legacy provider fields", async () => {
    const trigger = { id: "trigger-1", data: { kind: "trigger" } };
    const action = {
      id: "action-1",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "endpoint_template",
        actionFlowConfig: {
          templateId: "flow-local-1",
          ctaText: "Open",
          flowNavigationMode: "data_endpoint" as const,
          screens: [
            { id: "DETAILS", title: "Details", fields: [] },
            { id: "CONFIRM", title: "Confirm", fields: [] },
          ],
          screenRoutes: { DETAILS: ["CONFIRM"], CONFIRM: [] },
          metaFlowId: "attacker-flow",
          metaFlowStatus: "PUBLISHED",
        },
      },
    };
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Draft",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes: [trigger],
      edges: [],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));

    const response = await patchScenario({
      workspaceId: "workspace-1",
      status: "active",
      nodes: [trigger, action],
      edges: [{ source: "trigger-1", target: "action-1" }],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "whatsappServiceMessageInvalid",
    });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects activation when edited endpoint content invalidates its projection", async () => {
    const editableFlow = editableTwoScreenFlow();
    const projection = {
      operationId: "operation-complete",
      sourceId: "source-1",
      wabaId: "waba-1",
      contentRevision: 2,
      contentDigest: createWhatsAppFlowEditableContentDigest(editableFlow),
      flowId: "provider-flow-1",
      providerStatus: "PUBLISHED" as const,
    };
    const trigger = { id: "trigger-1", data: { kind: "trigger" } };
    const storedAction = {
      id: "action-1",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "endpoint_template",
        actionFlowConfig: {
          ...editableFlow,
          managedProvisioning: projection,
        },
      },
    };
    const incomingAction = {
      ...storedAction,
      data: {
        ...storedAction.data,
        actionFlowConfig: {
          ...storedAction.data.actionFlowConfig,
          ctaText: "Changed after provisioning",
        },
      },
    };
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Managed Flow",
      mode: "conversation",
      status: "draft",
      updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      nodes: [trigger, storedAction],
      edges: [{ source: "trigger-1", target: "action-1" }],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));

    const response = await patchScenario({
      workspaceId: "workspace-1",
      status: "active",
      nodes: [trigger, incomingAction],
      edges: existingScenario.edges,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "whatsappServiceMessageInvalid",
    });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("validates the canonical trigger graph that it will persist", async () => {
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Canonical validation",
      mode: "conversation",
      status: "draft",
      updatedAt: "2026-05-04T07:26:11.684Z",
      nodes: [],
      edges: [],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue(existingScenario),
    });
    mockValidateScenarioGraph.mockImplementationOnce(nodes => {
      const trigger = nodes[0]?.data;
      return trigger &&
        !Object.prototype.hasOwnProperty.call(trigger, "triggerType") &&
        trigger.triggerConfig?.enabled === false
        ? "reserved_persisted_node_id"
        : null;
    });

    const response = await patchScenario({
      workspaceId: "workspace-1",
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
    });

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
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "reserved node IDs",
      expectedCode: "reserved_persisted_node_id",
      nodes: [
        {
          id: "__system:trigger",
          data: {
            kind: "trigger",
            triggerType: "incoming_customer_message",
          },
        },
        {
          id: "action-1",
          data: { kind: "action", actionType: "reply" },
        },
      ],
      edges: [{ source: "__system:trigger", target: "action-1" }],
    },
    {
      name: "mixed action outcome ownership",
      expectedCode: "mixed_action_outcome_ownership",
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerType: "incoming_customer_message",
          },
        },
        {
          id: "action-1",
          data: { kind: "action", actionType: "reply" },
        },
        {
          id: "logic-1",
          data: {
            kind: "logic",
            logicType: "audience_filter",
            actionOutcomes: { version: 1 },
          },
        },
      ],
      edges: [
        { source: "trigger-1", target: "action-1" },
        { source: "action-1", target: "logic-1" },
      ],
    },
    {
      name: "unknown action outcome versions",
      expectedCode: "unsupported_action_outcomes_version",
      nodes: [
        {
          id: "trigger-1",
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
            actionOutcomes: { version: 99, vendorData: { untouched: true } },
          },
        },
      ],
      edges: [{ source: "trigger-1", target: "action-1" }],
    },
    {
      name: "unknown action run-condition versions",
      expectedCode: "unsupported_action_run_conditions_version",
      nodes: [
        {
          id: "trigger-1",
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
            actionRunConditions: {
              version: 99,
              vendorData: { untouched: true },
            },
          },
        },
      ],
      edges: [{ source: "trigger-1", target: "action-1" }],
    },
  ])("returns a stable 400 code when activating $name", async fixture => {
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Routing validation",
      mode: "conversation",
      status: "draft",
      updatedAt: "2026-05-04T07:26:11.684Z",
      nodes: [],
      edges: [],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));

    const response = await patchScenario({
      workspaceId: "workspace-1",
      expectedUpdatedAt: existingScenario.updatedAt,
      nodes: fixture.nodes,
      edges: fixture.edges,
      status: "active",
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.code).toBe(fixture.expectedCode);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects activation when the persisted graph has a compiler diagnostic", async () => {
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Invalid persisted routing",
      mode: "conversation",
      status: "draft",
      updatedAt: "2026-05-04T07:26:11.684Z",
      nodes: [
        {
          id: "__system:trigger",
          data: {
            kind: "trigger",
            triggerType: "incoming_customer_message",
          },
        },
        {
          id: "action-1",
          data: { kind: "action", actionType: "reply" },
        },
      ],
      edges: [{ source: "__system:trigger", target: "action-1" }],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));

    const response = await patchScenario({
      workspaceId: "workspace-1",
      expectedUpdatedAt: existingScenario.updatedAt,
      status: "active",
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.code).toBe("reserved_persisted_node_id");
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("scenario action routing persistence", () => {
  it("normalizes supported routing fields and excludes UI or compiled data", () => {
    const [node] = normalizeScenarioNodesForPersistence([
      {
        id: "action-1",
        data: {
          kind: "action",
          actionType: "reply",
          actionRunConditions: {
            version: 1,
            match: "any",
            conditions: [
              {
                id: " customer ",
                type: "specific_customers",
                customerIds: [" one ", "one", "two"],
              },
            ],
          },
          actionOutcomes: {
            version: 1,
            answerMatches: [
              { id: " answer one ", mode: "exact", text: "  Yes  " },
            ],
          },
          uiLegacyActionRouting: {
            actionOutcomesSource: {
              sourceNodeId: "legacy",
              sourceKind: "post_action_condition",
            },
          },
          uiOnConvertLegacyActionRouting: jest.fn(),
          compiledNodes: [{ id: "__system:virtual" }],
          compiledEdges: [{ source: "action-1", target: "__system:virtual" }],
        },
      },
    ]) as Array<{ data: Record<string, unknown> }>;

    expect(node.data.actionRunConditions).toEqual({
      version: 1,
      match: "all",
      conditions: [
        {
          id: "customer",
          type: "specific_customers",
          customerIds: ["one", "two"],
        },
      ],
    });
    expect(node.data.actionOutcomes).toEqual({
      version: 1,
      answerMatches: [{ id: "answer_one", mode: "exact", text: "Yes" }],
    });
    expect(node.data).not.toHaveProperty("uiLegacyActionRouting");
    expect(node.data).not.toHaveProperty("uiOnConvertLegacyActionRouting");
    expect(node.data).not.toHaveProperty("compiledNodes");
    expect(node.data).not.toHaveProperty("compiledEdges");
  });

  it("retains unsupported routing versions exactly for validation", () => {
    const rawRunConditions = {
      version: 99,
      match: "vendor",
      conditions: [{ vendor: " untouched " }],
    };
    const rawOutcomes = {
      version: 99,
      vendorData: { text: " untouched " },
    };
    const [node] = normalizeScenarioNodesForPersistence([
      {
        id: "action-1",
        data: {
          kind: "action",
          actionType: "reply",
          actionRunConditions: rawRunConditions,
          actionOutcomes: rawOutcomes,
        },
      },
    ]) as Array<{ data: Record<string, unknown> }>;

    expect(node.data.actionRunConditions).toBe(rawRunConditions);
    expect(node.data.actionOutcomes).toBe(rawOutcomes);
  });
});

describe("DELETE /api/scenarios/[scenarioId]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mockDetachScenarioLinkedConditions.mockResolvedValue(undefined);
    mockDetachWhatsAppQrEntryPointsForScenarioDeletion.mockResolvedValue(
      undefined
    );
    mockMarkWhatsAppQrDetachPendingNodes.mockResolvedValue(undefined);
    mockReconcileWhatsAppQrDetachPendingForScenario.mockResolvedValue({
      attemptedNodeIds: [],
      failedNodeIds: [],
    });
    mockListWhatsAppQrScenarioSummaries.mockResolvedValue({});
    mockReconcileCampaignScenarioSchedules.mockResolvedValue(undefined);
    mockRetireCampaignScenarioSchedules.mockResolvedValue(undefined);
    mockRetireCampaignDeliveryTasksForScenario.mockResolvedValue(undefined);
  });

  it("rejects an unconfirmed delete request without touching Mongo", async () => {
    const response = await DELETE(createDeleteRequest(), {
      params: Promise.resolve({ scenarioId }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.code).toBe("scenario_delete_confirmation_required");
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockFindOneAndDelete).not.toHaveBeenCalled();
  });

  it("soft-deletes a scenario only after explicit name confirmation", async () => {
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Entry scenario",
      mode: "conversation",
      updatedAt: "2026-05-04T07:26:11.684Z",
      nodes: [],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ...existingScenario,
        status: "draft",
        deletedAt: "2026-05-04T08:00:00.000Z",
        deletedBy: "user-1",
      }),
    });

    const response = await DELETE(
      createDeleteRequest({
        confirmationToken: "delete_scenario",
        scenarioName: "Entry scenario",
        expectedUpdatedAt: "2026-05-04T07:26:11.684Z",
      }),
      { params: Promise.resolve({ scenarioId }) }
    );

    expect(response.status).toBe(200);
    expect(mockFindOne).toHaveBeenCalledWith({
      _id: scenarioId,
      workspaceId: "workspace-1",
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: scenarioId,
        workspaceId: "workspace-1",
        deletedAt: null,
        updatedAt: new Date("2026-05-04T07:26:11.684Z"),
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "draft",
          deletedBy: "user-1",
          updatedBy: "user-1",
        }),
      }),
      { new: true }
    );
    expect(mockFindOneAndDelete).not.toHaveBeenCalled();
    expect(
      mockReconcileWhatsAppQrDetachPendingForScenario
    ).not.toHaveBeenCalled();
  });

  // Builder scenarios keep Scenario.mode "conversation".
  async function deleteBuilderScenario(recipientAudienceSource: string) {
    const observedUpdatedAt = new Date("2026-05-04T07:26:11.684Z");
    const bulkRoot = {
      id: "bulk-root",
      data: {
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          recipientAudienceSource,
        },
      },
    };
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Builder scenario",
      mode: "conversation",
      timezone: "Asia/Qyzylorda",
      updatedAt: observedUpdatedAt,
      nodes: [bulkRoot, { id: "template-1", data: { kind: "action" } }],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ...existingScenario,
        status: "draft",
        deletedAt: new Date("2026-05-04T08:00:00.000Z"),
      }),
    });

    const response = await DELETE(
      createDeleteRequest({
        confirmationToken: "delete_scenario",
        scenarioName: "Builder scenario",
        expectedUpdatedAt: observedUpdatedAt.toISOString(),
      }),
      { params: Promise.resolve({ scenarioId }) }
    );
    expect(response.status).toBe(200);
    return { bulkRoot };
  }

  it("retires the birthday root schedules and tasks of a deleted builder scenario", async () => {
    const { bulkRoot } = await deleteBuilderScenario("customer_birthdays");

    expect(mockRetireCampaignScenarioSchedules).toHaveBeenCalledTimes(1);
    expect(mockRetireCampaignScenarioSchedules).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
      nodes: [bulkRoot],
      timezone: "Asia/Qyzylorda",
      now: expect.any(Date),
    });
    expect(mockRetireCampaignDeliveryTasksForScenario).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
      reason: "scenario_deleted",
      now: expect.any(Date),
    });
  });

  it("retires stored schedule records and tasks for a deleted conversation scenario without a birthday root", async () => {
    await deleteBuilderScenario("uploaded");

    // A record a failed reconcile left behind is found by the retire itself;
    // no graph node is passed, so an empty store costs no Temporal call.
    expect(mockRetireCampaignScenarioSchedules).toHaveBeenCalledTimes(1);
    expect(mockRetireCampaignScenarioSchedules).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
      nodes: [],
      timezone: "Asia/Qyzylorda",
      now: expect.any(Date),
    });
    // Tasks queued before an active save removed the birthday root.
    expect(mockRetireCampaignDeliveryTasksForScenario).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
      reason: "scenario_deleted",
      now: expect.any(Date),
    });
  });

  it("returns a deletion conflict when the observed revision loses the atomic soft-delete race", async () => {
    const observedUpdatedAt = new Date("2026-05-04T07:26:11.684Z");
    mockFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: scenarioId,
        workspaceId: "workspace-1",
        name: "Concurrent scenario",
        mode: "conversation",
        updatedAt: observedUpdatedAt,
        nodes: [],
      }),
    });
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    });

    const response = await DELETE(
      createDeleteRequest({
        confirmationToken: "delete_scenario",
        scenarioName: "Concurrent scenario",
        expectedUpdatedAt: observedUpdatedAt.toISOString(),
      }),
      { params: Promise.resolve({ scenarioId }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error:
        "This scenario changed in another tab or session. Reload the latest version before deleting it.",
      code: "scenario_updated_conflict",
      currentUpdatedAt: observedUpdatedAt.toISOString(),
    });
    expect(mockDetachScenarioLinkedConditions).not.toHaveBeenCalled();
    expect(mockEmitWorkspaceUsageDeltaBestEffort).not.toHaveBeenCalled();
  });

  it("returns retryable cleanup-pending after deletion and resumes idempotent cleanup on repeated DELETE", async () => {
    const observedUpdatedAt = new Date("2026-05-04T07:26:11.684Z");
    const deletedAt = new Date("2026-05-04T08:00:00.000Z");
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Campaign scenario",
      mode: "bulk_campaign",
      updatedAt: observedUpdatedAt,
      nodes: [],
    };
    const deletedScenario = {
      ...existingScenario,
      status: "draft",
      deletedAt,
      deletedBy: "user-1",
      updatedAt: deletedAt,
    };
    mockFindOne
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue(existingScenario),
      })
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue(deletedScenario),
      });
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue(deletedScenario),
    });
    mockDetachScenarioLinkedConditions
      .mockRejectedValueOnce(new Error("temporary linked cleanup failure"))
      .mockResolvedValueOnce(undefined);

    const requestBody = {
      confirmationToken: "delete_scenario",
      scenarioName: "Campaign scenario",
      expectedUpdatedAt: observedUpdatedAt.toISOString(),
    };
    const firstResponse = await DELETE(createDeleteRequest(requestBody), {
      params: Promise.resolve({ scenarioId }),
    });
    const retryResponse = await DELETE(createDeleteRequest(requestBody), {
      params: Promise.resolve({ scenarioId }),
    });

    expect(firstResponse.status).toBe(202);
    await expect(firstResponse.json()).resolves.toEqual({
      success: true,
      deleted: true,
      cleanupPending: true,
      retryable: true,
      code: "scenario_delete_cleanup_pending",
      pendingCleanup: ["linked_conditions"],
    });
    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toEqual({ success: true });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockEmitWorkspaceUsageDeltaBestEffort).toHaveBeenCalledTimes(1);
    expect(mockDetachScenarioLinkedConditions).toHaveBeenCalledTimes(2);
    expect(mockRetireCampaignScenarioSchedules).toHaveBeenCalledTimes(2);
    expect(mockRetireCampaignDeliveryTasksForScenario).toHaveBeenCalledTimes(2);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "scenario.linked_conditions_detach_failed",
      expect.any(Error),
      { workspaceId: "workspace-1", scenarioId }
    );
  });

  it("reports schedule cleanup pending when the real retirement owner cannot reach Temporal", async () => {
    const observedUpdatedAt = new Date("2026-05-04T07:26:11.684Z");
    const deletedAt = new Date("2026-05-04T08:00:00.000Z");
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Campaign scenario",
      mode: "bulk_campaign",
      updatedAt: observedUpdatedAt,
      nodes: [{ id: "scheduled", data: {} }],
    };
    const deletedScenario = {
      ...existingScenario,
      status: "draft",
      deletedAt,
      updatedAt: deletedAt,
    };
    mockFindOne
      .mockReturnValueOnce({ lean: async () => existingScenario })
      .mockReturnValueOnce({ lean: async () => deletedScenario });
    mockFindOneAndUpdate.mockReturnValue({ lean: async () => deletedScenario });
    const { retireCampaignScenarioSchedules } = jest.requireActual<
      typeof import("@/lib/campaign/campaign-node-schedules")
    >("@/lib/campaign/campaign-node-schedules");
    const model = {
      findOne: () => ({
        lean: async () => ({ nodeId: "scheduled", status: "active" }),
      }),
      find: () => ({
        lean: async () => [{ nodeId: "scheduled", status: "active" }],
      }),
      findOneAndUpdate: jest.fn(() => ({
        lean: async () => ({ nodeId: "scheduled", status: "error" }),
      })),
    };
    mockRetireCampaignScenarioSchedules
      .mockImplementationOnce(input =>
        retireCampaignScenarioSchedules({ ...input, model })
      )
      .mockResolvedValueOnce([]);
    const requestBody = {
      confirmationToken: "delete_scenario",
      scenarioName: "Campaign scenario",
      expectedUpdatedAt: observedUpdatedAt.toISOString(),
    };

    const firstResponse = await DELETE(createDeleteRequest(requestBody), {
      params: Promise.resolve({ scenarioId }),
    });
    expect(firstResponse.status).toBe(202);
    await expect(firstResponse.json()).resolves.toMatchObject({
      success: true,
      deleted: true,
      cleanupPending: true,
      retryable: true,
      code: "scenario_delete_cleanup_pending",
      pendingCleanup: ["campaign_schedules"],
    });
    const retryResponse = await DELETE(createDeleteRequest(requestBody), {
      params: Promise.resolve({ scenarioId }),
    });
    expect(retryResponse.status).toBe(200);
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockEmitWorkspaceUsageDeltaBestEffort).toHaveBeenCalledTimes(1);
    expect(mockRetireCampaignDeliveryTasksForScenario).toHaveBeenCalledTimes(2);
    expect(mockRetireCampaignScenarioSchedules).toHaveBeenCalledTimes(2);
  });

  it("returns QR cleanup-pending after deletion and retries it on repeated DELETE", async () => {
    const observedUpdatedAt = new Date("2026-05-04T07:26:11.684Z");
    const deletedAt = new Date("2026-05-04T08:00:00.000Z");
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "QR scenario",
      mode: "conversation",
      updatedAt: observedUpdatedAt,
      nodes: [
        {
          id: "trigger-qr",
          data: {
            kind: "trigger",
            triggerConfig: { entryPointType: "whatsapp_qr" },
          },
        },
      ],
    };
    const deletedScenario = {
      ...existingScenario,
      status: "draft",
      deletedAt,
      deletedBy: "user-1",
      updatedAt: deletedAt,
    };
    const deletedScenarioWithRetryMarker = {
      ...deletedScenario,
      whatsappQrDetachPendingNodeIds: ["trigger-qr"],
      whatsappQrDetachNextRetryAt: deletedAt,
    };
    mockFindOne
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue(existingScenario),
      })
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue(deletedScenarioWithRetryMarker),
      });
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue(deletedScenarioWithRetryMarker),
    });
    const detachError = new Error("QR detach failed");
    mockReconcileWhatsAppQrDetachPendingForScenario
      .mockRejectedValueOnce(detachError)
      .mockResolvedValueOnce({
        attemptedNodeIds: ["trigger-qr"],
        failedNodeIds: [],
      });

    const requestBody = {
      confirmationToken: "delete_scenario",
      scenarioName: "QR scenario",
      expectedUpdatedAt: observedUpdatedAt.toISOString(),
    };
    const firstResponse = await DELETE(createDeleteRequest(requestBody), {
      params: Promise.resolve({ scenarioId }),
    });
    const retryResponse = await DELETE(createDeleteRequest(requestBody), {
      params: Promise.resolve({ scenarioId }),
    });

    expect(firstResponse.status).toBe(202);
    await expect(firstResponse.json()).resolves.toEqual({
      success: true,
      deleted: true,
      cleanupPending: true,
      retryable: true,
      code: "scenario_delete_cleanup_pending",
      pendingCleanup: ["whatsapp_qr_entry_points"],
    });
    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toEqual({ success: true });
    expect(mockMarkWhatsAppQrDetachPendingNodes).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
      nodeIds: ["trigger-qr"],
    });
    expect(
      mockReconcileWhatsAppQrDetachPendingForScenario
    ).toHaveBeenCalledTimes(2);
    expect(
      mockReconcileWhatsAppQrDetachPendingForScenario
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          whatsappQrDetachPendingNodeIds: ["trigger-qr"],
          whatsappQrDetachNextRetryAt: expect.any(Date),
        }),
      }),
      { new: true }
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      "scenario.whatsapp_qr_detach_failed",
      detachError,
      { workspaceId: "workspace-1", scenarioId }
    );
  });

  it("fails closed when QR cleanup fails and its durable retry marker cannot be persisted", async () => {
    const observedUpdatedAt = new Date("2026-05-04T07:26:11.684Z");
    const deletedAt = new Date("2026-05-04T08:00:00.000Z");
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "QR scenario",
      mode: "conversation",
      updatedAt: deletedAt,
      deletedAt,
      deletedBy: "user-1",
      status: "draft",
      nodes: [
        {
          id: "trigger-qr",
          data: {
            kind: "trigger",
            triggerConfig: { entryPointType: "whatsapp_qr" },
          },
        },
      ],
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockMarkWhatsAppQrDetachPendingNodes.mockRejectedValue(
      new Error("marker write failed")
    );

    const response = await DELETE(
      createDeleteRequest({
        confirmationToken: "delete_scenario",
        scenarioName: "QR scenario",
        expectedUpdatedAt: observedUpdatedAt.toISOString(),
      }),
      { params: Promise.resolve({ scenarioId }) }
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to delete scenario",
    });
    expect(mockMarkWhatsAppQrDetachPendingNodes).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
      nodeIds: ["trigger-qr"],
    });
    expect(
      mockReconcileWhatsAppQrDetachPendingForScenario
    ).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("write-ahead marks stale QR entry-point rows that are no longer present in the graph", async () => {
    const observedUpdatedAt = new Date("2026-05-04T07:26:11.684Z");
    const deletedAt = new Date("2026-05-04T08:00:00.000Z");
    const existingScenario = {
      _id: scenarioId,
      workspaceId: "workspace-1",
      name: "Stale QR scenario",
      mode: "conversation",
      updatedAt: observedUpdatedAt,
      nodes: [],
    };
    const deletedScenario = {
      ...existingScenario,
      status: "draft",
      deletedAt,
      deletedBy: "user-1",
      updatedAt: deletedAt,
      whatsappQrDetachPendingNodeIds: ["stale-qr-node"],
      whatsappQrDetachNextRetryAt: deletedAt,
    };
    mockFindOne.mockReturnValue(leanResult(existingScenario));
    mockFindOneAndUpdate.mockReturnValue({
      lean: jest.fn().mockResolvedValue(deletedScenario),
    });
    mockListWhatsAppQrScenarioSummaries.mockResolvedValue({
      "stale-qr-node": {
        entryPointId: "entry-stale",
        placementName: "Stale placement",
        status: "ACTIVE",
        sourceId: "source-1",
        hasCurrentCode: true,
        version: 1,
      },
    });

    const response = await DELETE(
      createDeleteRequest({
        confirmationToken: "delete_scenario",
        scenarioName: "Stale QR scenario",
        expectedUpdatedAt: observedUpdatedAt.toISOString(),
      }),
      { params: Promise.resolve({ scenarioId }) }
    );

    expect(response.status).toBe(200);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          whatsappQrDetachPendingNodeIds: ["stale-qr-node"],
          whatsappQrDetachNextRetryAt: expect.any(Date),
        }),
      }),
      { new: true }
    );
    expect(
      mockReconcileWhatsAppQrDetachPendingForScenario
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      scenarioId,
    });
  });
});
