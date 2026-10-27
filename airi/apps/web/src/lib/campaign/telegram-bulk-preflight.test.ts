const mockConnectDB = jest.fn();
const mockConversationFind = jest.fn();
const mockSupabaseFrom = jest.fn();
const mockFindEligibleTelegramSubscriberMap = jest.fn();
const mockFindTelegramSubscriberStatusMap = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

jest.mock("@/lib/telegram/subscribers", () => ({
  findEligibleTelegramSubscriberMap: (...args: unknown[]) =>
    mockFindEligibleTelegramSubscriberMap(...args),
  findTelegramSubscriberStatusMap: (...args: unknown[]) =>
    mockFindTelegramSubscriberStatusMap(...args),
}));

import { resolveEligibleTelegramBulkRecipients } from "./telegram-bulk-preflight";

function selectLeanResult<T>(value: T) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

describe("resolveEligibleTelegramBulkRecipients", () => {
  const workspaceId = "workspace-1";

  /** Serves telegram_business_connections rows for the requested ids. */
  function mockBusinessConnections(
    rows: (businessConnectionIds: string[]) => Array<Record<string, unknown>>
  ) {
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table !== "telegram_business_connections") {
        throw new Error(`Unexpected Supabase table: ${table}`);
      }
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        in: jest.fn(
          async (_column: string, businessConnectionIds: string[]) => ({
            data: rows(businessConnectionIds),
            error: null,
          })
        ),
      };
    });
  }

  function replyableConnection(businessConnectionId: string) {
    return {
      business_connection_id: businessConnectionId,
      workspace_id: workspaceId,
      source_id: "source-a",
      can_reply: true,
      is_enabled: true,
    };
  }

  /** 501 numeric chat ids from start: one more than a lookup chunk. */
  function chatIdsFrom(start: number) {
    return Array.from({ length: 501 }, (_, index) => String(start + index));
  }

  const onSourceA = (chatIds: string[]) =>
    chatIds.map(chatId => ({ chatId, sourceId: "source-a" }));

  beforeEach(() => {
    [
      mockConnectDB,
      mockConversationFind,
      mockSupabaseFrom,
      mockFindEligibleTelegramSubscriberMap,
      mockFindTelegramSubscriberStatusMap,
    ].forEach(mock => mock.mockReset());
    mockConnectDB.mockResolvedValue(undefined);
    mockConversationFind.mockReturnValue(selectLeanResult([]));
    mockFindEligibleTelegramSubscriberMap.mockResolvedValue(new Map());
    mockFindTelegramSubscriberStatusMap.mockResolvedValue(new Map());
    mockBusinessConnections(() => []);
  });

  it("keeps an imported bot subscriber scoped to its selected source", async () => {
    mockFindEligibleTelegramSubscriberMap.mockResolvedValue(
      new Map([
        [
          "1001:source-a",
          { chatId: "1001", sourceId: "source-a", status: "imported" },
        ],
      ])
    );

    const result = await resolveEligibleTelegramBulkRecipients({
      workspaceId,
      defaultSourceId: "default-source",
      recipients: [
        { chatId: "tg_1001_source-a", sourceId: "source-a" },
        { chatId: "tg_1001_source-b", sourceId: "source-b" },
      ],
    });

    expect(result).toEqual({
      recipients: [
        {
          chatId: "1001",
          sourceId: "source-a",
          businessConnectionId: undefined,
        },
      ],
      skippedRecipientDetails: [
        { reason: "telegram_recipient_not_contacted", detail: "1001" },
      ],
    });
    expect(mockFindEligibleTelegramSubscriberMap.mock.calls).toEqual(
      expect.arrayContaining([
        [
          {
            workspaceId,
            sourceIds: ["source-a"],
            chatIds: ["1001"],
          },
        ],
        [
          {
            workspaceId,
            sourceIds: ["source-b"],
            chatIds: ["1001"],
          },
        ],
      ])
    );
  });

  it("does not qualify wrong-source or source-less conversations", async () => {
    mockConversationFind.mockReturnValue(
      selectLeanResult([
        {
          chat: "4004",
          sourceId: null,
          first_inbound_at: new Date(),
        },
        {
          chat: "5005",
          sourceId: "source-b",
          first_inbound_at: new Date(),
        },
      ])
    );

    const result = await resolveEligibleTelegramBulkRecipients({
      workspaceId,
      defaultSourceId: "source-a",
      recipients: [
        { chatId: "4004", sourceId: "source-a" },
        { chatId: "5005", sourceId: "source-a" },
      ],
    });

    expect(result).toEqual({
      recipients: [],
      skippedRecipientDetails: [
        { reason: "telegram_recipient_not_contacted", detail: "4004" },
        { reason: "telegram_recipient_not_contacted", detail: "5005" },
      ],
    });
    expect(mockConversationFind).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        channel: "telegram",
        sourceId: "source-a",
      })
    );
  });

  it("keeps a Business recipient only while its source connection reply window is active", async () => {
    mockConversationFind.mockReturnValue(
      selectLeanResult([
        {
          chat: "2002",
          sourceId: "source-a",
          business_connection_id: "business-active",
          first_inbound_at: new Date("2026-07-26T08:00:00.000Z"),
          last_inbound_at: new Date(),
        },
        {
          chat: "3003",
          sourceId: "source-a",
          business_connection_id: "business-expired",
          first_inbound_at: new Date("2026-07-25T08:00:00.000Z"),
          last_inbound_at: new Date(Date.now() - 24 * 60 * 60 * 1000 - 1),
        },
      ])
    );
    mockBusinessConnections(() => [
      replyableConnection("business-active"),
      replyableConnection("business-expired"),
    ]);

    const result = await resolveEligibleTelegramBulkRecipients({
      workspaceId,
      defaultSourceId: "default-source",
      recipients: [
        { chatId: "2002", sourceId: "source-a" },
        { chatId: "3003", sourceId: "source-a" },
      ],
    });

    expect(result).toEqual({
      recipients: [
        {
          chatId: "2002",
          sourceId: "source-a",
          businessConnectionId: "business-active",
        },
      ],
      skippedRecipientDetails: [
        {
          reason: "telegram_business_reply_window_expired",
          detail: "3003",
        },
      ],
    });
  });

  it.each(["standard_first", "business_first"] as const)(
    "prefers an eligible standard-bot conversation regardless of row order: %s",
    async order => {
      const standardConversation = {
        chat: "6006",
        sourceId: "source-a",
        first_inbound_at: new Date(),
        last_inbound_at: new Date(),
      };
      const expiredBusinessConversation = {
        chat: "6006",
        sourceId: "source-a",
        business_connection_id: "business-expired",
        first_inbound_at: new Date(
          Date.now() - 25 * 60 * 60 * 1000
        ),
        last_inbound_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
      };
      mockConversationFind.mockReturnValue(
        selectLeanResult(
          order === "standard_first"
            ? [standardConversation, expiredBusinessConversation]
            : [expiredBusinessConversation, standardConversation]
        )
      );
      mockBusinessConnections(() => [replyableConnection("business-expired")]);

      const result = await resolveEligibleTelegramBulkRecipients({
        workspaceId,
        defaultSourceId: "source-a",
        recipients: [{ chatId: "6006", sourceId: "source-a" }],
      });

      expect(result).toEqual({
        recipients: [
          {
            chatId: "6006",
            sourceId: "source-a",
            businessConnectionId: undefined,
          },
        ],
        skippedRecipientDetails: [],
      });
    }
  );

  it.each(["standard_first", "business_first"] as const)(
    "uses an eligible Business conversation when the standard row is not contacted: %s",
    async order => {
      const uncontactedStandardConversation = {
        chat: "7007",
        sourceId: "source-a",
      };
      const activeBusinessConversation = {
        chat: "7007",
        sourceId: "source-a",
        business_connection_id: "business-active",
        first_inbound_at: new Date(),
        last_inbound_at: new Date(),
      };
      mockConversationFind.mockReturnValue(
        selectLeanResult(
          order === "standard_first"
            ? [uncontactedStandardConversation, activeBusinessConversation]
            : [activeBusinessConversation, uncontactedStandardConversation]
        )
      );
      mockBusinessConnections(() => [replyableConnection("business-active")]);

      const result = await resolveEligibleTelegramBulkRecipients({
        workspaceId,
        defaultSourceId: "source-a",
        recipients: [{ chatId: "7007", sourceId: "source-a" }],
      });

      expect(result).toEqual({
        recipients: [
          {
            chatId: "7007",
            sourceId: "source-a",
            businessConnectionId: "business-active",
          },
        ],
        skippedRecipientDetails: [],
      });
    }
  );

  it("chunks conversation identities and keeps the same not-contacted reason", async () => {
    const chatIds = chatIdsFrom(1_000_000);
    const missingChatId = chatIds[500];
    mockConversationFind.mockImplementation(
      (filter: { chat: { $in: Array<string | number> } }) =>
        selectLeanResult(
          filter.chat.$in
            .filter(
              (value): value is string =>
                typeof value === "string" &&
                /^\d+$/.test(value) &&
                value !== missingChatId
            )
            .map(chat => ({
              chat,
              sourceId: "source-a",
              first_inbound_at: new Date(),
            }))
        )
    );

    const result = await resolveEligibleTelegramBulkRecipients({
      workspaceId,
      defaultSourceId: "source-a",
      recipients: onSourceA(chatIds),
    });

    expect(result.recipients).toHaveLength(500);
    expect(result.skippedRecipientDetails).toEqual([
      {
        reason: "telegram_recipient_not_contacted",
        detail: missingChatId,
      },
    ]);
    expect(mockConversationFind.mock.calls.length).toBeGreaterThan(1);
    for (const [filter] of mockConversationFind.mock.calls as Array<
      [{ sourceId: string; chat: { $in: unknown[] } }]
    >) {
      expect(filter.sourceId).toBe("source-a");
      expect(filter.chat.$in.length).toBeLessThanOrEqual(500);
    }
  });

  it("chunks subscriber inputs and keeps the same blocked reason", async () => {
    const chatIds = chatIdsFrom(2_000_000);
    const blockedChatId = chatIds[500];
    mockFindEligibleTelegramSubscriberMap.mockImplementation(
      async (params: { sourceIds: string[]; chatIds: string[] }) =>
        new Map(
          params.chatIds
            .filter(chatId => chatId !== blockedChatId)
            .map(chatId => [
              `${chatId}:source-a`,
              {
                chatId,
                sourceId: "source-a",
                status: "imported",
              },
            ])
        )
    );
    mockFindTelegramSubscriberStatusMap.mockImplementation(
      async (params: { chatIds: string[] }) =>
        params.chatIds.includes(blockedChatId)
          ? new Map([
              [
                `${blockedChatId}:source-a`,
                {
                  chatId: blockedChatId,
                  sourceId: "source-a",
                  status: "blocked",
                },
              ],
            ])
          : new Map()
    );

    const result = await resolveEligibleTelegramBulkRecipients({
      workspaceId,
      defaultSourceId: "source-a",
      recipients: onSourceA(chatIds),
    });

    expect(result.recipients).toHaveLength(500);
    expect(result.skippedRecipientDetails).toEqual([
      {
        reason: "telegram_subscriber_blocked",
        detail: blockedChatId,
      },
    ]);
    expect(
      mockFindEligibleTelegramSubscriberMap.mock.calls.length
    ).toBeGreaterThan(1);
    expect(
      mockFindTelegramSubscriberStatusMap.mock.calls.length
    ).toBeGreaterThan(1);
    for (const mock of [
      mockFindEligibleTelegramSubscriberMap,
      mockFindTelegramSubscriberStatusMap,
    ]) {
      for (const [params] of mock.mock.calls as Array<
        [{ sourceIds: string[]; chatIds: string[] }]
      >) {
        expect(params.sourceIds.length).toBeLessThanOrEqual(500);
        expect(params.chatIds.length).toBeLessThanOrEqual(500);
      }
    }
  });

  it("chunks subscriber lookups independently for each exact source", async () => {
    const chatIds = chatIdsFrom(4_000_000);
    mockFindEligibleTelegramSubscriberMap.mockImplementation(
      async (params: { sourceIds: string[]; chatIds: string[] }) => {
        const sourceId = params.sourceIds[0];
        return new Map(
          params.chatIds.map(chatId => [
            `${chatId}:${sourceId}`,
            {
              chatId,
              sourceId,
              status: "imported",
            },
          ])
        );
      }
    );

    const result = await resolveEligibleTelegramBulkRecipients({
      workspaceId,
      defaultSourceId: "source-a",
      recipients: [
        ...onSourceA(chatIds),
        ...chatIds.map(chatId => ({ chatId, sourceId: "source-b" })),
      ],
    });

    expect(result.recipients).toHaveLength(1_002);
    expect(result.skippedRecipientDetails).toEqual([]);
    expect(
      mockFindEligibleTelegramSubscriberMap.mock.calls.length
    ).toBeGreaterThanOrEqual(4);
    for (const mock of [
      mockFindEligibleTelegramSubscriberMap,
      mockFindTelegramSubscriberStatusMap,
    ]) {
      for (const [params] of mock.mock.calls as Array<
        [{ sourceIds: string[]; chatIds: string[] }]
      >) {
        expect(params.sourceIds).toHaveLength(1);
        expect(["source-a", "source-b"]).toContain(params.sourceIds[0]);
        expect(params.chatIds.length).toBeLessThanOrEqual(500);
      }
    }
  });

  it("chunks Business connection inputs and keeps the same unavailable reason", async () => {
    const chatIds = chatIdsFrom(3_000_000);
    const unavailableChatId = chatIds[500];
    const businessConnectionInputs: string[][] = [];
    mockConversationFind.mockImplementation(
      (filter: { chat: { $in: Array<string | number> } }) =>
        selectLeanResult(
          filter.chat.$in
            .filter(
              (value): value is string =>
                typeof value === "string" && /^\d+$/.test(value)
            )
            .map(chat => ({
              chat,
              sourceId: "source-a",
              business_connection_id: `business-${chat}`,
              first_inbound_at: new Date(),
              last_inbound_at: new Date(),
            }))
        )
    );
    mockBusinessConnections(businessConnectionIds => {
      businessConnectionInputs.push(businessConnectionIds);
      return businessConnectionIds
        .filter(
          businessConnectionId =>
            businessConnectionId !== `business-${unavailableChatId}`
        )
        .map(replyableConnection);
    });

    const result = await resolveEligibleTelegramBulkRecipients({
      workspaceId,
      defaultSourceId: "source-a",
      recipients: onSourceA(chatIds),
    });

    expect(result.recipients).toHaveLength(500);
    expect(result.skippedRecipientDetails).toEqual([
      {
        reason: "telegram_business_reply_unavailable",
        detail: unavailableChatId,
      },
    ]);
    expect(businessConnectionInputs.length).toBeGreaterThan(1);
    businessConnectionInputs.forEach(values =>
      expect(values.length).toBeLessThanOrEqual(500)
    );
  });
});
