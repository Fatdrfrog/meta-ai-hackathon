const mockConnectDB = jest.fn();
const mockEnsureCustomerBirthdayIndexes = jest.fn();
const mockCustomerFindOne = jest.fn();
const mockCustomerCreate = jest.fn();
const mockCustomerFind = jest.fn();
const mockCustomerBulkWrite = jest.fn();
const mockFindEligibleTelegramSubscriberMap = jest.fn();
const mockImportSession = { kind: "birthday-import-session" };
const mockBirthdayTransaction = jest.fn();
jest.mock("./customer-birthday-transaction", () => ({
  withBirthdayWorkspaceTransaction: (...args: unknown[]) =>
    mockBirthdayTransaction(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/customer", () => ({
  __esModule: true,
  default: Object.assign(
    jest.fn((data: unknown) => ({ toObject: () => data })),
    {
      findOne: (...args: unknown[]) => mockCustomerFindOne(...args),
      create: (...args: unknown[]) => mockCustomerCreate(...args),
      find: (...args: unknown[]) => mockCustomerFind(...args),
      bulkWrite: (...args: unknown[]) => mockCustomerBulkWrite(...args),
    }
  ),
  ensureCustomerBirthdayIndexes: (...args: unknown[]) =>
    mockEnsureCustomerBirthdayIndexes(...args),
}));

jest.mock("@/lib/telegram/subscribers", () => ({
  findEligibleTelegramSubscriberMap: (...args: unknown[]) =>
    mockFindEligibleTelegramSubscriberMap(...args),
  normalizeTelegramSubscriberChatId: (value: unknown) =>
    String(value || "").trim(),
  isTelegramPrivateSubscriberChatId: (value: string) => /^\d+$/.test(value),
}));

import { importCustomerBirthdays } from "./customer-birthday-import";

describe("importCustomerBirthdays", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBirthdayTransaction.mockImplementation(
      (
        _workspaceId: string,
        operation: (session: unknown) => Promise<unknown>
      ) => operation(mockImportSession)
    );
    mockConnectDB.mockResolvedValue(undefined);
    mockEnsureCustomerBirthdayIndexes.mockResolvedValue(undefined);
    mockCustomerFindOne.mockResolvedValue(null);
    mockCustomerCreate.mockResolvedValue({});
    mockCustomerFind.mockReturnValue({
      session: () => ({ sort: () => ({ lean: async () => [] }) }),
    });
    mockCustomerBulkWrite.mockResolvedValue({});
    mockFindEligibleTelegramSubscriberMap.mockResolvedValue(new Map());
  });

  it("imports a birthday against an eligible selected Telegram bot chat", async () => {
    mockFindEligibleTelegramSubscriberMap.mockResolvedValue(
      new Map([
        [
          "123456:source-1",
          { chatId: "123456", sourceId: "source-1", status: "active" },
        ],
      ])
    );

    const result = await importCustomerBirthdays({
      workspaceId: "workspace-1",
      channel: "telegram",
      sourceId: "source-1",
      recipients: [{ chatId: "123456", name: "Aibek", birthday: "17.04.1992" }],
      now: new Date("2026-07-23T00:00:00.000Z"),
    });

    expect(mockFindEligibleTelegramSubscriberMap).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceIds: ["source-1"],
      chatIds: ["123456"],
    });
    expect(mockCustomerFind).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        identities: {
          $elemMatch: expect.objectContaining({
            type: "channel_chat",
            channel: "telegram",
            sourceId: "source-1",
            normalizedValue: { $in: ["123456", "tg_123456_source-1"] },
          }),
        },
      })
    );
    expect(mockCustomerBulkWrite).toHaveBeenCalledWith(
      [
        {
          insertOne: {
            document: expect.objectContaining({
              workspaceId: "workspace-1",
              displayName: "Aibek",
              identities: [
                expect.objectContaining({
                  type: "channel_chat",
                  channel: "telegram",
                  sourceId: "source-1",
                  value: "123456",
                  normalizedValue: "123456",
                }),
              ],
              profileSummary: expect.objectContaining({
                channels: ["telegram"],
              }),
              profileDates: {
                birthday: expect.objectContaining({
                  month: 4,
                  day: 17,
                  year: 1992,
                  source: "csv",
                }),
              },
            }),
          },
        },
      ],
      { ordered: true, session: mockImportSession }
    );
    expect(result).toEqual(
      expect.objectContaining({
        imported: 1,
        skippedMissingChatId: 0,
        skippedIneligibleTelegramSubscriber: 0,
      })
    );
  });

  it("skips Telegram chats that are not eligible subscribers of the source", async () => {
    const result = await importCustomerBirthdays({
      workspaceId: "workspace-1",
      channel: "telegram",
      sourceId: "source-1",
      recipients: [
        { chatId: "123456", birthday: "17.04.1992" },
        { chatId: "group-chat", birthday: "17.04.1992" },
      ],
    });

    expect(result.skippedIneligibleTelegramSubscriber).toBe(1);
    expect(result.skippedMissingChatId).toBe(1);
    expect(mockCustomerCreate).not.toHaveBeenCalled();
    expect(mockCustomerBulkWrite).not.toHaveBeenCalled();
  });

  it("imports the maximum upload using bounded database round trips", async () => {
    const recipients = Array.from({ length: 10_000 }, (_, i) => ({
      phone: `+770${String(i).padStart(8, "0")}`,
      birthday: "17.04",
    }));
    const result = await importCustomerBirthdays({
      workspaceId: "workspace-1",
      recipients,
    });
    expect(result.imported).toBe(10_000);
    const calls =
      mockCustomerFindOne.mock.calls.length +
      mockCustomerCreate.mock.calls.length +
      mockCustomerFind.mock.calls.length +
      mockCustomerBulkWrite.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(40);
    // Each bounded batch commits independently of Mongo's transaction lifetime.
    expect(mockBirthdayTransaction).toHaveBeenCalledTimes(20);
  });

  it("preserves committed batch counts when a later batch transaction retries", async () => {
    mockBirthdayTransaction
      .mockImplementationOnce(
        (
          _workspaceId: string,
          operation: (session: unknown) => Promise<unknown>
        ) => operation(mockImportSession)
      )
      .mockImplementationOnce(
        async (
          _workspaceId: string,
          operation: (session: unknown) => Promise<unknown>
        ) => {
          await operation(mockImportSession);
          return operation(mockImportSession);
        }
      );
    const result = await importCustomerBirthdays({
      workspaceId: "workspace-1",
      recipients: Array.from({ length: 501 }, (_, i) => ({
        phone: "+770" + String(i).padStart(8, "0"),
        birthday: "17.04",
      })),
    });
    expect(result).toMatchObject({ total: 501, imported: 501, updated: 0 });
    expect(mockBirthdayTransaction).toHaveBeenCalledTimes(2);
    expect(mockCustomerBulkWrite).toHaveBeenCalledTimes(3);
  });

  it("does not accumulate row counts when Mongo retries an import transaction", async () => {
    mockBirthdayTransaction.mockImplementationOnce(
      async (
        _workspaceId: string,
        operation: (session: unknown) => Promise<unknown>
      ) => {
        await operation(mockImportSession);
        return operation(mockImportSession);
      }
    );
    const result = await importCustomerBirthdays({
      workspaceId: "workspace-1",
      recipients: [{ phone: "+77001234567", birthday: "17.04" }],
    });
    expect(result).toMatchObject({ total: 1, imported: 1, updated: 0 });
    expect(mockCustomerBulkWrite).toHaveBeenCalledTimes(2);
  });

  it("merges repeated imported identities into one insert and conserves row counts", async () => {
    const result = await importCustomerBirthdays({
      workspaceId: "workspace-1",
      recipients: [
        { phone: "+77001234567", birthday: "17.04" },
        { phone: "77001234567", birthday: "18.04" },
      ],
    });
    expect(result).toMatchObject({ total: 2, imported: 1, updated: 1 });
    const writes = mockCustomerBulkWrite.mock.calls[0][0];
    expect(writes).toHaveLength(1);
    expect(writes[0].insertOne.document).toMatchObject({
      seedKeys: ["birthday_import:77001234567"],
      profileDates: {
        birthday: expect.objectContaining({ month: 4, day: 18 }),
      },
    });
  });

  it("merges rows for two identities of one customer without losing existing data", async () => {
    const customer = {
      _id: "507f1f77bcf86cd799439011",
      status: "active",
      displayName: "Existing name",
      seedKeys: ["existing-seed"],
      profileSummary: {
        channels: ["whatsapp"],
        tags: ["vip"],
        contactPoints: {
          phones: ["77001234567", "77007654321"],
          emails: ["kept@example.com"],
        },
      },
      profileDates: { anniversary: { month: 6, day: 2 } },
      identities: ["77001234567", "77007654321"].map(normalizedValue => ({
        type: "phone",
        channel: "whatsapp",
        normalizedValue,
        value: normalizedValue,
      })),
    };
    mockCustomerFind.mockReturnValue({
      session: () => ({ sort: () => ({ lean: async () => [customer] }) }),
    });
    const result = await importCustomerBirthdays({
      workspaceId: "workspace-1",
      recipients: [
        { phone: "+77001234567", birthday: "17.04" },
        { phone: "+77007654321", birthday: "18.04" },
      ],
    });
    expect(result).toMatchObject({ total: 2, imported: 0, updated: 2 });
    expect(mockCustomerBulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: { _id: customer._id, workspaceId: "workspace-1" },
            update: {
              $set: expect.objectContaining({
                displayName: "Existing name",
                seedKeys: [
                  "existing-seed",
                  "birthday_import:77001234567",
                  "birthday_import:77007654321",
                ],
                profileSummary: expect.objectContaining({
                  tags: ["vip"],
                  contactPoints: expect.objectContaining({
                    emails: ["kept@example.com"],
                  }),
                }),
                profileDates: expect.objectContaining({
                  anniversary: { month: 6, day: 2 },
                  birthday: expect.objectContaining({ month: 4, day: 18 }),
                }),
              }),
            },
          }),
        }),
      ],
      expect.any(Object)
    );
  });
});
