const mockGetWhatsAppWorkspaceContext = jest.fn();
const mockListSuggestions = jest.fn();
const mockAdoptUsername = jest.fn();

const mockBusinessUsernameErrorClass = class WhatsAppBusinessUsernameError extends Error {
  code?: number | string;
  status: number;
  transferRequired: boolean;

  constructor(params: {
    code?: number | string;
    message: string;
    status: number;
    transferRequired?: boolean;
  }) {
    super(params.message);
    this.code = params.code;
    this.status = params.status;
    this.transferRequired = params.transferRequired === true;
  }
};

jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockGetWhatsAppWorkspaceContext(...args),
}));

jest.mock("./utils", () => ({
  WhatsAppBusinessUsernameError: mockBusinessUsernameErrorClass,
  adoptWhatsAppBusinessUsername: (...args: unknown[]) =>
    mockAdoptUsername(...args),
  getWhatsAppBusinessUsernameApiUnavailableReason: (input: {
    coexistenceMode?: boolean;
    isOnBizApp?: boolean;
  }) =>
    input.coexistenceMode === true || input.isOnBizApp === true
      ? "Username API is not available for this WhatsApp Business app number. Manage the username in the WhatsApp Business app."
      : null,
  hasStoredWhatsAppBusinessUsername: (state: {
    status?: string;
    username?: string;
  }) => Boolean(state.username && state.status !== "deleted"),
  listWhatsAppBusinessUsernameSuggestions: (...args: unknown[]) =>
    mockListSuggestions(...args),
  normalizeBusinessUsernameInput: (input: unknown) =>
    typeof input === "string" ? input.trim().replace(/^@+/, "").trim() : "",
  normalizeBusinessUsernameTransferAction: (input: unknown) =>
    input === "force_transfer" ? "force_transfer" : "none",
  readStoredWhatsAppBusinessUsernameState: (credentials: unknown) => {
    const record =
      credentials && typeof credentials === "object"
        ? (credentials as Record<string, unknown>)
        : {};
    const state =
      record.business_username && typeof record.business_username === "object"
        ? (record.business_username as Record<string, unknown>)
        : {};
    return {
      status: typeof state.status === "string" ? state.status : undefined,
      username: typeof state.username === "string" ? state.username : undefined,
    };
  },
}));

function mockContext(overrides?: {
  accessToken?: string;
  credentials?: {
    coexistenceMode?: boolean;
    isOnBizApp?: boolean;
  };
  phoneNumberId?: string;
  rawCredentials?: unknown;
  role?: string;
}) {
  mockGetWhatsAppWorkspaceContext.mockResolvedValue({
    context: {
      accessToken: overrides?.accessToken,
      credentials: overrides?.credentials || {},
      membership: { role: overrides?.role || "admin" },
      phoneNumberId: overrides?.phoneNumberId,
      rawCredentials: overrides?.rawCredentials,
      user: { id: "user-1" },
    },
  });
}

function getRequest(url: string) {
  return new Request(url);
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/whatsapp/username", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/whatsapp/username", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockContext({ accessToken: "token-1", phoneNumberId: "phone-1" });
    mockListSuggestions.mockResolvedValue(["airi_chat", "airi_support"]);
    mockAdoptUsername.mockResolvedValue({
      status: "reserved",
      username: "airi_chat",
    });
  });

  it("hides the navbar action when WhatsApp is not connected", async () => {
    mockContext({});
    const { GET } = await import("./route");

    const response = await GET(
      getRequest("http://localhost/api/whatsapp/username?workspaceId=ws-1")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      canCreate: false,
      connected: false,
      hasUsername: false,
    });
  });

  it("returns suggestions only for a manager without an existing username", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      getRequest(
        "http://localhost/api/whatsapp/username?workspaceId=ws-1&includeSuggestions=1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      canCreate: true,
      connected: true,
      hasUsername: false,
      suggestions: ["airi_chat", "airi_support"],
    });
    expect(mockListSuggestions).toHaveBeenCalledWith({
      accessToken: "token-1",
      phoneNumberId: "phone-1",
    });
  });

  it("does not expose create when the phone number already has a username", async () => {
    mockContext({
      accessToken: "token-1",
      phoneNumberId: "phone-1",
      rawCredentials: {
        business_username: {
          status: "approved",
          username: "airi_chat",
        },
      },
    });
    const { GET } = await import("./route");

    const response = await GET(
      getRequest(
        "http://localhost/api/whatsapp/username?workspaceId=ws-1&includeSuggestions=1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      canCreate: false,
      hasUsername: true,
      status: "approved",
      suggestions: [],
      username: "airi_chat",
    });
    expect(mockListSuggestions).not.toHaveBeenCalled();
  });

  it("hides create for WhatsApp Business app/co-existence numbers", async () => {
    mockContext({
      accessToken: "token-1",
      credentials: { coexistenceMode: true, isOnBizApp: true },
      phoneNumberId: "phone-1",
    });
    const { GET } = await import("./route");

    const response = await GET(
      getRequest(
        "http://localhost/api/whatsapp/username?workspaceId=ws-1&includeSuggestions=1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      canCreate: false,
      connected: true,
      hasUsername: false,
      suggestions: [],
      usernameApiUnavailableReason:
        "Username API is not available for this WhatsApp Business app number. Manage the username in the WhatsApp Business app.",
    });
    expect(mockListSuggestions).not.toHaveBeenCalled();
  });

  it("keeps the action visible when suggestions fail", async () => {
    mockListSuggestions.mockRejectedValue(new Error("Meta rollout edge"));
    const { GET } = await import("./route");

    const response = await GET(
      getRequest(
        "http://localhost/api/whatsapp/username?workspaceId=ws-1&includeSuggestions=1"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      canCreate: true,
      connected: true,
      hasUsername: false,
      suggestions: [],
    });
  });

  it("creates a username using the phone-number scoped API context", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        transferAction: "force_transfer",
        username: "@airi_chat",
        workspaceId: "ws-1",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      hasUsername: true,
      status: "reserved",
      username: "airi_chat",
    });
    expect(mockAdoptUsername).toHaveBeenCalledWith({
      accessToken: "token-1",
      phoneNumberId: "phone-1",
      transferAction: "force_transfer",
      username: "airi_chat",
    });
  });

  it("rejects create locally for WhatsApp Business app/co-existence numbers", async () => {
    mockContext({
      accessToken: "token-1",
      credentials: { coexistenceMode: true, isOnBizApp: true },
      phoneNumberId: "phone-1",
    });
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({ username: "airi_chat", workspaceId: "ws-1" })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      code: 147006,
      error:
        "Username API is not available for this WhatsApp Business app number. Manage the username in the WhatsApp Business app.",
      usernameApiUnavailable: true,
    });
    expect(mockAdoptUsername).not.toHaveBeenCalled();
  });

  it("returns transfer-required errors from Meta", async () => {
    mockAdoptUsername.mockRejectedValue(
      new mockBusinessUsernameErrorClass({
        code: 147005,
        message: "Transfer required",
        status: 409,
        transferRequired: true,
      })
    );
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({ username: "airi_chat", workspaceId: "ws-1" })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      code: 147005,
      error: "Transfer required",
      transferRequired: true,
    });
  });
});

export {};
