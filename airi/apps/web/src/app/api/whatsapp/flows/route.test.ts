const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockGetWhatsAppWorkspaceReadiness = jest.fn();
const mockCreateMetaWhatsAppFlow = jest.fn();
const mockDeleteMetaWhatsAppFlow = jest.fn();
const mockGetMetaWhatsAppFlow = jest.fn();
const mockIsMetaWhatsAppFlowOwnedByWaba = jest.fn();
const mockListMetaWhatsAppFlows = jest.fn();
const mockUpdateMetaWhatsAppFlow = jest.fn();
const mockIsWhatsAppFlowProviderManaged = jest.fn();
const mockListWhatsAppFlowProviderArtifacts = jest.fn();
const mockResolveWhatsAppFlowProviderArtifact = jest.fn();
const mockSendWhatsappInteractiveFlow = jest.fn();

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
  getWhatsAppWorkspaceReadiness: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceReadiness(...args),
}));

jest.mock("@/lib/whatsapp/flows/service", () => ({
  createMetaWhatsAppFlow: (...args: unknown[]) =>
    mockCreateMetaWhatsAppFlow(...args),
  deleteMetaWhatsAppFlow: (...args: unknown[]) =>
    mockDeleteMetaWhatsAppFlow(...args),
  getMetaWhatsAppFlow: (...args: unknown[]) => mockGetMetaWhatsAppFlow(...args),
  isMetaWhatsAppFlowOwnedByWaba: (...args: unknown[]) =>
    mockIsMetaWhatsAppFlowOwnedByWaba(...args),
  listMetaWhatsAppFlows: (...args: unknown[]) =>
    mockListMetaWhatsAppFlows(...args),
  updateMetaWhatsAppFlow: (...args: unknown[]) =>
    mockUpdateMetaWhatsAppFlow(...args),
}));

jest.mock("@/lib/whatsapp/flows/provisioning-operation-store", () => ({
  isWhatsAppFlowProviderManaged: (...args: unknown[]) =>
    mockIsWhatsAppFlowProviderManaged(...args),
  listWhatsAppFlowProviderArtifacts: (...args: unknown[]) =>
    mockListWhatsAppFlowProviderArtifacts(...args),
}));

jest.mock(
  "@/lib/whatsapp/flows/provisioning-provider-resolution-service",
  () => ({
    resolveWhatsAppFlowProviderArtifact: (...args: unknown[]) =>
      mockResolveWhatsAppFlowProviderArtifact(...args),
  })
);

jest.mock("@/lib/whatsapp", () => ({
  normalizeWhatsappRecipient: (value: string) => value.replace(/\D/g, ""),
  sendWhatsappInteractiveFlow: (...args: unknown[]) =>
    mockSendWhatsappInteractiveFlow(...args),
}));

