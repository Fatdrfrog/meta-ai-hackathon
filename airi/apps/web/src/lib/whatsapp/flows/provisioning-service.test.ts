/**
 * @jest-environment node
 */

jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: jest.fn(),
}));
jest.mock("@/lib/meta/app-config", () => ({
  getMetaServerAppConfig: jest.fn(),
}));
jest.mock("@/lib/whatsapp/account/resolution", () => ({
  resolveWhatsAppAccountContext: jest.fn(),
}));
jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveFreshWhatsAppSendContext: jest.fn(),
}));
jest.mock("@/lib/whatsapp/waba-service", () => ({
  getWABAPhoneNumbersStrict: jest.fn(),
}));
jest.mock("@/lib/whatsapp/flows/endpoint-security-service", () => ({
  ensureWhatsAppFlowPhoneKeyReadiness: jest.fn(),
  resolveManagedWhatsAppFlowEndpointIdentity: jest.fn(),
}));
jest.mock("@/lib/whatsapp/flows/source-binding-fence-store", () => ({
  whatsAppFlowSourceBindingFenceStore: {
    acquire: jest.fn(),
    renew: jest.fn(),
    assertCurrent: jest.fn(),
    release: jest.fn(),
  },
}));

import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import type { WhatsAppFlowProvisioningOperationRecord } from "@/models/whatsapp-flow-provisioning-operation";
import { WhatsAppFlowProvisioningStoreError } from "./provisioning-operation-store";
import { createWhatsAppFlowProvisioningService } from "./provisioning-service";
import { generateFlowJsonString } from "@/components/scenarios/builders/whatsapp/flow-json-generator";
import { parseFlowJsonToWhatsAppFlowConfig } from "@/components/scenarios/builders/whatsapp/flow-json-parser";
import { DEMOSHOP_FLOW_JSON } from "@/components/scenarios/builders/whatsapp/flow-json-fixtures";

type WhatsAppFlowProvisioningDependencies = Parameters<
  typeof createWhatsAppFlowProvisioningService
>[0];

const NOW = new Date("2026-08-08T10:00:00.000Z");
const DIGEST = "a".repeat(64);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function config(): WhatsAppFlowConfig {
  return {
    templateId: "appointment_booking",
    ctaText: "Book",
    headerText: "Appointment",
    flowNavigationMode: "data_endpoint",
    screens: [
      { id: "DETAILS", title: "Details", fields: [] },
      { id: "CONFIRM", title: "Confirm", fields: [] },
    ],
    screenRoutes: { DETAILS: ["CONFIRM"] },
  };
}

function linearConfig(): WhatsAppFlowConfig {
  return {
    templateId: "lead_generation",
    ctaText: "Continue",
    headerText: "Lead form",
    flowNavigationMode: "linear",
    screens: [{ id: "LEAD_FORM", title: "Lead form", fields: [] }],
  };
}

