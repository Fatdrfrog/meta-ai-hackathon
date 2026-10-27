const mockAuthGetUser = jest.fn();
const mockCompanyUserLookup = jest.fn();
const mockConnectDB = jest.fn();
const mockConversationFindById = jest.fn();
const mockFetchSourceWithCredentialsResult = jest.fn();
const mockGetWorkspaceMemberDisplayName = jest.fn();
const mockGetHiddenConversationPlanGateResponse = jest.fn();
const mockGetWhatsappTemplates = jest.fn();
const mockListTemplates = jest.fn();
const mockPersistManagerOutboundMessage = jest.fn();
const mockResolveStoredWhatsAppRecipientTarget = jest.fn();
const mockSendWhatsappTemplate = jest.fn();
const mockUpsertManagerAuthor = jest.fn();
const mockUserFindById = jest.fn();
const mockWhatsAppTemplateFind = jest.fn();

type SupabaseQueryMock = {
  eq: jest.Mock;
  limit: jest.Mock;
  maybeSingle: jest.Mock;
  order: jest.Mock;
  select: jest.Mock;
};

type SourceRow = {
  id: string;
  workspace_id: string;
  type: "whatsapp";
  created_at: string;
  credentials: Record<string, unknown>;
};

const SINGLE_SOURCE: SourceRow = {
  id: "source-1",
  workspace_id: "workspace-1",
  type: "whatsapp",
  created_at: "2026-01-01T00:00:00.000Z",
  credentials: {
    access_token: "access-token",
    phone_number_id: "phone-1",
    waba_id: "legacy-waba",
  },
};

/** The workspace's WhatsApp sources, newest last. */
let mockSourceRows: SourceRow[] = [SINGLE_SOURCE];

function newestMockSource(): SourceRow | null {
  return (
    [...mockSourceRows].sort((a, b) =>
      b.created_at.localeCompare(a.created_at)
    )[0] ?? null
  );
}

jest.mock("@/lib/conversation-messages", () => ({
  persistManagerOutboundMessage: (...args: unknown[]) =>
    mockPersistManagerOutboundMessage(...args),
  upsertManagerAuthor: (...args: unknown[]) => mockUpsertManagerAuthor(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  getHiddenConversationPlanGateResponse: (...args: unknown[]) =>
    mockGetHiddenConversationPlanGateResponse(...args),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getWorkspaceMemberDisplayName: (...args: unknown[]) =>
    mockGetWorkspaceMemberDisplayName(...args),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: (...args: unknown[]) => mockAuthGetUser(...args),
    },
    from: (table: string) => {
      const query = Promise.resolve({
        data: null,
        error: null,
      }) as Promise<{ data: null; error: null }> & SupabaseQueryMock;
      query.select = jest.fn(() => query);
      query.eq = jest.fn(() => query);
      query.order = jest.fn(() => query);
      query.limit = jest.fn(() => query);
      query.maybeSingle = jest.fn(async () => {
        if (table === "company_users") {
          return { data: mockCompanyUserLookup(), error: null };
        }
        if (table === "sources") {
          // What a workspace-wide "newest WhatsApp source" read returns.
          return { data: newestMockSource(), error: null };
        }
        return { data: null, error: null };
      });
      return query;
    },
  }),
}));

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentialsResult: (...args: unknown[]) =>
    mockFetchSourceWithCredentialsResult(...args),
}));

jest.mock("@/lib/whatsapp", () => ({
  getWhatsappTemplates: (...args: unknown[]) =>
    mockGetWhatsappTemplates(...args),
  sendWhatsappTemplate: (...args: unknown[]) =>
    mockSendWhatsappTemplate(...args),
}));

jest.mock("@icecore/shared/lib/whatsapp/contact-identities", () => ({
  resolveStoredWhatsAppRecipientTarget: (...args: unknown[]) =>
    mockResolveStoredWhatsAppRecipientTarget(...args),
}));

jest.mock("@/lib/whatsapp/templates/service", () => ({
  listTemplates: (...args: unknown[]) => mockListTemplates(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findById: (...args: unknown[]) => mockUserFindById(...args),
  },
}));

jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateModel: {
    find: (...args: unknown[]) => mockWhatsAppTemplateFind(...args),
  },
}));

function leanQuery<T>(value: T) {
  return {
    select: jest.fn(() => ({
      lean: jest.fn(() => Promise.resolve(value)),
    })),
  };
}

function buildConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: "conversation-1",
    channel: "whatsapp",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    user: "customer-1",
    chat: {
      _id: "chat-1",
      first_name: "Aida",
      whatsapp: { waId: "77001112233" },
    },
    ...overrides,
  };
}

function mockConversation(overrides: Record<string, unknown> = {}) {
  mockConversationFindById.mockReturnValue({
    select: jest.fn(() => ({
      populate: jest.fn(() => ({
        lean: jest.fn().mockResolvedValue(buildConversation(overrides)),
      })),
    })),
  });
}

