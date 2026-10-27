const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockCacheReadWithStatus = jest.fn();
const mockAfter = jest.fn();
let mockCacheMemoryEnabled = false;
const mockConnectDb = jest.fn();
const mockGetWorkspaceFeatureFlags = jest.fn();
const mockConversationFindById = jest.fn();
const mockMessageFind = jest.fn();
const mockMessageCountDocuments = jest.fn();
const mockChatFindOne = jest.fn();
const mockUserFindOne = jest.fn();
const mockUserFind = jest.fn();
const mockWhatsAppCallSessionFind = jest.fn();
const mockWhatsAppCallCommandFind = jest.fn();
const mockScenarioFind = jest.fn();
const mockGetCompanyConversationVisibilityGate = jest.fn();
const mockIsConversationVisibleForPlan = jest.fn();
const mockBuildCompanyConversationVisibilityExceededResponse = jest.fn();
const mockGetHiddenConversationPlanGateResponse = jest.fn();
const mockMembershipRead = jest.fn();
const mockMembershipSelect = jest.fn();
const mockGetUserProfilesByIds = jest.fn();
const mockAuthGetUser = jest.fn();
const mockRequestLogSuccess = jest.fn();
const mockRequestLogError = jest.fn();
const mockCreateRequestLogger = jest.fn();

jest.mock("@/lib/observability/server-logs", () => ({
  createRequestLogger: (...args: unknown[]) => mockCreateRequestLogger(...args),
}));

jest.mock("next/server", () => ({
  ...jest.requireActual("next/server"),
  after: (...args: unknown[]) => mockAfter(...args),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getUserProfilesByIds: (...args: unknown[]) =>
    mockGetUserProfilesByIds(...args),
}));

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (...parts: unknown[]) => JSON.stringify(parts),
  cache: {
    get memoryEnabled() {
      return mockCacheMemoryEnabled;
    },
    get: (...args: unknown[]) => mockCacheGet(...args),
    readWithStatus: (...args: unknown[]) => mockCacheReadWithStatus(...args),
    set: (...args: unknown[]) => mockCacheSet(...args),
  },
  invalidateConversationCache: jest.fn(),
  invalidateRequestsForWorkspace: jest.fn(),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDb(...args),
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: (...args: unknown[]) => mockAuthGetUser(...args),
    },
    from: () => ({
      select: (fields: string) => {
        mockMembershipSelect(fields);
        const query = {
          eq: () => query,
          in: () => mockMembershipRead(),
          maybeSingle: async () => {
            const result = await mockMembershipRead();
            return { ...result, data: result.data?.[0] ?? null };
          },
        };
        return query;
      },
    }),
  }),
}));

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: jest.fn(),
}));

jest.mock("@/lib/workspace-feature-flags", () => ({
  getWorkspaceFeatureFlags: (...args: unknown[]) =>
    mockGetWorkspaceFeatureFlags(...args),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  getCompanyConversationVisibilityGate: (...args: unknown[]) =>
    mockGetCompanyConversationVisibilityGate(...args),
  isConversationVisibleForPlan: (...args: unknown[]) =>
    mockIsConversationVisibleForPlan(...args),
  buildCompanyConversationVisibilityExceededResponse: (...args: unknown[]) =>
    mockBuildCompanyConversationVisibilityExceededResponse(...args),
  getHiddenConversationPlanGateResponse: (...args: unknown[]) =>
    mockGetHiddenConversationPlanGateResponse(...args),
}));

jest.mock("@/lib/customers/service", () => ({
  ensureCustomerForConversation: jest.fn(),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockMessageFind(...args),
    countDocuments: (...args: unknown[]) => mockMessageCountDocuments(...args),
  },
}));

jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockChatFindOne(...args),
  },
}));

// Marks the stored Supabase media URLs the real helper would sign: message
// images and the author's or customer's avatar.
jest.mock("@/lib/media/customer-media-read-url", () => {
  const sign = (value: unknown) =>
    typeof value === "string" && value.includes("/object/public/")
      ? `signed:${value}`
      : value;
  const signAvatar = (holder: unknown) =>
    holder && typeof holder === "object" && "avatar_url" in holder
      ? { ...holder, avatar_url: sign(holder.avatar_url) }
      : holder;
  return {
    withCustomerMediaReadUrls: async (items: Array<Record<string, unknown>>) =>
      items.map(item => ({
        ...item,
        ...("imageUrl" in item ? { imageUrl: sign(item.imageUrl) } : {}),
        ...("author" in item ? { author: signAvatar(item.author) } : {}),
        ...("user" in item ? { user: signAvatar(item.user) } : {}),
      })),
  };
});

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockUserFindOne(...args),
    find: (...args: unknown[]) => mockUserFind(...args),
  },
}));

jest.mock("@/models/whatsapp-call-session", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockWhatsAppCallSessionFind(...args),
  },
}));

jest.mock("@/models/whatsapp-call-command", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockWhatsAppCallCommandFind(...args),
  },
}));

jest.mock("@/models/scenario", () => ({
  Scenario: { find: (...args: unknown[]) => mockScenarioFind(...args) },
}));

import {
  MEDAL_FLOW_ID,
  medalTemplateForm,
  medalTemplateStep,
} from "@/lib/scenarios/__tests__/scenario-form-fixtures";
import {
  CONVERSATION_CHAT_SELECT_FIELDS,
  CONVERSATION_DETAIL_EXCLUDED_FIELDS,
  CONVERSATION_DETAIL_SELECT_FIELDS,
  GET,
  shouldCacheConversationResponse,
} from "@/app/api/conversations/[id]/route";