function operation(
  overrides: Partial<WhatsAppFlowProvisioningOperationRecord> = {}
): WhatsAppFlowProvisioningOperationRecord {
  const providerAcknowledgement =
    typeof overrides.providerFlowId === "string" &&
    !Object.prototype.hasOwnProperty.call(overrides, "providerAcknowledgedAt")
      ? { providerAcknowledgedAt: NOW }
      : {};
  return {
    operationId: "operation-1",
    operationKeyHash: "b".repeat(64),
    workspaceId: "workspace-1",
    scenarioId: "scenario-1",
    nodeId: "node-1",
    targetOwner: "template",
    sourceId: "source-1",
    wabaId: "waba-1",
    releaseMode: "data_endpoint",
    endpointId: "endpoint-1",
    applicationId: "application-1",
    contentRevision: 1,
    contentDigest: DIGEST,
    providerMarker: "airi_marker",
    stage: "CREATING_FLOW",
    status: "RUNNING",
    lease: { fence: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...providerAcknowledgement,
    ...overrides,
  };
}

function input() {
  return {
    workspaceId: "workspace-1",
    sourceId: "source-1",
    scenarioId: "scenario-1",
    nodeId: "node-1",
    editableConfig: config(),
    updatedBy: "user-1",
  };
}

function dependencies(
  overrides: Partial<WhatsAppFlowProvisioningDependencies> = {}
) {
  let current = operation();
  const projection = {
    operationId: current.operationId,
    sourceId: current.sourceId,
    wabaId: current.wabaId,
    contentRevision: current.contentRevision,
    contentDigest: current.contentDigest,
    providerStatus: "DRAFT" as const,
  };
  const deps: WhatsAppFlowProvisioningDependencies = {
    now: () => NOW,
    getReleasePolicy: jest.fn().mockReturnValue({
      valid: true,
      managedFlowEnabled: true,
      legacyFlowAllowed: true,
    }),
    isWorkspaceEnabled: jest.fn().mockResolvedValue(true),
    validateTarget: jest.fn().mockResolvedValue({
      config: config(),
      contentDigest: DIGEST,
      owner: "template",
      releaseMode: "data_endpoint",
    }),
    resolveContext: jest.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      applicationId: "application-1",
      accessToken: "secret-token",
      phoneNumberIds: ["phone-1"],
    }),
    resolveEndpointIdentity: jest.fn().mockResolvedValue({
      endpointId: "endpoint-1",
      endpointUri:
        "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
      expectedGenerationId: "generation-1",
    }),
    prepareOperation: jest.fn().mockImplementation(async () => current),
    acquireLease: jest.fn().mockResolvedValue({
      operationId: "operation-1",
      ownerToken: "worker-1",
      fence: 1,
      expiresAt: new Date("2026-08-08T10:02:00.000Z"),
    }),
    renewLease: jest.fn().mockImplementation(async ({ lease }) => ({
      ...lease,
      expiresAt: new Date(lease.expiresAt.getTime() + 2 * 60 * 1_000),
    })),
    assertTargetCurrent: jest.fn().mockResolvedValue(undefined),
    assertSourceBinding: jest.fn().mockResolvedValue(undefined),
    acquireSourceFence: jest.fn().mockResolvedValue({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      expectedWabaId: "waba-1",
      kind: "PROVISIONING",
      semanticOperationId: `provision:${DIGEST}`,
      ownerToken: "source-worker-1",
      fence: 1,
      leaseExpiresAt: new Date("2026-08-08T10:02:00.000Z"),
    }),
    renewSourceFence: jest.fn().mockImplementation(async lease => lease),
    assertSourceFence: jest.fn().mockResolvedValue(undefined),
    releaseSourceFence: jest.fn().mockResolvedValue(undefined),
    transitionStage: jest.fn().mockImplementation(async ({ stage }) => {
      current = { ...current, stage, status: "RUNNING" };
      return current;
    }),
    recordProviderDraft: jest.fn().mockImplementation(async params => {
      current = {
        ...current,
        providerFlowId: params.providerFlowId,
        providerAcknowledgedAt:
          current.providerAcknowledgedAt ?? params.now ?? NOW,
        providerFlowName: params.providerFlowName,
      };
      return current;
    }),
    recordProviderStatus: jest.fn().mockImplementation(async params => {
      current = { ...current, providerStatus: params.providerStatus };
      return current;
    }),
    resolveMissingProviderDraft: jest.fn().mockImplementation(async params => {
      current = {
        ...current,
        status: "MANUALLY_RESOLVED",
        lastError: params.error,
        lease: { fence: params.lease.fence },
      };
      return current;
    }),
    reconcileCompletedProviderStatus: jest
      .fn()
      .mockImplementation(async ({ operation: completed, providerStatus }) => ({
        operation: { ...completed, providerStatus },
        projection: {
          ...projection,
          flowId: completed.providerFlowId,
          providerStatus,
        },
        scenarioUpdatedAt: "2026-08-08T10:00:04.000Z",
      })),
    failOperation: jest.fn().mockImplementation(async ({ error }) => {
      current = { ...current, status: "FAILED", lastError: error };
      return current;
    }),
    completeOperation: jest.fn().mockImplementation(async () => {
      current = { ...current, status: "COMPLETED", stage: "COMPLETED" };
      return {
        operation: current,
        projection: {
          ...projection,
          flowId: current.providerFlowId,
          providerStatus: "PUBLISHED",
        },
        scenarioUpdatedAt: "2026-08-08T10:00:04.000Z",
      };
    }),
    releaseLease: jest.fn().mockResolvedValue(undefined),
    findFlowByExactName: jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      flow: null,
    }),
    createFlow: jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      providerFlowId: "flow-1",
      flow: {
        id: "flow-1",
        name: "Appointment [airi_marker]",
        status: "DRAFT",
        endpoint_uri:
          "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
        whatsapp_business_account: { id: "waba-1" },
        application: { id: "application-1" },
        validation_errors: [],
      },
    }),
    getFlow: jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      flow: {
        id: "flow-1",
        name: "Appointment [airi_marker]",
        status: "PUBLISHED",
        endpoint_uri:
          "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
        whatsapp_business_account: { id: "waba-1" },
        application: { id: "application-1" },
        validation_errors: [],
      },
    }),
    updateFlow: jest.fn().mockImplementation(async params => ({
      ok: true,
      status: 200,
      providerFlowId: params.flowId,
      flow: {
        id: params.flowId,
        name: "Appointment [airi_marker]",
        status: params.operation === "publish" ? "PUBLISHED" : "DRAFT",
        endpoint_uri:
          "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
        whatsapp_business_account: { id: "waba-1" },
        application: { id: "application-1" },
        validation_errors: [],
      },
    })),
    ensurePhoneKeys: jest.fn().mockResolvedValue({
      provisioning: {
        status: "READY",
        generationId: "generation-1",
      },
      phones: [
        {
          phoneNumberId: "phone-1",
          generationId: "generation-1",
          signatureStatus: "VALID",
          stage: "READY",
          updatedAt: NOW.toISOString(),
        },
      ],
    }),
    generateFlowJson: jest.fn().mockReturnValue('{"version":"7.1"}'),
    ...overrides,
  };
  return deps;
}

