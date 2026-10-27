import type { NextRequest } from "next/server";

const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockGetJson = jest.fn();
const mockPostJson = jest.fn();

class MockMetaGraphRequestError extends Error {
  status: number;
  formattedError?: { message?: string; actionable?: string };
  metaError?: unknown;

  constructor(params: {
    message: string;
    status: number;
    formattedError?: { message?: string; actionable?: string };
    metaError?: unknown;
  }) {
    super(params.message);
    this.name = "MetaGraphRequestError";
    this.status = params.status;
    this.formattedError = params.formattedError;
    this.metaError = params.metaError;
  }
}

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));

jest.mock("@icecore/shared/lib/meta/api", () => ({
  getWhatsAppGraphClient: () => ({
    getJson: (...args: unknown[]) => mockGetJson(...args),
    postJson: (...args: unknown[]) => mockPostJson(...args),
  }),
  MetaGraphRequestError: MockMetaGraphRequestError,
}));

function mockContext(credentials: Record<string, unknown>) {
  mockGetWhatsAppWorkspaceContext.mockResolvedValue({
    context: {
      credentials,
      membership: { role: "admin" },
      user: { id: "user-1" },
      wabaId: credentials.wabaId,
    },
  });
}

function getRequest(url: string) {
  return new Request(url) as unknown as NextRequest;
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/whatsapp/max-price-agreement", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("/api/whatsapp/max-price-agreement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContext({
      businessId: "business-1",
      accessToken: "access-token",
      wabaId: "waba-1",
    });
    mockGetJson.mockResolvedValue({
      status: "accepted",
      signer_name: "Jane Doe",
      signer_email: "jane@example.com",
    });
    mockPostJson.mockResolvedValue({
      status: "pending",
      signer_name: "Jane Doe",
      signer_email: "jane@example.com",
    });
  });

  it("gets max-price agreement status for the workspace Business Manager", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      getRequest(
        "http://localhost/api/whatsapp/max-price-agreement?workspaceId=workspace-1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        businessId: "business-1",
        agreement: {
          status: "accepted",
        },
      },
    });
    expect(mockGetWhatsAppWorkspaceContext).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        requireManager: true,
        requireCredentials: false,
      })
    );
    expect(mockGetJson).toHaveBeenCalledWith(
      "business-1/max_price_agreements",
      { token: "access-token" }
    );
  });

  it("posts signer details to the Business Manager agreement endpoint", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        workspaceId: "workspace-1",
        signerName: "Jane Doe",
        signerEmail: "jane@example.com",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        businessId: "business-1",
        agreement: {
          status: "pending",
          signer_name: "Jane Doe",
          signer_email: "jane@example.com",
        },
      },
    });
    expect(mockPostJson).toHaveBeenCalledWith(
      "business-1/max_price_agreements",
      {
        token: "access-token",
        body: {
          signer_name: "Jane Doe",
          signer_email: "jane@example.com",
        },
      }
    );
  });

  it("requires a Business Manager ID before calling Meta", async () => {
    mockContext({ accessToken: "access-token", wabaId: "waba-1" });
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        workspaceId: "workspace-1",
        signerName: "Jane Doe",
        signerEmail: "jane@example.com",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: "Meta Business ID is required for max-price enrollment",
    });
    expect(mockPostJson).not.toHaveBeenCalled();
  });

  it("returns Meta's actionable message on agreement errors", async () => {
    mockPostJson.mockRejectedValueOnce(
      new MockMetaGraphRequestError({
        message: "Meta denied the request",
        status: 403,
        formattedError: {
          message: "Missing business_management",
          actionable: "Grant business_management and retry.",
        },
        metaError: { code: 10 },
      })
    );
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        workspaceId: "workspace-1",
        signerName: "Jane Doe",
        signerEmail: "jane@example.com",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      error: "Missing business_management",
      actionable: "Grant business_management and retry.",
      meta_error: { code: 10 },
    });
  });
});
