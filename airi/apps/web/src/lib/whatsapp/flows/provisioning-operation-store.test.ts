/**
 * @jest-environment node
 */

const mockConnectDB = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockOperationExists = jest.fn();
const mockOperationFind = jest.fn();
const mockOperationFindOne = jest.fn();
const mockOperationFindOneAndUpdate = jest.fn();
const mockMutateScenarioGraphWithCas = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
  },
}));
jest.mock("@/models/whatsapp-flow-provisioning-operation", () => {
  const actual = jest.requireActual(
    "@/models/whatsapp-flow-provisioning-operation"
  );
  return {
    ...actual,
    WhatsAppFlowProvisioningOperation: {
      exists: (...args: unknown[]) => mockOperationExists(...args),
      find: (...args: unknown[]) => mockOperationFind(...args),
      findOne: (...args: unknown[]) => mockOperationFindOne(...args),
      findOneAndUpdate: (...args: unknown[]) =>
        mockOperationFindOneAndUpdate(...args),
    },
  };
});
jest.mock("@/lib/scenarios/scenario-graph-mutation", () => ({
  mutateScenarioGraphWithCas: (...args: unknown[]) =>
    mockMutateScenarioGraphWithCas(...args),
}));

import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { createWhatsAppFlowEditableContentDigest } from "@/lib/scenarios/whatsapp-flow-projection";
import type { WhatsAppFlowProvisioningOperationRecord } from "@/models/whatsapp-flow-provisioning-operation";
import {
  acquireWhatsAppFlowProvisioningLease,
  assertWhatsAppFlowProvisioningTargetCurrent,
  claimWhatsAppFlowProviderResolution,
  completeWhatsAppFlowProvisioningOperation,
  confirmWhatsAppFlowProviderResolution,
  hasWhatsAppFlowProvisioningSourceRebindBlocker,
  isWhatsAppFlowProviderManaged,
  listWhatsAppFlowProviderArtifacts,
  prepareWhatsAppFlowProvisioningOperation,
  reconcileCompletedWhatsAppFlowProviderStatus,
  recordWhatsAppFlowProviderDraft,
  recordWhatsAppFlowProviderStatus,
  resolveMissingWhatsAppFlowProviderDraft,
  renewWhatsAppFlowProvisioningLease,
  validateWhatsAppFlowProvisioningTarget,
  WhatsAppFlowProvisioningStoreError,
} from "./provisioning-operation-store";

const REVISION = "2026-07-30T10:00:00.000Z";
const NOW = new Date(REVISION);

function config(
  overrides: Partial<WhatsAppFlowConfig> = {}
): WhatsAppFlowConfig {
  return {
    templateId: "appointment_booking",
    ctaText: "Book",
    flowNavigationMode: "data_endpoint",
    screens: [
      { id: "DETAILS", title: "Details", fields: [] },
      { id: "CONFIRM", title: "Confirm", fields: [] },
    ],
    screenRoutes: { DETAILS: ["CONFIRM"] },
    ...overrides,
  };
}

function serviceMessageNode(flowConfig: WhatsAppFlowConfig) {
  return {
    id: "node-1",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Open the form" },
          flowConfig,
        },
      },
    },
  };
}

function templateNode(flowConfig: WhatsAppFlowConfig, flowIds: string[]) {
  return {
    id: "node-1",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      kind: "action",
      actionType: "whatsapp_template",
      actionFlowConfig: flowConfig,
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS",
          buttons: flowIds.map(flowId => ({
            type: "FLOW",
            text: "Open",
            flow_id: flowId,
          })),
        },
      ],
    },
  };
}

