const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockCreateMessagingCustomerBase = jest.fn();
const mockListMessagingCustomerBases = jest.fn();

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));

jest.mock("@/lib/whatsapp/signup-service", () => ({
  createMessagingCustomerBase: (...args: unknown[]) =>
    mockCreateMessagingCustomerBase(...args),
  listMessagingCustomerBases: (...args: unknown[]) =>
    mockListMessagingCustomerBases(...args),
}));

function mockContext(credentials: Record<string, unknown>) {
  mockGetWhatsAppWorkspaceContext.mockResolvedValue({
    context: {
      accessToken: credentials.accessToken,
      credentials,
      membership: { role: "admin" },
      phoneNumberId: credentials.phoneNumberId,
      sourceId: "source-1",
      user: { id: "user-1" },
      wabaId: credentials.wabaId,
    },
  });
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/whatsapp/messaging-customer-bases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/whatsapp/messaging-customer-bases", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContext({
      accessToken: "access-token",
      businessId: "business-1",
      phoneNumberId: "phone-1",
      wabaId: "waba-1",
    });
    mockListMessagingCustomerBases.mockResolvedValue({ bases: [] });
    mockCreateMessagingCustomerBase.mockResolvedValue({
      id: "base-1",
      name: "Summer subscribers",
    });
  });

  it("syncs Meta messaging customer bases into the local cache", async () => {
    mockListMessagingCustomerBases.mockResolvedValue({
      bases: [{ id: "base-1", name: "Summer subscribers" }],
    });
    const { GET } = await import("./route");

    const response = (await GET(
      new Request(
        "http://localhost/api/whatsapp/messaging-customer-bases?workspaceId=workspace-1"
      )
    ))!;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.bases).toEqual([{ id: "base-1", name: "Summer subscribers" }]);
    expect(mockListMessagingCustomerBases).toHaveBeenCalledWith({
      accessToken: "access-token",
      businessId: "business-1",
      sourceId: "source-1",
      wabaId: "waba-1",
      workspaceId: "workspace-1",
    });
  });

  it("creates a Meta messaging customer base under the connected business", async () => {
    const { POST } = await import("./route");

    const response = (await POST(
      postRequest({
        workspaceId: "workspace-1",
        name: "Summer subscribers",
      })
    ))!;
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.base).toEqual({
      id: "base-1",
      name: "Summer subscribers",
    });
    expect(mockCreateMessagingCustomerBase).toHaveBeenCalledWith({
      accessToken: "access-token",
      businessId: "business-1",
      name: "Summer subscribers",
      sourceId: "source-1",
      wabaId: "waba-1",
      workspaceId: "workspace-1",
    });
  });
});

export {};
