const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockCreateWhatsAppSignupLink = jest.fn();
const mockListWhatsAppSignupLinks = jest.fn();

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));

jest.mock("@/lib/whatsapp/signup-service", () => ({
  createWhatsAppSignupLink: (...args: unknown[]) =>
    mockCreateWhatsAppSignupLink(...args),
  listWhatsAppSignupLinks: (...args: unknown[]) =>
    mockListWhatsAppSignupLinks(...args),
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
  return new Request("http://localhost/api/whatsapp/signups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawPostRequest(body: string) {
  return new Request("http://localhost/api/whatsapp/signups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("/api/whatsapp/signups", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContext({
      accessToken: "access-token",
      businessId: "business-1",
      displayPhoneNumber: "+1 555 123 4567",
      phoneNumberId: "phone-1",
      wabaId: "waba-1",
    });
    mockListWhatsAppSignupLinks.mockResolvedValue({ links: [] });
    mockCreateWhatsAppSignupLink.mockResolvedValue({
      id: "link-1",
      metaSignupId: "signup-1",
      deepLinkUrl: "https://wa.me/15551234567/signup/signup-1",
    });
  });

  it("lists locally cached signup links for a connected workspace", async () => {
    mockListWhatsAppSignupLinks.mockResolvedValue({
      links: [{ id: "link-1", displayName: "Summer list" }],
    });
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "http://localhost/api/whatsapp/signups?workspaceId=workspace-1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.links).toEqual([{ id: "link-1", displayName: "Summer list" }]);
    expect(mockListWhatsAppSignupLinks).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
    });
  });

  it("creates a Meta signup and persists the workspace-scoped asset", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        workspaceId: "workspace-1",
        displayName: "Summer list",
        signupMessage: "Subscribe for launches.",
        confirmationMessage: "You are subscribed.",
        privacyPolicyUrl: "https://airi.chat/privacy",
        productLine: "Retail",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.link).toMatchObject({
      id: "link-1",
      metaSignupId: "signup-1",
    });
    expect(mockCreateWhatsAppSignupLink).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "access-token",
        businessPhoneNumber: "+1 555 123 4567",
        input: expect.objectContaining({
          displayName: "Summer list",
          productLine: "Retail",
        }),
        phoneNumberId: "phone-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        workspaceId: "workspace-1",
      })
    );
  });

  it("rejects invalid JSON without running signup logic", async () => {
    const { POST } = await import("./route");

    const response = await POST(rawPostRequest("{not json"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
    expect(mockCreateWhatsAppSignupLink).not.toHaveBeenCalled();
  });

  it("rejects malformed signup bodies before calling Meta", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        workspaceId: "workspace-1",
        displayName: "Summer list",
        signupMessage: { text: "Subscribe" },
        confirmationMessage: "You are subscribed.",
        privacyPolicyUrl: "https://airi.chat/privacy",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("signupMessage must be a string");
    expect(mockCreateWhatsAppSignupLink).not.toHaveBeenCalled();
  });
});

export {};