describe("WhatsApp Flow provisioning service", () => {
  it("returns a specific rebind failure before account or provider work", async () => {
    const deps = dependencies({
      validateTarget: jest
        .fn()
        .mockRejectedValue(
          new WhatsAppFlowProvisioningStoreError(
            "TEMPLATE_REBIND_REQUIRED",
            "Published template Flow binding must be replaced"
          )
        ),
    });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_TEMPLATE_REBIND_REQUIRED",
        retryable: false,
      },
    });
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(deps.prepareOperation).not.toHaveBeenCalled();
    expect(deps.getFlow).not.toHaveBeenCalled();
    expect(deps.createFlow).not.toHaveBeenCalled();
  });

  it("hard-stops dark policy before scenario, context, or provider work", async () => {
    const deps = dependencies({
      getReleasePolicy: jest.fn().mockReturnValue({
        valid: true,
        managedFlowEnabled: false,
        legacyFlowAllowed: true,
      }),
    });
    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WHATSAPP_FLOW_PROVISIONING_POLICY_DISABLED" },
    });
    expect(deps.validateTarget).not.toHaveBeenCalled();
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(deps.createFlow).not.toHaveBeenCalled();
  });

  it("records an operation before provider mutation and projects only after PUBLISHED readback", async () => {
    const deps = dependencies();
    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: true,
      status: "COMPLETED",
      stage: "COMPLETED",
      projection: {
        flowId: "flow-1",
        providerStatus: "PUBLISHED",
      },
      scenarioRevision: {
        finalUpdatedAt: "2026-08-08T10:00:04.000Z",
      },
    });
    expect(deps.createFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointUri:
          "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
      })
    );
    expect(
      (deps.prepareOperation as jest.Mock).mock.invocationCallOrder[0]
    ).toBeLessThan((deps.createFlow as jest.Mock).mock.invocationCallOrder[0]);
    expect(
      (deps.acquireSourceFence as jest.Mock).mock.invocationCallOrder[0]
    ).toBeLessThan(
      (deps.prepareOperation as jest.Mock).mock.invocationCallOrder[0]
    );
    expect(
      (deps.assertSourceFence as jest.Mock).mock.invocationCallOrder[0]
    ).toBeLessThan((deps.createFlow as jest.Mock).mock.invocationCallOrder[0]);
    const uploadCallIndex = (deps.updateFlow as jest.Mock).mock.calls.findIndex(
      ([params]) => params.operation === "update_json"
    );
    expect(
      (deps.ensurePhoneKeys as jest.Mock).mock.invocationCallOrder[0]
    ).toBeLessThan(
      (deps.updateFlow as jest.Mock).mock.invocationCallOrder[uploadCallIndex]
    );
    expect(deps.completeOperation).toHaveBeenCalledTimes(1);
    expect(deps.releaseSourceFence).toHaveBeenCalledTimes(1);
  });

  it("creates a service-message replacement from its immutable published clone", async () => {
    const replacement = operation({
      targetOwner: "service_message",
      replacesOperationId: "operation-published",
      cloneFlowId: "flow-published",
      contentRevision: 2,
    });
    const deps = dependencies({
      validateTarget: jest.fn().mockResolvedValue({
        config: config(),
        contentDigest: DIGEST,
        owner: "service_message",
        releaseMode: "data_endpoint",
      }),
      prepareOperation: jest.fn().mockResolvedValue(replacement),
      getFlow: jest.fn().mockImplementation(async params => ({
        ok: true,
        status: 200,
        flow:
          params.flowId === "flow-published"
            ? {
                id: "flow-published",
                name: "Published predecessor",
                status: "PUBLISHED",
                whatsapp_business_account: { id: "waba-1" },
                validation_errors: [],
              }
            : {
                id: "flow-1",
                name: "Appointment [airi_marker]",
                status: "PUBLISHED",
                endpoint_uri:
                  "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
                whatsapp_business_account: { id: "waba-1" },
                application: { id: "application-1" },
                validation_errors: [],
              },
      })),
    });

    await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(deps.createFlow).toHaveBeenCalledWith(
      expect.objectContaining({ cloneFlowId: "flow-published" })
    );
  });

  it.each(["DRAFT", "DEPRECATED", "BLOCKED", "THROTTLED"] as const)(
    "fails closed before cloning a locally published predecessor that Meta reports as %s",
    async providerStatus => {
      const replacement = operation({
        targetOwner: "service_message",
        replacesOperationId: "operation-published",
        cloneFlowId: "flow-published",
        contentRevision: 2,
      });
      const deps = dependencies({
        validateTarget: jest.fn().mockResolvedValue({
          config: config(),
          contentDigest: DIGEST,
          owner: "service_message",
          releaseMode: "data_endpoint",
        }),
        prepareOperation: jest.fn().mockResolvedValue(replacement),
        getFlow: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          flow: {
            id: "flow-published",
            name: "Stale predecessor",
            status: providerStatus,
            whatsapp_business_account: { id: "waba-1" },
          },
        }),
      });

      const result =
        await createWhatsAppFlowProvisioningService(deps).provision(input());

      expect(result).toMatchObject({
        ok: false,
        operationId: "operation-1",
        error: {
          code: "WHATSAPP_FLOW_PROVISIONING_CLONE_SOURCE_UNAVAILABLE",
          retryable: false,
        },
      });
      expect(deps.createFlow).not.toHaveBeenCalled();
      expect(deps.failOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: "WHATSAPP_FLOW_PROVISIONING_CLONE_SOURCE_UNAVAILABLE",
          }),
        })
      );
    }
  );

  it("fails closed before cloning a predecessor that Meta no longer has", async () => {
    const replacement = operation({
      targetOwner: "service_message",
      replacesOperationId: "operation-published",
      cloneFlowId: "flow-published",
      contentRevision: 2,
    });
    const deps = dependencies({
      validateTarget: jest.fn().mockResolvedValue({
        config: config(),
        contentDigest: DIGEST,
        owner: "service_message",
        releaseMode: "data_endpoint",
      }),
      prepareOperation: jest.fn().mockResolvedValue(replacement),
      getFlow: jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        error: "Flow not found",
        validation_errors: [],
        flow: null,
      }),
    });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_CLONE_SOURCE_UNAVAILABLE",
        retryable: false,
      },
    });
    expect(deps.createFlow).not.toHaveBeenCalled();
  });

  it("does not create a provisioning ledger or call Meta when the source fence is busy", async () => {
    const deps = dependencies({
      acquireSourceFence: jest
        .fn()
        .mockRejectedValue(new Error("source fence busy")),
    });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_OPERATION_FAILED",
        retryable: true,
      },
    });
    expect(deps.prepareOperation).not.toHaveBeenCalled();
    expect(deps.createFlow).not.toHaveBeenCalled();
  });

  it("re-reads completed operations and persists a provider-confirmed BLOCKED status", async () => {
    const completed = operation({
      providerFlowId: "flow-1",
      providerFlowName: "Appointment [airi_marker]",
      providerStatus: "PUBLISHED",
      status: "COMPLETED",
      stage: "COMPLETED",
    });
    const deps = dependencies({
      prepareOperation: jest.fn().mockResolvedValue(completed),
      getFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: {
          id: "flow-1",
          name: "Appointment [airi_marker]",
          status: "BLOCKED",
          endpoint_uri:
            "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
          whatsapp_business_account: { id: "waba-1" },
          application: { id: "application-1" },
          validation_errors: [],
        },
      }),
    });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      status: "COMPLETED",
      stage: "READING_BACK",
      projection: { flowId: "flow-1", providerStatus: "BLOCKED" },
      scenarioRevision: {
        finalUpdatedAt: "2026-08-08T10:00:04.000Z",
      },
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
      },
    });
    expect(deps.getFlow).toHaveBeenCalledTimes(1);
    expect(deps.reconcileCompletedProviderStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: completed,
        providerStatus: "BLOCKED",
      })
    );
    expect(deps.acquireLease).not.toHaveBeenCalled();
    expect(deps.updateFlow).not.toHaveBeenCalled();
    expect(deps.releaseSourceFence).toHaveBeenCalledTimes(1);
  });

  it("revalidates current phone keys before accepting a completed data-endpoint replay", async () => {
    const completed = operation({
      providerFlowId: "flow-1",
      providerFlowName: "Appointment [airi_marker]",
      providerStatus: "PUBLISHED",
      status: "COMPLETED",
      stage: "COMPLETED",
    });
    const deps = dependencies({
      prepareOperation: jest.fn().mockResolvedValue(completed),
      ensurePhoneKeys: jest.fn().mockResolvedValue({
        provisioning: {
          status: "IN_PROGRESS",
          generationId: "generation-2",
        },
        phones: [
          {
            phoneNumberId: "phone-1",
            generationId: "generation-1",
            signatureStatus: "INVALID",
            stage: "VERIFYING",
            updatedAt: NOW.toISOString(),
          },
        ],
      }),
    });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      status: "COMPLETED",
      stage: "ENSURING_PHONE_KEYS",
      projection: { flowId: "flow-1", providerStatus: "PUBLISHED" },
      phones: [
        expect.objectContaining({
          phoneNumberId: "phone-1",
          signatureStatus: "INVALID",
        }),
      ],
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_PHONE_KEYS_NOT_READY",
        retryable: true,
      },
    });
    expect(deps.ensurePhoneKeys).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGenerationId: "generation-1",
        phoneNumberIds: ["phone-1"],
      })
    );
    expect(deps.reconcileCompletedProviderStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: completed,
        providerStatus: "PUBLISHED",
      })
    );
    expect(deps.acquireLease).not.toHaveBeenCalled();
  });

  it("fails a deleted completed-flow replay without returning cached PUBLISHED state", async () => {
    const completed = operation({
      providerFlowId: "flow-1",
      providerFlowName: "Appointment [airi_marker]",
      providerStatus: "PUBLISHED",
      status: "COMPLETED",
      stage: "COMPLETED",
    });
    const deps = dependencies({
      prepareOperation: jest.fn().mockResolvedValue(completed),
      getFlow: jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        error: "Flow not found",
      }),
    });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      status: "COMPLETED",
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
        retryable: false,
      },
    });
    expect(result).not.toHaveProperty("projection");
    expect(result).not.toHaveProperty("scenarioRevision");
    expect(deps.reconcileCompletedProviderStatus).not.toHaveBeenCalled();
    expect(deps.acquireLease).not.toHaveBeenCalled();
  });

  it("hard-stops a completed replay when its source now belongs to another WABA", async () => {
    const completed = operation({
      providerFlowId: "flow-1",
      providerFlowName: "Appointment [airi_marker]",
      providerStatus: "PUBLISHED",
      status: "COMPLETED",
      stage: "COMPLETED",
    });
    const deps = dependencies({
      prepareOperation: jest.fn().mockResolvedValue(completed),
      assertSourceBinding: jest
        .fn()
        .mockRejectedValue(
          new WhatsAppFlowProvisioningStoreError(
            "SOURCE_REBIND_REQUIRED",
            "WhatsApp source now belongs to another WABA"
          )
        ),
    });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      stage: "READING_BACK",
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_SOURCE_REBIND_REQUIRED",
        retryable: false,
      },
    });
    expect(deps.getFlow).not.toHaveBeenCalled();
    expect(deps.reconcileCompletedProviderStatus).not.toHaveBeenCalled();
  });

  it("stops provider mutation when the source WABA changes after create acknowledgement", async () => {
    const assertSourceBinding = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(
        new WhatsAppFlowProvisioningStoreError(
          "SOURCE_REBIND_REQUIRED",
          "WhatsApp source changed during provisioning"
        )
      );
    const deps = dependencies({ assertSourceBinding });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_SOURCE_REBIND_REQUIRED",
        retryable: false,
      },
    });
    expect(deps.createFlow).toHaveBeenCalledTimes(1);
    expect(deps.recordProviderDraft).toHaveBeenCalledWith(
      expect.objectContaining({ providerFlowId: "flow-1" })
    );
    expect(deps.updateFlow).not.toHaveBeenCalled();
    expect(deps.completeOperation).not.toHaveBeenCalled();
  });

  it("renews the fenced lease while a provider mutation exceeds the lease window", async () => {
    jest.useFakeTimers();
    const providerCall =
      deferred<
        Awaited<ReturnType<WhatsAppFlowProvisioningDependencies["createFlow"]>>
      >();
    const createStarted = deferred<void>();
    const deps = dependencies({
      createFlow: jest.fn().mockImplementation(() => {
        createStarted.resolve();
        return providerCall.promise;
      }),
    });

    try {
      const pending =
        createWhatsAppFlowProvisioningService(deps).provision(input());
      await createStarted.promise;
      await jest.advanceTimersByTimeAsync(2 * 60 * 1_000 + 1);
      providerCall.resolve({
        ok: true,
        status: 200,
        providerFlowId: "flow-1",
        flow: {
          id: "flow-1",
          name: "Appointment [airi_marker]",
          status: "DRAFT",
          endpoint_uri:
            "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
          whatsapp_business_account: { id: "waba-1" },
          application: { id: "application-1" },
          validation_errors: [],
        },
      });
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(deps.renewLease).toHaveBeenCalled();
      expect(deps.renewSourceFence).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: "source-1",
          ownerToken: "source-worker-1",
          fence: 1,
        })
      );
      expect(deps.renewLease).toHaveBeenCalledWith(
        expect.objectContaining({
          lease: expect.objectContaining({
            operationId: "operation-1",
            ownerToken: "worker-1",
            fence: 1,
          }),
        })
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("reuses a template draft ID and records its provider-confirmed name", async () => {
    const bound = operation({
      providerFlowId: "template-draft-flow",
      stage: "CREATING_FLOW",
    });
    const providerName = "Customer approved template Flow";
    const getFlow = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        flow: {
          id: "template-draft-flow",
          name: providerName,
          status: "DRAFT",
          endpoint_uri:
            "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
          whatsapp_business_account: { id: "waba-1" },
          application: { id: "application-1" },
          validation_errors: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        flow: {
          id: "template-draft-flow",
          name: providerName,
          status: "DRAFT",
          endpoint_uri:
            "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
          whatsapp_business_account: { id: "waba-1" },
          application: { id: "application-1" },
          validation_errors: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        flow: {
          id: "template-draft-flow",
          name: providerName,
          status: "PUBLISHED",
          endpoint_uri:
            "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
          whatsapp_business_account: { id: "waba-1" },
          application: { id: "application-1" },
          validation_errors: [],
        },
      });
    const deps = dependencies({
      validateTarget: jest.fn().mockResolvedValue({
        config: config(),
        contentDigest: DIGEST,
        owner: "template",
        releaseMode: "data_endpoint",
        managedProjection: {
          operationId: "operation-1",
          sourceId: "source-1",
          wabaId: "waba-1",
          contentRevision: 1,
          flowId: "template-draft-flow",
          providerStatus: "DRAFT",
          contentDigest: DIGEST,
        },
      }),
      prepareOperation: jest.fn().mockResolvedValue(bound),
      getFlow,
      updateFlow: jest.fn().mockImplementation(async params => ({
        ok: true,
        status: 200,
        providerFlowId: params.flowId,
        flow: {
          id: params.flowId,
          name: providerName,
          status: params.operation === "publish" ? "PUBLISHED" : "DRAFT",
          endpoint_uri:
            "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
          whatsapp_business_account: { id: "waba-1" },
          application: { id: "application-1" },
          validation_errors: [],
        },
      })),
    });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result.ok).toBe(true);
    expect(deps.findFlowByExactName).not.toHaveBeenCalled();
    expect(deps.createFlow).not.toHaveBeenCalled();
    expect(deps.recordProviderDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFlowId: "template-draft-flow",
        providerFlowName: providerName,
      })
    );
    expect(deps.updateFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "update_json",
        flowId: "template-draft-flow",
      })
    );
  });

  it("does not treat a provider-published template as current without stored digest evidence", async () => {
    const bound = operation({
      providerFlowId: "template-flow",
      stage: "CREATING_FLOW",
    });
    const deps = dependencies({
      validateTarget: jest.fn().mockResolvedValue({
        config: config(),
        contentDigest: DIGEST,
        owner: "template",
        releaseMode: "data_endpoint",
        managedProjection: {
          operationId: "operation-1",
          sourceId: "source-1",
          wabaId: "waba-1",
          contentRevision: 1,
          flowId: "template-flow",
          providerStatus: "DRAFT",
          contentDigest: DIGEST,
        },
      }),
      prepareOperation: jest.fn().mockResolvedValue(bound),
      getFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: {
          id: "template-flow",
          name: "Provider-published template",
          status: "PUBLISHED",
          endpoint_uri:
            "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
          whatsapp_business_account: { id: "waba-1" },
          application: { id: "application-1" },
          validation_errors: [],
        },
      }),
    });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      stage: "CREATING_FLOW",
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_TEMPLATE_REBIND_REQUIRED",
        retryable: false,
      },
    });
    expect(deps.recordProviderDraft).not.toHaveBeenCalled();
    expect(deps.updateFlow).not.toHaveBeenCalled();
    expect(deps.completeOperation).not.toHaveBeenCalled();
  });

  it.each(["linear", "static_graph"] as const)(
    "uses the same durable release lifecycle for %s Flows without endpoint provisioning",
    async navigationMode => {
      const imported = parseFlowJsonToWhatsAppFlowConfig({
        flowJson: DEMOSHOP_FLOW_JSON,
        flowId: "fixture",
      });
      if (!imported) throw new Error("Expected lossless static graph");
      const linear =
        navigationMode === "static_graph"
          ? {
              ...imported,
              templateId: "custom",
              metaFlowId: undefined,
              headerText: "Lead form",
            }
          : linearConfig();
      const deps = dependencies({
        getReleasePolicy: jest.fn().mockReturnValue({
          valid: true,
          managedFlowEnabled: false,
          legacyFlowAllowed: true,
        }),
        generateFlowJson: jest.fn(generateFlowJsonString),
        validateTarget: jest.fn().mockResolvedValue({
          config: linear,
          contentDigest: DIGEST,
          owner: "template",
          releaseMode: "linear",
        }),
        createFlow: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          providerFlowId: "flow-1",
          flow: {
            id: "flow-1",
            name: "Lead form [airi_marker]",
            status: "DRAFT",
            whatsapp_business_account: { id: "waba-1" },
            validation_errors: [],
          },
        }),
        getFlow: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          flow: {
            id: "flow-1",
            name: "Lead form [airi_marker]",
            status: "PUBLISHED",
            whatsapp_business_account: { id: "waba-1" },
            validation_errors: [],
          },
        }),
        updateFlow: jest.fn().mockImplementation(async params => ({
          ok: true,
          status: 200,
          providerFlowId: params.flowId,
          flow: {
            id: params.flowId,
            name: "Lead form [airi_marker]",
            status: params.operation === "publish" ? "PUBLISHED" : "DRAFT",
            whatsapp_business_account: { id: "waba-1" },
            validation_errors: [],
          },
        })),
      });

      const result = await createWhatsAppFlowProvisioningService(
        deps
      ).provision({
        ...input(),
        editableConfig: linear,
      });

      if (!result.ok) throw new Error(JSON.stringify(result));
      expect(result).toMatchObject({
        ok: true,
        projection: { flowId: "flow-1", providerStatus: "PUBLISHED" },
      });
      expect(deps.resolveEndpointIdentity).not.toHaveBeenCalled();
      expect(deps.ensurePhoneKeys).not.toHaveBeenCalled();
      expect(deps.isWorkspaceEnabled).not.toHaveBeenCalled();
      expect(deps.prepareOperation).toHaveBeenCalledWith(
        expect.objectContaining({ releaseMode: "linear" })
      );
      expect(deps.createFlow).toHaveBeenCalledWith(
        expect.not.objectContaining({ endpointUri: expect.anything() })
      );
      expect(deps.updateFlow).not.toHaveBeenCalledWith(
        expect.objectContaining({ operation: "update" })
      );
      if (navigationMode === "static_graph") {
        const upload = jest
          .mocked(deps.updateFlow)
          .mock.calls.find(
            ([request]) => request.operation === "update_json"
          )?.[0];
        if (upload?.operation !== "update_json")
          throw new Error("Expected graph upload");
        expect(JSON.parse(upload.flowJson!)).toEqual(DEMOSHOP_FLOW_JSON);
      }
    }
  );

  it("hard-stops linear Flow releases after the legacy cutoff before scenario or provider work", async () => {
    const deps = dependencies({
      getReleasePolicy: jest.fn().mockReturnValue({
        valid: true,
        managedFlowEnabled: true,
        legacyFlowAllowed: false,
      }),
    });

    const result = await createWhatsAppFlowProvisioningService(deps).provision({
      ...input(),
      editableConfig: linearConfig(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WHATSAPP_FLOW_PROVISIONING_LEGACY_DISABLED" },
    });
    expect(deps.validateTarget).not.toHaveBeenCalled();
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(deps.prepareOperation).not.toHaveBeenCalled();
    expect(deps.createFlow).not.toHaveBeenCalled();
  });

  it("persists an acknowledged create id before returning a failed provider readback", async () => {
    const deps = dependencies({
      createFlow: jest.fn().mockResolvedValue({
        ok: false,
        status: 502,
        providerFlowId: "flow-acknowledged",
        flow: null,
        error: "Meta acknowledged the Flow but readback failed",
        providerCode: 190,
        providerSubcode: 463,
      }),
    });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      stage: "CREATING_FLOW",
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
        providerCode: 190,
        providerSubcode: 463,
        retryable: true,
      },
    });
    expect(deps.recordProviderDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFlowId: "flow-acknowledged",
      })
    );
    expect(
      (deps.recordProviderDraft as jest.Mock).mock.invocationCallOrder[0]
    ).toBeLessThan(
      (deps.failOperation as jest.Mock).mock.invocationCallOrder[0]
    );
    expect(deps.updateFlow).not.toHaveBeenCalled();
  });

  it("terminally resolves an acknowledged draft only after a definitive 404", async () => {
    const acknowledged = operation({
      providerFlowId: "flow-acknowledged",
      providerAcknowledgedAt: new Date("2026-08-08T09:50:00.000Z"),
      providerFlowName: "Appointment [airi_marker]",
      providerStatus: "DRAFT",
      stage: "CREATING_FLOW",
      createdAt: new Date("2026-08-08T09:50:00.000Z"),
    });
    const resolved = {
      ...acknowledged,
      status: "MANUALLY_RESOLVED" as const,
      cleanupAt: new Date("2026-09-07T10:00:00.000Z"),
      lease: { fence: 1 },
    };
    const resolveMissingProviderDraft = jest.fn().mockResolvedValue(resolved);
    const deps = dependencies({
      prepareOperation: jest.fn().mockResolvedValue(acknowledged),
      getFlow: jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        flow: null,
        error: "Flow not found",
      }),
    });
    Object.assign(deps, { resolveMissingProviderDraft });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      operationId: acknowledged.operationId,
      status: "MANUALLY_RESOLVED",
      stage: "CREATING_FLOW",
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
        retryable: true,
      },
    });
    expect(resolveMissingProviderDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFlowId: "flow-acknowledged",
        error: expect.objectContaining({
          code: "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
          stage: "CREATING_FLOW",
          retryable: true,
        }),
      })
    );
    expect(deps.failOperation).not.toHaveBeenCalled();
    expect(deps.findFlowByExactName).toHaveBeenCalledWith({
      accessToken: "secret-token",
      wabaId: "waba-1",
      name: "Appointment [airi_marker]",
    });
    expect(deps.createFlow).not.toHaveBeenCalled();
  });

  it("keeps a zero-match acknowledged draft resumable during the provider consistency grace", async () => {
    const acknowledged = operation({
      providerFlowId: "flow-acknowledged",
      providerAcknowledgedAt: new Date("2026-08-08T09:59:00.000Z"),
      providerFlowName: "Appointment [airi_marker]",
      providerStatus: "DRAFT",
      stage: "CREATING_FLOW",
      createdAt: new Date("2026-08-08T09:59:00.000Z"),
    });
    const resolveMissingProviderDraft = jest.fn().mockResolvedValue({
      ...acknowledged,
      status: "MANUALLY_RESOLVED",
      lease: { fence: 1 },
    });
    const deps = dependencies({
      prepareOperation: jest.fn().mockResolvedValue(acknowledged),
      getFlow: jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        flow: null,
        error: "Flow not found",
      }),
    });
    Object.assign(deps, { resolveMissingProviderDraft });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      status: "FAILED",
      stage: "CREATING_FLOW",
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
        retryable: true,
      },
    });
    expect(deps.findFlowByExactName).toHaveBeenCalled();
    expect(resolveMissingProviderDraft).not.toHaveBeenCalled();
    expect(deps.failOperation).toHaveBeenCalled();
    expect(deps.createFlow).not.toHaveBeenCalled();
  });

  it("starts missing-draft grace when an old operation receives a fresh provider acknowledgement", async () => {
    let now = NOW;
    let current = operation({
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
      updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    const prepareOperation = jest.fn().mockImplementation(async () => current);
    const recordProviderDraft = jest.fn().mockImplementation(async params => {
      current = {
        ...current,
        providerFlowId: params.providerFlowId,
        providerFlowName: params.providerFlowName,
        providerAcknowledgedAt: params.now,
      };
      return current;
    });
    const failOperation = jest.fn().mockImplementation(async ({ error }) => {
      current = { ...current, status: "FAILED" as const, lastError: error };
      return current;
    });
    const resolveMissingProviderDraft = jest.fn();
    const createFlow = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      providerFlowId: "flow-freshly-acknowledged",
      flow: null,
      error: "Meta acknowledged the Flow but readback failed",
    });
    const deps = dependencies({
      now: () => now,
      prepareOperation,
      recordProviderDraft,
      failOperation,
      resolveMissingProviderDraft,
      createFlow,
      getFlow: jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        flow: null,
        error: "Flow not found",
      }),
    });
    const service = createWhatsAppFlowProvisioningService(deps);

    const firstResult = await service.provision(input());
    expect(firstResult).toMatchObject({ ok: false, status: "FAILED" });
    expect(current).toMatchObject({
      providerFlowId: "flow-freshly-acknowledged",
      providerAcknowledgedAt: NOW,
    });

    now = new Date("2026-08-08T10:01:00.000Z");
    const retryResult = await service.provision(input());

    expect(retryResult).toMatchObject({
      ok: false,
      status: "FAILED",
      stage: "CREATING_FLOW",
      error: { retryable: true },
    });
    expect(resolveMissingProviderDraft).not.toHaveBeenCalled();
    expect(createFlow).toHaveBeenCalledTimes(1);
    expect(deps.findFlowByExactName).toHaveBeenCalledWith({
      accessToken: "secret-token",
      wabaId: "waba-1",
      name: "Appointment [airi_marker]",
    });
  });

  it("resumes the acknowledged provider ID when exact-name reconciliation finds the same Flow", async () => {
    const acknowledged = operation({
      providerFlowId: "flow-acknowledged",
      providerMarker: "airi_random_marker_7f3b",
      providerStatus: "DRAFT",
      stage: "CREATING_FLOW",
      createdAt: new Date("2026-08-08T09:50:00.000Z"),
    });
    const draftFlow = {
      id: "flow-acknowledged",
      name: "Appointment [airi_random_marker_7f3b]",
      status: "DRAFT",
      endpoint_uri:
        "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
      whatsapp_business_account: { id: "waba-1" },
      application: { id: "application-1" },
      validation_errors: [],
    };
    const getFlow = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        flow: null,
        error: "Flow not found",
      })
      .mockResolvedValueOnce({ ok: true, status: 200, flow: draftFlow })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        flow: { ...draftFlow, status: "PUBLISHED" },
      });
    const resolveMissingProviderDraft = jest.fn().mockResolvedValue({
      ...acknowledged,
      status: "MANUALLY_RESOLVED",
      lease: { fence: 1 },
    });
    const deps = dependencies({
      prepareOperation: jest.fn().mockResolvedValue(acknowledged),
      getFlow,
      findFlowByExactName: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: draftFlow,
      }),
      updateFlow: jest.fn().mockImplementation(async params => ({
        ok: true,
        status: 200,
        providerFlowId: params.flowId,
        flow: {
          ...draftFlow,
          status: params.operation === "publish" ? "PUBLISHED" : "DRAFT",
        },
      })),
    });
    Object.assign(deps, { resolveMissingProviderDraft });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result.ok).toBe(true);
    expect(deps.recordProviderDraft).toHaveBeenCalledWith(
      expect.objectContaining({ providerFlowId: "flow-acknowledged" })
    );
    expect(deps.findFlowByExactName).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Appointment [airi_random_marker_7f3b]",
      })
    );
    expect(resolveMissingProviderDraft).not.toHaveBeenCalled();
    expect(deps.createFlow).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a different exact-name Flow",
      reconciliation: {
        ok: true,
        status: 200,
        flow: { id: "flow-different", name: "Appointment [airi_marker]" },
      },
      code: "WHATSAPP_FLOW_PROVISIONING_PROVIDER_MISMATCH",
    },
    {
      label: "ambiguous exact-name matches",
      reconciliation: {
        ok: false,
        status: 409,
        flow: null,
        error: "Multiple provider Flows use the exact reconciliation name",
      },
      code: "WHATSAPP_FLOW_PROVISIONING_MARKER_AMBIGUOUS",
    },
  ])("hard-stops $label after an acknowledged-ID 404", async testCase => {
    const acknowledged = operation({
      providerFlowId: "flow-acknowledged",
      providerFlowName: "Appointment [airi_marker]",
      providerStatus: "DRAFT",
      stage: "CREATING_FLOW",
      createdAt: new Date("2026-08-08T09:50:00.000Z"),
    });
    const resolveMissingProviderDraft = jest.fn().mockResolvedValue({
      ...acknowledged,
      status: "MANUALLY_RESOLVED",
      lease: { fence: 1 },
    });
    const deps = dependencies({
      prepareOperation: jest.fn().mockResolvedValue(acknowledged),
      getFlow: jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        flow: null,
        error: "Flow not found",
      }),
      findFlowByExactName: jest.fn().mockResolvedValue(testCase.reconciliation),
    });
    Object.assign(deps, { resolveMissingProviderDraft });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      status: "FAILED",
      stage: "CREATING_FLOW",
      error: { code: testCase.code, retryable: false },
    });
    expect(resolveMissingProviderDraft).not.toHaveBeenCalled();
    expect(deps.failOperation).toHaveBeenCalled();
    expect(deps.createFlow).not.toHaveBeenCalled();
    expect(deps.updateFlow).not.toHaveBeenCalled();
  });

  it("keeps an acknowledged draft resumable when Meta's missing-or-permissions error is ambiguous", async () => {
    const acknowledged = operation({
      providerFlowId: "flow-acknowledged",
      providerFlowName: "Appointment [airi_marker]",
      providerStatus: "DRAFT",
      stage: "CREATING_FLOW",
    });
    const resolveMissingProviderDraft = jest.fn();
    const deps = dependencies({
      prepareOperation: jest.fn().mockResolvedValue(acknowledged),
      getFlow: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        flow: null,
        error: "Unsupported get request: object missing or permissions denied",
        providerCode: 100,
        providerSubcode: 33,
      }),
    });
    Object.assign(deps, { resolveMissingProviderDraft });

    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      status: "FAILED",
      stage: "CREATING_FLOW",
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED",
        providerCode: 100,
        providerSubcode: 33,
      },
    });
    expect(resolveMissingProviderDraft).not.toHaveBeenCalled();
    expect(deps.failOperation).toHaveBeenCalled();
  });

  it("retains DRAFT in the ledger without exposing an unpersisted failure projection", async () => {
    const deps = dependencies({
      getFlow: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        flow: {
          id: "flow-1",
          name: "Appointment [airi_marker]",
          status: "DRAFT",
          endpoint_uri:
            "https://example.test/api/whatsapp/flows/endpoint/endpoint-1",
          whatsapp_business_account: { id: "waba-1" },
          application: { id: "application-1" },
          validation_errors: [],
        },
      }),
    });
    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
      },
    });
    expect(result).not.toHaveProperty("projection");
    expect(result).not.toHaveProperty("scenarioRevision");
    expect(deps.completeOperation).not.toHaveBeenCalled();
    expect(deps.failOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ stage: "READING_BACK" }),
      })
    );
  });

  it("resumes a known draft without marker lookup or another create", async () => {
    const known = operation({
      providerFlowId: "flow-1",
      providerFlowName: "Appointment [airi_marker]",
      stage: "UPLOADING_JSON",
    });
    let knownCurrent = known;
    const deps = dependencies({
      prepareOperation: jest.fn().mockResolvedValue(known),
      transitionStage: jest.fn().mockImplementation(async ({ stage }) => {
        knownCurrent = { ...knownCurrent, stage, status: "RUNNING" };
        return knownCurrent;
      }),
      recordProviderStatus: jest.fn().mockImplementation(async params => {
        knownCurrent = {
          ...knownCurrent,
          providerStatus: params.providerStatus,
        };
        return knownCurrent;
      }),
      completeOperation: jest.fn().mockImplementation(async () => {
        knownCurrent = {
          ...knownCurrent,
          status: "COMPLETED",
          stage: "COMPLETED",
        };
        return {
          operation: knownCurrent,
          projection: {
            operationId: knownCurrent.operationId,
            sourceId: knownCurrent.sourceId,
            wabaId: knownCurrent.wabaId,
            contentRevision: knownCurrent.contentRevision,
            contentDigest: knownCurrent.contentDigest,
            flowId: "flow-1",
            providerStatus: "PUBLISHED" as const,
          },
          scenarioUpdatedAt: "2026-08-08T10:00:04.000Z",
        };
      }),
    });
    const result =
      await createWhatsAppFlowProvisioningService(deps).provision(input());

    expect(result.ok).toBe(true);
    expect(deps.findFlowByExactName).not.toHaveBeenCalled();
    expect(deps.createFlow).not.toHaveBeenCalled();
  });
});