function request(method: string, body: unknown) {
  return new Request("http://localhost/api/whatsapp/flows", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(method: string, body: string) {
  return new Request("http://localhost/api/whatsapp/flows", {
    method,
    headers: { "Content-Type": "application/json" },
    body,
  });
}

function patchRequest(body: unknown) {
  return request("PATCH", body);
}

function putRequest(body: unknown) {
  return request("PUT", body);
}

function postRequest(body: unknown) {
  return request("POST", body);
}

function deleteRequest(body: unknown) {
  return request("DELETE", body);
}

function getRequest(query: string) {
  return new Request(`http://localhost/api/whatsapp/flows?${query}`);
}

describe("/api/whatsapp/flows", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockGetWhatsAppWorkspaceContext.mockResolvedValue({
      context: {
        accessToken: "access-token",
        credentials: {},
        membership: { role: "admin" },
        phoneNumberId: "phone-1",
        sourceId: "source-1",
        user: { id: "user-1" },
        wabaId: "waba-1",
      },
    });
    mockGetWhatsAppWorkspaceReadiness.mockResolvedValue({
      readiness: {
        hasWabaId: true,
        hasPhoneNumberId: true,
        hasAccessToken: true,
      },
      wabaId: "waba-1",
      accessToken: "access-token",
      phoneNumberId: "phone-1",
      sourceId: "source-1",
    });
    mockGetMetaWhatsAppFlow.mockResolvedValue({
      ok: true,
      status: 200,
      flow: {
        id: "flow-1",
        name: "Lead Flow",
        status: "DRAFT",
        whatsapp_business_account: { id: "waba-1" },
      },
    });
    mockIsMetaWhatsAppFlowOwnedByWaba.mockReturnValue(true);
    mockIsWhatsAppFlowProviderManaged.mockResolvedValue(false);
    mockListWhatsAppFlowProviderArtifacts.mockResolvedValue([]);
    mockResolveWhatsAppFlowProviderArtifact.mockResolvedValue({
      ok: true,
      status: 200,
      operationId: "operation-old",
      operationStatus: "MANUALLY_RESOLVED",
      providerStatus: "DEPRECATED",
      cleanupAt: "2026-08-29T10:00:00.000Z",
      providerResolution: {
        kind: "published_deprecated",
        outcome: "deprecated",
        requestedAt: "2026-08-01T10:00:00.000Z",
        requestedBy: "user-1",
        confirmedAt: "2026-08-01T10:00:01.000Z",
        confirmedBy: "user-1",
      },
    });
    mockListMetaWhatsAppFlows.mockResolvedValue({
      ok: true,
      status: 200,
      flows: [],
    });
    mockCreateMetaWhatsAppFlow.mockResolvedValue({
      ok: true,
      status: 200,
      flow: { id: "flow-1", status: "DRAFT" },
    });
    mockUpdateMetaWhatsAppFlow.mockResolvedValue({
      ok: true,
      status: 200,
      flow: { id: "flow-1", status: "DRAFT" },
    });
    mockDeleteMetaWhatsAppFlow.mockResolvedValue({
      ok: true,
      status: 200,
      flow: { success: true },
    });
    mockSendWhatsappInteractiveFlow.mockResolvedValue({
      messageId: "wamid-1",
    });
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "%s rejects malformed JSON before authorization or provider calls",
    async method => {
      const handlers = await import("./route");

      const response = await handlers[method](rawRequest(method, "{"));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid JSON body" });
      expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
      expect(mockGetMetaWhatsAppFlow).not.toHaveBeenCalled();
      expect(mockCreateMetaWhatsAppFlow).not.toHaveBeenCalled();
      expect(mockUpdateMetaWhatsAppFlow).not.toHaveBeenCalled();
      expect(mockDeleteMetaWhatsAppFlow).not.toHaveBeenCalled();
      expect(mockSendWhatsappInteractiveFlow).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "POST",
      {
        workspaceId: "workspace-1",
        recipientPhone: "+77001234567",
        flowId: "flow-1",
        flowToken: "token-1",
      },
    ],
    ["PUT", { workspaceId: "workspace-1", name: "Flow" }],
    [
      "PATCH",
      {
        workspaceId: "workspace-1",
        flowId: "flow-1",
        operation: "publish",
      },
    ],
    [
      "DELETE",
      {
        workspaceId: "workspace-1",
        flowId: "flow-1",
        acknowledgeDraftDeletion: true,
      },
    ],
  ] as const)(
    "%s hard-stops before authorization when sourceId is omitted",
    async (method, body) => {
      const handlers = await import("./route");

      const response = await handlers[method](request(method, body));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "Validation failed",
      });
      expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    }
  );

  it("requests the official Flow detail field set with phone-scoped health status", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      getRequest("workspaceId=workspace-1&flowId=flow-1")
    );

    expect(response.status).toBe(200);
    expect(mockGetMetaWhatsAppFlow).toHaveBeenCalledWith({
      accessToken: "access-token",
      expectedWabaId: "waba-1",
      flowId: "flow-1",
      phoneNumberId: "phone-1",
      includeJson: false,
    });
  });

  it("requests official Flow fields for WABA list reads", async () => {
    const { GET } = await import("./route");

    const response = await GET(getRequest("workspaceId=workspace-1&limit=5"));

    expect(response.status).toBe(200);
    expect(mockListMetaWhatsAppFlows).toHaveBeenCalledWith({
      accessToken: "access-token",
      wabaId: "waba-1",
      limit: 5,
    });
    await expect(response.json()).resolves.toMatchObject({
      sourceId: "source-1",
    });
  });

  it("passes an authorized source selector to workspace readiness", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      getRequest("workspaceId=workspace-1&sourceId=source-1&limit=5")
    );

    expect(response.status).toBe(200);
    expect(mockGetWhatsAppWorkspaceReadiness).toHaveBeenCalledWith(
      "workspace-1",
      { sourceId: "source-1" }
    );
    expect(mockListWhatsAppFlowProviderArtifacts).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      limit: 5,
    });
  });

  it("keeps a pre-publish ledger-only artifact reachable as missing and derives draft cleanup from its stage", async () => {
    mockListWhatsAppFlowProviderArtifacts.mockResolvedValueOnce([
      {
        operationId: "operation-missing",
        scenarioId: "scenario-owner",
        providerFlowId: "flow-missing",
        providerFlowName: "Retained provider draft",
        stage: "UPLOADING_JSON",
        status: "FAILED",
        cleanupEligibility: "ELIGIBLE",
      },
    ]);
    const { GET } = await import("./route");

    const response = await GET(
      getRequest("workspaceId=workspace-1&sourceId=source-1")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      flows: [
        {
          id: "flow-missing",
          name: "Retained provider draft",
          status: "MISSING",
          providerUnavailable: true,
          managedArtifact: {
            operationId: "operation-missing",
            scenarioId: "scenario-owner",
            cleanupEligibility: "ELIGIBLE",
            suggestedResolutionKind: "draft_deleted",
          },
        },
      ],
    });
  });

  it("does not offer a deterministic cleanup action when provider status became ambiguous during publish", async () => {
    mockListWhatsAppFlowProviderArtifacts.mockResolvedValueOnce([
      {
        operationId: "operation-ambiguous",
        providerFlowId: "flow-ambiguous",
        providerFlowName: "Ambiguous Flow",
        stage: "PUBLISHING",
        status: "FAILED",
        cleanupEligibility: "ELIGIBLE",
      },
    ]);
    const { GET } = await import("./route");

    const response = await GET(
      getRequest("workspaceId=workspace-1&sourceId=source-1")
    );
    const body = await response.json();

    expect(body.flows[0]).toMatchObject({
      id: "flow-ambiguous",
      status: "MISSING",
      managedArtifact: {
        cleanupEligibility: "STATUS_UNVERIFIED",
      },
    });
    expect(body.flows[0].managedArtifact).not.toHaveProperty(
      "suggestedResolutionKind"
    );
  });

  it("keeps a provider-confirmed DEPRECATED managed artifact reachable for ledger reconciliation", async () => {
    mockListMetaWhatsAppFlows.mockResolvedValueOnce({
      ok: true,
      status: 200,
      flows: [{ id: "flow-deprecated", status: "DEPRECATED" }],
    });
    mockListWhatsAppFlowProviderArtifacts.mockResolvedValueOnce([
      {
        operationId: "operation-deprecated",
        providerFlowId: "flow-deprecated",
        lastKnownProviderStatus: "DEPRECATED",
        stage: "COMPLETED",
        status: "SUPERSEDED",
        cleanupEligibility: "ELIGIBLE",
      },
    ]);
    const { GET } = await import("./route");

    const response = await GET(
      getRequest("workspaceId=workspace-1&sourceId=source-1")
    );

    expect(await response.json()).toMatchObject({
      flows: [
        {
          id: "flow-deprecated",
          status: "DEPRECATED",
          managedArtifact: {
            cleanupEligibility: "ELIGIBLE",
            suggestedResolutionKind: "published_deprecated",
          },
        },
      ],
    });
  });

  it("passes only draft-creation fields to the Flow service", async () => {
    const { PUT } = await import("./route");

    const response = await PUT(
      putRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        name: "Lead Flow",
        categories: ["LEAD_GENERATION"],
      })
    );

    expect(response.status).toBe(200);
    expect(mockCreateMetaWhatsAppFlow).toHaveBeenCalledWith({
      accessToken: "access-token",
      wabaId: "waba-1",
      name: "Lead Flow",
      categories: ["LEAD_GENERATION"],
      cloneFlowId: undefined,
    });
  });

  it.each([{ flowJson: '{"version":"5.0","screens":[]}' }, { publish: true }])(
    "rejects create-time release bypass fields %#",
    async extra => {
      const { PUT } = await import("./route");

      const response = await PUT(
        putRequest({
          workspaceId: "workspace-1",
          sourceId: "source-1",
          name: "Lead Flow",
          ...extra,
        })
      );

      expect(response.status).toBe(400);
      expect(mockCreateMetaWhatsAppFlow).not.toHaveBeenCalled();
    }
  );

  it("passes an authorized source selector through manager mutations", async () => {
    const { PUT } = await import("./route");

    const response = await PUT(
      putRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        name: "Lead Flow",
      })
    );

    expect(response.status).toBe(200);
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        requireManager: true,
        sourceId: "source-1",
      })
    );
  });

  it("rejects browser-selected endpoint and application identifiers", async () => {
    const { PATCH, PUT } = await import("./route");

    const createResponse = await PUT(
      putRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        name: "Lead Flow",
        endpointUri: "https://browser.example/flow",
      })
    );
    const updateResponse = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        operation: "update",
        applicationId: "browser-app-1",
      })
    );

    expect(createResponse.status).toBe(400);
    expect(updateResponse.status).toBe(400);
    expect(mockCreateMetaWhatsAppFlow).not.toHaveBeenCalled();
    expect(mockUpdateMetaWhatsAppFlow).not.toHaveBeenCalled();
  });

  it("verifies ownership before updating a caller-selected Flow", async () => {
    const { PATCH } = await import("./route");

    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        operation: "update",
        name: "Updated Flow",
      })
    );

    expect(response.status).toBe(200);
    expect(mockGetMetaWhatsAppFlow).toHaveBeenCalledWith({
      accessToken: "access-token",
      flowId: "flow-1",
    });
    expect(mockIsMetaWhatsAppFlowOwnedByWaba).toHaveBeenCalledWith(
      expect.objectContaining({ id: "flow-1" }),
      "waba-1"
    );
    expect(mockUpdateMetaWhatsAppFlow).toHaveBeenCalledWith({
      accessToken: "access-token",
      flowId: "flow-1",
      operation: "update",
      name: "Updated Flow",
      categories: undefined,
    });
  });

  it("saves external draft JSON after live ownership and manager checks while preserving endpoint metadata", async () => {
    const flowJson = JSON.stringify({
      version: "7.3",
      data_api_version: "4.0",
      screens: [
        { id: "START", layout: { type: "SingleColumnLayout", children: [] } },
      ],
      routing_model: { START: [] },
    });
    mockGetMetaWhatsAppFlow.mockResolvedValueOnce({
      ok: true,
      status: 200,
      flow: {
        id: "flow-1",
        status: "DRAFT",
        endpoint_uri: "https://customer.example/flow",
        application: { id: "customer-app" },
        whatsapp_business_account: { id: "waba-1" },
      },
    });
    mockUpdateMetaWhatsAppFlow.mockResolvedValueOnce({
      ok: true,
      status: 200,
      flow: {
        id: "flow-1",
        status: "DRAFT",
        endpoint_uri: "https://customer.example/flow",
      },
    });
    const { PATCH } = await import("./route");
    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        operation: "update_json",
        flowJson,
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      operation: "update_json",
      flow: { status: "DRAFT", endpoint_uri: "https://customer.example/flow" },
    });
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledWith(
      "workspace-1",
      {
        requireManager: true,
        sourceId: "source-1",
      }
    );
    expect(mockUpdateMetaWhatsAppFlow).toHaveBeenCalledWith({
      accessToken: "access-token",
      flowId: "flow-1",
      operation: "update_json",
      flowJson,
    });
  });

  it.each([["publish"], ["update"], ["update_json"]] as const)(
    "blocks generic %s mutations for scenario-managed provider Flows",
    async operation => {
      mockIsWhatsAppFlowProviderManaged.mockResolvedValue(true);
      const { PATCH } = await import("./route");

      const response = await PATCH(
        patchRequest({
          workspaceId: "workspace-1",
          sourceId: "source-1",
          flowId: "flow-1",
          operation,
          ...(operation === "update" ? { name: "Renamed Flow" } : {}),
          ...(operation === "update_json"
            ? { flowJson: '{"version":"7.3","screens":[{"id":"START"}]}' }
            : {}),
        })
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error:
          "This Flow is managed by a scenario release. Publish or replace it from the scenario editor.",
      });
      expect(mockIsWhatsAppFlowProviderManaged).toHaveBeenCalledWith({
        wabaId: "waba-1",
        providerFlowId: "flow-1",
      });
      expect(mockUpdateMetaWhatsAppFlow).not.toHaveBeenCalled();
    }
  );

  it.each(["PUBLISHED", "DEPRECATED", "BLOCKED", "THROTTLED", undefined])(
    "rejects JSON uploads when the live provider status is %s",
    async status => {
      mockGetMetaWhatsAppFlow.mockResolvedValueOnce({
        ok: true,
        status: 200,
        flow: {
          id: "flow-1",
          status,
          whatsapp_business_account: { id: "waba-1" },
        },
      });
      const { PATCH } = await import("./route");
      const response = await PATCH(
        patchRequest({
          workspaceId: "workspace-1",
          sourceId: "source-1",
          flowId: "flow-1",
          operation: "update_json",
          flowJson: '{"version":"7.3","screens":[{"id":"START"}]}',
        })
      );
      expect(response.status).toBe(409);
      expect(mockUpdateMetaWhatsAppFlow).not.toHaveBeenCalled();
    }
  );

  it("blocks foreign JSON uploads before provider mutation", async () => {
    mockIsMetaWhatsAppFlowOwnedByWaba.mockReturnValue(false);
    const { PATCH } = await import("./route");
    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "foreign-flow",
        operation: "update_json",
        flowJson: '{"version":"7.3","screens":[{"id":"START"}]}',
      })
    );
    expect(response.status).toBe(404);
    expect(mockUpdateMetaWhatsAppFlow).not.toHaveBeenCalled();
  });

  it("denies non-manager JSON saves before provider reads", async () => {
    mockGetWhatsAppWorkspaceContext.mockResolvedValueOnce({
      error: Response.json(
        { error: "Only managers and admins can perform this action" },
        { status: 403 }
      ),
    });
    const { PATCH } = await import("./route");
    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        operation: "update_json",
        flowJson: '{"version":"7.3","screens":[{"id":"START"}]}',
      })
    );
    expect(response.status).toBe(403);
    expect(mockGetMetaWhatsAppFlow).not.toHaveBeenCalled();
    expect(mockUpdateMetaWhatsAppFlow).not.toHaveBeenCalled();
  });

  it.each([
    "{",
    "[]",
    "null",
    "{}",
    '{"version":"7.3","screens":[]}',
    '{"version":"7.3","screens":[{}]}',
    '{"version":"7.3","screens":[{"id":"START"},{"id":"START"}]}',
  ])("rejects malformed Flow JSON before authorization: %s", async flowJson => {
    const { PATCH } = await import("./route");
    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        operation: "update_json",
        flowJson,
      })
    );
    expect(response.status).toBe(400);
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    expect(mockUpdateMetaWhatsAppFlow).not.toHaveBeenCalled();
  });

  it("measures Flow JSON limits in UTF-8 bytes", async () => {
    const flowJson = JSON.stringify({
      version: "7.3",
      screens: [{ id: "START" }],
      description: "界".repeat(3_500_000),
    });
    const { PATCH } = await import("./route");
    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        operation: "update_json",
        flowJson,
      })
    );
    expect(response.status).toBe(400);
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
  });

  it("preserves provider validation pointers for a rejected draft JSON upload", async () => {
    const validationErrors = [
      {
        message: "Missing Footer",
        pointers: [{ path: "screens[0].layout.children" }],
      },
    ];
    mockUpdateMetaWhatsAppFlow.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: "Flow JSON validation failed",
      validation_errors: validationErrors,
    });
    const { PATCH } = await import("./route");
    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        operation: "update_json",
        flowJson: '{"version":"7.3","screens":[{"id":"START"}]}',
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Flow JSON validation failed",
      validation_errors: validationErrors,
    });
  });

  it("requires a draft readback after a JSON upload", async () => {
    mockUpdateMetaWhatsAppFlow.mockResolvedValueOnce({
      ok: true,
      status: 200,
      flow: { id: "flow-1", status: "PUBLISHED" },
    });
    const { PATCH } = await import("./route");
    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        operation: "update_json",
        flowJson: '{"version":"7.3","screens":[{"id":"START"}]}',
      })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("DRAFT"),
    });
  });

  it("bounds the request stream before parsing a JSON upload", async () => {
    const { PATCH } = await import("./route");
    const oversized = patchRequest({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      flowId: "flow-1",
      operation: "update_json",
      flowJson: '{"version":"7.3","screens":[{"id":"START"}]}',
    });
    oversized.headers.set("content-length", "100000000");
    const response = await PATCH(oversized);
    expect(response.status).toBe(413);
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    expect(mockGetMetaWhatsAppFlow).not.toHaveBeenCalled();
  });

  it.each(["PUT", "PATCH"] as const)(
    "%s rejects unsupported categories and overlong names",
    async method => {
      const handlers = await import("./route");
      for (const metadata of [
        { categories: ["SIGNUP"] },
        { categories: [] },
        { name: "n".repeat(201) },
      ]) {
        const response = await handlers[method](
          request(method, {
            workspaceId: "workspace-1",
            sourceId: "source-1",
            name: "Flow",
            ...(method === "PATCH"
              ? { flowId: "flow-1", operation: "update" }
              : {}),
            ...metadata,
          })
        );
        expect(response.status).toBe(400);
      }
      expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    }
  );

  it("requires explicit acknowledgement before any irreversible deprecation", async () => {
    const { PATCH } = await import("./route");

    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        operation: "deprecate",
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Flow retirement acknowledgement is required",
    });
    expect(mockUpdateMetaWhatsAppFlow).not.toHaveBeenCalled();
  });

  it("routes an acknowledged managed deprecation through the durable retirement service", async () => {
    mockIsWhatsAppFlowProviderManaged.mockResolvedValue(true);
    const { PATCH } = await import("./route");

    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        operation: "deprecate",
        acknowledgePreviouslySentMessagesWillStopOpening: true,
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      operation: "deprecate",
      managedResolution: {
        operationId: "operation-old",
        operationStatus: "MANUALLY_RESOLVED",
        providerStatus: "DEPRECATED",
        cleanupAt: "2026-08-29T10:00:00.000Z",
      },
    });
    expect(mockResolveWhatsAppFlowProviderArtifact).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      accessToken: "access-token",
      providerFlowId: "flow-1",
      requestedBy: "user-1",
      kind: "published_deprecated",
    });
    expect(mockGetMetaWhatsAppFlow).not.toHaveBeenCalled();
    expect(mockUpdateMetaWhatsAppFlow).not.toHaveBeenCalled();
  });

  it("preserves normalized Meta publish diagnostics from the Flow service", async () => {
    mockUpdateMetaWhatsAppFlow.mockResolvedValue({
      ok: false,
      status: 400,
      error:
        "OAuthException (139000): Blocked By Integrity - Integrity requirements not met - fbtrace_id: trace-1",
      validation_errors: [],
    });
    const { PATCH } = await import("./route");

    const response = await PATCH(
      patchRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        operation: "publish",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("139000");
    expect(body.error).toContain("Integrity requirements not met");
    expect(body.error).toContain("trace-1");
  });

  it("blocks cross-WABA delete before calling the provider mutation", async () => {
    mockIsMetaWhatsAppFlowOwnedByWaba.mockReturnValue(false);
    const { DELETE } = await import("./route");

    const response = await DELETE(
      deleteRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-other",
        acknowledgeDraftDeletion: true,
      })
    );

    expect(response.status).toBe(404);
    expect(mockDeleteMetaWhatsAppFlow).not.toHaveBeenCalled();
  });

  it("requires explicit acknowledgement before deleting any draft", async () => {
    const { DELETE } = await import("./route");

    const response = await DELETE(
      deleteRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Flow draft deletion acknowledgement is required",
    });
    expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
    expect(mockDeleteMetaWhatsAppFlow).not.toHaveBeenCalled();
  });

  it("never returns a success HTTP status for a typed delete failure", async () => {
    mockDeleteMetaWhatsAppFlow.mockResolvedValue({
      ok: false,
      status: 200,
      error: "Only draft Flows can be deleted",
      validation_errors: [],
    });
    const { DELETE } = await import("./route");

    const response = await DELETE(
      deleteRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        acknowledgeDraftDeletion: true,
      })
    );
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("Only draft Flows can be deleted");
  });

  it("routes acknowledged managed draft deletion through durable provider resolution", async () => {
    mockIsWhatsAppFlowProviderManaged.mockResolvedValue(true);
    mockResolveWhatsAppFlowProviderArtifact.mockResolvedValueOnce({
      ok: true,
      status: 200,
      operationId: "operation-draft",
      operationStatus: "MANUALLY_RESOLVED",
      providerStatus: null,
      cleanupAt: "2026-08-29T10:00:00.000Z",
      providerResolution: {
        kind: "draft_deleted",
        outcome: "missing",
        requestedAt: "2026-08-01T10:00:00.000Z",
        requestedBy: "user-1",
        confirmedAt: "2026-08-01T10:00:01.000Z",
        confirmedBy: "user-1",
      },
    });
    const { DELETE } = await import("./route");

    const response = await DELETE(
      deleteRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        flowId: "flow-1",
        acknowledgeDraftDeletion: true,
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      operation: "delete",
      managedResolution: {
        operationId: "operation-draft",
        providerStatus: null,
      },
    });
    expect(mockResolveWhatsAppFlowProviderArtifact).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      accessToken: "access-token",
      providerFlowId: "flow-1",
      requestedBy: "user-1",
      kind: "draft_deleted",
    });
    expect(mockGetMetaWhatsAppFlow).not.toHaveBeenCalled();
    expect(mockDeleteMetaWhatsAppFlow).not.toHaveBeenCalled();
  });

  it("blocks cross-WABA test sends before WhatsApp transport", async () => {
    mockIsMetaWhatsAppFlowOwnedByWaba.mockReturnValue(false);
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        recipientPhone: "+77001234567",
        flowId: "flow-other",
        flowToken: "test-token",
      })
    );

    expect(response.status).toBe(404);
    expect(mockSendWhatsappInteractiveFlow).not.toHaveBeenCalled();
  });
});

export {};