describe("conversation route Telegram hydration", () => {
  const selectedConversationFields: string[] = [];
  const selectedMessageFields: string[] = [];
  const selectedMessageLimits: number[] = [];
  const selectedCallSessionFields: string[] = [];
  const selectedCallCommandFields: string[] = [];

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  function readQuery<T>(rows: Promise<T[]> | (() => Promise<T[]>)) {
    const query = {
      sort: () => query,
      skip: () => query,
      limit: () => query,
      select: () => query,
      lean: () => query,
      exec: () => (typeof rows === "function" ? rows() : rows),
    };
    return query;
  }

  function mockConversationDocument(
    channel: "telegram" | "whatsapp",
    lastInboundAt?: Date
  ) {
    mockConversationFindById.mockReturnValue({
      select: (fields: string) => {
        selectedConversationFields.push(fields);
        return {
          lean: () => ({
            exec: async () => ({
              _id: "507f1f77bcf86cd799439011",
              workspaceId: "ws_1",
              chat: "tg_-1001_source-1",
              user: 777001,
              channel,
              ...(fields.split(/\s+/).includes("last_inbound_at")
                ? { last_inbound_at: lastInboundAt }
                : {}),
              messages: [],
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            }),
          }),
        };
      },
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockMembershipRead.mockReset();
    mockCacheGet.mockReset();
    mockCacheReadWithStatus.mockReset();
    mockCacheSet.mockReset();
    mockAfter.mockReset();
    mockCacheMemoryEnabled = false;
    mockGetUserProfilesByIds.mockReset();
    selectedConversationFields.length = 0;
    selectedMessageFields.length = 0;
    selectedMessageLimits.length = 0;
    selectedCallSessionFields.length = 0;
    selectedCallCommandFields.length = 0;
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: "agent_1" } } });
    mockCreateRequestLogger.mockReturnValue({
      success: mockRequestLogSuccess,
      error: mockRequestLogError,
    });
    mockMembershipRead.mockResolvedValue({
      data: [
        { user_id: "agent_1", workspace_id: "ws_1", users: null, email: null },
      ],
      error: null,
    });
    mockCacheGet.mockResolvedValue(null);
    mockCacheReadWithStatus.mockImplementation(async (...args: unknown[]) => {
      const value = await mockCacheGet(...args);
      return value === null ? { status: "miss" } : { status: "hit", value };
    });
    mockCacheSet.mockResolvedValue(undefined);
    mockGetUserProfilesByIds.mockResolvedValue(new Map());
    mockConnectDb.mockResolvedValue(undefined);
    mockGetWorkspaceFeatureFlags.mockResolvedValue({
      customer_identity: false,
      customer_behavioral_profile: false,
    });
    mockGetCompanyConversationVisibilityGate.mockResolvedValue({
      visibleConversationIds: ["507f1f77bcf86cd799439011"],
    });
    mockIsConversationVisibleForPlan.mockReturnValue(true);
    mockBuildCompanyConversationVisibilityExceededResponse.mockReturnValue(
      Response.json(
        {
          error: "Plan limit exceeded",
          code: "company_conversation_visibility_exceeded",
        },
        { status: 402 }
      )
    );
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(null);

    mockConversationDocument("telegram");

    mockMessageFind.mockReturnValue({
      sort: () => ({
        skip: () => ({
          limit: (limit: number) => {
            selectedMessageLimits.push(limit);
            return {
              select: (fields: string) => {
                selectedMessageFields.push(fields);
                return {
                  lean: () => ({
                    exec: async () => [
                      {
                        _id: "msg_1",
                        text: "Hello from the group",
                        date: new Date("2026-01-01T00:05:00.000Z"),
                        direction: "inbound",
                        conversation: "507f1f77bcf86cd799439011",
                        author: 777001,
                        telegramMeta: {
                          senderDisplayName: "Alice",
                          messageThreadId: 42,
                        },
                      },
                    ],
                  }),
                };
              },
            };
          },
        }),
      }),
    });

    mockMessageCountDocuments.mockReturnValue({
      exec: async () => 1,
    });

    mockChatFindOne.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: "tg_-1001_source-1",
          type: "supergroup",
          title: "Support war room",
          sourceId: "source-1",
          is_forum: true,
        }),
      }),
    });

    mockUserFindOne.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: 777001,
          firstName: "Alice",
          username: "alice_ops",
          avatar_url: "https://example.com/alice.png",
        }),
      }),
    });

    mockUserFind.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: async () => [
            {
              _id: 777001,
              firstName: "Alice",
              username: "alice_ops",
              avatar_url: "https://example.com/alice.png",
              isBot: false,
            },
          ],
        }),
      }),
    });

    mockWhatsAppCallSessionFind.mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: (fields: string) => {
            selectedCallSessionFields.push(fields);
            return {
              lean: () => ({
                exec: async () => [],
              }),
            };
          },
        }),
      }),
    });
    mockWhatsAppCallCommandFind.mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: (fields: string) => {
            selectedCallCommandFields.push(fields);
            return {
              lean: () => ({
                exec: async () => [],
              }),
            };
          },
        }),
      }),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("hydrates Telegram composite chat ids and numeric users into the response payload", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011"
      ),
      {
        params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }),
      }
    );
    const data = await response.json();

    expect(data.chat).toEqual(
      expect.objectContaining({
        _id: "tg_-1001_source-1",
        type: "supergroup",
        title: "Support war room",
        is_forum: true,
      })
    );
    expect(data.user).toEqual(
      expect.objectContaining({
        _id: "777001",
        firstName: "Alice",
        username: "alice_ops",
      })
    );
    expect(data.messages[0]).toEqual(
      expect.objectContaining({
        telegramMeta: expect.objectContaining({
          senderDisplayName: "Alice",
          messageThreadId: 42,
        }),
        author: expect.objectContaining({
          firstName: "Alice",
          username: "alice_ops",
          avatar_url: "https://example.com/alice.png",
        }),
      })
    );
  });

  it("signs stored customer media per response and caches only the stored URL", async () => {
    const stored =
      "https://project.supabase.co/storage/v1/object/public/conversation-images/telegram/ws/c/m.jpg";
    mockMessageFind.mockReturnValueOnce({
      sort: () => ({
        skip: () => ({
          limit: () => ({
            select: () => ({
              lean: () => ({
                exec: async () => [
                  {
                    _id: "msg_photo",
                    text: "[Image attachment]",
                    date: new Date("2026-01-01T00:05:00.000Z"),
                    direction: "inbound",
                    conversation: "507f1f77bcf86cd799439011",
                    author: 777001,
                    imageUrl: stored,
                    mediaType: "image",
                  },
                ],
              }),
            }),
          }),
        }),
      }),
    });

    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );
    const data = await response.json();

    expect(data.messages[0].imageUrl).toBe(`signed:${stored}`);
    const cachedMessages = mockCacheSet.mock.calls
      .map(
        call =>
          (call[1] as { messages?: Array<{ imageUrl?: string }> })?.messages
      )
      .find(Array.isArray);
    expect(cachedMessages?.[0]?.imageUrl).toBe(stored);
  });

  it("signs the customer's and the author's stored avatar per response", async () => {
    const avatar =
      "https://project.supabase.co/storage/v1/object/public/avatars/telegram/777001.jpg";
    const telegramUser = {
      _id: 777001,
      firstName: "Alice",
      username: "alice_ops",
      avatar_url: avatar,
    };
    mockUserFindOne.mockReturnValue({
      select: () => ({ lean: async () => telegramUser }),
    });
    mockUserFind.mockReturnValue({
      select: () => ({
        lean: () => ({ exec: async () => [{ ...telegramUser, isBot: false }] }),
      }),
    });

    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );
    const data = await response.json();

    expect(data.user.avatar_url).toBe(`signed:${avatar}`);
    expect(data.messages[0].author.avatar_url).toBe(`signed:${avatar}`);
    const cached = mockCacheSet.mock.calls
      .map(call => call[1] as { user?: { avatar_url?: string } })
      .find(value => value?.user);
    expect(cached?.user?.avatar_url).toBe(avatar);
  });

  it("uses an explicit conversation detail field list for the info contract", async () => {
    await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011"
      ),
      {
        params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }),
      }
    );

    const detailSelect = selectedConversationFields.find(
      fields => fields !== "_id workspaceId"
    );
    expect(detailSelect).toBeDefined();

    const selectedFields = new Set((detailSelect || "").split(/\s+/));
    for (const field of [
      "airi_context_memory",
      "engagement_metrics",
      "customer_satisfaction_comment",
      "awaiting_csat",
      "csat_timeout_closed",
      "classification.confidence",
      "classification_error",
      "internal_labels",
      "sourceId",
      "last_inbound_at",
      "last_outbound_at",
      "first_inbound_at",
      "whatsapp_opt_in",
      "followUpAudience",
      "external_thread",
      "whatsappReferral",
    ]) {
      expect(selectedFields).toContain(field);
      expect(CONVERSATION_DETAIL_SELECT_FIELDS).toContain(
        field as (typeof CONVERSATION_DETAIL_SELECT_FIELDS)[number]
      );
    }

    for (const field of CONVERSATION_DETAIL_EXCLUDED_FIELDS) {
      expect(selectedFields).not.toContain(field);
      expect(detailSelect).not.toContain(`-${field}`);
    }

    // The customer-health snapshot is no longer computed or shown.
    for (const field of [
      "health_score_snapshot",
      "health_score_factors",
      "health_scored_at",
      "health_score_version",
      "churn_risk_level",
      "estimated_customer_ltv",
      "recommended_action",
    ]) {
      expect(selectedFields).not.toContain(field);
    }
  });

  it.each([
    { cachePath: "ordinary", search: "", conversationReads: 1 },
    {
      cachePath: "workspace fast",
      search: "?workspaceId=ws_1",
      conversationReads: 0,
    },
  ])(
    "returns an access-checked cached WhatsApp detail through the $cachePath path without hydration queries",
    async ({ search, conversationReads }) => {
      mockConversationDocument("whatsapp");
      mockCacheGet.mockResolvedValueOnce({
        _id: "507f1f77bcf86cd799439011",
        workspaceId: "ws_1",
        cached: true,
      });

      const response = await GET(
        new Request(
          `http://localhost/api/conversations/507f1f77bcf86cd799439011${search}`
        ),
        {
          params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }),
        }
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(mockMembershipRead).toHaveBeenCalledTimes(1);
      expect(mockGetCompanyConversationVisibilityGate).toHaveBeenCalledTimes(1);
      expect(mockConversationFindById).toHaveBeenCalledTimes(conversationReads);
      expect(data).toEqual(
        expect.objectContaining({
          _id: "507f1f77bcf86cd799439011",
          cached: true,
        })
      );
      expect(mockMessageFind).not.toHaveBeenCalled();
      expect(mockMessageCountDocuments).not.toHaveBeenCalled();
      expect(mockChatFindOne).not.toHaveBeenCalled();
      expect(mockUserFindOne).not.toHaveBeenCalled();
      expect(mockGetWorkspaceFeatureFlags).not.toHaveBeenCalled();
      expect(mockWhatsAppCallSessionFind).not.toHaveBeenCalled();
      expect(mockWhatsAppCallCommandFind).not.toHaveBeenCalled();
    }
  );

  it("rejects hidden conversations with a plan-limit response before hydration", async () => {
    mockIsConversationVisibleForPlan.mockReturnValueOnce(false);

    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011"
      ),
      {
        params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }),
      }
    );
    const data = await response.json();

    expect(response.status).toBe(402);
    expect(data).toEqual(
      expect.objectContaining({
        code: "company_conversation_visibility_exceeded",
      })
    );
    expect(mockMessageFind).not.toHaveBeenCalled();
    expect(mockMessageCountDocuments).not.toHaveBeenCalled();
    expect(mockChatFindOne).not.toHaveBeenCalled();
    expect(mockUserFindOne).not.toHaveBeenCalled();
  });

  it("does not cache an empty first page when conversation metadata says messages exist", () => {
    expect(
      shouldCacheConversationResponse({
        page: 1,
        messagesLength: 0,
        totalMessages: 2,
        conversationMessageCount: 2,
        lastMessageAt: new Date("2026-01-01T00:00:00.000Z"),
      })
    ).toBe(false);

    expect(
      shouldCacheConversationResponse({
        page: 1,
        messagesLength: 1,
        totalMessages: 2,
        conversationMessageCount: 2,
        lastMessageAt: new Date("2026-01-01T00:00:00.000Z"),
      })
    ).toBe(true);
  });

  it("uses lightweight conversation and message fields for the chat view", async () => {
    await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat"
      ),
      {
        params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }),
      }
    );

    const chatSelect = selectedConversationFields.find(fields =>
      fields.includes("message_count")
    );
    expect(chatSelect).toBeDefined();

    const selectedFields = new Set((chatSelect || "").split(/\s+/));
    expect(selectedFields).toContain("lastMessageAt");
    expect(selectedFields).not.toContain("engagement_metrics");
    expect(selectedFields).not.toContain("customer_satisfaction_comment");
    expect(Array.from(CONVERSATION_CHAT_SELECT_FIELDS)).not.toContain(
      "engagement_metrics"
    );

    expect(selectedMessageFields[0]).toContain("imageUrl");
    expect(selectedMessageFields[0]).not.toContain("imageAnalysis");
    expect(selectedMessageFields[0]).not.toContain("audioAnalysis");
    expect(selectedMessageFields[0]).not.toContain("videoAnalysis");
    expect(mockGetWorkspaceFeatureFlags).not.toHaveBeenCalled();
  });

  it.each([
    { hoursAgo: 1, isWithinWindow: true },
    { hoursAgo: 25, isWithinWindow: false },
  ])(
    "uses the saved inbound timestamp for a $hoursAgo-hour-old chat without reloading it",
    async ({ hoursAgo, isWithinWindow }) => {
      const lastInboundAt = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
      mockConversationDocument("whatsapp", lastInboundAt);

      const response = await GET(
        new Request(
          "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat"
        ),
        { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.messaging_window.windowInfo).toMatchObject({
        isWithinWindow,
        lastCustomerMessageAt: lastInboundAt.toISOString(),
      });
      expect(mockConversationFindById).toHaveBeenCalledTimes(1);
    }
  );

  it("selects and returns WhatsApp commerce context for message rendering", async () => {
    mockMessageFind.mockReturnValueOnce({
      sort: () => ({
        skip: () => ({
          limit: (limit: number) => {
            selectedMessageLimits.push(limit);
            return {
              select: (fields: string) => {
                selectedMessageFields.push(fields);
                return {
                  lean: () => ({
                    exec: async () => [
                      {
                        _id: "msg_order_1",
                        text: "[WhatsApp order: 2 items, 20.00 USD]",
                        date: new Date("2026-01-01T00:05:00.000Z"),
                        direction: "inbound",
                        conversation: "507f1f77bcf86cd799439011",
                        author: 777001,
                        whatsappOrder: {
                          catalogId: "catalog-1",
                          text: "Please deliver today",
                          productItems: [
                            {
                              productRetailerId: "sku-1",
                              quantity: 2,
                              itemPrice: 10,
                              currency: "USD",
                            },
                          ],
                          totalQuantity: 2,
                          totalAmount: 20,
                          currency: "USD",
                        },
                        whatsappProductInquiry: {
                          catalogId: "catalog-1",
                          productRetailerId: "sku-1",
                          contextMessageId: "wamid.product",
                        },
                      },
                    ],
                  }),
                };
              },
            };
          },
        }),
      }),
    });

    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat"
      ),
      {
        params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }),
      }
    );
    const data = await response.json();

    expect(selectedMessageFields[0]).toContain("whatsappOrder");
    expect(selectedMessageFields[0]).toContain("whatsappProductInquiry");
    expect(data.messages[0]).toEqual(
      expect.objectContaining({
        whatsappOrder: expect.objectContaining({
          catalogId: "catalog-1",
          totalQuantity: 2,
          totalAmount: 20,
          currency: "USD",
        }),
        whatsappProductInquiry: expect.objectContaining({
          productRetailerId: "sku-1",
        }),
      })
    );
  });

  it("labels a scenario form send that stored no fields from its step's saved form", async () => {
    const scenarioId = "65f000000000000000000001";
    mockConversationDocument("whatsapp");
    mockMessageFind.mockReturnValueOnce({
      sort: () => ({
        skip: () => ({
          limit: () => ({
            select: () => ({
              lean: () => ({
                exec: async () => [
                  {
                    _id: "msg_medal",
                    text: "[Template: medal_pick_1]",
                    date: new Date("2026-01-01T00:05:00.000Z"),
                    direction: "outbound",
                    conversation: "507f1f77bcf86cd799439011",
                    whatsappFlow: {
                      flowId: MEDAL_FLOW_ID,
                      scenarioId,
                      actionNodeId: "medal-pick",
                      responseFieldMetadata: null,
                    },
                  },
                ],
              }),
            }),
          }),
        }),
      }),
    });
    mockScenarioFind.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: async () => [
            {
              _id: scenarioId,
              nodes: [
                {
                  id: "medal-pick",
                  data: medalTemplateStep({
                    actionWhatsAppTemplateForm: medalTemplateForm(),
                  }),
                },
              ],
            },
          ],
        }),
      }),
    });

    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat"
      ),
      {
        params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }),
      }
    );
    const data = await response.json();

    expect(mockScenarioFind).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      _id: { $in: [scenarioId] },
    });
    const metadata = data.messages[0].whatsappFlow.responseFieldMetadata;
    expect(metadata.map((field: { id: string }) => field.id)).toEqual([
      "__9ba1c9",
      "____133f36",
      "_68d224",
      "_ebfcfb",
      "other_sport",
    ]);
    expect(metadata[1]).toEqual(
      expect.objectContaining({
        id: "____133f36",
        label: "Design",
        options: [
          { id: "0_Есімі_жазылатын_(Именная)", title: "Personalised" },
          { id: "1_Классикалық", title: "Classic" },
        ],
        fieldType: "RadioButtonsGroup",
      })
    );
  });

  it("labels a send only with a saved form of the Flow it sent", async () => {
    const scenarioId = "65f000000000000000000001";
    const sendOf = (_id: string, flowId: string) => ({
      _id,
      text: "[Template: medal_pick_1]",
      date: new Date("2026-01-01T00:05:00.000Z"),
      direction: "outbound",
      conversation: "507f1f77bcf86cd799439011",
      whatsappFlow: {
        flowId,
        scenarioId,
        actionNodeId: "medal-pick",
        responseFieldMetadata: null,
      },
    });
    mockConversationDocument("whatsapp");
    mockMessageFind.mockReturnValueOnce({
      sort: () => ({
        skip: () => ({
          limit: () => ({
            select: () => ({
              lean: () => ({
                exec: async () => [
                  sendOf("msg_medal", MEDAL_FLOW_ID),
                  sendOf("msg_other", "1571793974235171"),
                ],
              }),
            }),
          }),
        }),
      }),
    });
    mockScenarioFind.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: async () => [
            {
              _id: scenarioId,
              nodes: [
                {
                  id: "medal-pick",
                  data: medalTemplateStep({
                    actionWhatsAppTemplateForm: medalTemplateForm(),
                  }),
                },
              ],
            },
          ],
        }),
      }),
    });

    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat"
      ),
      {
        params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }),
      }
    );
    const data = await response.json();
    const flowOf = (id: string) =>
      data.messages.find((message: { _id: string }) => message._id === id)
        .whatsappFlow;

    expect(
      flowOf("msg_medal").responseFieldMetadata.map(
        (field: { id: string }) => field.id
      )
    ).toEqual(["__9ba1c9", "____133f36", "_68d224", "_ebfcfb", "other_sport"]);
    // A send of another Flow keeps its answers' own keys as labels.
    expect(flowOf("msg_other")).toEqual(
      expect.objectContaining({
        flowId: "1571793974235171",
        responseFieldMetadata: null,
      })
    );
  });

  it("includes recent WhatsApp call sessions in chat view responses", async () => {
    mockConversationDocument("whatsapp");
    mockWhatsAppCallSessionFind.mockReturnValueOnce({
      sort: (sort: unknown) => ({
        limit: (limit: number) => ({
          select: (fields: string) => {
            selectedCallSessionFields.push(fields);
            return {
              lean: () => ({
                exec: async () => [
                  {
                    _id: "call_session_1",
                    callId: "wacid.1",
                    state: "incoming",
                    direction: "USER_INITIATED",
                    phoneNumberId: "phone-1",
                    contactName: "Alice",
                    lastProviderUpdateAt: new Date("2026-02-02T02:40:00.000Z"),
                    createdAt: new Date("2026-02-02T02:39:00.000Z"),
                    updatedAt: new Date("2026-02-02T02:40:00.000Z"),
                    sort,
                    limit,
                  },
                ],
              }),
            };
          },
        }),
      }),
    });
    mockWhatsAppCallCommandFind.mockReturnValueOnce({
      sort: (sort: unknown) => ({
        limit: (limit: number) => ({
          select: (fields: string) => {
            selectedCallCommandFields.push(fields);
            return {
              lean: () => ({
                exec: async () => [
                  {
                    _id: "call_command_1",
                    callSessionId: "call_session_1",
                    action: "accept",
                    status: "pending",
                    correlationId: "corr_1",
                    providerError: null,
                    createdAt: new Date("2026-02-02T02:41:00.000Z"),
                    sort,
                    limit,
                  },
                ],
              }),
            };
          },
        }),
      }),
    });

    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat"
      ),
      {
        params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }),
      }
    );
    const data = await response.json();

    expect(mockWhatsAppCallSessionFind).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      conversationId: "507f1f77bcf86cd799439011",
    });
    expect(selectedCallSessionFields[0]).toContain("state");
    expect(selectedCallSessionFields[0]).toContain("lastProviderUpdateAt");
    expect(mockWhatsAppCallCommandFind).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      callSessionId: { $in: ["call_session_1"] },
    });
    expect(selectedCallCommandFields[0]).toContain("providerError");
    expect(data.whatsapp_call_sessions).toEqual([
      expect.objectContaining({
        _id: "call_session_1",
        callId: "wacid.1",
        state: "incoming",
        direction: "USER_INITIATED",
        phoneNumberId: "phone-1",
        contactName: "Alice",
        latestCommand: expect.objectContaining({
          id: "call_command_1",
          callSessionId: "call_session_1",
          action: "accept",
          status: "pending",
          correlationId: "corr_1",
        }),
      }),
    ]);
  });

  it("checks the authorized plan while the ordinary cache read is pending", async () => {
    const cached = deferred<unknown>();
    const plan = deferred<{ visibleConversationIds: string[] }>();
    mockCacheGet.mockReturnValueOnce(cached.promise);
    mockGetCompanyConversationVisibilityGate.mockReturnValueOnce(plan.promise);
    let settled = false;
    const responsePromise = GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    ).then(response => {
      settled = true;
      return response;
    });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(mockGetCompanyConversationVisibilityGate).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(mockMessageFind).not.toHaveBeenCalled();
      plan.resolve({ visibleConversationIds: ["507f1f77bcf86cd799439011"] });
      cached.resolve({ messages: [{ text: "cached message" }] });
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        messages: [{ text: "cached message" }],
      });
      expect(mockMessageFind).not.toHaveBeenCalled();
    } finally {
      plan.resolve({ visibleConversationIds: [] });
      cached.resolve(null);
      await responsePromise;
    }
  });

  it("hydrates message authors while independent chat metadata is pending", async () => {
    const chat = deferred<unknown>();
    mockChatFindOne.mockReturnValueOnce({
      select: () => ({ lean: () => chat.promise }),
    });
    let settled = false;
    const responsePromise = GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    ).then(response => {
      settled = true;
      return response;
    });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(mockUserFind).toHaveBeenCalledWith({ _id: { $in: [777001] } });
      expect(settled).toBe(false);
      chat.resolve({ _id: "tg_-1001_source-1", title: "Support" });
      const response = await responsePromise;
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.messages[0].author.firstName).toBe("Alice");
      expect(payload.chat.title).toBe("Support");
    } finally {
      chat.resolve(null);
      await responsePromise;
    }
  });

  it("preserves the chat-reference fallback when its lookup fails during message hydration", async () => {
    const messages = deferred<unknown[]>();
    const chat = deferred<unknown>();
    mockMessageFind.mockReturnValueOnce(readQuery(messages.promise));
    mockChatFindOne.mockReturnValueOnce({
      select: () => ({ lean: () => chat.promise }),
    });
    const responsePromise = GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      chat.reject(new Error("chat_lookup_failed"));
      await new Promise<void>(resolve => setImmediate(resolve));
      messages.resolve([]);
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect((await response.json()).chat).toBe("tg_-1001_source-1");
    } finally {
      chat.resolve(null);
      messages.resolve([]);
      await responsePromise;
    }
  });

  it("loads authorized call history before messages finish without blocking message hydration", async () => {
    mockConversationDocument("whatsapp", new Date());
    const membership = deferred<{ data: { user_id: string }[] }>();
    const planGate = deferred<{ visibleConversationIds: string[] }>();
    const messages = deferred<unknown[]>();
    const sessions = deferred<unknown[]>();
    const commands = deferred<unknown[]>();
    mockMembershipRead.mockReturnValue(membership.promise);
    mockGetCompanyConversationVisibilityGate.mockReturnValue(planGate.promise);
    mockMessageFind.mockReturnValue(readQuery(messages.promise));
    mockWhatsAppCallSessionFind.mockReturnValue(readQuery(sessions.promise));
    mockWhatsAppCallCommandFind.mockReturnValue(readQuery(commands.promise));
    let settled = false;
    const responsePromise = GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    ).then(response => {
      settled = true;
      return response;
    });
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));

    try {
      await flush();
      expect(mockWhatsAppCallSessionFind).not.toHaveBeenCalled();
      membership.resolve({ data: [{ user_id: "agent_1" }] });
      await flush();
      expect(mockWhatsAppCallSessionFind).not.toHaveBeenCalled();

      planGate.resolve({
        visibleConversationIds: ["507f1f77bcf86cd799439011"],
      });
      await flush();
      expect(mockMessageFind).toHaveBeenCalled();
      expect(mockWhatsAppCallSessionFind).toHaveBeenCalledWith({
        workspaceId: "ws_1",
        conversationId: "507f1f77bcf86cd799439011",
      });
      expect(mockWhatsAppCallCommandFind).not.toHaveBeenCalled();

      sessions.resolve([
        { _id: "call_session_1", callId: "wacid.1", state: "incoming" },
      ]);
      await flush();
      expect(mockWhatsAppCallCommandFind).toHaveBeenCalledWith({
        workspaceId: "ws_1",
        callSessionId: { $in: ["call_session_1"] },
      });
      expect(settled).toBe(false);

      messages.resolve([
        { _id: "msg_1", text: "Hello", date: new Date(), author: 777001 },
      ]);
      await flush();
      expect(mockUserFind).toHaveBeenCalledWith({ _id: { $in: [777001] } });
      expect(settled).toBe(false);

      commands.resolve([
        {
          _id: "call_command_1",
          callSessionId: "call_session_1",
          action: "accept",
          status: "pending",
        },
      ]);
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect((await response.json()).whatsapp_call_sessions[0]).toMatchObject({
        _id: "call_session_1",
        latestCommand: { id: "call_command_1", status: "pending" },
      });
    } finally {
      membership.resolve({ data: [{ user_id: "agent_1" }] });
      planGate.resolve({
        visibleConversationIds: ["507f1f77bcf86cd799439011"],
      });
      messages.resolve([]);
      sessions.resolve([]);
      commands.resolve([]);
      await responsePromise;
    }
  });

  it.each(["sessions", "commands"])(
    "returns a call-history %s failure even when messages are still loading",
    async failure => {
      mockConversationDocument("whatsapp", new Date());
      const messages = deferred<unknown[]>();
      mockMessageFind.mockReturnValue(readQuery(messages.promise));
      mockWhatsAppCallSessionFind.mockReturnValue(
        readQuery(Promise.resolve([{ _id: "call_session_1" }]))
      );
      (failure === "sessions"
        ? mockWhatsAppCallSessionFind
        : mockWhatsAppCallCommandFind
      ).mockReturnValue(
        readQuery(async () => {
          throw new Error("call_history_failed");
        })
      );

      const responsePromise = GET(
        new Request(
          "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat"
        ),
        { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
      );
      await new Promise<void>(resolve => setImmediate(resolve));
      messages.resolve([]);
      const response = await responsePromise;
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "call_history_failed" });
      expect(mockCacheSet).not.toHaveBeenCalled();
    }
  );

  it.each([
    { gate: "access", status: 403 },
    { gate: "plan", status: 402 },
  ])(
    "does not load call history when the $gate gate denies access",
    async ({ gate, status }) => {
      mockConversationDocument("whatsapp", new Date());
      if (gate === "access") mockMembershipRead.mockResolvedValue({ data: [] });
      else mockIsConversationVisibleForPlan.mockReturnValue(false);

      const response = await GET(
        new Request(
          "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat"
        ),
        { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
      );
      expect(response.status).toBe(status);
      expect(mockWhatsAppCallSessionFind).not.toHaveBeenCalled();
      expect(mockWhatsAppCallCommandFind).not.toHaveBeenCalled();
    }
  );

  it("does not load WhatsApp call sessions for Telegram chat view responses", async () => {
    await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat"
      ),
      {
        params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }),
      }
    );

    expect(mockWhatsAppCallSessionFind).not.toHaveBeenCalled();
    expect(mockWhatsAppCallCommandFind).not.toHaveBeenCalled();
  });

  it("does not load call sessions for WhatsApp message-only pagination", async () => {
    mockConversationDocument("whatsapp");
    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?messagesOnly=1&page=2"
      ),
      {
        params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }),
      }
    );

    expect(response.status).toBe(200);
    expect(Object.keys(await response.json()).sort()).toEqual([
      "message_pagination",
      "messages",
    ]);
    expect(mockWhatsAppCallSessionFind).not.toHaveBeenCalled();
    expect(mockWhatsAppCallCommandFind).not.toHaveBeenCalled();
  });

  it("honors a one-message full view request for fast info drawer hydration", async () => {
    await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=full&limit=1"
      ),
      {
        params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }),
      }
    );

    expect(selectedMessageLimits[0]).toBe(2);
    // Media analysis is not rendered by any inbox or mobile view.
    expect(selectedMessageFields[0]).not.toContain("imageAnalysis");
  });

  it("does not load call sessions for the WhatsApp info view", async () => {
    mockConversationDocument("whatsapp");

    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=full&limit=1"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );

    expect(response.status).toBe(200);
    expect((await response.json()).whatsapp_call_sessions).toEqual([]);
    expect(mockWhatsAppCallSessionFind).not.toHaveBeenCalled();
  });

  it("selects the channel and message counters for message-only pages", async () => {
    await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?messagesOnly=1&page=2"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );

    // channel drives WhatsApp Flow enrichment on later pages; the counters
    // keep an empty first page out of the cache.
    expect(selectedConversationFields[0].split(/\s+/)).toEqual(
      expect.arrayContaining([
        "workspaceId",
        "channel",
        "message_count",
        "lastMessageAt",
      ])
    );
  });

  it("emits one allowlisted completion event without request or conversation contents", async () => {
    const request = new Request(
      "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&page=1&limit=30&workspaceId=ws_1&secret=private-query",
      { headers: { authorization: "private-token", cookie: "private-cookie" } }
    );
    const response = await GET(request, {
      params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }),
    });

    expect(response.status).toBe(200);
    expect(mockCreateRequestLogger).toHaveBeenCalledWith(
      "api.conversations.detail",
      request,
      { route: "/api/conversations/[id]" }
    );
    expect(mockRequestLogSuccess).toHaveBeenCalledTimes(1);
    expect(mockRequestLogError).not.toHaveBeenCalled();
    const [name, event] = mockRequestLogSuccess.mock.calls[0];
    expect(name).toBe("Conversation detail completed");
    expect(event).toMatchObject({
      statusCode: 200,
      outcome: "success",
      page: 1,
      limit: 30,
      view: "chat",
      messagesOnly: false,
      messageCount: 1,
      cachePath: "workspace_miss",
      fastCacheReadStatus: "miss",
      durationMs: expect.any(Number),
      stageTimings: {
        auth: { outcome: "success", durationMs: expect.any(Number) },
        access: { outcome: "success", durationMs: expect.any(Number) },
        plan_gate: { outcome: "success", durationMs: expect.any(Number) },
        messages: { outcome: "success", durationMs: expect.any(Number) },
        cache_write: { outcome: "pending", durationMs: expect.any(Number) },
      },
    });
    const serialized = JSON.stringify(event);
    for (const privateValue of [
      "private-query",
      "private-token",
      "private-cookie",
      "ws_1",
      "507f1f77bcf86cd799439011",
      "Alice",
      "alice_ops",
      "Hello from the group",
      "https://example.com/alice.png",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(Object.keys(event).sort()).toEqual([
      "cachePath",
      "durationMs",
      "fastCacheReadStatus",
      "limit",
      "messageCount",
      "messagesOnly",
      "outcome",
      "page",
      "stageTimings",
      "statusCode",
      "view",
    ]);
  });

  it.each([
    { search: "", cachePath: "ordinary_hit" },
    { search: "?workspaceId=ws_1", cachePath: "workspace_hit" },
  ])(
    "logs $cachePath only after its access and plan checks",
    async ({ search, cachePath }) => {
      const cached = {
        messages: [{ text: "private-cached-text" }],
        cached: true,
      };
      mockCacheGet.mockResolvedValueOnce(cached);
      const response = await GET(
        new Request(
          `http://localhost/api/conversations/507f1f77bcf86cd799439011${search}`
        ),
        { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
      );
      expect(await response.json()).toEqual(cached);
      expect(mockRequestLogSuccess).toHaveBeenCalledTimes(1);
      expect(mockRequestLogSuccess.mock.calls[0][1]).toMatchObject({
        cachePath,
        statusCode: 200,
        messageCount: 1,
        outcome: "success",
      });
      expect(mockRequestLogSuccess.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockIsConversationVisibleForPlan.mock.invocationCallOrder[0]
      );
      expect(mockMessageFind).not.toHaveBeenCalled();
      expect(
        JSON.stringify(mockRequestLogSuccess.mock.calls[0][1])
      ).not.toContain("private-cached-text");
    }
  );

  it.each([
    { failure: "auth", status: 401, outcome: "denied", reason: "auth_failed" },
    { failure: "id", status: 404, outcome: "not_found", reason: "invalid_id" },
    {
      failure: "membership",
      status: 403,
      outcome: "denied",
      reason: "workspace_access_denied",
    },
    {
      failure: "plan",
      status: 402,
      outcome: "denied",
      reason: "plan_visibility_denied",
    },
  ])(
    "logs one completion for $failure failure",
    async ({ failure, status, outcome, reason }) => {
      if (failure === "auth")
        mockAuthGetUser.mockResolvedValue({ data: { user: null } });
      if (failure === "membership")
        mockMembershipRead.mockResolvedValue({ data: [] });
      if (failure === "plan")
        mockIsConversationVisibleForPlan.mockReturnValue(false);
      const response = await GET(
        new Request(
          "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat"
        ),
        {
          params: Promise.resolve({
            id: failure === "id" ? "invalid-id" : "507f1f77bcf86cd799439011",
          }),
        }
      );
      expect(response.status).toBe(status);
      expect(mockRequestLogSuccess).toHaveBeenCalledTimes(1);
      expect(mockRequestLogError).not.toHaveBeenCalled();
      expect(mockRequestLogSuccess.mock.calls[0][1]).toMatchObject({
        statusCode: status,
        outcome,
        denialReason: reason,
      });
    }
  );

  it("logs query failures without logging exception contents", async () => {
    mockConnectDb.mockRejectedValue(new Error("private-database-uri"));
    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "private-database-uri" });
    expect(mockRequestLogSuccess).not.toHaveBeenCalled();
    expect(mockRequestLogError).toHaveBeenCalledTimes(1);
    expect(mockRequestLogError.mock.calls[0][1]).toBeUndefined();
    expect(mockRequestLogError.mock.calls[0][2]).toMatchObject({
      statusCode: 500,
      outcome: "error",
      stageTimings: {
        mongo_connect: { outcome: "error", durationMs: expect.any(Number) },
      },
    });
    expect(JSON.stringify(mockRequestLogError.mock.calls)).not.toContain(
      "private-database-uri"
    );
  });

  it("preserves thrown failures before the existing response error boundary", async () => {
    const authFailure = new Error("private-auth-provider-url");
    mockAuthGetUser.mockRejectedValue(authFailure);
    await expect(
      GET(
        new Request(
          "http://localhost/api/conversations/507f1f77bcf86cd799439011"
        ),
        { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
      )
    ).rejects.toBe(authFailure);
    expect(mockRequestLogSuccess).not.toHaveBeenCalled();
    expect(mockRequestLogError).toHaveBeenCalledTimes(1);
    expect(mockRequestLogError.mock.calls[0][2]).toMatchObject({
      outcome: "error",
      statusCode: 500,
      stageTimings: {
        auth: { outcome: "error", durationMs: expect.any(Number) },
      },
    });
    expect(JSON.stringify(mockRequestLogError.mock.calls)).not.toContain(
      authFailure.message
    );
  });

  it("preserves canonical access fallback after a fast-cache membership mismatch", async () => {
    mockCacheGet.mockResolvedValueOnce({ messages: [], cached: true });
    mockMembershipRead.mockResolvedValueOnce({ data: [] });
    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=wrong_workspace"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );
    expect(response.status).toBe(200);
    expect((await response.json()).messages).toHaveLength(1);
    expect(mockMembershipRead).toHaveBeenCalledTimes(2);
    expect(mockRequestLogSuccess).toHaveBeenCalledTimes(1);
    expect(mockRequestLogSuccess.mock.calls[0][1]).toMatchObject({
      cachePath: "ordinary_miss",
      stageTimings: {
        fast_access: { outcome: "success", durationMs: expect.any(Number) },
        access: { outcome: "success", durationMs: expect.any(Number) },
      },
    });
  });

  it("snapshots unfinished early queries honestly when access denies the request", async () => {
    const messages = deferred<unknown[]>();
    mockMessageFind.mockReturnValue(readQuery(messages.promise));
    mockMembershipRead.mockResolvedValue({ data: [] });
    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );
    expect(response.status).toBe(403);
    const event = mockRequestLogSuccess.mock.calls[0][1];
    expect(event.stageTimings.messages).toMatchObject({
      outcome: "pending",
      durationMs: expect.any(Number),
    });
    messages.resolve([]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(event.stageTimings.messages.outcome).toBe("pending");
    expect(mockRequestLogSuccess).toHaveBeenCalledTimes(1);
  });

  it("times overlapping queries from their start without delaying them", async () => {
    const messages = deferred<unknown[]>();
    const conversation = deferred<unknown>();
    let elapsed = 0;
    const clock = jest
      .spyOn(performance, "now")
      .mockImplementation(() => elapsed);
    mockMessageFind.mockReturnValue(readQuery(messages.promise));
    mockConversationFindById.mockReturnValue({
      select: () => ({ lean: () => ({ exec: () => conversation.promise }) }),
    });
    const responsePromise = GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );
    const flush = () => new Promise<void>(resolve => setImmediate(resolve));
    try {
      await flush();
      expect(mockMessageFind).toHaveBeenCalledTimes(1);
      expect(mockRequestLogSuccess).not.toHaveBeenCalled();
      elapsed = 20;
      messages.resolve([]);
      await flush();
      elapsed = 50;
      conversation.resolve({
        _id: "507f1f77bcf86cd799439011",
        workspaceId: "ws_1",
        channel: "telegram",
      });
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(mockRequestLogSuccess).toHaveBeenCalledTimes(1);
      expect(mockRequestLogSuccess.mock.calls[0][1]).toMatchObject({
        durationMs: 50,
        stageTimings: {
          messages: { outcome: "success", durationMs: 20 },
          conversation: { outcome: "success", durationMs: 50 },
        },
      });
    } finally {
      messages.resolve([]);
      conversation.resolve(null);
      await responsePromise;
      clock.mockRestore();
    }
  });

  it.each([220, 450])(
    "serves a healthy %i ms cache hit with its rich payload and no Mongo hydration",
    async latency => {
      jest.useFakeTimers();
      const cached = {
        messages: [
          {
            _id: "recent_outbound",
            direction: "outbound",
            text: "Recent real message",
            delivery: { status: "delivered" },
            mediaType: "image",
            imageUrl: "/recent.png",
          },
        ],
        message_pagination: { page: 1, limit: 30, has_more: true, total: 91 },
      };
      mockCacheGet.mockImplementationOnce(
        () => new Promise(resolve => setTimeout(() => resolve(cached), latency))
      );
      const responsePromise = GET(
        new Request(
          "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
        ),
        { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
      );
      await jest.advanceTimersByTimeAsync(latency - 1);
      expect(mockConnectDb).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(cached);
      expect(mockConnectDb).not.toHaveBeenCalled();
      expect(mockMessageFind).not.toHaveBeenCalled();
      expect(mockMembershipRead).toHaveBeenCalledTimes(1);
      expect(mockRequestLogSuccess.mock.calls[0][1]).toMatchObject({
        cachePath: "workspace_hit",
        fastCacheReadStatus: "hit",
      });
    }
  );

  it("bounds a stalled cache read at 550 ms and reports timeout instead of a confirmed miss", async () => {
    jest.useFakeTimers();
    mockCacheReadWithStatus.mockReturnValueOnce(new Promise(() => undefined));
    const responsePromise = GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );
    await jest.advanceTimersByTimeAsync(549);
    expect(mockConnectDb).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect((await responsePromise).status).toBe(200);
    expect(mockRequestLogSuccess.mock.calls[0][1]).toMatchObject({
      cachePath: "workspace_miss",
      fastCacheReadStatus: "timeout",
    });
  });

  it.each(["miss", "unavailable"])(
    "reports a confirmed cache %s without holding canonical messages",
    async status => {
      mockCacheReadWithStatus.mockResolvedValueOnce({ status });
      const response = await GET(
        new Request(
          "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
        ),
        { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
      );
      expect(response.status).toBe(200);
      expect((await response.json()).messages).toHaveLength(1);
      expect(mockRequestLogSuccess.mock.calls[0][1].fastCacheReadStatus).toBe(
        status
      );
    }
  );

  it("preserves the existing cache.get development memory fallback", async () => {
    mockCacheMemoryEnabled = true;
    const cached = {
      messages: [{ _id: "dev_recent", direction: "outbound" }],
      message_pagination: { page: 1, limit: 30, has_more: false },
    };
    mockCacheGet.mockResolvedValueOnce(cached);
    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );
    expect(await response.json()).toEqual(cached);
    expect(mockCacheGet).toHaveBeenCalledTimes(1);
    expect(mockCacheReadWithStatus).not.toHaveBeenCalled();
    expect(mockConnectDb).not.toHaveBeenCalled();
    expect(mockRequestLogSuccess.mock.calls[0][1]).toMatchObject({
      cachePath: "workspace_hit",
      fastCacheReadStatus: "hit",
    });
  });

  it("preserves the raw fast-cache membership rejection boundary", async () => {
    const failure = new Error("fast_membership_rejected");
    mockCacheGet.mockResolvedValueOnce({ messages: [], cached: true });
    mockMembershipRead.mockRejectedValueOnce(failure);
    await expect(
      GET(
        new Request(
          "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
        ),
        { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
      )
    ).rejects.toBe(failure);
    expect(mockMembershipRead).toHaveBeenCalledTimes(1);
    expect(mockConnectDb).not.toHaveBeenCalled();
    expect(mockGetCompanyConversationVisibilityGate).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockRequestLogError).toHaveBeenCalledTimes(1);
    expect(mockRequestLogError.mock.calls[0][2]).toMatchObject({
      statusCode: 500,
      outcome: "error",
      stageTimings: { fast_access: { outcome: "error" } },
    });
    expect(JSON.stringify(mockRequestLogError.mock.calls)).not.toContain(
      failure.message
    );
  });

  it("preserves canonical fallback for a fast-cache PostgREST membership error", async () => {
    mockCacheGet.mockResolvedValueOnce({ messages: [], cached: true });
    mockMembershipRead.mockResolvedValueOnce({
      data: [],
      error: { message: "fast_membership_error" },
    });
    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );
    expect(response.status).toBe(200);
    expect((await response.json()).messages).toHaveLength(1);
    expect(mockMembershipRead).toHaveBeenCalledTimes(2);
    expect(mockConnectDb).toHaveBeenCalledTimes(1);
    expect(mockRequestLogSuccess.mock.calls[0][1].cachePath).toBe(
      "ordinary_miss"
    );
  });

  it("answers while the actual cache SET remains retained by after", async () => {
    jest.useFakeTimers();
    const write = deferred<void>();
    mockCacheSet.mockReturnValueOnce(write.promise);
    let answered = false;
    const responsePromise = GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    ).then(response => {
      answered = true;
      return response;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(answered).toBe(true);
    expect((await responsePromise).status).toBe(200);
    expect(mockAfter).toHaveBeenCalledTimes(1);
    const retained = mockAfter.mock.calls[0][0] as Promise<unknown>;
    let retainedSettled = false;
    void retained.then(() => {
      retainedSettled = true;
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(retainedSettled).toBe(false);
    write.resolve();
    await retained;
    expect(retainedSettled).toBe(true);
    expect(mockCacheSet.mock.calls[0][2]).toBe(15);
    expect(
      mockRequestLogSuccess.mock.calls[0][1].stageTimings.cache_write.outcome
    ).toBe("pending");
  });

  it("owns a later cache SET rejection without changing the answered response", async () => {
    const write = deferred<void>();
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    mockCacheSet.mockReturnValueOnce(write.promise);
    try {
      const response = await GET(
        new Request(
          "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
        ),
        { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
      );
      expect(response.status).toBe(200);
      expect((await response.json()).messages).toHaveLength(1);
      const retained = mockAfter.mock.calls[0][0] as Promise<unknown>;
      write.reject(new Error("cache_write_rejected"));
      await expect(retained).resolves.toBeUndefined();
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(mockRequestLogSuccess).toHaveBeenCalledTimes(1);
      expect(mockRequestLogError).not.toHaveBeenCalled();
      expect(
        mockRequestLogSuccess.mock.calls[0][1].stageTimings.cache_write.outcome
      ).toBe("pending");
    } finally {
      write.resolve();
      errorLog.mockRestore();
    }
  });

  it("keeps cache SET failure owned if after registration is unavailable", async () => {
    const write = deferred<void>();
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    mockCacheSet.mockReturnValueOnce(write.promise);
    mockAfter.mockImplementationOnce(() => {
      throw new Error("outside_request_scope");
    });
    try {
      const response = await GET(
        new Request(
          "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
        ),
        { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
      );
      expect(response.status).toBe(200);
      const writePromise = mockAfter.mock.calls[0][0] as Promise<unknown>;
      write.reject(new Error("cache_write_rejected"));
      await expect(writePromise).resolves.toBeUndefined();
      expect(mockCacheSet).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(mockRequestLogSuccess).toHaveBeenCalledTimes(1);
      expect(mockRequestLogError).not.toHaveBeenCalled();
    } finally {
      write.resolve();
      errorLog.mockRestore();
    }
  });

  it.each(["chat", "messagesOnly"])(
    "starts matching %s membership before slow Mongo and reuses the verified lookup",
    async view => {
      const connect = deferred<void>();
      const membership = deferred<{
        data: { user_id: string; workspace_id: string }[];
        error: null;
      }>();
      mockConnectDb.mockReturnValueOnce(connect.promise);
      mockMembershipRead.mockReturnValueOnce(membership.promise);
      const responsePromise = GET(
        new Request(
          `http://localhost/api/conversations/507f1f77bcf86cd799439011?workspaceId=ws_1&${view === "chat" ? "view=chat" : "messagesOnly=1&page=2"}`
        ),
        { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
      );
      await new Promise<void>(resolve => setImmediate(resolve));
      try {
        expect(mockMembershipRead).toHaveBeenCalledTimes(1);
        expect(mockMembershipRead.mock.invocationCallOrder[0]).toBeLessThan(
          mockConnectDb.mock.invocationCallOrder[0]
        );
        expect(mockGetCompanyConversationVisibilityGate).not.toHaveBeenCalled();
        membership.resolve({
          data: [{ user_id: "agent_1", workspace_id: "ws_1" }],
          error: null,
        });
        connect.resolve();
        const response = await responsePromise;
        expect(response.status).toBe(200);
        expect(mockMembershipRead).toHaveBeenCalledTimes(1);
        expect(mockGetCompanyConversationVisibilityGate).toHaveBeenCalledTimes(
          1
        );
        expect((await response.json()).messages).toHaveLength(1);
      } finally {
        membership.resolve({ data: [], error: null });
        connect.resolve();
        await responsePromise;
      }
    }
  );

  it("cannot use successful membership in requested workspace A to authorize canonical workspace B", async () => {
    mockMembershipRead
      .mockResolvedValueOnce({
        data: [{ user_id: "agent_1", workspace_id: "workspace_a" }],
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null });
    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=workspace_a"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );
    expect(response.status).toBe(403);
    expect(mockMembershipRead).toHaveBeenCalledTimes(2);
    expect(mockGetCompanyConversationVisibilityGate).not.toHaveBeenCalled();
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it.each(["missing", "error", "rejected"])(
    "falls back to canonical membership after a %s speculative lookup",
    async failure => {
      if (failure === "rejected")
        mockMembershipRead.mockRejectedValueOnce(new Error("lookup_failed"));
      else
        mockMembershipRead.mockResolvedValueOnce({
          data: [],
          error: failure === "error" ? { message: "lookup_failed" } : null,
        });
      const response = await GET(
        new Request(
          "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
        ),
        { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
      );
      expect(response.status).toBe(200);
      expect(mockMembershipRead).toHaveBeenCalledTimes(2);
      expect((await response.json()).messages).toHaveLength(1);
    }
  );

  it("returns the existing canonical error response when both membership reads reject", async () => {
    mockMembershipRead
      .mockRejectedValueOnce(new Error("speculative_lookup_rejected"))
      .mockRejectedValueOnce(new Error("canonical_lookup_rejected"));
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await GET(
        new Request(
          "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
        ),
        { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "canonical_lookup_rejected",
      });
      expect(mockMembershipRead).toHaveBeenCalledTimes(2);
      expect(mockGetCompanyConversationVisibilityGate).not.toHaveBeenCalled();
      expect(mockAfter).not.toHaveBeenCalled();
      expect(mockRequestLogError).toHaveBeenCalledTimes(1);
      expect(
        mockRequestLogError.mock.calls[0][2].stageTimings.access.outcome
      ).toBe("error");
    } finally {
      errorLog.mockRestore();
    }
  });

  it.each(["auth", "id"])(
    "does not start membership work before the %s guard",
    async guard => {
      if (guard === "auth")
        mockAuthGetUser.mockResolvedValue({ data: { user: null } });
      const response = await GET(
        new Request(
          "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=chat&workspaceId=ws_1"
        ),
        {
          params: Promise.resolve({
            id: guard === "id" ? "invalid" : "507f1f77bcf86cd799439011",
          }),
        }
      );
      expect(response.status).toBe(guard === "auth" ? 401 : 404);
      expect(mockMembershipRead).not.toHaveBeenCalled();
      expect(mockCacheReadWithStatus).not.toHaveBeenCalled();
      expect(mockConnectDb).not.toHaveBeenCalled();
    }
  );

  it("retains the full handled-agent membership and profile lookup", async () => {
    mockConversationFindById.mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: async () => ({
            _id: "507f1f77bcf86cd799439011",
            workspaceId: "ws_1",
            channel: "telegram",
            handled_by_agent_id: "agent_2",
          }),
        }),
      }),
    });
    mockMembershipRead.mockResolvedValueOnce({
      data: [
        { user_id: "agent_1", workspace_id: "ws_1" },
        {
          user_id: "agent_2",
          workspace_id: "ws_1",
          email: "agent2@example.test",
        },
      ],
      error: null,
    });
    mockGetUserProfilesByIds.mockResolvedValueOnce(
      new Map([
        ["agent_2", { full_name: "Support Agent", avatar_url: "/agent.png" }],
      ])
    );
    const response = await GET(
      new Request(
        "http://localhost/api/conversations/507f1f77bcf86cd799439011?view=full&workspaceId=ws_1&limit=1"
      ),
      { params: Promise.resolve({ id: "507f1f77bcf86cd799439011" }) }
    );
    expect(response.status).toBe(200);
    expect(mockMembershipRead).toHaveBeenCalledTimes(1);
    expect(mockMembershipSelect.mock.calls[0][0]).toContain("email");
    expect(mockGetUserProfilesByIds).toHaveBeenCalledWith(expect.anything(), [
      "agent_2",
    ]);
    expect((await response.json()).handled_by_agent).toEqual({
      id: "agent_2",
      name: "Support Agent",
      avatar_url: "/agent.png",
    });
  });
});
