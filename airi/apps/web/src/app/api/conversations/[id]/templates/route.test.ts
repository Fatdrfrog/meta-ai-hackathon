const mockAuthGetUser = jest.fn();
const mockConnectDB = jest.fn();
const mockConversationFindById = jest.fn();
const mockGetHiddenConversationPlanGateResponse = jest.fn();
const mockListTemplates = jest.fn();
const mockGetWhatsappTemplates = jest.fn();

type SupabaseQueryMock = {
  eq: jest.Mock;
  limit: jest.Mock;
  maybeSingle: jest.Mock;
  order: jest.Mock;
  select: jest.Mock;
};

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  getHiddenConversationPlanGateResponse: (...args: unknown[]) =>
    mockGetHiddenConversationPlanGateResponse(...args),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: (...args: unknown[]) => mockAuthGetUser(...args),
    },
    from: (table: string) => {
      const query = {} as SupabaseQueryMock;
      query.select = jest.fn(() => query);
      query.eq = jest.fn(() => query);
      query.order = jest.fn(() => query);
      query.limit = jest.fn(() => query);
      query.maybeSingle = jest.fn(async () => {
        if (table === "company_users") {
          return { data: { workspace_id: "workspace-1" }, error: null };
        }
        if (table === "sources") {
          return {
            data: {
              credentials: {
                access_token: "legacy-access-token",
                waba_id: "legacy-waba",
              },
            },
            error: null,
          };
        }
        return { data: null, error: null };
      });
      return query;
    },
  }),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

jest.mock("@/lib/whatsapp/templates/service", () => ({
  listTemplates: (...args: unknown[]) => mockListTemplates(...args),
}));

jest.mock("@/lib/whatsapp", () => ({
  getWhatsappTemplates: (...args: unknown[]) =>
    mockGetWhatsappTemplates(...args),
}));

function leanResult(value: Record<string, unknown>) {
  return { select: () => ({ lean: async () => value }) };
}

describe("GET /api/conversations/[id]/templates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
    });
    mockConnectDB.mockResolvedValue(undefined);
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(null);
    mockConversationFindById.mockReturnValue(
      leanResult({
        _id: "conversation-1",
        channel: "whatsapp",
        workspaceId: "workspace-1",
      })
    );
    mockListTemplates.mockResolvedValue({
      templates: [
        {
          name: "welcome_offer",
          language: "en",
          category: "MARKETING",
          status: "APPROVED",
          components: [{ type: "BODY", text: "Hi {{1}}" }],
        },
      ],
    });
    mockGetWhatsappTemplates.mockResolvedValue([]);
  });

  it("uses the shared template service for approved WhatsApp conversation templates", async () => {
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "conversation-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListTemplates).toHaveBeenCalledWith("workspace-1", {
      status: "APPROVED",
    });
    expect(mockGetWhatsappTemplates).not.toHaveBeenCalled();
    expect(body.templates).toEqual([
      {
        name: "welcome_offer",
        language: "en",
        category: "MARKETING",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Hi {{1}}" }],
        variables: ["1"],
      },
    ]);
  });

  it("lists the templates of the WhatsApp source the conversation sends from", async () => {
    mockConversationFindById.mockReturnValue(
      leanResult({
        _id: "conversation-1",
        channel: "whatsapp",
        workspaceId: "workspace-1",
        sourceId: "source-old",
      })
    );

    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "conversation-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockListTemplates).toHaveBeenCalledWith("workspace-1", {
      status: "APPROVED",
      sourceId: "source-old",
    });
  });

  it("blocks template listing when the conversation is hidden by the plan gate", async () => {
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "company_conversation_visibility_exceeded",
          planGate: { reason: "trial_expired", hiddenCount: 1 },
        }),
        { status: 402 }
      )
    );

    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "conversation-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(402);
    expect(body.code).toBe("company_conversation_visibility_exceeded");
    expect(mockGetHiddenConversationPlanGateResponse).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-1",
      "conversation-1"
    );
    expect(mockListTemplates).not.toHaveBeenCalled();
  });
});

export {};