function selectedLeanQuery<T>(value: T) {
  const query = {
    limit: jest.fn(),
    select: jest.fn(),
    sort: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
}

function leanQuery<T>(value: T) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

function operation(
  flowConfig: WhatsAppFlowConfig,
  overrides: Partial<WhatsAppFlowProvisioningOperationRecord> = {}
): WhatsAppFlowProvisioningOperationRecord {
  const releaseMode =
    flowConfig.flowNavigationMode === "data_endpoint"
      ? "data_endpoint"
      : "linear";
  const providerAcknowledgement =
    typeof overrides.providerFlowId === "string" &&
    !Object.prototype.hasOwnProperty.call(overrides, "providerAcknowledgedAt")
      ? { providerAcknowledgedAt: NOW }
      : {};
  return {
    operationId: "operation-1",
    operationKeyHash: "a".repeat(64),
    workspaceId: "workspace-1",
    scenarioId: "scenario-1",
    nodeId: "node-1",
    targetOwner: "service_message",
    sourceId: "source-1",
    wabaId: "waba-1",
    releaseMode,
    ...(releaseMode === "data_endpoint"
      ? { endpointId: "endpoint-1", applicationId: "application-1" }
      : {}),
    contentRevision: 1,
    contentDigest: createWhatsAppFlowEditableContentDigest(flowConfig),
    providerMarker: "airi_operation_1",
    stage: "CREATING_FLOW",
    status: "RUNNING",
    lease: { fence: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...providerAcknowledgement,
    ...overrides,
  };
}

function scenarioSnapshot(
  node: ReturnType<typeof serviceMessageNode> | ReturnType<typeof templateNode>,
  status = "draft"
) {
  return selectedLeanQuery({
    _id: "scenario-1",
    nodes: [node],
    edges: [],
    status,
    updatedAt: NOW,
  });
}

function prepareParams(flowConfig: WhatsAppFlowConfig) {
  const releaseMode =
    flowConfig.flowNavigationMode === "data_endpoint"
      ? "data_endpoint"
      : "linear";
  return {
    workspaceId: "workspace-1",
    scenarioId: "scenario-1",
    nodeId: "node-1",
    sourceId: "source-1",
    wabaId: "waba-1",
    releaseMode,
    ...(releaseMode === "data_endpoint"
      ? { endpointId: "endpoint-1", applicationId: "application-1" }
      : {}),
    now: NOW,
  } as const;
}

async function prepareOperationForTest(flowConfig: WhatsAppFlowConfig) {
  const target = await validateWhatsAppFlowProvisioningTarget({
    workspaceId: "workspace-1",
    scenarioId: "scenario-1",
    nodeId: "node-1",
    editableConfig: flowConfig,
  });
  return prepareWhatsAppFlowProvisioningOperation({
    ...prepareParams(flowConfig),
    target,
  });
}

function liveLease(operationId = "operation-1") {
  return {
    operationId,
    ownerToken: "worker-1",
    fence: 1,
    expiresAt: new Date("2026-07-30T10:02:00.000Z"),
  };
}

describe("WhatsApp Flow provisioning operation store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockOperationExists.mockResolvedValue(null);
    mockOperationFind.mockReturnValue(selectedLeanQuery([]));
    mockOperationFindOne.mockReturnValue(selectedLeanQuery(null));
  });

  it("creates stable ledger state without projecting transient DRAFT state", async () => {
    const flowConfig = config();
    const inserted = operation(flowConfig);
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(flowConfig))
    );
    mockOperationFindOneAndUpdate.mockReturnValue(leanQuery(inserted));

    const result = await prepareOperationForTest(flowConfig);

    expect(result).toMatchObject({
      operationId: "operation-1",
      contentRevision: 1,
    });
    expect(mockMutateScenarioGraphWithCas).not.toHaveBeenCalled();
  });

  it("uses one deterministic identity for concurrent first attempts", async () => {
    const flowConfig = config();
    const inserted = operation(flowConfig);
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(flowConfig))
    );
    mockOperationFindOneAndUpdate.mockReturnValue(leanQuery(inserted));

    await Promise.all([
      prepareOperationForTest(flowConfig),
      prepareOperationForTest(flowConfig),
    ]);

    const inserts = mockOperationFindOneAndUpdate.mock.calls.map(
      call => call[1].$setOnInsert
    );
    expect(inserts).toHaveLength(2);
    expect(inserts.map(record => record.contentRevision)).toEqual([1, 1]);
    expect(new Set(inserts.map(record => record.operationKeyHash)).size).toBe(
      1
    );
  });

  it("uses WABA, endpoint, and application identity in operation deduplication", async () => {
    const flowConfig = config();
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(flowConfig))
    );
    mockOperationFindOneAndUpdate.mockImplementation((_filter, update) =>
      leanQuery({
        ...update.$setOnInsert,
        createdAt: NOW,
        updatedAt: NOW,
      })
    );
    const target = await validateWhatsAppFlowProvisioningTarget({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      nodeId: "node-1",
      editableConfig: flowConfig,
    });

    for (const binding of [
      { wabaId: "waba-1", endpointId: "endpoint-1", applicationId: "app-1" },
      { wabaId: "waba-2", endpointId: "endpoint-1", applicationId: "app-1" },
      { wabaId: "waba-1", endpointId: "endpoint-2", applicationId: "app-1" },
      { wabaId: "waba-1", endpointId: "endpoint-1", applicationId: "app-2" },
    ]) {
      await prepareWhatsAppFlowProvisioningOperation({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeId: "node-1",
        sourceId: "source-1",
        releaseMode: "data_endpoint",
        target,
        now: NOW,
        ...binding,
      });
    }

    const hashes = mockOperationFindOneAndUpdate.mock.calls.map(
      call => call[1].$setOnInsert.operationKeyHash
    );
    expect(new Set(hashes).size).toBe(4);
  });

  it("creates a replacement when endpoint identity rotates without content changes", async () => {
    const editable = config();
    const digest = createWhatsAppFlowEditableContentDigest(editable);
    const completed = operation(editable, {
      operationId: "operation-old",
      providerFlowId: "flow-old",
      providerFlowName: "Provider Flow Old",
      providerStatus: "PUBLISHED",
      status: "COMPLETED",
      stage: "COMPLETED",
    });
    const persisted = {
      ...editable,
      managedProvisioning: {
        operationId: completed.operationId,
        sourceId: completed.sourceId,
        wabaId: completed.wabaId,
        contentRevision: completed.contentRevision,
        contentDigest: digest,
        flowId: completed.providerFlowId!,
        providerStatus: "PUBLISHED" as const,
      },
    };
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(persisted))
    );
    mockOperationFindOne.mockImplementation(filter =>
      selectedLeanQuery(
        filter.operationId === completed.operationId && !filter.endpointId
          ? completed
          : null
      )
    );
    mockOperationFindOneAndUpdate.mockImplementation((_filter, update) =>
      leanQuery({
        ...update.$setOnInsert,
        createdAt: NOW,
        updatedAt: NOW,
      })
    );
    const target = await validateWhatsAppFlowProvisioningTarget({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      nodeId: "node-1",
      editableConfig: editable,
    });

    const replacement = await prepareWhatsAppFlowProvisioningOperation({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      nodeId: "node-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      releaseMode: "data_endpoint",
      endpointId: "endpoint-2",
      applicationId: "application-2",
      target,
      now: NOW,
    });

    expect(replacement).toMatchObject({
      endpointId: "endpoint-2",
      applicationId: "application-2",
      replacesOperationId: completed.operationId,
      contentRevision: completed.contentRevision + 1,
      contentDigest: digest,
      status: "RUNNING",
    });
  });

  it("clones the authoritative published predecessor after projection and endpoint rotation", async () => {
    const original = config({ bodyText: "Original" });
    const edited = config({ bodyText: "Edited" });
    const predecessor = operation(original, {
      operationId: "operation-published",
      providerFlowId: "flow-published",
      providerFlowName: "Published Flow",
      providerStatus: "PUBLISHED",
      status: "COMPLETED",
      stage: "COMPLETED",
      contentRevision: 7,
    });
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(edited))
    );
    mockOperationFindOne.mockImplementation(filter =>
      selectedLeanQuery(
        filter.providerStatus === "PUBLISHED" ? predecessor : null
      )
    );
    mockOperationFindOneAndUpdate.mockImplementation((_filter, update) =>
      leanQuery({
        ...update.$setOnInsert,
        createdAt: NOW,
        updatedAt: NOW,
      })
    );
    const target = await validateWhatsAppFlowProvisioningTarget({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      nodeId: "node-1",
      editableConfig: edited,
    });

    const replacement = await prepareWhatsAppFlowProvisioningOperation({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      nodeId: "node-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      releaseMode: "data_endpoint",
      endpointId: "endpoint-2",
      applicationId: "application-2",
      target,
      now: NOW,
    });

    expect(replacement).toMatchObject({
      replacesOperationId: "operation-published",
      cloneFlowId: "flow-published",
      contentRevision: 8,
      endpointId: "endpoint-2",
      applicationId: "application-2",
    });
    expect(mockOperationFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeId: "node-1",
        targetOwner: "service_message",
        sourceId: "source-1",
        wabaId: "waba-1",
        providerStatus: "PUBLISHED",
        stage: "COMPLETED",
      })
    );
  });

  it("walks past a missing draft revision to clone the last published predecessor", async () => {
    const publishedConfig = config({ bodyText: "Published" });
    const edited = config({ bodyText: "Edited" });
    const predecessor = operation(publishedConfig, {
      operationId: "operation-published",
      providerFlowId: "flow-published",
      providerStatus: "PUBLISHED",
      status: "COMPLETED",
      stage: "COMPLETED",
      contentRevision: 4,
    });
    const missingDraft = operation(edited, {
      operationId: "operation-missing",
      operationKeyHash: "c".repeat(64),
      replacesOperationId: predecessor.operationId,
      cloneFlowId: undefined,
      providerMarker: "airi_operation_missing",
      providerFlowId: "flow-missing",
      providerStatus: undefined,
      status: "MANUALLY_RESOLVED",
      stage: "CREATING_FLOW",
      contentRevision: 5,
      cleanupAt: new Date("2026-08-29T10:00:00.000Z"),
    });
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(edited))
    );
    mockOperationFindOne
      .mockReturnValueOnce(selectedLeanQuery(missingDraft))
      .mockReturnValueOnce(selectedLeanQuery(predecessor));
    mockOperationFindOneAndUpdate.mockImplementation((_filter, update) =>
      leanQuery({
        ...update.$setOnInsert,
        createdAt: NOW,
        updatedAt: NOW,
      })
    );

    const replacement = await prepareOperationForTest(edited);

    expect(replacement).toMatchObject({
      replacesOperationId: predecessor.operationId,
      cloneFlowId: predecessor.providerFlowId,
      contentRevision: 6,
    });
    expect(replacement.cloneFlowId).not.toBe(missingDraft.providerFlowId);
  });

  it("uses a new provider marker when the deterministic operation row was cleaned up", async () => {
    const flowConfig = config();
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(flowConfig))
    );
    mockOperationFindOne.mockReturnValue(selectedLeanQuery(null));
    mockOperationFindOneAndUpdate.mockImplementation((_filter, update) =>
      leanQuery({
        ...update.$setOnInsert,
        createdAt: NOW,
        updatedAt: NOW,
      })
    );

    await prepareOperationForTest(flowConfig);
    await prepareOperationForTest(flowConfig);

    const [first, recreated] = mockOperationFindOneAndUpdate.mock.calls.map(
      call => call[1].$setOnInsert
    );
    expect(recreated.operationKeyHash).toBe(first.operationKeyHash);
    expect(recreated.operationId).not.toBe(first.operationId);
    expect(recreated.providerMarker).not.toBe(first.providerMarker);
  });

  it("resumes only an exact digest retry without mutating operation identity", async () => {
    const flowConfig = config();
    const failed = operation(flowConfig, {
      status: "FAILED",
      stage: "UPLOADING_JSON",
      providerFlowId: "flow-draft-1",
    });
    const resumed = { ...failed, status: "RUNNING" as const };
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(flowConfig))
    );
    mockOperationFindOne.mockReturnValue(selectedLeanQuery(failed));
    mockOperationFindOneAndUpdate.mockReturnValue(leanQuery(resumed));

    const result = await prepareOperationForTest(flowConfig);

    expect(result.operationId).toBe(failed.operationId);
    const update = mockOperationFindOneAndUpdate.mock.calls[0][1];
    expect(update.$set).toEqual({
      status: "RUNNING",
      stage: "UPLOADING_JSON",
    });
    expect(update.$set).not.toHaveProperty("contentDigest");
    expect(update.$set).not.toHaveProperty("contentRevision");
  });

  it("supersedes a poisoned clone attempt and creates a fresh operation without reusing the stale predecessor", async () => {
    const flowConfig = config();
    const poisoned = operation(flowConfig, {
      operationId: "operation-poisoned",
      operationKeyHash: "d".repeat(64),
      replacesOperationId: "operation-published",
      cloneFlowId: "flow-stale",
      contentRevision: 2,
      status: "FAILED",
      stage: "CREATING_FLOW",
      lastError: {
        code: "WHATSAPP_FLOW_PROVISIONING_CLONE_SOURCE_UNAVAILABLE",
        message: "Clone source is unavailable",
        stage: "CREATING_FLOW",
        retryable: false,
        at: NOW,
      },
    });
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(flowConfig))
    );
    mockOperationFindOne.mockImplementation(filter =>
      selectedLeanQuery(filter.providerStatus === "PUBLISHED" ? null : poisoned)
    );
    mockOperationFindOneAndUpdate.mockImplementation((_filter, update) => {
      if (update.$set?.status === "SUPERSEDED") {
        return leanQuery({ ...poisoned, status: "SUPERSEDED" });
      }
      return leanQuery({
        ...update.$setOnInsert,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });

    const replacement = await prepareOperationForTest(flowConfig);

    expect(replacement).toMatchObject({
      contentRevision: 3,
      status: "RUNNING",
    });
    expect(replacement.operationId).not.toBe(poisoned.operationId);
    expect(replacement.providerMarker).not.toBe(poisoned.providerMarker);
    expect(replacement).not.toHaveProperty("cloneFlowId");
    expect(replacement).not.toHaveProperty("replacesOperationId");
    expect(mockOperationFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFlowId: expect.objectContaining({ $nin: ["flow-stale"] }),
      })
    );
  });

  it("supersedes an inactive changed digest and creates a new operation without reusing its provider Flow", async () => {
    const original = config();
    const edited = config({ bodyText: "Edited" });
    const failed = operation(original, {
      status: "FAILED",
      stage: "PUBLISHING",
      providerFlowId: "flow-draft-1",
    });
    const superseded = {
      ...failed,
      status: "SUPERSEDED" as const,
      cleanupAt: new Date("2026-08-29T10:00:00.000Z"),
    };
    const replacement = operation(edited, {
      operationId: "operation-2",
      operationKeyHash: "b".repeat(64),
      providerMarker: "airi_operation_2",
      contentRevision: 2,
    });
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(edited))
    );
    mockOperationFindOne.mockReturnValue(selectedLeanQuery(failed));
    mockOperationFindOneAndUpdate
      .mockReturnValueOnce(leanQuery(superseded))
      .mockReturnValueOnce(leanQuery(replacement));

    const result = await prepareOperationForTest(edited);

    expect(result).toMatchObject({
      operationId: "operation-2",
      contentRevision: 2,
    });
    expect(result.providerFlowId).toBeUndefined();
    expect(
      mockOperationFindOneAndUpdate.mock.calls[1][1].$setOnInsert
    ).not.toHaveProperty("providerFlowId");
  });

  it("preflights every obsolete binding before superseding any inactive operation", async () => {
    const flowConfig = config();
    const inactive = operation(flowConfig, {
      sourceId: "old-source",
      operationId: "inactive-operation",
    });
    const leased = operation(flowConfig, {
      sourceId: "older-source",
      operationId: "leased-operation",
      lease: liveLease(),
    });
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(flowConfig))
    );
    mockOperationFind.mockReturnValue(selectedLeanQuery([inactive, leased]));

    await expect(prepareOperationForTest(flowConfig)).rejects.toMatchObject<
      Partial<WhatsAppFlowProvisioningStoreError>
    >({
      code: "OPERATION_BUSY",
    });
    expect(mockOperationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects a managed service-message source change before ledger mutation", async () => {
    const editable = config();
    const persisted = {
      ...editable,
      managedProvisioning: {
        operationId: "old-operation",
        sourceId: "old-source",
        wabaId: "old-waba",
        contentRevision: 1,
        contentDigest: createWhatsAppFlowEditableContentDigest(editable),
        flowId: "old-flow",
        providerStatus: "PUBLISHED" as const,
      },
    };
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(persisted))
    );

    await expect(prepareOperationForTest(editable)).rejects.toMatchObject<
      Partial<WhatsAppFlowProvisioningStoreError>
    >({
      code: "SOURCE_REBIND_REQUIRED",
    });
    expect(mockOperationFind).not.toHaveBeenCalled();
    expect(mockOperationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("requires one concrete template component Flow ID matching an exact managed digest", async () => {
    const editable = config();
    const digest = createWhatsAppFlowEditableContentDigest(editable);
    const projection = {
      operationId: "template-operation",
      sourceId: "source-1",
      wabaId: "waba-1",
      contentRevision: 4,
      contentDigest: digest,
      flowId: "template-flow",
      flowName: "Approved Flow",
      providerStatus: "PUBLISHED" as const,
    };
    const persisted = { ...editable, managedProvisioning: projection };
    const completed = operation(editable, {
      operationId: projection.operationId,
      operationKeyHash: "c".repeat(64),
      targetOwner: "template",
      contentRevision: 4,
      providerFlowId: projection.flowId,
      providerFlowName: projection.flowName,
      providerStatus: "PUBLISHED",
      status: "COMPLETED",
      stage: "COMPLETED",
    });
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(templateNode(persisted, ["template-flow"]))
    );
    mockOperationFindOne.mockReturnValue(selectedLeanQuery(completed));

    const result = await prepareOperationForTest(editable);

    expect(result).toEqual(completed);
    expect(mockOperationFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "template-operation",
        providerFlowId: "template-flow",
        contentDigest: digest,
      })
    );
    expect(mockOperationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", []],
    ["multiple", ["template-flow", "template-flow"]],
    ["mismatched", ["other-flow"]],
  ])("quarantines a %s template component binding", async (_label, flowIds) => {
    const editable = config();
    const digest = createWhatsAppFlowEditableContentDigest(editable);
    const persisted = {
      ...editable,
      managedProvisioning: {
        operationId: "template-operation",
        sourceId: "source-1",
        wabaId: "waba-1",
        contentRevision: 1,
        contentDigest: digest,
        flowId: "template-flow",
        providerStatus: "PUBLISHED" as const,
      },
    };
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(templateNode(persisted, flowIds))
    );

    await expect(
      validateWhatsAppFlowProvisioningTarget({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeId: "node-1",
        editableConfig: editable,
      })
    ).rejects.toMatchObject<Partial<WhatsAppFlowProvisioningStoreError>>({
      code: "TEMPLATE_REBIND_REQUIRED",
    });
  });

  it("blocks active legacy scenarios before operation or provider work", async () => {
    const flowConfig = config();
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(flowConfig), "active")
    );

    await expect(
      validateWhatsAppFlowProvisioningTarget({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeId: "node-1",
        editableConfig: flowConfig,
      })
    ).rejects.toMatchObject<Partial<WhatsAppFlowProvisioningStoreError>>({
      code: "ACTIVE_SCENARIO_MIGRATION_REQUIRED",
    });
    expect(mockOperationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("keeps an active completed binding replayable when only provider status drifted", async () => {
    const editable = config();
    const digest = createWhatsAppFlowEditableContentDigest(editable);
    const persisted = {
      ...editable,
      managedProvisioning: {
        operationId: "operation-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        contentRevision: 1,
        contentDigest: digest,
        flowId: "flow-1",
        providerStatus: "PUBLISHED" as const,
      },
    };
    const completed = operation(editable, {
      providerFlowId: "flow-1",
      providerStatus: "BLOCKED",
      status: "COMPLETED",
      stage: "COMPLETED",
    });
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(persisted), "active")
    );
    mockOperationFindOne.mockReturnValue(selectedLeanQuery(completed));

    await expect(
      validateWhatsAppFlowProvisioningTarget({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeId: "node-1",
        editableConfig: editable,
      })
    ).resolves.toMatchObject({
      contentDigest: digest,
      managedProjection: {
        operationId: "operation-1",
        sourceId: "source-1",
        wabaId: "waba-1",
      },
    });
  });

  it("replays the operation owned by a service-message projection instead of a later stale failure", async () => {
    const editable = config({ bodyText: "Current content" });
    const contentDigest = createWhatsAppFlowEditableContentDigest(editable);
    const completed = operation(editable, {
      operationId: "operation-current",
      operationKeyHash: "b".repeat(64),
      contentRevision: 2,
      providerFlowId: "flow-current",
      providerFlowName: "Current Provider Flow",
      providerStatus: "PUBLISHED",
      status: "COMPLETED",
      stage: "COMPLETED",
    });
    const persisted = {
      ...editable,
      managedProvisioning: {
        operationId: completed.operationId,
        sourceId: completed.sourceId,
        wabaId: completed.wabaId,
        contentRevision: completed.contentRevision,
        contentDigest,
        flowId: completed.providerFlowId!,
        providerStatus: "PUBLISHED" as const,
      },
    };
    const staleFailure = operation(config({ bodyText: "Stale content" }), {
      operationId: "operation-stale",
      operationKeyHash: "c".repeat(64),
      contentRevision: 3,
      status: "FAILED",
      stage: "UPLOADING_JSON",
      createdAt: new Date("2026-07-30T10:00:01.000Z"),
    });
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(persisted))
    );
    mockOperationFindOne.mockImplementation(filter =>
      selectedLeanQuery(
        filter.operationId === completed.operationId ? completed : staleFailure
      )
    );

    await expect(prepareOperationForTest(editable)).resolves.toEqual(completed);
    expect(mockOperationFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: completed.operationId,
        providerFlowId: completed.providerFlowId,
        contentDigest,
      })
    );
    expect(mockOperationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("records intermediate provider truth only in the durable ledger", async () => {
    const flowConfig = config();
    const lease = liveLease();
    const draft = operation(flowConfig, {
      providerFlowId: "flow-1",
      providerAcknowledgedAt: NOW,
      providerFlowName: "Provider Flow",
      providerStatus: "DRAFT",
      lease: {
        ownerToken: lease.ownerToken,
        fence: lease.fence,
        expiresAt: lease.expiresAt,
      },
    });
    const throttled = { ...draft, providerStatus: "THROTTLED" as const };
    mockOperationFindOneAndUpdate
      .mockReturnValueOnce(leanQuery(draft))
      .mockReturnValueOnce(leanQuery(throttled));

    const recorded = await recordWhatsAppFlowProviderDraft({
      lease,
      providerFlowId: "flow-1",
      providerFlowName: "Provider Flow",
      providerStatus: "DRAFT",
      now: NOW,
    });
    const status = await recordWhatsAppFlowProviderStatus({
      lease,
      providerStatus: "THROTTLED",
      now: NOW,
    });

    expect(recorded.providerStatus).toBe("DRAFT");
    expect(recorded.providerAcknowledgedAt).toEqual(NOW);
    expect(status.providerStatus).toBe("THROTTLED");
    expect(mockMutateScenarioGraphWithCas).not.toHaveBeenCalled();
    expect(mockOperationFindOneAndUpdate.mock.calls[0]).toEqual([
      expect.objectContaining({
        operationId: lease.operationId,
        providerFlowId: { $exists: false },
        providerAcknowledgedAt: { $exists: false },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          providerFlowId: "flow-1",
          providerAcknowledgedAt: NOW,
        }),
      }),
      { new: true, runValidators: true },
    ]);
  });

  it("preserves the first acknowledgement time during same-ID enrichment", async () => {
    const flowConfig = config();
    const lease = liveLease();
    const firstAcknowledgedAt = new Date("2026-07-30T09:59:00.000Z");
    const enriched = operation(flowConfig, {
      providerFlowId: "flow-1",
      providerAcknowledgedAt: firstAcknowledgedAt,
      providerFlowName: "Confirmed Provider Flow",
      providerStatus: "DRAFT",
      lease: {
        ownerToken: lease.ownerToken,
        fence: lease.fence,
        expiresAt: lease.expiresAt,
      },
    });
    mockOperationFindOneAndUpdate
      .mockReturnValueOnce(leanQuery(null))
      .mockReturnValueOnce(leanQuery(enriched));

    const result = await recordWhatsAppFlowProviderDraft({
      lease,
      providerFlowId: "flow-1",
      providerFlowName: "Confirmed Provider Flow",
      providerStatus: "DRAFT",
      now: NOW,
    });

    expect(result.providerAcknowledgedAt).toEqual(firstAcknowledgedAt);
    expect(mockOperationFindOneAndUpdate.mock.calls[1]).toEqual([
      expect.objectContaining({
        operationId: lease.operationId,
        providerFlowId: "flow-1",
        providerAcknowledgedAt: { $type: "date" },
      }),
      {
        $set: {
          providerFlowName: "Confirmed Provider Flow",
          providerStatus: "DRAFT",
        },
      },
      { new: true, runValidators: true },
    ]);
  });

  it("never swaps an acknowledged provider Flow ID", async () => {
    const lease = liveLease();
    mockOperationFindOneAndUpdate
      .mockReturnValueOnce(leanQuery(null))
      .mockReturnValueOnce(leanQuery(null));

    await expect(
      recordWhatsAppFlowProviderDraft({
        lease,
        providerFlowId: "flow-replacement",
        providerFlowName: "Replacement Provider Flow",
        providerStatus: "DRAFT",
        now: NOW,
      })
    ).rejects.toMatchObject<Partial<WhatsAppFlowProvisioningStoreError>>({
      code: "OPERATION_CONFLICT",
    });

    expect(mockOperationFindOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        operationId: lease.operationId,
        providerFlowId: { $exists: false },
        providerAcknowledgedAt: { $exists: false },
      }),
      expect.anything(),
      expect.anything()
    );
    expect(mockOperationFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        operationId: lease.operationId,
        providerFlowId: "flow-replacement",
        providerAcknowledgedAt: { $type: "date" },
      }),
      expect.not.objectContaining({
        $set: expect.objectContaining({
          providerFlowId: expect.anything(),
          providerAcknowledgedAt: expect.anything(),
        }),
      }),
      expect.anything()
    );
  });

  it("terminally resolves a leased provider draft that is definitively missing", async () => {
    const flowConfig = config();
    const lease = liveLease();
    const error = {
      code: "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
      message: "Meta no longer has the acknowledged Flow draft",
      stage: "CREATING_FLOW" as const,
      providerCode: 100,
      providerSubcode: 33,
      retryable: true,
      at: NOW,
    };
    const resolved = operation(flowConfig, {
      providerFlowId: "flow-missing",
      providerFlowName: "Provider Flow",
      status: "MANUALLY_RESOLVED",
      cleanupAt: new Date("2026-08-29T10:00:00.000Z"),
      lastError: error,
      lease: { fence: lease.fence },
    });
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(resolved));

    const result = await resolveMissingWhatsAppFlowProviderDraft({
      lease,
      providerFlowId: "flow-missing",
      error,
      now: NOW,
    });

    expect(result).toEqual(resolved);
    expect(mockOperationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: lease.operationId,
        status: "RUNNING",
        stage: "CREATING_FLOW",
        providerFlowId: "flow-missing",
        "lease.ownerToken": lease.ownerToken,
        "lease.fence": lease.fence,
      }),
      {
        $set: {
          status: "MANUALLY_RESOLVED",
          stage: "CREATING_FLOW",
          cleanupAt: new Date("2026-08-29T10:00:00.000Z"),
          lastError: error,
        },
        $unset: {
          providerStatus: 1,
          "lease.ownerToken": 1,
          "lease.expiresAt": 1,
        },
      },
      { new: true, runValidators: true }
    );
  });

  it("creates a fresh exact retry after the missing provider draft is terminal", async () => {
    const flowConfig = config();
    const resolved = operation(flowConfig, {
      providerFlowId: "flow-missing",
      providerFlowName: "Provider Flow",
      providerStatus: "DRAFT",
      status: "MANUALLY_RESOLVED",
      cleanupAt: new Date("2026-08-29T10:00:00.000Z"),
    });
    const replacement = operation(flowConfig, {
      operationId: "operation-2",
      operationKeyHash: "b".repeat(64),
      providerMarker: "airi_operation_2",
      contentRevision: 2,
    });
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(serviceMessageNode(flowConfig))
    );
    mockOperationFindOne.mockReturnValue(selectedLeanQuery(resolved));
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(replacement));

    const result = await prepareOperationForTest(flowConfig);

    expect(result).toEqual(replacement);
    const inserted =
      mockOperationFindOneAndUpdate.mock.calls[0][1].$setOnInsert;
    expect(inserted).toMatchObject({
      contentRevision: 2,
      contentDigest: resolved.contentDigest,
      status: "RUNNING",
      stage: "CREATING_FLOW",
    });
    expect(inserted.operationKeyHash).not.toBe(resolved.operationKeyHash);
    expect(inserted.providerMarker).not.toBe(resolved.providerMarker);
    expect(inserted).not.toHaveProperty("providerFlowId");
    expect(inserted).not.toHaveProperty("providerFlowName");
    expect(inserted).not.toHaveProperty("providerStatus");
  });

  it("accepts retained old projection metadata while guarding current editable content", async () => {
    const editable = config();
    const current = operation(editable, {
      lease: {
        ownerToken: "worker-1",
        fence: 1,
        expiresAt: new Date("2026-07-30T10:02:00.000Z"),
      },
    });
    const retained = {
      ...editable,
      managedProvisioning: {
        operationId: "old-operation",
        sourceId: "old-source",
        wabaId: "old-waba",
        contentRevision: 1,
        contentDigest: "d".repeat(64),
        flowId: "old-flow",
        providerStatus: "PUBLISHED" as const,
      },
    };
    mockOperationFindOne.mockReturnValueOnce(selectedLeanQuery(current));
    mockScenarioFindOne.mockReturnValueOnce(
      scenarioSnapshot(serviceMessageNode(retained))
    );

    await expect(
      assertWhatsAppFlowProvisioningTargetCurrent({
        operation: current,
        lease: liveLease(),
        now: NOW,
      })
    ).resolves.toBeUndefined();
  });

  it("completes the current row before projecting PUBLISHED and cleans older rows with per-row CAS", async () => {
    const editable = config();
    const lease = liveLease("operation-2");
    const current = operation(editable, {
      operationId: "operation-2",
      operationKeyHash: "b".repeat(64),
      providerFlowId: "flow-2",
      providerFlowName: "Provider Flow 2",
      providerStatus: "DRAFT",
      stage: "READING_BACK",
      lease: {
        ownerToken: lease.ownerToken,
        fence: lease.fence,
        expiresAt: lease.expiresAt,
      },
    });
    const completed = {
      ...current,
      status: "COMPLETED" as const,
      stage: "COMPLETED" as const,
      providerStatus: "PUBLISHED" as const,
      lease: { fence: 1 },
    };
    const older = operation(editable, {
      operationId: "operation-1",
      providerFlowId: "flow-1",
      status: "COMPLETED",
      stage: "COMPLETED",
      createdAt: new Date("2026-07-30T09:59:59.000Z"),
    });
    const superseded = {
      ...older,
      status: "SUPERSEDED" as const,
      cleanupAt: new Date("2026-08-29T10:00:00.000Z"),
    };
    const nodes = [serviceMessageNode(editable)];
    mockOperationFindOne.mockReturnValue(selectedLeanQuery(current));
    mockOperationFind.mockReturnValue(selectedLeanQuery([older]));
    mockOperationFindOneAndUpdate
      .mockReturnValueOnce(leanQuery(completed))
      .mockReturnValueOnce(leanQuery(superseded));
    mockMutateScenarioGraphWithCas.mockImplementation(async input => {
      const projected = input.project({ nodes, edges: [] });
      return {
        status: "updated",
        value: projected.value,
        previousScenarioUpdatedAt: REVISION,
        scenarioUpdatedAt: "2026-07-30T10:00:01.000Z",
      };
    });

    const result = await completeWhatsAppFlowProvisioningOperation({
      lease,
      updatedBy: "user-1",
      now: NOW,
    });

    expect(result.projection).toMatchObject({
      operationId: "operation-2",
      flowId: "flow-2",
      providerStatus: "PUBLISHED",
    });
    expect(
      mockOperationFindOneAndUpdate.mock.invocationCallOrder[0]
    ).toBeLessThan(mockMutateScenarioGraphWithCas.mock.invocationCallOrder[0]);
    expect(
      mockMutateScenarioGraphWithCas.mock.invocationCallOrder[0]
    ).toBeLessThan(mockOperationFindOneAndUpdate.mock.invocationCallOrder[1]);
    expect(mockOperationFind).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAt: { $lt: completed.createdAt },
      })
    );
  });

  it("projects a replacement operation over its explicitly recorded predecessor", async () => {
    const previous = config({ bodyText: "Previous content" });
    const editable = config({ bodyText: "Replacement content" });
    const lease = liveLease("operation-b");
    const current = operation(editable, {
      operationId: "operation-b",
      operationKeyHash: "b".repeat(64),
      replacesOperationId: "operation-a",
      contentRevision: 2,
      providerFlowId: "flow-b",
      providerFlowName: "Replacement Provider Flow",
      providerStatus: "DRAFT",
      stage: "READING_BACK",
      lease: {
        ownerToken: lease.ownerToken,
        fence: lease.fence,
        expiresAt: lease.expiresAt,
      },
    });
    const completed = {
      ...current,
      status: "COMPLETED" as const,
      stage: "COMPLETED" as const,
      providerStatus: "PUBLISHED" as const,
      lease: { fence: lease.fence },
    };
    const nodes = [
      serviceMessageNode({
        ...editable,
        managedProvisioning: {
          operationId: "operation-a",
          sourceId: "source-1",
          wabaId: "waba-1",
          contentRevision: 1,
          contentDigest: createWhatsAppFlowEditableContentDigest(previous),
          flowId: "flow-a",
          providerStatus: "PUBLISHED",
        },
      }),
    ];
    let projectedNodes: unknown[] | undefined;
    mockOperationFindOne.mockReturnValue(selectedLeanQuery(current));
    mockOperationFind.mockReturnValue(selectedLeanQuery([]));
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(completed));
    mockMutateScenarioGraphWithCas.mockImplementation(async input => {
      const projected = input.project({ nodes, edges: [] });
      projectedNodes = projected.changed ? projected.nodes : undefined;
      return {
        status: "updated",
        value: projected.value,
        previousScenarioUpdatedAt: REVISION,
        scenarioUpdatedAt: "2026-07-30T10:00:01.000Z",
      };
    });

    const result = await completeWhatsAppFlowProvisioningOperation({
      lease,
      now: NOW,
    });

    expect(result.projection).toMatchObject({
      operationId: "operation-b",
      contentRevision: 2,
      flowId: "flow-b",
      providerStatus: "PUBLISHED",
    });
    expect(projectedNodes).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          actionWhatsAppServiceMessage: expect.objectContaining({
            message: expect.objectContaining({
              flowConfig: expect.objectContaining({
                managedProvisioning: expect.objectContaining({
                  operationId: "operation-b",
                  flowId: "flow-b",
                }),
              }),
            }),
          }),
        }),
      }),
    ]);
  });

  it("reconciles exact non-PUBLISHED provider status onto a completed scenario", async () => {
    const editable = config();
    const completed = operation(editable, {
      providerFlowId: "flow-1",
      providerFlowName: "Provider Flow",
      providerStatus: "PUBLISHED",
      status: "COMPLETED",
      stage: "COMPLETED",
    });
    const blocked = { ...completed, providerStatus: "BLOCKED" as const };
    const nodes = [serviceMessageNode(editable)];
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(blocked));
    mockOperationFind.mockReturnValue(selectedLeanQuery([]));
    mockMutateScenarioGraphWithCas.mockImplementation(async input => {
      const projected = input.project({ nodes, edges: [] });
      return {
        status: "updated",
        value: projected.value,
        previousScenarioUpdatedAt: REVISION,
        scenarioUpdatedAt: "2026-07-30T10:00:01.000Z",
      };
    });

    const result = await reconcileCompletedWhatsAppFlowProviderStatus({
      operation: completed,
      providerStatus: "BLOCKED",
      now: NOW,
    });

    expect(result.operation.providerStatus).toBe("BLOCKED");
    expect(result.projection.providerStatus).toBe("BLOCKED");
    expect(mockOperationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "operation-1",
        status: "COMPLETED",
        stage: "COMPLETED",
      }),
      { $set: { providerStatus: "BLOCKED" } },
      { new: true, runValidators: true }
    );
  });

  it("reconciles the projected completed operation despite a later unprojected failure", async () => {
    const editable = config({ bodyText: "Current content" });
    const completed = operation(editable, {
      operationId: "operation-current",
      operationKeyHash: "b".repeat(64),
      contentRevision: 2,
      providerFlowId: "flow-current",
      providerFlowName: "Current Provider Flow",
      providerStatus: "PUBLISHED",
      status: "COMPLETED",
      stage: "COMPLETED",
    });
    const blocked = { ...completed, providerStatus: "BLOCKED" as const };
    const staleFailure = operation(config({ bodyText: "Stale content" }), {
      operationId: "operation-stale",
      operationKeyHash: "c".repeat(64),
      contentRevision: 3,
      status: "FAILED",
      stage: "UPLOADING_JSON",
      createdAt: new Date("2026-07-30T10:00:01.000Z"),
    });
    const nodes = [
      serviceMessageNode({
        ...editable,
        managedProvisioning: {
          operationId: completed.operationId,
          sourceId: completed.sourceId,
          wabaId: completed.wabaId,
          contentRevision: completed.contentRevision,
          contentDigest: completed.contentDigest,
          flowId: completed.providerFlowId!,
          providerStatus: "PUBLISHED",
        },
      }),
    ];
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(blocked));
    mockOperationFindOne.mockReturnValue(selectedLeanQuery(staleFailure));
    mockMutateScenarioGraphWithCas.mockImplementation(async input => {
      const projected = input.project({ nodes, edges: [] });
      return {
        status: "updated",
        value: projected.value,
        previousScenarioUpdatedAt: REVISION,
        scenarioUpdatedAt: "2026-07-30T10:00:01.000Z",
      };
    });

    await expect(
      reconcileCompletedWhatsAppFlowProviderStatus({
        operation: completed,
        providerStatus: "BLOCKED",
        now: NOW,
      })
    ).resolves.toMatchObject({
      operation: { operationId: completed.operationId },
      projection: { providerStatus: "BLOCKED" },
    });
    expect(mockOperationFindOne).not.toHaveBeenCalled();
  });

  it("does not reconcile an old operation without a predecessor over a lower-revision projection", async () => {
    const editable = config();
    const completed = operation(editable, {
      providerFlowId: "flow-1",
      providerFlowName: "Provider Flow",
      providerStatus: "PUBLISHED",
      status: "COMPLETED",
      stage: "COMPLETED",
      contentRevision: 5,
    });
    const blocked = { ...completed, providerStatus: "BLOCKED" as const };
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(blocked));
    const nodes = [
      serviceMessageNode({
        ...editable,
        managedProvisioning: {
          operationId: "operation-2",
          sourceId: "source-1",
          wabaId: "waba-1",
          contentRevision: 1,
          contentDigest: completed.contentDigest,
          flowId: "flow-2",
          providerStatus: "PUBLISHED",
        },
      }),
    ];
    mockMutateScenarioGraphWithCas.mockImplementation(async input => {
      const projected = input.project({ nodes, edges: [] });
      return {
        status: "updated",
        value: projected.value,
        previousScenarioUpdatedAt: REVISION,
        scenarioUpdatedAt: "2026-07-30T10:00:01.000Z",
      };
    });

    await expect(
      reconcileCompletedWhatsAppFlowProviderStatus({
        operation: completed,
        providerStatus: "BLOCKED",
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "TARGET_CHANGED" });
    expect(mockMutateScenarioGraphWithCas).toHaveBeenCalledTimes(1);
  });

  it("keeps superseded provider evidence inside generic Flow mutation guards", async () => {
    mockOperationFindOne.mockReturnValue(
      selectedLeanQuery({ operationId: "operation-1" })
    );

    await expect(
      isWhatsAppFlowProviderManaged({
        wabaId: "waba-1",
        providerFlowId: "flow-1",
      })
    ).resolves.toBe(true);
    expect(mockOperationFindOne).toHaveBeenCalledWith({
      wabaId: "waba-1",
      providerFlowId: "flow-1",
      status: {
        $in: ["RUNNING", "FAILED", "COMPLETED", "SUPERSEDED"],
      },
    });
  });

  it("claims an unprojected managed artifact with an exact source/WABA fence", async () => {
    const current = operation(config(), {
      providerFlowId: "flow-1",
      providerFlowName: "Managed Flow",
      providerStatus: undefined,
      stage: "COMPLETED",
      status: "COMPLETED",
    });
    const claimed = {
      ...current,
      status: "SUPERSEDED" as const,
      providerResolution: {
        kind: "published_deprecated" as const,
        requestedAt: NOW,
        requestedBy: "user-1",
      },
      lease: {
        ownerToken: "resolution-1",
        fence: 1,
        expiresAt: new Date("2026-07-30T10:02:00.000Z"),
      },
    };
    mockOperationFindOne
      .mockReturnValueOnce(selectedLeanQuery(current))
      .mockReturnValueOnce(selectedLeanQuery(null));
    mockScenarioFindOne.mockReturnValue(selectedLeanQuery(null));
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(claimed));

    await expect(
      claimWhatsAppFlowProviderResolution({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        providerFlowId: "flow-1",
        kind: "published_deprecated",
        requestedBy: "user-1",
        ownerToken: "resolution-1",
        now: NOW,
      })
    ).resolves.toMatchObject({
      kind: "claimed",
      lease: { operationId: current.operationId, fence: 1 },
    });
    expect(mockOperationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: current.operationId,
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        providerFlowId: "flow-1",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "SUPERSEDED",
          providerResolution: expect.objectContaining({
            kind: "published_deprecated",
          }),
        }),
      }),
      { new: true, runValidators: true }
    );
  });

  it("refuses to retire the operation currently projected by the scenario", async () => {
    const editable = config();
    const current = operation(editable, {
      providerFlowId: "flow-1",
      providerStatus: "PUBLISHED",
      stage: "COMPLETED",
      status: "COMPLETED",
    });
    mockOperationFindOne.mockReturnValueOnce(selectedLeanQuery(current));
    mockScenarioFindOne.mockReturnValue(
      scenarioSnapshot(
        serviceMessageNode({
          ...editable,
          managedProvisioning: {
            operationId: current.operationId,
            sourceId: current.sourceId,
            wabaId: current.wabaId,
            contentRevision: current.contentRevision,
            contentDigest: current.contentDigest,
            flowId: current.providerFlowId!,
            providerStatus: "PUBLISHED",
          },
        })
      )
    );

    await expect(
      claimWhatsAppFlowProviderResolution({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        providerFlowId: "flow-1",
        kind: "published_deprecated",
        requestedBy: "user-1",
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
    expect(mockOperationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses to retire a predecessor while a resumable replacement depends on it", async () => {
    const current = operation(config(), {
      providerFlowId: "flow-1",
      providerStatus: "PUBLISHED",
      stage: "COMPLETED",
      status: "SUPERSEDED",
    });
    mockOperationFindOne
      .mockReturnValueOnce(selectedLeanQuery(current))
      .mockReturnValueOnce(
        selectedLeanQuery({ operationId: "operation-replacement" })
      );
    mockScenarioFindOne.mockReturnValue(selectedLeanQuery(null));

    await expect(
      claimWhatsAppFlowProviderResolution({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        providerFlowId: "flow-1",
        kind: "published_deprecated",
        requestedBy: "user-1",
        now: NOW,
      })
    ).rejects.toMatchObject({ code: "OPERATION_BUSY" });
  });

  it("confirms provider evidence atomically and maps missing truth without a stale provider status", async () => {
    const lease = liveLease();
    const current = operation(config(), {
      providerFlowId: "flow-1",
      providerStatus: "DRAFT",
      status: "SUPERSEDED",
      lease: {
        ownerToken: lease.ownerToken,
        fence: lease.fence,
        expiresAt: lease.expiresAt,
      },
      providerResolution: {
        kind: "draft_deleted",
        requestedAt: NOW,
        requestedBy: "user-1",
      },
    });
    const resolved = {
      ...current,
      status: "MANUALLY_RESOLVED" as const,
      providerStatus: undefined,
      cleanupAt: new Date("2026-08-29T10:00:00.000Z"),
      providerResolution: {
        ...current.providerResolution!,
        outcome: "missing" as const,
        confirmedAt: NOW,
        confirmedBy: "user-1",
      },
      lease: { fence: lease.fence },
    };
    mockOperationFindOne.mockReturnValueOnce(selectedLeanQuery(current));
    mockOperationFindOneAndUpdate.mockReturnValueOnce(leanQuery(resolved));

    await expect(
      confirmWhatsAppFlowProviderResolution({
        lease,
        kind: "draft_deleted",
        outcome: "missing",
        confirmedBy: "user-1",
        now: NOW,
      })
    ).resolves.toMatchObject({
      status: "MANUALLY_RESOLVED",
      providerResolution: { outcome: "missing" },
    });
    expect(mockOperationFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: lease.operationId }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: "MANUALLY_RESOLVED" }),
        $unset: expect.objectContaining({ providerStatus: 1 }),
      }),
      { new: true, runValidators: true }
    );
  });

  it("lists exact-source ledger artifacts including confirmed missing rows without presenting last-known status as truth", async () => {
    const resolved = operation(config(), {
      providerFlowId: "flow-missing",
      providerFlowName: "Deleted draft",
      providerStatus: undefined,
      status: "MANUALLY_RESOLVED",
      providerResolution: {
        kind: "draft_deleted",
        requestedAt: NOW,
        requestedBy: "user-1",
        outcome: "missing",
        confirmedAt: NOW,
        confirmedBy: "user-1",
      },
    });
    mockOperationFind.mockReturnValue(selectedLeanQuery([resolved]));

    await expect(
      listWhatsAppFlowProviderArtifacts({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-1",
      })
    ).resolves.toEqual([
      {
        operationId: resolved.operationId,
        scenarioId: "scenario-1",
        providerFlowId: "flow-missing",
        providerFlowName: "Deleted draft",
        stage: resolved.stage,
        status: "MANUALLY_RESOLVED",
        resolutionKind: "draft_deleted",
        resolutionOutcome: "missing",
        cleanupEligibility: "RESOLVED",
      },
    ]);
    expect(mockOperationFind).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-1",
      })
    );
  });

  it("reserves a source for any unresolved provider artifact in one query", async () => {
    mockOperationExists.mockResolvedValue({ _id: "operation-1" });

    await expect(
      hasWhatsAppFlowProvisioningSourceRebindBlocker({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-1",
      })
    ).resolves.toBe(true);

    expect(mockOperationExists).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      $or: [
        { status: "RUNNING" },
        {
          status: { $in: ["FAILED", "COMPLETED", "SUPERSEDED"] },
          providerFlowId: { $type: "string" },
        },
      ],
    });
    expect(mockOperationFind).not.toHaveBeenCalled();
    expect(mockScenarioFindOne).not.toHaveBeenCalled();
  });

  it("does not reserve a source without an unresolved provider artifact", async () => {
    await expect(
      hasWhatsAppFlowProvisioningSourceRebindBlocker({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "waba-1",
      })
    ).resolves.toBe(false);

    expect(mockOperationExists).toHaveBeenCalledTimes(1);
    expect(mockOperationFind).not.toHaveBeenCalled();
    expect(mockScenarioFindOne).not.toHaveBeenCalled();
  });

  it("omits WABA matching when the source is currently unbound", async () => {
    mockOperationExists.mockResolvedValue({ _id: "operation-1" });

    await expect(
      hasWhatsAppFlowProvisioningSourceRebindBlocker({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        wabaId: "",
      })
    ).resolves.toBe(true);

    expect(mockOperationExists).toHaveBeenCalledWith(
      expect.not.objectContaining({ wabaId: expect.anything() })
    );
  });

  it.each(["COMPLETED", "SUPERSEDED", "MANUALLY_RESOLVED"] as const)(
    "never reacquires a %s provisioning operation",
    async status => {
      const terminal = operation(config(), {
        status,
        ...(status === "COMPLETED" ? { stage: "COMPLETED" } : {}),
      });
      mockOperationFindOne.mockReturnValueOnce(selectedLeanQuery(terminal));

      await expect(
        acquireWhatsAppFlowProvisioningLease({
          operationId: terminal.operationId,
          ownerToken: "worker-1",
          now: NOW,
        })
      ).rejects.toMatchObject<Partial<WhatsAppFlowProvisioningStoreError>>({
        code: "OPERATION_CONFLICT",
      });
      expect(mockOperationFindOneAndUpdate).not.toHaveBeenCalled();
    }
  );

  it("acquires and renews only the current fenced lease", async () => {
    const editable = config();
    const initial = operation(editable);
    const acquired = operation(editable, { lease: liveLease() });
    const renewed = operation(editable, {
      lease: {
        ...liveLease(),
        expiresAt: new Date("2026-07-30T10:03:00.000Z"),
      },
    });
    mockOperationFindOne.mockReturnValueOnce(selectedLeanQuery(initial));
    mockOperationFindOneAndUpdate
      .mockReturnValueOnce(leanQuery(acquired))
      .mockReturnValueOnce(leanQuery(renewed));

    const lease = await acquireWhatsAppFlowProvisioningLease({
      operationId: "operation-1",
      ownerToken: "worker-1",
      now: NOW,
    });
    const result = await renewWhatsAppFlowProvisioningLease({
      lease,
      now: new Date("2026-07-30T10:01:00.000Z"),
    });

    expect(lease.fence).toBe(1);
    expect(result).toEqual({
      ...lease,
      expiresAt: new Date("2026-07-30T10:03:00.000Z"),
    });
  });
});
