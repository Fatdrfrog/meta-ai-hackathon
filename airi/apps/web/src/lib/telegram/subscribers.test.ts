import {
  backfillTelegramSubscribersFromConversations,
  buildTelegramSubscribersCsv,
  fetchTelegramSubscriberContacts,
  parseTelegramSubscriberCsv,
} from "@/lib/telegram/subscribers";

const mockConversationFind = jest.fn();
const mockSubscriberBulkWrite = jest.fn();
const mockSubscriberFind = jest.fn();

jest.mock("@/lib/mongoose", () => jest.fn(async () => undefined));

jest.mock("@/lib/logger", () => ({
  logger: {
    warn: jest.fn(),
  },
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));

jest.mock("@/models/telegram-subscriber", () => ({
  TelegramSubscriber: {
    bulkWrite: (...args: unknown[]) => mockSubscriberBulkWrite(...args),
    find: (...args: unknown[]) => mockSubscriberFind(...args),
  },
}));

jest.mock("@/models/telegram-subscriber-import-batch", () => ({
  TelegramSubscriberImportBatch: {},
}));

function mockConversationRows(rows: unknown[]) {
  const lean = jest.fn(async () => rows);
  const limit = jest.fn(() => ({ lean }));
  const sort = jest.fn(() => ({ limit }));
  const select = jest.fn(() => ({ sort }));
  mockConversationFind.mockReturnValue({ select });
  return { select, sort, limit, lean };
}

function mockSubscriberRows(rows: unknown[]) {
  const lean = jest.fn(async () => rows);
  const limit = jest.fn(() => ({ lean }));
  const sort = jest.fn(() => ({ limit }));
  mockSubscriberFind.mockReturnValue({ sort });
  return { sort, limit, lean };
}

describe("telegram subscriber import helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversationRows([]);
    mockSubscriberRows([]);
    mockSubscriberBulkWrite.mockResolvedValue({ upsertedCount: 0 });
  });

  it("parses valid private chat ids from common CSV column aliases", () => {
    const parsed = parseTelegramSubscriberCsv({
      csv: [
        "telegram_chat_id,first_name,last_name,username,language",
        'tg_123456_source-a,"Sam, Jr",Smith,sammy,en',
        ",Ignored,Because,This,is missing the id",
      ].join("\n"),
      sourceId: "source-a",
    });

    expect(parsed.validRows).toEqual([
      expect.objectContaining({
        chatId: "123456",
        firstName: "Sam, Jr",
        lastName: "Smith",
        username: "sammy",
        languageCode: "en",
      }),
    ]);
    expect(parsed.summary).toMatchObject({
      totalRows: 2,
      validRows: 1,
      invalidRows: 1,
      duplicateRows: 0,
    });
    expect(parsed.errors[0]).toMatchObject({
      rowNumber: 3,
      reason: "missing_chat_id",
    });
  });

  it("rejects group ids, usernames, and duplicate rows without dropping the first valid row", () => {
    const parsed = parseTelegramSubscriberCsv({
      csv: [
        "chat_id,name",
        "123,Ada",
        "123,Duplicate Ada",
        "-100123,Group",
        "@username,Username only",
      ].join("\n"),
      sourceId: "source-a",
    });

    expect(parsed.validRows).toEqual([
      expect.objectContaining({ chatId: "123", displayName: "Ada" }),
    ]);
    expect(parsed.summary).toMatchObject({
      totalRows: 4,
      validRows: 1,
      duplicateRows: 1,
      invalidRows: 2,
    });
    expect(parsed.errors.map(error => error.reason)).toEqual([
      "duplicate_chat_id",
      "telegram_group_dm_not_supported",
      "invalid_chat_id",
    ]);
  });

  it("exports subscriber rows as CSV without secrets", () => {
    const csv = buildTelegramSubscribersCsv([
      {
        chatId: "123",
        sourceId: "source-a",
        status: "active",
        origin: "import",
        displayName: "Ada Lovelace",
        username: "ada",
        firstName: "Ada",
        lastName: "Lovelace",
        languageCode: "en",
        importedAt: new Date("2026-06-23T10:00:00.000Z"),
        lastSuccessfulSendAt: null,
        lastSendError: null,
      },
    ]);

    expect(csv).toContain("chat_id,source_id,status,origin");
    expect(csv).toContain("123,source-a,active,import");
    expect(csv).not.toContain("bot_token");
    expect(csv).not.toContain("webhook_secret");
  });

  it("backfills known private conversations in bounded batches", async () => {
    const conversationQuery = mockConversationRows([
      {
        chat: "123",
        user: { id: 123 },
        sourceId: "telegram-source-1",
        first_inbound_at: new Date("2026-06-20T10:00:00.000Z"),
        last_inbound_at: new Date("2026-06-21T10:00:00.000Z"),
      },
    ]);
    mockSubscriberBulkWrite.mockResolvedValue({ upsertedCount: 1 });

    const result = await backfillTelegramSubscribersFromConversations({
      workspaceId: "workspace-1",
      sourceId: "telegram-source-1",
    });

    expect(result).toEqual({ scanned: 1, upserted: 1 });
    expect(mockConversationFind).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        channel: "telegram",
        sourceId: "telegram-source-1",
      })
    );
    expect(conversationQuery.limit).toHaveBeenCalledWith(500);
    expect(mockSubscriberBulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: expect.objectContaining({
              workspaceId: "workspace-1",
              sourceId: "telegram-source-1",
              chatId: "123",
            }),
          }),
        }),
      ],
      { ordered: false }
    );
  });

  it("returns Telegram subscriber contacts without inline conversation backfill", async () => {
    mockSubscriberRows([
      {
        chatId: "123",
        sourceId: "telegram-source-1",
        status: "active",
        origin: "conversation_backfill",
        displayName: "Ada",
      },
    ]);

    const contacts = await fetchTelegramSubscriberContacts({
      workspaceId: "workspace-1",
      sourceIds: [" telegram-source-1 ", "telegram-source-1"],
    });

    expect(mockConversationFind).not.toHaveBeenCalled();
    expect(mockSubscriberBulkWrite).not.toHaveBeenCalled();
    expect(mockSubscriberFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: { $in: ["telegram-source-1"] },
      status: { $in: ["active", "imported"] },
    });
    expect(contacts).toEqual([
      {
        identifier: "123",
        channel: "telegram",
        sourceId: "telegram-source-1",
        name: "Ada",
        status: "active",
        origin: "conversation_backfill",
      },
    ]);
  });
});