async function postTemplate() {
  const { POST } = await import("./route");
  return POST(
    buildRequest({
      templateName: "welcome_offer",
      languageCode: "en",
    }) as never,
    { params: Promise.resolve({ id: "conversation-1" }) }
  );
}

function expectNoProviderCall() {
  expect(mockSendWhatsappTemplate).not.toHaveBeenCalled();
  expect(mockListTemplates).not.toHaveBeenCalled();
  expect(mockUpsertManagerAuthor).not.toHaveBeenCalled();
  expect(mockPersistManagerOutboundMessage).not.toHaveBeenCalled();
}

function buildRequest(body: Record<string, unknown>) {
  return new Request(
    "http://localhost/api/conversations/conversation-1/send-template",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

describe("POST /api/conversations/[id]/send-template", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthGetUser.mockResolvedValue({
      data: { user: { id: "manager-1" } },
    });
    mockCompanyUserLookup.mockReturnValue({
      workspace_id: "workspace-1",
      email: "agent@airi.chat",
    });
    mockConnectDB.mockResolvedValue(undefined);
    mockSourceRows = [SINGLE_SOURCE];
    // Mirrors fetchSourceWithCredentialsResult: optional id, type and column
    // filters, newest row first.
    mockFetchSourceWithCredentialsResult.mockImplementation(
      async (
        sourceId?: string,
        sourceType?: string,
        filters?: Record<string, string>
      ) => {
        const source =
          [...mockSourceRows]
            .filter(
              row =>
                (!sourceId || row.id === sourceId) &&
                (!sourceType || row.type === sourceType) &&
                Object.entries(filters ?? {}).every(
                  ([key, value]) =>
                    (row as Record<string, unknown>)[key] === value
                )
            )
            .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ??
          null;
        return { ok: true, source };
      }
    );
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(null);
    mockConversation();
    mockGetWorkspaceMemberDisplayName.mockResolvedValue("Dana");
    mockGetWhatsappTemplates.mockResolvedValue([]);
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
    mockPersistManagerOutboundMessage.mockResolvedValue({ _id: "message-1" });
    mockResolveStoredWhatsAppRecipientTarget.mockReturnValue({
      kind: "phone",
      value: "77001112233",
    });
    mockSendWhatsappTemplate.mockResolvedValue({
      messageId: "wamid-1",
      date: 1_725_000_000,
    });
    mockUserFindById.mockReturnValue(
      leanQuery({
        _id: "customer-1",
        firstName: "Aida",
        whatsapp: { waId: "77001112233" },
      })
    );
    mockUpsertManagerAuthor.mockResolvedValue({ _id: "manager-1" });
    mockWhatsAppTemplateFind.mockReturnValue(leanQuery([]));
  });

  it("uses the shared template service for live fallback when cached template components are missing", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      buildRequest({
        templateName: "welcome_offer",
        languageCode: "en",
      }) as never,
      { params: Promise.resolve({ id: "conversation-1" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mockListTemplates).toHaveBeenCalledWith("workspace-1", {
      status: "APPROVED",
      sourceId: "source-1",
    });
    expect(mockGetWhatsappTemplates).not.toHaveBeenCalled();
    expect(mockSendWhatsappTemplate).toHaveBeenCalledWith(
      "phone-1",
      "access-token",
      { kind: "phone", value: "77001112233" },
      "welcome_offer",
      "en",
      [
        {
          type: "body",
          parameters: [{ type: "text", text: "Aida" }],
        },
      ],
      expect.objectContaining({
        requirePhoneRecipient: false,
      })
    );
    expect(mockFetchSourceWithCredentialsResult).toHaveBeenCalledWith(
      "source-1",
      "whatsapp"
    );
    // Meta accepts the template before the author or message is stored.
    expect(mockSendWhatsappTemplate.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpsertManagerAuthor.mock.invocationCallOrder[0]
    );
    expect(mockUpsertManagerAuthor).toHaveBeenCalledWith({
      id: "manager-1",
      name: "Manager",
      namePromise: expect.any(Promise),
    });
    await expect(
      mockUpsertManagerAuthor.mock.calls[0][0].namePromise
    ).resolves.toBe("Dana");
    expect(mockPersistManagerOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ _id: "conversation-1" }),
        workspaceId: "workspace-1",
        channel: "whatsapp",
        managerId: "manager-1",
        managerUser: { _id: "manager-1" },
        message: expect.objectContaining({
          messageId: "wamid-1",
          date: new Date(1_725_000_000 * 1000),
          text: '[Template: welcome_offer] with variables: ["Aida"]',
          fields: { whatsappTemplate: expect.any(Object) },
          origin: {
            templateName: "welcome_offer",
            templateCategory: "MARKETING",
            sourceId: "source-1",
          },
        }),
      })
    );
  });

  it("sends from the conversation's own number when the workspace has several WhatsApp sources", async () => {
    mockSourceRows = [
      {
        id: "source-old",
        workspace_id: "workspace-1",
        type: "whatsapp",
        created_at: "2026-01-01T00:00:00.000Z",
        credentials: {
          access_token: "old-token",
          phone_number_id: "old-phone",
          waba_id: "old-waba",
          messaging_account_id: "old-messaging-account",
        },
      },
      {
        id: "source-new",
        workspace_id: "workspace-1",
        type: "whatsapp",
        created_at: "2026-09-01T00:00:00.000Z",
        credentials: {
          access_token: "new-token",
          phone_number_id: "new-phone",
          waba_id: "new-waba",
          messaging_account_id: "new-messaging-account",
        },
      },
    ];
    mockConversation({ sourceId: "source-old" });

    const response = await postTemplate();

    expect(response.status).toBe(200);
    expect(mockSendWhatsappTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendWhatsappTemplate).toHaveBeenCalledWith(
      "old-phone",
      "old-token",
      { kind: "phone", value: "77001112233" },
      "welcome_offer",
      "en",
      expect.any(Array),
      expect.objectContaining({
        messagingAccountId: "old-messaging-account",
      })
    );
    expect(mockFetchSourceWithCredentialsResult).toHaveBeenCalledWith(
      "source-old",
      "whatsapp"
    );
    // The live template fallback reads the sending source's WABA.
    expect(mockListTemplates).toHaveBeenCalledWith("workspace-1", {
      status: "APPROVED",
      sourceId: "source-old",
    });
    expect(
      mockPersistManagerOutboundMessage.mock.calls[0][0].message.origin
    ).toMatchObject({ sourceId: "source-old" });
  });

  it("refuses to send without a Graph call when the conversation has no WhatsApp source binding", async () => {
    mockConversation({ sourceId: undefined });

    const response = await postTemplate();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "WHATSAPP_SOURCE_REQUIRED",
      error:
        "The conversation has no WhatsApp source binding. Contact support before sending.",
    });
    expect(mockFetchSourceWithCredentialsResult).not.toHaveBeenCalled();
    expectNoProviderCall();
  });

  it.each([
    ["was deleted", [] as SourceRow[]],
    [
      "has paused Cloud API messaging",
      [
        {
          ...SINGLE_SOURCE,
          credentials: {
            ...SINGLE_SOURCE.credentials,
            coexistence_mode: true,
            coexistence_reonboarding_status: "offboarded",
            cloud_api_messaging_suspended: true,
          },
        },
      ],
    ],
    [
      "belongs to another workspace",
      [{ ...SINGLE_SOURCE, workspace_id: "workspace-2" }],
    ],
    [
      "has no phone number id",
      [
        {
          ...SINGLE_SOURCE,
          credentials: { access_token: "access-token", waba_id: "legacy-waba" },
        },
      ],
    ],
  ])(
    "refuses to send without a Graph call or a fallback when the bound source %s",
    async (_case, boundRows) => {
      mockSourceRows = [
        ...boundRows,
        {
          id: "source-other",
          workspace_id: "workspace-1",
          type: "whatsapp",
          created_at: "2026-09-01T00:00:00.000Z",
          credentials: {
            access_token: "other-token",
            phone_number_id: "other-phone",
            waba_id: "other-waba",
          },
        },
      ];

      const response = await postTemplate();
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body).toEqual({
        code: "WHATSAPP_SOURCE_UNAVAILABLE",
        error: "The conversation's WhatsApp connection is unavailable.",
      });
      expect(mockFetchSourceWithCredentialsResult).toHaveBeenCalledTimes(1);
      expect(mockFetchSourceWithCredentialsResult).toHaveBeenCalledWith(
        "source-1",
        "whatsapp"
      );
      expectNoProviderCall();
    }
  );

  it("denies a manager who is not a member of the conversation's workspace", async () => {
    mockCompanyUserLookup.mockReturnValue(null);

    const response = await postTemplate();
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe("Access denied to this conversation");
    expect(mockGetHiddenConversationPlanGateResponse).not.toHaveBeenCalled();
    expect(mockFetchSourceWithCredentialsResult).not.toHaveBeenCalled();
    expectNoProviderCall();
  });

  it("blocks template sends when the conversation is hidden by the plan gate", async () => {
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "company_conversation_visibility_exceeded",
          planGate: { reason: "trial_expired", hiddenCount: 1 },
        }),
        { status: 402 }
      )
    );

    const { POST } = await import("./route");

    const response = await POST(
      buildRequest({
        templateName: "welcome_offer",
        languageCode: "en",
      }) as never,
      { params: Promise.resolve({ id: "conversation-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(402);
    expect(body.code).toBe("company_conversation_visibility_exceeded");
    expect(mockGetHiddenConversationPlanGateResponse).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-1",
      "conversation-1"
    );
    expect(mockFetchSourceWithCredentialsResult).not.toHaveBeenCalled();
    expectNoProviderCall();
  });
});

export {};
