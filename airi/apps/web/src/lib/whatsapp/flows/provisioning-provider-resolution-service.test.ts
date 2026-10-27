/**
 * @jest-environment node
 */

import type { WhatsAppFlowProvisioningOperationRecord } from "@/models/whatsapp-flow-provisioning-operation";

jest.mock("@/lib/whatsapp/flows/source-binding-fence-store", () => ({
  whatsAppFlowSourceBindingFenceStore: {},
  WhatsAppFlowSourceBindingFenceConflictError: class extends Error {},
}));

import { createWhatsAppFlowProviderResolutionService } from "@/lib/whatsapp/flows/provisioning-provider-resolution-service";

type Dependencies = Parameters<
  typeof createWhatsAppFlowProviderResolutionService
>[0];

const NOW = new Date("2026-08-08T10:00:00.000Z");
const REQUESTED_AT = new Date("2026-08-08T09:59:00.000Z");

function providerFlow(status: string, wabaId = "waba-1") {
  return {
    id: "flow-1",
    name: "Managed Flow",
    status,
    whatsapp_business_account: { id: wabaId },
  };
}

function operation(
  overrides: Partial<WhatsAppFlowProvisioningOperationRecord> = {}
): WhatsAppFlowProvisioningOperationRecord {
  return {
    operationId: "operation-1",
    operationKeyHash: "a".repeat(64),
    workspaceId: "workspace-1",
    scenarioId: "scenario-1",
    nodeId: "node-1",
    targetOwner: "service_message",
    sourceId: "source-1",
    wabaId: "waba-1",
    releaseMode: "linear",
    contentRevision: 1,
    contentDigest: "b".repeat(64),
    providerMarker: "airi_operation_1",
    providerFlowId: "flow-1",
    providerFlowName: "Managed Flow",
    providerStatus: "PUBLISHED",
    stage: "COMPLETED",
    status: "SUPERSEDED",
    lease: {
      ownerToken: "resolution-owner-1",
      fence: 4,
      expiresAt: new Date("2026-08-08T10:02:00.000Z"),
    },
    providerResolution: {
      kind: "published_deprecated",
      requestedAt: REQUESTED_AT,
      requestedBy: "user-1",
    },
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: NOW,
    ...overrides,
  };
}

function resolvedOperation(params: {
  kind: "published_deprecated" | "draft_deleted";
  outcome: "deprecated" | "missing";
  stage?: WhatsAppFlowProvisioningOperationRecord["stage"];
}) {
  return operation({
    stage: params.stage ?? "COMPLETED",
    status: "MANUALLY_RESOLVED",
    providerStatus: params.outcome === "deprecated" ? "DEPRECATED" : undefined,
    cleanupAt: new Date("2026-09-07T10:00:00.000Z"),
    lease: { fence: 4 },
    providerResolution: {
      kind: params.kind,
      outcome: params.outcome,
      requestedAt: REQUESTED_AT,
      requestedBy: "user-1",
      confirmedAt: NOW,
      confirmedBy: "user-1",
    },
  });
}

function dependencies(
  overrides: Partial<Dependencies> = {}
): jest.Mocked<Dependencies> {
  return {
    claimResolution: jest.fn().mockResolvedValue({
      kind: "claimed",
      operation: operation(),
      lease: {
        operationId: "operation-1",
        ownerToken: "resolution-owner-1",
        fence: 4,
        expiresAt: new Date("2026-08-08T10:02:00.000Z"),
      },
    }),
    confirmResolution: jest.fn().mockImplementation(async params =>
      resolvedOperation({
        kind: params.kind,
        outcome: params.outcome,
      })
    ),
    releaseResolutionClaim: jest.fn().mockResolvedValue(undefined),
    assertResolutionCurrent: jest.fn().mockResolvedValue(undefined),
    acquireSourceFence: jest.fn().mockResolvedValue({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      expectedWabaId: "waba-1",
      kind: "PROVISIONING",
      semanticOperationId: "provider-resolution:published_deprecated:flow-1",
      ownerToken: "source-owner-1",
      fence: 1,
      leaseExpiresAt: new Date("2026-08-08T10:02:00.000Z"),
    }),
    assertSourceFence: jest.fn().mockResolvedValue(undefined),
    releaseSourceFence: jest.fn().mockResolvedValue(undefined),
    getFlow: jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      flow: providerFlow("PUBLISHED"),
    }),
    deprecateFlow: jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      flow: providerFlow("DEPRECATED"),
    }),
    deleteFlow: jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      flow: { success: true },
    }),
    isFlowOwnedByWaba: jest.fn((flow, wabaId) => {
      const owner = (flow as { whatsapp_business_account?: { id?: string } })
        ?.whatsapp_business_account?.id;
      return owner === wabaId;
    }),
    now: jest.fn(() => NOW),
    ...overrides,
  } as jest.Mocked<Dependencies>;
}

