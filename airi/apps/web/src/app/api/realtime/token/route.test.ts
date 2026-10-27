const mockGetRealtimeGatewayUrl = jest.fn();
const mockGetRealtimeTokenSecret = jest.fn();
const mockSignRealtimeToken = jest.fn();
const mockVerifyVisitorToken = jest.fn();
const mockConversationFindOne = jest.fn();
const mockGetSupabaseRouteAuth = jest.fn();
const mockGetCompanyConversationVisibilityGate = jest.fn();
const mockIsConversationVisibleForPlan = jest.fn();
const mockReadActivationDecision = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockFlushServerLogsAfterResponse = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@/lib/realtime/gateway-url", () => ({
  getRealtimeGatewayUrl: () => mockGetRealtimeGatewayUrl(),
}));

jest.mock("@/lib/realtime/token", () => ({
  REALTIME_BOUNDED_TOKEN_MAX_TTL_SECONDS: 300,
  getRealtimeTokenSecret: () => mockGetRealtimeTokenSecret(),
  signRealtimeToken: (...args: unknown[]) => mockSignRealtimeToken(...args),
}));

jest.mock("@/lib/supabase/route-auth", () => ({
  getSupabaseRouteAuth: (...args: unknown[]) =>
    mockGetSupabaseRouteAuth(...args),
  isSupabaseRouteAuthError: (value: unknown) =>
    value !== null && typeof value === "object" && "error" in value,
}));

jest.mock("@/lib/limits/company-limits", () => ({
  getCompanyConversationVisibilityGate: (...args: unknown[]) =>
    mockGetCompanyConversationVisibilityGate(...args),
  isConversationVisibleForPlan: (...args: unknown[]) =>
    mockIsConversationVisibleForPlan(...args),
}));

jest.mock("@/lib/requests-projection/activation", () => ({
  readRequestsProjectionActivationDecision: (...args: unknown[]) =>
    mockReadActivationDecision(...args),
}));

jest.mock("@/lib/widget/visitor-auth", () => ({
  verifyVisitorToken: (...args: unknown[]) => mockVerifyVisitorToken(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: (...args: unknown[]) => mockConversationFindOne(...args),
  },
}));

jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    error: mockLoggerError,
    info: jest.fn(),
    warn: mockLoggerWarn,
  }),
  flushServerLogsAfterResponse: () => mockFlushServerLogsAfterResponse(),
}));

function postRequest(body: unknown, headers?: Record<string, string>) {
  return new Request("https://www.airi.chat/api/realtime/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://embed.example",
      "x-vercel-id": "iad1::test-request",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function getRequest(input: {
  workspaceId: string;
  conversationId?: string;
  bearer?: boolean;
  headers?: HeadersInit;
}) {
  const url = new URL("https://www.airi.chat/api/realtime/token");
  url.searchParams.set("workspaceId", input.workspaceId);
  if (input.conversationId) {
    url.searchParams.set("conversationId", input.conversationId);
  }
  const headers = new Headers(input.headers);
  headers.set("x-vercel-id", "iad1::legacy-token-test");
  if (input.bearer) headers.set("authorization", "Bearer mobile-token");
  return new Request(url, {
    headers,
  });
}

function createSupabaseMembershipClient() {
  const maybeSingle = jest.fn().mockResolvedValue({
    data: { workspace_id: "workspace-1" },
    error: null,
  });
  const chain = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle,
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return {
    from: jest.fn().mockReturnValue(chain),
  };
}

function expectNoStore(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}

const WIDGET_CONVERSATION = {
  _id: "conversation-1",
  workspaceId: "workspace-1",
  channel: "web_widget",
  sourceId: "source-1",
  visitor_id: "visitor-1",
};

function mockConversationLookup(conversation: Record<string, unknown> | null) {
  mockConversationFindOne.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(conversation),
      }),
    }),
  });
}

function mockConversationBelongsToWorkspace(belongs: boolean) {
  mockConversationLookup(belongs ? WIDGET_CONVERSATION : null);
}

