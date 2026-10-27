const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockProvisionWhatsAppFlow = jest.fn();

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));
jest.mock("@/lib/whatsapp/flows/provisioning-service", () => ({
  provisionWhatsAppFlow: (...args: unknown[]) =>
    mockProvisionWhatsAppFlow(...args),
}));

import { POST } from "./route";

const VALID_BODY = {
  workspaceId: "workspace-1",
  sourceId: "source-1",
  scenarioId: "scenario-1",
  nodeId: "node-1",
  editableConfig: {
    templateId: "appointment_booking",
    ctaText: "Book",
    flowNavigationMode: "data_endpoint",
    screens: [
      {
        id: "DETAILS",
        title: "Details",
        fields: [
          {
            id: "name",
            label: "Name",
            fieldType: "TextInput",
            required: true,
          },
        ],
      },
      { id: "CONFIRM", title: "Confirm", fields: [] },
    ],
    screenRoutes: { DETAILS: ["CONFIRM"] },
  },
};

function request(body: unknown) {
  return new Request("http://localhost/api/whatsapp/flows/provision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/whatsapp/flows/provision", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWhatsAppWorkspaceContext.mockResolvedValue({
      context: {
        sourceId: "source-1",
        user: { id: "user-1" },
        membership: { role: "admin" },
        credentials: {},
      },
    });
    mockProvisionWhatsAppFlow.mockResolvedValue({
      ok: true,
      operationId: "operation-1",
      status: "COMPLETED",
      stage: "COMPLETED",
      projection: {
        operationId: "operation-1",
        sourceId: "source-1",
        contentRevision: 1,
        contentDigest: "a".repeat(64),
        flowId: "flow-1",
        providerStatus: "PUBLISHED",
      },
      scenarioRevision: {
        finalUpdatedAt: "2026-08-08T10:00:01.000Z",
      },
      phones: [],
      validationErrors: [],
    });
  });

  it("authorizes the exact manager/source and forwards only strict editable input", async () => {
    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(200);
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ requireManager: true, sourceId: "source-1" })
    );
    expect(mockProvisionWhatsAppFlow).toHaveBeenCalledWith({
      ...VALID_BODY,
      updatedBy: "user-1",
    });
  });

  it("accepts a strict linear Flow target for the same server-owned lifecycle", async () => {
    const linearBody = {
      ...VALID_BODY,
      editableConfig: {
        templateId: "lead_generation",
        ctaText: "Continue",
        flowNavigationMode: "linear",
        screens: [{ id: "LEAD_FORM", title: "Lead form", fields: [] }],
      },
    };

    const response = await POST(request(linearBody));

    expect(response.status).toBe(200);
    expect(mockProvisionWhatsAppFlow).toHaveBeenCalledWith({
      ...linearBody,
      updatedBy: "user-1",
    });
  });

  it("accepts the form's answers key, which the editor keeps with its Flow", async () => {
    const body = {
      ...VALID_BODY,
      editableConfig: { ...VALID_BODY.editableConfig, answersKey: "booking" },
    };

    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(mockProvisionWhatsAppFlow).toHaveBeenCalledWith({
      ...body,
      updatedBy: "user-1",
    });
  });

  it.each([
    { extra: true },
    { contentRevision: 1 },
    {
      editableConfig: {
        ...VALID_BODY.editableConfig,
        metaFlowId: "browser-owned-flow",
      },
    },
    {
      editableConfig: {
        ...VALID_BODY.editableConfig,
        answersKey: "Booking form",
      },
    },
    {
      editableConfig: {
        ...VALID_BODY.editableConfig,
        screens: [
          {
            id: "DETAILS",
            title: "Details",
            fields: [
              {
                id: "name",
                label: "Name",
                fieldType: "TextInput",
                providerOnly: true,
              },
            ],
          },
        ],
      },
    },
  ])(
    "rejects unknown or server-owned fields before auth/provider work",
    async patch => {
      const body = {
        ...VALID_BODY,
        ...patch,
        ...(patch.editableConfig
          ? { editableConfig: patch.editableConfig }
          : {}),
      };
      const response = await POST(request(body));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        stage: "VALIDATING",
        phones: [],
        validationErrors: [],
        error: {
          code: "WHATSAPP_FLOW_PROVISIONING_INVALID_INPUT",
          message: "Request must contain one strict editable Flow target",
          retryable: false,
        },
      });
      expect(mockGetWhatsAppWorkspaceContext).not.toHaveBeenCalled();
      expect(mockProvisionWhatsAppFlow).not.toHaveBeenCalled();
    }
  );

  it.each([401, 403])(
    "normalizes a %s authorization failure into the provisioning contract",
    async status => {
      mockGetWhatsAppWorkspaceContext.mockResolvedValueOnce({
        error: Response.json({ error: "Access denied" }, { status }),
      });
      const response = await POST(request(VALID_BODY));

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        stage: "VALIDATING",
        phones: [],
        validationErrors: [],
        error: {
          code: "WHATSAPP_FLOW_PROVISIONING_ACCESS_DENIED",
          message: "Access denied",
          retryable: false,
        },
      });
      expect(mockProvisionWhatsAppFlow).not.toHaveBeenCalled();
    }
  );

  it("returns a typed conflict when the authorized source binding changed", async () => {
    mockGetWhatsAppWorkspaceContext.mockResolvedValueOnce({
      context: {
        sourceId: "source-2",
        user: { id: "user-1" },
        membership: { role: "admin" },
        credentials: {},
      },
    });

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      stage: "VALIDATING",
      phones: [],
      validationErrors: [],
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_SOURCE_BINDING_CHANGED",
        message: "WhatsApp source binding changed; refresh and retry",
        retryable: false,
      },
    });
    expect(mockProvisionWhatsAppFlow).not.toHaveBeenCalled();
  });

  it("returns a typed retryable failure when provisioning throws", async () => {
    mockProvisionWhatsAppFlow.mockRejectedValueOnce(new Error("provider down"));

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      stage: "VALIDATING",
      phones: [],
      validationErrors: [],
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_FAILED",
        message: "WhatsApp Flow provisioning failed",
        retryable: true,
      },
    });
  });

  it("returns typed non-success results without claiming HTTP success", async () => {
    mockProvisionWhatsAppFlow.mockResolvedValueOnce({
      ok: false,
      stage: "READING_BACK",
      phones: [],
      validationErrors: [],
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
        message: "Meta did not confirm the Flow as PUBLISHED",
        retryable: true,
      },
    });
    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
      },
    });
  });
});
