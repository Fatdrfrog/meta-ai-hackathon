const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockCreate = jest.fn();
const mockConnect = jest.fn();
const mockApply = jest.fn();
const mockCheckProvider = jest.fn();
const mockReplace = jest.fn();
const mockSetRouting = jest.fn();
const mockDelete = jest.fn();
const mockReconcile = jest.fn();
const mockGetEntryPointDetail = jest.fn();
const mockAcquireMetaReadLock = jest.fn();
const mockReleaseMetaReadPermit = jest.fn();
const mockBuildMetaRateLimitPatch = jest.fn();
const mockSetCachedMetaCooldown = jest.fn();
const mockUpdateSourceCredentials = jest.fn();

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));

jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  updateCurrentWhatsAppSourceCredentials: (...args: unknown[]) =>
    mockUpdateSourceCredentials(...args),
}));

jest.mock("@/lib/whatsapp/meta-read-policy", () => ({
  META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD: "meta_diagnostics_cooldown_until",
  acquireWhatsAppMetaReadLock: (...args: unknown[]) =>
    mockAcquireMetaReadLock(...args),
  buildWhatsAppMetaRateLimitCredentialPatch: (...args: unknown[]) =>
    mockBuildMetaRateLimitPatch(...args),
  releaseWhatsAppMetaReadPermit: (...args: unknown[]) =>
    mockReleaseMetaReadPermit(...args),
  setCachedWhatsAppMetaReadCooldownUntil: (...args: unknown[]) =>
    mockSetCachedMetaCooldown(...args),
}));

jest.mock("@/lib/whatsapp/qr-entry-points/http", () => {
  const actual = jest.requireActual("@/lib/whatsapp/qr-entry-points/http");
  return {
    ...actual,
    getWhatsAppQrEntryPointDetail: (...args: unknown[]) =>
      mockGetEntryPointDetail(...args),
    createWhatsAppQrEntryPointCode: (...args: unknown[]) => mockCreate(...args),
    connectWhatsAppQrEntryPointCode: (...args: unknown[]) =>
      mockConnect(...args),
    applyWhatsAppQrMessage: (...args: unknown[]) => mockApply(...args),
    checkWhatsAppQrProviderState: (...args: unknown[]) =>
      mockCheckProvider(...args),
    replaceWhatsAppQrCode: (...args: unknown[]) => mockReplace(...args),
    setWhatsAppQrCodeRouting: (...args: unknown[]) => mockSetRouting(...args),
    deleteWhatsAppQrCodeFromProvider: (...args: unknown[]) =>
      mockDelete(...args),
    reconcileWhatsAppQrOperation: (...args: unknown[]) =>
      mockReconcile(...args),
  };
});

import { WhatsAppQrServiceError } from "@/lib/whatsapp/qr-entry-points/http";
import { POST } from "./route";

const BASE = {
  workspaceId: "workspace-1",
  sourceId: "source-1",
  entryPointId: "entry-1",
};