describe("/api/realtime/token", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRealtimeTokenSecret.mockReturnValue("secret");
    mockGetRealtimeGatewayUrl.mockReturnValue("https://realtime.example.com");
    mockSignRealtimeToken.mockResolvedValue("signed-token");
    mockVerifyVisitorToken.mockResolvedValue({
      visitorId: "visitor-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      scope: "widget",
    });
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: createSupabaseMembershipClient(),
      user: { id: "user-1" },
      authType: "cookie",
    });
    mockGetCompanyConversationVisibilityGate.mockResolvedValue({
      visibleConversationIds: null,
    });
    mockIsConversationVisibleForPlan.mockReturnValue(true);
    mockConversationBelongsToWorkspace(true);
    jest.spyOn(Date, "now").mockReturnValue(1_900_000_000_123);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns a repairable stale-conversation code and logs one denial event", async () => {
    mockConversationBelongsToWorkspace(false);
    const { POST } = await import("./route");

    const response = await POST(
      postRequest(
        {
          source: "widget",
          workspaceId: "workspace-1",
          conversationId: "conversation-missing",
        },
        { "x-visitor-token": "visitor-token" }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      code: "widget_conversation_not_found",
      error: "Conversation not found",
    });
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Realtime token request completed",
      expect.objectContaining({
        method: "POST",
        route: "/api/realtime/token",
        requestId: "iad1::test-request",
        statusCode: 404,
        outcome: "denied",
        denialReason: "widget_conversation_not_found",
        code: "widget_conversation_not_found",
        hasWorkspaceId: true,
        hasConversationId: true,
        authMode: "visitor_header",
        conversationOwnedByVisitor: false,
      })
    );
    const serializedLog = JSON.stringify(mockLoggerWarn.mock.calls);
    expect(serializedLog).not.toContain("workspace-1");
    expect(serializedLog).not.toContain("conversation-missing");
    expectNoStore(response);
  });

  it.each([
    ["another visitor's widget thread", { visitor_id: "visitor-2" }],
    ["a WhatsApp thread", { channel: "whatsapp", visitor_id: null }],
    ["another widget source", { sourceId: "source-2" }],
  ])(
    "refuses a widget token for %s in the same workspace",
    async (_label, overrides) => {
      mockConversationLookup({ ...WIDGET_CONVERSATION, ...overrides });
      const { POST } = await import("./route");

      const response = await POST(
        postRequest(
          {
            source: "widget",
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
          },
          { "x-visitor-token": "visitor-token" }
        )
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        code: "widget_conversation_not_found",
      });
      expect(mockSignRealtimeToken).not.toHaveBeenCalled();
    }
  );

  it("issues a widget token for the visitor's legacy thread owned through user", async () => {
    mockConversationLookup({
      ...WIDGET_CONVERSATION,
      sourceId: null,
      visitor_id: null,
      user: "visitor-1",
    });
    const { POST } = await import("./route");

    const response = await POST(
      postRequest(
        {
          source: "widget",
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
        },
        { "x-visitor-token": "visitor-token" }
      )
    );

    expect(response.status).toBe(200);
    expect(mockSignRealtimeToken).toHaveBeenCalledTimes(1);
  });

  it("returns a specific code when the visitor token belongs to another workspace", async () => {
    mockVerifyVisitorToken.mockResolvedValue({
      visitorId: "visitor-1",
      workspaceId: "workspace-other",
      sourceId: "source-1",
      scope: "widget",
    });
    const { POST } = await import("./route");

    const response = await POST(
      postRequest(
        {
          source: "widget",
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
        },
        { "x-visitor-token": "visitor-token" }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      code: "widget_visitor_workspace_mismatch",
      error: "Forbidden",
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Realtime token request completed",
      expect.objectContaining({
        statusCode: 403,
        outcome: "denied",
        denialReason: "visitor_workspace_mismatch",
        code: "widget_visitor_workspace_mismatch",
        visitorMatchesWorkspace: false,
      })
    );
    const serializedLog = JSON.stringify(mockLoggerWarn.mock.calls);
    expect(serializedLog).not.toContain("workspace-other");
    expect(serializedLog).not.toContain("source-1");
    expectNoStore(response);
  });

  it("never logs an untrusted widget source value", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      postRequest({
        source: "raw-source-secret",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
      })
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain(
      "raw-source-secret"
    );
    expectNoStore(response);
  });

  it("never attaches raw identifier-bearing exceptions to completion logs", async () => {
    mockConversationFindOne.mockImplementationOnce(() => {
      throw new Error(
        "database failure for workspace-1/507f1f77bcf86cd799439011/user-1"
      );
    });
    const { GET } = await import("./route");

    const response = await GET(
      getRequest({
        workspaceId: "workspace-1",
        conversationId: "507f1f77bcf86cd799439011",
      })
    );

    expect(response.status).toBe(500);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Realtime token request completed",
      undefined,
      expect.objectContaining({
        statusCode: 500,
        outcome: "error",
        denialReason: "token_exception",
      })
    );
    const serializedLog = JSON.stringify(mockLoggerError.mock.calls);
    expect(serializedLog).not.toContain("workspace-1");
    expect(serializedLog).not.toContain("507f1f77bcf86cd799439011");
    expect(serializedLog).not.toContain("user-1");
    expectNoStore(response);
  });

  it.each([
    ["dashboard", false, "cookie"],
    ["mobile", true, "bearer"],
  ] as const)(
    "applies the plan gate and exact five-minute TTL for %s conversation tokens",
    async (source, bearer, authType) => {
      const supabase = createSupabaseMembershipClient();
      mockGetSupabaseRouteAuth.mockResolvedValue({
        supabase,
        user: { id: "user-1" },
        authType,
      });
      const { GET } = await import("./route");

      const response = await GET(
        getRequest({
          workspaceId: "workspace-1",
          conversationId: "507f1f77bcf86cd799439011",
          bearer,
        })
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockGetCompanyConversationVisibilityGate).toHaveBeenCalledWith(
        supabase,
        "workspace-1"
      );
      expect(mockIsConversationVisibleForPlan).toHaveBeenCalledWith(
        expect.anything(),
        "507f1f77bcf86cd799439011"
      );
      expect(mockSignRealtimeToken).toHaveBeenCalledWith(
        {
          kind: "conversation",
          workspaceId: "workspace-1",
          conversationId: "507f1f77bcf86cd799439011",
          userId: "user-1",
          source,
        },
        {
          expiresInSeconds: 300,
          nowSeconds: 1_900_000_000,
        }
      );
      expect(body).toMatchObject({
        token: "signed-token",
        expiresInSeconds: 300,
        expiresAt: new Date(1_900_000_300_000).toISOString(),
      });
      expectNoStore(response);
      expect(mockReadActivationDecision).not.toHaveBeenCalled();
    }
  );

  it("accepts the exact cookie dashboard header after transport whitespace trimming", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      getRequest({
        workspaceId: "workspace-1",
        headers: {
          "x-airi-realtime-client-contract": "  dashboard-v1\t",
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockSignRealtimeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "workspace",
        source: "dashboard",
        clientContract: "dashboard-v1",
      }),
      { expiresInSeconds: 3_600, nowSeconds: 1_900_000_000 }
    );
  });

  it.each([
    ["workspace", undefined, 3_600],
    ["conversation", "507f1f77bcf86cd799439011", 300],
  ] as const)(
    "signs dashboard-v1 only for an exact cookie %s request header",
    async (_kind, conversationId, expiresInSeconds) => {
      const { GET } = await import("./route");

      const response = await GET(
        getRequest({
          workspaceId: "workspace-1",
          conversationId,
          headers: {
            "x-airi-realtime-client-contract": "dashboard-v1",
          },
        })
      );

      expect(response.status).toBe(200);
      expect(mockSignRealtimeToken).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: conversationId ? "conversation" : "workspace",
          workspaceId: "workspace-1",
          source: "dashboard",
          clientContract: "dashboard-v1",
          ...(conversationId ? { conversationId } : {}),
        }),
        { expiresInSeconds, nowSeconds: 1_900_000_000 }
      );
    }
  );

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["unknown", "future-dashboard-v2"],
  ] as const)(
    "keeps an otherwise-authorized cookie token unlabeled for a %s header",
    async (_case, clientContract) => {
      const { GET } = await import("./route");
      const response = await GET(
        getRequest({
          workspaceId: "workspace-1",
          headers:
            clientContract === undefined
              ? undefined
              : { "x-airi-realtime-client-contract": clientContract },
        })
      );

      expect(response.status).toBe(200);
      expect(mockSignRealtimeToken).toHaveBeenCalledWith(
        expect.not.objectContaining({ clientContract: expect.anything() }),
        expect.anything()
      );
    }
  );

  it("keeps a repeated dashboard client-contract header unlabeled", async () => {
    const headers = new Headers();
    headers.append("x-airi-realtime-client-contract", "dashboard-v1");
    headers.append("x-airi-realtime-client-contract", "dashboard-v1");
    const { GET } = await import("./route");

    const response = await GET(
      getRequest({ workspaceId: "workspace-1", headers })
    );

    expect(response.status).toBe(200);
    expect(mockSignRealtimeToken).toHaveBeenCalledWith(
      expect.not.objectContaining({ clientContract: expect.anything() }),
      expect.anything()
    );
  });

  it("ignores a cookie GET client-contract query attempt", async () => {
    const { GET } = await import("./route");
    const request = getRequest({ workspaceId: "workspace-1" });
    const url = new URL(request.url);
    url.searchParams.set("clientContract", "dashboard-v1");

    const response = await GET(new Request(url, request));

    expect(response.status).toBe(200);
    expect(mockSignRealtimeToken).toHaveBeenCalledWith(
      expect.not.objectContaining({ clientContract: expect.anything() }),
      expect.anything()
    );
  });

  it("does not let a bearer mobile request self-label", async () => {
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: createSupabaseMembershipClient(),
      user: { id: "user-1" },
      authType: "bearer",
    });
    const { GET } = await import("./route");

    const response = await GET(
      getRequest({
        workspaceId: "workspace-1",
        bearer: true,
        headers: {
          "x-airi-realtime-client-contract": "dashboard-v1",
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockSignRealtimeToken).toHaveBeenCalledWith(
      expect.objectContaining({ source: "mobile" }),
      expect.anything()
    );
    expect(mockSignRealtimeToken).toHaveBeenCalledWith(
      expect.not.objectContaining({ clientContract: expect.anything() }),
      expect.anything()
    );
  });

  it("ignores dashboard provenance in widget headers, body, and query", async () => {
    const { POST } = await import("./route");
    const request = postRequest(
      {
        source: "widget",
        workspaceId: "workspace-1",
        conversationId: "507f1f77bcf86cd799439011",
        clientContract: "dashboard-v1",
      },
      {
        "x-visitor-token": "visitor-token",
        "x-airi-realtime-client-contract": "dashboard-v1",
      }
    );

    const response = await POST(
      new Request(`${request.url}?clientContract=dashboard-v1`, request)
    );

    expect(response.status).toBe(200);
    expect(mockSignRealtimeToken).toHaveBeenCalledWith(
      expect.objectContaining({ source: "widget" }),
      expect.anything()
    );
    expect(mockSignRealtimeToken).toHaveBeenCalledWith(
      expect.not.objectContaining({ clientContract: expect.anything() }),
      expect.anything()
    );
  });

  it("keeps provenance passive during denial and never logs its raw value", async () => {
    const membership = createSupabaseMembershipClient();
    membership.from().maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: membership,
      user: { id: "user-1" },
      authType: "cookie",
    });
    const { GET } = await import("./route");

    const response = await GET(
      getRequest({
        workspaceId: "workspace-1",
        headers: {
          "x-airi-realtime-client-contract": "raw-contract-secret",
        },
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mockSignRealtimeToken).not.toHaveBeenCalled();
    expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain(
      "raw-contract-secret"
    );
  });

  it("collapses a plan-hidden and a wrong-workspace conversation to the same 403", async () => {
    const { GET } = await import("./route");
    mockIsConversationVisibleForPlan.mockReturnValueOnce(false);

    const hidden = await GET(
      getRequest({
        workspaceId: "workspace-1",
        conversationId: "507f1f77bcf86cd799439011",
      })
    );
    expect(hidden.status).toBe(403);
    await expect(hidden.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mockSignRealtimeToken).not.toHaveBeenCalled();
    expectNoStore(hidden);

    jest.clearAllMocks();
    mockGetRealtimeTokenSecret.mockReturnValue("secret");
    mockGetRealtimeGatewayUrl.mockReturnValue("https://realtime.example.com");
    mockGetSupabaseRouteAuth.mockResolvedValue({
      supabase: createSupabaseMembershipClient(),
      user: { id: "user-1" },
      authType: "cookie",
    });
    mockConversationBelongsToWorkspace(false);
    const wrongWorkspace = await GET(
      getRequest({
        workspaceId: "workspace-1",
        conversationId: "507f1f77bcf86cd799439011",
      })
    );
    expect(wrongWorkspace.status).toBe(403);
    await expect(wrongWorkspace.json()).resolves.toEqual({
      error: "Forbidden",
    });
    expect(mockGetCompanyConversationVisibilityGate).not.toHaveBeenCalled();
    expect(mockSignRealtimeToken).not.toHaveBeenCalled();
    expectNoStore(wrongWorkspace);
  });

  it.each([
    ["dashboard", false, "cookie"],
    ["mobile", true, "bearer"],
  ] as const)(
    "preserves one-hour %s workspace issuance without the conversation plan gate",
    async (source, bearer, authType) => {
      mockGetSupabaseRouteAuth.mockResolvedValue({
        supabase: createSupabaseMembershipClient(),
        user: { id: "user-1" },
        authType,
      });
      const { GET } = await import("./route");
      const response = await GET(
        getRequest({ workspaceId: "workspace-1", bearer })
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockGetCompanyConversationVisibilityGate).not.toHaveBeenCalled();
      expect(mockIsConversationVisibleForPlan).not.toHaveBeenCalled();
      expect(mockSignRealtimeToken).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "workspace", source }),
        { expiresInSeconds: 3_600, nowSeconds: 1_900_000_000 }
      );
      expect(body).toMatchObject({
        expiresInSeconds: 3_600,
        expiresAt: new Date(1_900_003_600_000).toISOString(),
      });
      expectNoStore(response);
      expect(mockReadActivationDecision).not.toHaveBeenCalled();
    }
  );

  it("preserves widget CORS and one-hour exact issuance without the company gate", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      postRequest(
        {
          source: "widget",
          workspaceId: "workspace-1",
          conversationId: "507f1f77bcf86cd799439011",
        },
        { "x-visitor-token": "visitor-token" }
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetCompanyConversationVisibilityGate).not.toHaveBeenCalled();
    expect(mockSignRealtimeToken).toHaveBeenCalledWith(
      {
        kind: "conversation",
        workspaceId: "workspace-1",
        conversationId: "507f1f77bcf86cd799439011",
        source: "widget",
      },
      { expiresInSeconds: 3_600, nowSeconds: 1_900_000_000 }
    );
    expect(body).toMatchObject({
      expiresInSeconds: 3_600,
      expiresAt: new Date(1_900_003_600_000).toISOString(),
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://embed.example"
    );
    expectNoStore(response);
    expect(mockReadActivationDecision).not.toHaveBeenCalled();
  });
});

export {};