const INPUT = {
  workspaceId: "workspace-1",
  sourceId: "source-1",
  wabaId: "waba-1",
  accessToken: "token-1",
  providerFlowId: "flow-1",
  requestedBy: "user-1",
} as const;

describe("WhatsApp Flow provider resolution service", () => {
  it("deprecates an owned published Flow and records provider-confirmed evidence", async () => {
    const deps = dependencies();
    const service = createWhatsAppFlowProviderResolutionService(deps);

    const result = await service.resolve({
      ...INPUT,
      kind: "published_deprecated",
    });

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      operationId: "operation-1",
      operationStatus: "MANUALLY_RESOLVED",
      providerStatus: "DEPRECATED",
      providerResolution: {
        kind: "published_deprecated",
        outcome: "deprecated",
      },
    });
    expect(deps.getFlow).toHaveBeenCalledWith({
      accessToken: "token-1",
      flowId: "flow-1",
    });
    expect(deps.deprecateFlow).toHaveBeenCalledWith({
      accessToken: "token-1",
      flowId: "flow-1",
      operation: "deprecate",
    });
    expect(deps.confirmResolution).toHaveBeenCalledWith({
      lease: expect.objectContaining({ operationId: "operation-1", fence: 4 }),
      kind: "published_deprecated",
      outcome: "deprecated",
      confirmedBy: "user-1",
      now: NOW,
    });
    expect(deps.releaseResolutionClaim).not.toHaveBeenCalled();
  });

  it("confirms an already-deprecated Flow without repeating the mutation", async () => {
    const deps = dependencies({
      getFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: providerFlow("DEPRECATED"),
      }),
    });

    const result = await createWhatsAppFlowProviderResolutionService(
      deps
    ).resolve({ ...INPUT, kind: "published_deprecated" });

    expect(result).toMatchObject({
      ok: true,
      providerResolution: { outcome: "deprecated" },
    });
    expect(deps.deprecateFlow).not.toHaveBeenCalled();
    expect(deps.confirmResolution).toHaveBeenCalledTimes(1);
  });

  it("treats only an exact 404 read as conclusive missing-provider truth", async () => {
    const deps = dependencies({
      getFlow: jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        error: "Flow not found",
      }),
    });

    const result = await createWhatsAppFlowProviderResolutionService(
      deps
    ).resolve({ ...INPUT, kind: "published_deprecated" });

    expect(result).toMatchObject({
      ok: true,
      providerStatus: null,
      providerResolution: { outcome: "missing" },
    });
    expect(deps.deprecateFlow).not.toHaveBeenCalled();
    expect(deps.confirmResolution).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "missing" })
    );
  });

  it("does not misclassify Graph code 100/subcode 33 as missing", async () => {
    const deps = dependencies({
      getFlow: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        providerCode: 100,
        providerSubcode: 33,
        error: "Unsupported get request",
      }),
    });

    const result = await createWhatsAppFlowProviderResolutionService(
      deps
    ).resolve({ ...INPUT, kind: "published_deprecated" });

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Unsupported get request",
      validation_errors: [],
    });
    expect(deps.confirmResolution).not.toHaveBeenCalled();
    expect(deps.releaseResolutionClaim).toHaveBeenCalledWith({
      lease: expect.objectContaining({ operationId: "operation-1", fence: 4 }),
      clearRequest: false,
      now: NOW,
    });
  });

  it("deletes an owned provider draft and confirms absence", async () => {
    const draftOperation = operation({
      stage: "UPLOADING_JSON",
      status: "SUPERSEDED",
      providerStatus: "DRAFT",
      providerResolution: {
        kind: "draft_deleted",
        requestedAt: REQUESTED_AT,
        requestedBy: "user-1",
      },
    });
    const deps = dependencies({
      claimResolution: jest.fn().mockResolvedValue({
        kind: "claimed",
        operation: draftOperation,
        lease: {
          operationId: "operation-1",
          ownerToken: "resolution-owner-1",
          fence: 4,
          expiresAt: new Date("2026-08-08T10:02:00.000Z"),
        },
      }),
      getFlow: jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        error: "Flow not found",
      }),
    });
    deps.getFlow
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        flow: providerFlow("DRAFT"),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        error: "Flow not found",
      });

    const result = await createWhatsAppFlowProviderResolutionService(
      deps
    ).resolve({ ...INPUT, kind: "draft_deleted" });

    expect(result).toMatchObject({
      ok: true,
      providerStatus: null,
      providerResolution: {
        kind: "draft_deleted",
        outcome: "missing",
      },
    });
    expect(deps.deleteFlow).toHaveBeenCalledWith({
      accessToken: "token-1",
      flowId: "flow-1",
    });
    expect(deps.confirmResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "draft_deleted",
        outcome: "missing",
      })
    );
    expect(deps.getFlow).toHaveBeenCalledTimes(2);
  });

  it("does not confirm deletion while Meta still returns the draft", async () => {
    const deps = dependencies({
      getFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: providerFlow("DRAFT"),
      }),
    });

    const result = await createWhatsAppFlowProviderResolutionService(
      deps
    ).resolve({ ...INPUT, kind: "draft_deleted" });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "Meta still reports the managed Flow draft after deletion",
      validation_errors: [],
    });
    expect(deps.getFlow).toHaveBeenCalledTimes(2);
    expect(deps.confirmResolution).not.toHaveBeenCalled();
    expect(deps.releaseResolutionClaim).toHaveBeenCalledWith(
      expect.objectContaining({ clearRequest: false })
    );
  });

  it("requires an exact GET 404 readback even when DELETE itself returns 404", async () => {
    const deps = dependencies({
      deleteFlow: jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        error: "Flow not found",
      }),
    });
    deps.getFlow
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        flow: providerFlow("DRAFT"),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        error: "Flow not found",
      });

    const result = await createWhatsAppFlowProviderResolutionService(
      deps
    ).resolve({ ...INPUT, kind: "draft_deleted" });

    expect(result).toMatchObject({
      ok: true,
      providerResolution: { outcome: "missing" },
    });
    expect(deps.getFlow).toHaveBeenCalledTimes(2);
    expect(deps.confirmResolution).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-WABA readback instead of converting it into missing truth", async () => {
    const deps = dependencies({
      getFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: providerFlow("PUBLISHED", "waba-other"),
      }),
    });

    const result = await createWhatsAppFlowProviderResolutionService(
      deps
    ).resolve({ ...INPUT, kind: "published_deprecated" });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "Managed Flow ownership no longer matches its WABA binding",
      validation_errors: [],
    });
    expect(deps.deprecateFlow).not.toHaveBeenCalled();
    expect(deps.confirmResolution).not.toHaveBeenCalled();
    expect(deps.releaseResolutionClaim).toHaveBeenCalledWith(
      expect.objectContaining({ clearRequest: false })
    );
  });

  it("clears an unstarted wrong-action request so the correct cleanup can be claimed", async () => {
    const deps = dependencies({
      getFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: providerFlow("DRAFT"),
      }),
    });

    const result = await createWhatsAppFlowProviderResolutionService(
      deps
    ).resolve({ ...INPUT, kind: "published_deprecated" });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "Only published Flows can be deprecated",
      validation_errors: [],
    });
    expect(deps.deprecateFlow).not.toHaveBeenCalled();
    expect(deps.releaseResolutionClaim).toHaveBeenCalledWith({
      lease: expect.objectContaining({ operationId: "operation-1", fence: 4 }),
      clearRequest: true,
      now: NOW,
    });
  });

  it("returns an idempotent stored result without touching Meta", async () => {
    const alreadyResolved = resolvedOperation({
      kind: "published_deprecated",
      outcome: "deprecated",
    });
    const deps = dependencies({
      claimResolution: jest.fn().mockResolvedValue({
        kind: "already_resolved",
        operation: alreadyResolved,
      }),
    });

    const result = await createWhatsAppFlowProviderResolutionService(
      deps
    ).resolve({ ...INPUT, kind: "published_deprecated" });

    expect(result).toMatchObject({
      ok: true,
      operationId: "operation-1",
      providerResolution: { outcome: "deprecated" },
    });
    expect(deps.getFlow).not.toHaveBeenCalled();
    expect(deps.deprecateFlow).not.toHaveBeenCalled();
    expect(deps.confirmResolution).not.toHaveBeenCalled();
  });
});