function request(body: unknown, idempotencyKey = "idem-1") {
  return new Request("http://localhost/api/whatsapp/qr-entry-points/commands", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/whatsapp/qr-entry-points/commands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWhatsAppWorkspaceContext.mockResolvedValue({
      context: {
        sourceId: "source-1",
        accessToken: "token",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        credentials: {},
        rawCredentials: {
          existing: "credential",
          meta_diagnostics_cooldown_until: "2030-08-12T12:05:00.000Z",
        },
        membership: { role: "admin" },
        user: { id: "user-1" },
      },
    });
    mockGetEntryPointDetail.mockResolvedValue({
      entryPoint: {
        entryPointId: "entry-1",
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeId: "node-1",
        placementName: "Door",
        status: "DRAFT",
        version: 0,
      },
    });
    mockCreate.mockResolvedValue({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 1,
      codeVersion: 1,
    });
    mockAcquireMetaReadLock.mockResolvedValue({
      outcome: "acquired",
      cooldownUntil: null,
      lockKey: "meta-read-lock",
      lockToken: "meta-read-token",
    });
    mockReleaseMetaReadPermit.mockResolvedValue(true);
    mockBuildMetaRateLimitPatch.mockReturnValue({
      meta_diagnostics_cooldown_until: "2026-08-12T12:05:00.000Z",
      meta_diagnostics_consecutive_rate_limits: 1,
    });
    mockSetCachedMetaCooldown.mockResolvedValue(undefined);
    mockUpdateSourceCredentials.mockImplementation(
      async (params: {
        buildCredentials: (
          current: Record<string, unknown>
        ) => Record<string, unknown>;
      }) => ({
        credentials: params.buildCredentials({ existing: "credential" }),
      })
    );
    mockCheckProvider.mockResolvedValue({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 1,
      codeVersion: 2,
    });
  });

  it("requires Idempotency-Key before auth", async () => {
    const response = await POST(
      new Request("http://localhost/api/whatsapp/qr-entry-points/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "create",
          ...BASE,
          desiredMessage: "Hi",
          expectedEntryPointVersion: 0,
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
  });

  it("authorizes manager/source and forwards create with provider context", async () => {
    const response = await POST(
      request({
        command: "create",
        ...BASE,
        desiredMessage: "Hi",
        expectedEntryPointVersion: 0,
      })
    );

    expect(response.status).toBe(200);
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        requireManager: true,
        sourceId: "source-1",
        requirePhoneNumber: true,
      })
    );
    expect(mockCreate).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      sourceId: "source-1",
      desiredMessage: "Hi",
      expectedEntryPointVersion: 0,
      idempotencyKey: "idem-1",
      accessToken: "token",
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
    });
  });

  it("rejects a command when the entry point is bound to another WhatsApp source", async () => {
    mockGetEntryPointDetail.mockResolvedValueOnce({
      entryPoint: {
        entryPointId: "entry-1",
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeId: "node-1",
        placementName: "Door",
        sourceId: "source-2",
        wabaId: "waba-2",
        phoneNumberId: "phone-2",
        currentCodeId: "code-2",
        status: "ACTIVE",
        version: 1,
      },
    });

    const response = await POST(
      request({
        command: "create",
        ...BASE,
        desiredMessage: "Hi",
        expectedEntryPointVersion: 1,
      })
    );

    expect(response.status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps busy results to 409 and reconcile_required to 202", async () => {
    mockCreate.mockResolvedValueOnce({
      status: "busy",
      entryPointId: "entry-1",
      operationId: "op-1",
    });
    const busy = await POST(
      request({
        command: "create",
        ...BASE,
        desiredMessage: "Hi",
        expectedEntryPointVersion: 0,
      })
    );
    expect(busy.status).toBe(409);

    mockCreate.mockResolvedValueOnce({
      status: "reconcile_required",
      entryPointId: "entry-1",
      operationId: "op-2",
    });
    const reconcile = await POST(
      request({
        command: "create",
        ...BASE,
        desiredMessage: "Hi",
        expectedEntryPointVersion: 0,
      })
    );
    expect(reconcile.status).toBe(202);
  });

  it("maps VERSION_CONFLICT service errors to 409", async () => {
    mockCreate.mockRejectedValueOnce(
      new WhatsAppQrServiceError("VERSION_CONFLICT")
    );
    const response = await POST(
      request({
        command: "create",
        ...BASE,
        desiredMessage: "Hi",
        expectedEntryPointVersion: 0,
      })
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "VERSION_CONFLICT",
    });
  });

  it("rejects unknown command fields before auth", async () => {
    const response = await POST(
      request({
        command: "create",
        ...BASE,
        desiredMessage: "Hi",
        expectedEntryPointVersion: 0,
        extra: true,
      })
    );
    expect(response.status).toBe(400);
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
  });

  it("forwards confirmed delete commands", async () => {
    mockDelete.mockResolvedValue({
      status: "applied",
      entryPointId: "entry-1",
      codeId: "code-1",
      entryPointVersion: 2,
      codeVersion: 3,
    });
    const deleteResponse = await POST(
      request({
        command: "delete",
        ...BASE,
        codeId: "code-1",
        confirmed: true,
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 2,
      })
    );
    expect(deleteResponse.status).toBe(200);
    expect(mockDelete).toHaveBeenCalled();
  });

  it("coordinates and forwards a manager-only provider status check", async () => {
    const response = await POST(
      request({
        command: "check_provider",
        ...BASE,
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 2,
      })
    );

    expect(response.status).toBe(200);
    expect(mockAcquireMetaReadLock).toHaveBeenCalledWith({
      sourceId: "source-1",
      wabaId: "waba-1",
      additionalCooldownUntil: "2030-08-12T12:05:00.000Z",
    });
    expect(mockCheckProvider).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      sourceId: "source-1",
      expectedEntryPointVersion: 1,
      expectedCodeVersion: 2,
      idempotencyKey: "idem-1",
      accessToken: "token",
      phoneNumberId: "phone-1",
    });
    expect(mockReleaseMetaReadPermit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "acquired" })
    );
  });

  it("persists and shares Meta rate-limit cooldowns from provider checks", async () => {
    mockCheckProvider.mockRejectedValueOnce(
      new WhatsAppQrServiceError("PROVIDER_FAILED", undefined, {
        category: "graph_response",
        httpStatus: 429,
        providerCode: 4,
      })
    );

    const response = await POST(
      request({
        command: "check_provider",
        ...BASE,
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 2,
      })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "PROVIDER_FAILED",
    });
    expect(mockSetCachedMetaCooldown).toHaveBeenCalledWith(
      "waba-1",
      "2026-08-12T12:05:00.000Z",
      { now: expect.any(Date) }
    );
    expect(mockUpdateSourceCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedWabaId: "waba-1",
        expectedPhoneNumberId: "phone-1",
        buildCredentials: expect.any(Function),
      })
    );
    const mutation = mockUpdateSourceCredentials.mock.calls[0][0];
    expect(mutation.buildCredentials({ current: true })).toEqual({
      current: true,
      meta_diagnostics_cooldown_until: "2026-08-12T12:05:00.000Z",
      meta_diagnostics_consecutive_rate_limits: 1,
    });
    expect(mockReleaseMetaReadPermit).toHaveBeenCalled();
  });

  it("preserves the provider error when cooldown persistence fails", async () => {
    mockCheckProvider.mockRejectedValueOnce(
      new WhatsAppQrServiceError("PROVIDER_FAILED", undefined, {
        category: "graph_response",
        httpStatus: 429,
      })
    );
    mockUpdateSourceCredentials.mockRejectedValueOnce(
      new Error("source binding changed")
    );

    const response = await POST(
      request({
        command: "check_provider",
        ...BASE,
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 2,
      })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "PROVIDER_FAILED",
    });
    expect(mockSetCachedMetaCooldown).toHaveBeenCalledWith(
      "waba-1",
      "2026-08-12T12:05:00.000Z",
      { now: expect.any(Date) }
    );
    expect(mockReleaseMetaReadPermit).toHaveBeenCalled();
  });

  it("maps the active-Scenario delete fence to a metadata-safe 409", async () => {
    mockDelete.mockRejectedValueOnce(
      new WhatsAppQrServiceError(
        "ACTIVE_SCENARIO_ASSIGNMENT",
        "Deactivate the assigned Scenario before deleting this QR from Meta"
      )
    );

    const response = await POST(
      request({
        command: "delete",
        ...BASE,
        codeId: "code-1",
        confirmed: true,
        expectedEntryPointVersion: 1,
        expectedCodeVersion: 2,
      })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error:
        "Deactivate the assigned Scenario before deleting this QR from Meta",
      code: "ACTIVE_SCENARIO_ASSIGNMENT",
    });
    expect(body).not.toHaveProperty("scenarioId");
    expect(body).not.toHaveProperty("nodeId");
  });

  it("rejects legacy provider MOVE commands before auth or mutation", async () => {
    const moveResponse = await POST(
      request({
        command: "move",
        ...BASE,
        targetScenarioId: "scenario-2",
        targetNodeId: "node-2",
        confirmed: true,
        expectedEntryPointVersion: 2,
      })
    );

    expect(moveResponse.status).toBe(400);
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
