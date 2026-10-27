const mockConnectDB = jest.fn();
const mockEnsureCustomerBirthdayIndexes = jest.fn();
const mockCustomerFind = jest.fn();
const mockCustomerCountDocuments = jest.fn();
const mockFindEligibleTelegramSubscriberMap = jest.fn();
const mockFilterKnownMarketingOptOutRecipients = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/customer", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockCustomerFind(...args),
    countDocuments: (...args: unknown[]) => mockCustomerCountDocuments(...args),
  },
  ensureCustomerBirthdayIndexes: (...args: unknown[]) =>
    mockEnsureCustomerBirthdayIndexes(...args),
}));

jest.mock("@/lib/campaign/marketing-opt-in", () => ({
  filterKnownMarketingOptOutRecipients: (...args: unknown[]) =>
    mockFilterKnownMarketingOptOutRecipients(...args),
}));

jest.mock("@/lib/telegram/subscribers", () => ({
  findEligibleTelegramSubscriberMap: (...args: unknown[]) =>
    mockFindEligibleTelegramSubscriberMap(...args),
  normalizeTelegramSubscriberChatId: (value: unknown) =>
    jest.requireActual("@/lib/telegram/chat-id").normalizeTelegramChatId(value),
  isTelegramPrivateSubscriberChatId: (value: string) =>
    jest.requireActual("@/lib/telegram/chat-id").isTelegramPrivateChatId(value),
}));

import { Types } from "mongoose";
import {
  buildBirthdayAudiencePreview,
  findBirthdayAudiencePage,
} from "./campaign-birthday-audience";

function customerQuery<T>(value: T) {
  return {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

describe("findBirthdayAudiencePage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockEnsureCustomerBirthdayIndexes.mockResolvedValue(undefined);
  });

  it("returns only eligible birthday chats for the selected Telegram bot", async () => {
    const eligibleId = new Types.ObjectId();
    const ineligibleId = new Types.ObjectId();
    mockCustomerFind.mockReturnValue(
      customerQuery([
        {
          _id: eligibleId,
          displayName: "Aibek",
          identities: [
            {
              type: "channel_chat",
              channel: "telegram",
              sourceId: "source-1",
              value: "123456",
              normalizedValue: "123456",
            },
          ],
          profileDates: { birthday: { month: 7, day: 23, year: 1992 } },
        },
        {
          _id: ineligibleId,
          displayName: "Blocked",
          identities: [
            {
              type: "channel_chat",
              channel: "telegram",
              sourceId: "source-1",
              value: "654321",
              normalizedValue: "654321",
            },
          ],
          profileDates: { birthday: { month: 7, day: 23 } },
        },
      ])
    );
    mockFindEligibleTelegramSubscriberMap.mockResolvedValue(
      new Map([
        [
          "123456:source-1",
          { chatId: "123456", sourceId: "source-1", status: "active" },
        ],
      ])
    );

    const result = await findBirthdayAudiencePage({
      workspaceId: "workspace-1",
      channel: "telegram",
      telegramSourceId: "source-1",
      recipientChatIds: ["123456", "654321"],
      scheduledFor: new Date("2026-07-23T09:00:00.000Z"),
      timezone: "UTC",
      limit: 100,
    });

    expect(mockCustomerFind).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        identities: {
          $elemMatch: expect.objectContaining({
            type: "channel_chat",
            channel: "telegram",
            sourceId: "source-1",
            normalizedValue: {
              $in: [
                "123456",
                "tg_123456_source-1",
                "654321",
                "tg_654321_source-1",
              ],
            },
          }),
        },
      })
    );
    expect(mockFindEligibleTelegramSubscriberMap).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceIds: ["source-1"],
      chatIds: ["123456", "654321"],
    });
    expect(result.candidateCount).toBe(2);
    expect(result.recipients).toEqual([
      expect.objectContaining({
        customerId: eligibleId.toHexString(),
        chatId: "123456",
        sourceId: "source-1",
        name: "Aibek",
        variables: expect.objectContaining({
          chat_id: "123456",
          birthday: "1992-07-23",
        }),
      }),
    ]);
  });

  it("keeps WhatsApp birthday recipients whose consent is unknown", async () => {
    const firstId = new Types.ObjectId();
    const secondId = new Types.ObjectId();
    mockCustomerFind.mockReturnValue(
      customerQuery([
        {
          _id: firstId,
          displayName: "Known opt-in",
          identities: [
            {
              type: "phone",
              channel: "whatsapp",
              value: "+1 555 000 0001",
              normalizedValue: "15550000001",
            },
          ],
          profileDates: { birthday: { month: 7, day: 23 } },
        },
        {
          _id: secondId,
          displayName: "Unknown consent",
          identities: [
            {
              type: "phone",
              channel: "whatsapp",
              value: "+1 555 000 0002",
              normalizedValue: "15550000002",
            },
          ],
          profileDates: { birthday: { month: 7, day: 23 } },
        },
      ])
    );
    mockFilterKnownMarketingOptOutRecipients.mockImplementation(
      async ({ recipients }: { recipients: Array<{ phone?: string }> }) => ({
        recipients,
        skippedRecipients: [],
        skippedOptIn: 0,
        skippedPhones: [],
        marketingOptInWarningRecipients: recipients.slice(1),
        marketingOptInWarningCount: 1,
        marketingOptInWarningPhones: ["15550000002"],
      })
    );

    const result = await findBirthdayAudiencePage({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      templateCategory: "MARKETING",
      scheduledFor: new Date("2026-07-23T09:00:00.000Z"),
      timezone: "UTC",
      limit: 100,
    });

    expect(mockFilterKnownMarketingOptOutRecipients).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      recipients: expect.arrayContaining([
        expect.objectContaining({ phone: "15550000001" }),
        expect.objectContaining({ phone: "15550000002" }),
      ]),
    });
    expect(result.candidateCount).toBe(2);
    expect(result.recipients).toEqual([
      expect.objectContaining({ customerId: firstId.toHexString() }),
      expect.objectContaining({ customerId: secondId.toHexString() }),
    ]);
    expect(result.skippedMarketingOptIn).toBe(0);
  });

  it("defers WhatsApp marketing consent for complete-occurrence runtime evaluation", async () => {
    const optedOutId = new Types.ObjectId();
    const eligibleId = new Types.ObjectId();
    mockCustomerFind.mockReturnValue(
      customerQuery([
        {
          _id: optedOutId,
          displayName: "Opted out",
          identities: [
            {
              type: "phone",
              channel: "whatsapp",
              normalizedValue: "15550000001",
            },
          ],
          profileDates: { birthday: { month: 7, day: 23 } },
        },
        {
          _id: eligibleId,
          displayName: "Eligible",
          identities: [
            {
              type: "phone",
              channel: "whatsapp",
              normalizedValue: "15550000002",
            },
          ],
          profileDates: { birthday: { month: 7, day: 23 } },
        },
      ])
    );
    mockFilterKnownMarketingOptOutRecipients.mockResolvedValue({
      recipients: [{ phone: "15550000002" }],
      skippedRecipients: [{ phone: "15550000001" }],
      skippedOptIn: 1,
      skippedPhones: ["15550000001"],
      marketingOptInWarningRecipients: [],
      marketingOptInWarningCount: 0,
      marketingOptInWarningPhones: [],
    });

    const result = await findBirthdayAudiencePage({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      templateCategory: "MARKETING",
      scheduledFor: new Date("2026-07-23T09:00:00.000Z"),
      timezone: "UTC",
      limit: 100,
      deferMarketingPolicy: true,
    } as Parameters<typeof findBirthdayAudiencePage>[0]);

    expect(mockFilterKnownMarketingOptOutRecipients).not.toHaveBeenCalled();
    expect(result.recipients.map(recipient => recipient.customerId)).toEqual([
      optedOutId.toHexString(),
      eligibleId.toHexString(),
    ]);
    expect(result.skippedMarketingOptIn).toBe(0);
  });
});

describe("birthday recipient identity projection", () => {
  const scheduledFor = new Date("2026-07-23T09:00:00.000Z");
  const phoneIdentity = (phone: string) => ({
    type: "phone",
    channel: "whatsapp",
    value: phone,
    normalizedValue: phone,
  });
  const customer = (
    identities: Array<Record<string, string>>,
    displayName = "Birthday customer"
  ) => ({
    _id: new Types.ObjectId(),
    displayName,
    identities,
    profileDates: { birthday: { month: 7, day: 23, source: "csv" } },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockEnsureCustomerBirthdayIndexes.mockResolvedValue(undefined);
    mockCustomerCountDocuments.mockResolvedValue(0);
    mockFilterKnownMarketingOptOutRecipients.mockImplementation(
      async ({ recipients }) => ({
        recipients,
        skippedOptIn: 0,
        marketingOptInWarningCount: 0,
      })
    );
    mockFindEligibleTelegramSubscriberMap.mockResolvedValue(new Map());
  });

  it("uses the selected second phone of a customer instead of the first phone", async () => {
    mockCustomerFind.mockReturnValue(
      customerQuery([
        customer([phoneIdentity("15550000001"), phoneIdentity("15550000002")]),
      ])
    );

    const page = await findBirthdayAudiencePage({
      workspaceId: "workspace-1",
      scheduledFor,
      timezone: "UTC",
      recipientPhones: ["+1 555 000 0002"],
      deferMarketingPolicy: true,
    });

    expect(page.recipients.map(recipient => recipient.phone)).toEqual([
      "15550000002",
    ]);
  });

  it("projects every selected phone once across duplicate identities and customers", async () => {
    mockCustomerFind.mockReturnValue(
      customerQuery([
        customer([
          phoneIdentity("15550000001"),
          phoneIdentity("+1 555 000 0001"),
          phoneIdentity("15550000002"),
        ]),
        customer([phoneIdentity("15550000002")], "Duplicate customer"),
      ])
    );

    const page = await findBirthdayAudiencePage({
      workspaceId: "workspace-1",
      scheduledFor,
      timezone: "UTC",
      recipientPhones: ["15550000001", "15550000002"],
      deferMarketingPolicy: true,
    });

    expect(page.recipients.map(recipient => recipient.phone)).toEqual([
      "15550000001",
      "15550000002",
    ]);
    expect(page.candidateCount).toBe(2);
    expect(page.recipients[1].name).toBe("Birthday customer");
  });

  it("fails closed for an explicitly empty selected phone list", async () => {
    mockCustomerFind.mockReturnValue(
      customerQuery([customer([phoneIdentity("15550000001")])])
    );

    const page = await findBirthdayAudiencePage({
      workspaceId: "workspace-1",
      scheduledFor,
      timezone: "UTC",
      recipientPhones: [],
      deferMarketingPolicy: true,
    });

    expect(page.recipients).toEqual([]);
    expect(page.candidateCount).toBe(0);
  });

  it("projects selected Telegram chats only for their bot and dedupes composite IDs", async () => {
    mockCustomerFind.mockReturnValue(
      customerQuery([
        customer([
          {
            type: "channel_chat",
            channel: "telegram",
            sourceId: "other-bot",
            normalizedValue: "654321",
          },
          {
            type: "channel_chat",
            channel: "telegram",
            sourceId: "source-1",
            normalizedValue: "123456",
          },
          {
            type: "channel_chat",
            channel: "telegram",
            sourceId: "source-1",
            normalizedValue: "tg_654321_source-1",
          },
          {
            type: "channel_chat",
            channel: "telegram",
            sourceId: "source-1",
            normalizedValue: "654321",
          },
          {
            type: "channel_chat",
            channel: "telegram",
            sourceId: "source-1",
            normalizedValue: "-100123",
          },
        ]),
      ])
    );
    mockFindEligibleTelegramSubscriberMap.mockResolvedValue(
      new Map([
        ["123456:source-1", { status: "active" }],
        ["654321:source-1", { status: "active" }],
      ])
    );

    const page = await findBirthdayAudiencePage({
      workspaceId: "workspace-1",
      channel: "telegram",
      telegramSourceId: "source-1",
      recipientChatIds: ["654321"],
      scheduledFor,
      timezone: "UTC",
    });

    expect(
      page.recipients.map(recipient => [recipient.chatId, recipient.sourceId])
    ).toEqual([["654321", "source-1"]]);
  });

  it("projects every eligible selected Telegram chat and fails closed for an empty selection", async () => {
    mockCustomerFind.mockReturnValue(
      customerQuery([
        customer([
          {
            type: "channel_chat",
            channel: "telegram",
            sourceId: "source-1",
            normalizedValue: "123456",
          },
          {
            type: "channel_chat",
            channel: "telegram",
            sourceId: "source-1",
            normalizedValue: "654321",
          },
        ]),
      ])
    );
    mockFindEligibleTelegramSubscriberMap.mockResolvedValue(
      new Map([
        ["123456:source-1", { status: "active" }],
        ["654321:source-1", { status: "active" }],
      ])
    );
    const params = {
      workspaceId: "workspace-1",
      channel: "telegram" as const,
      telegramSourceId: "source-1",
      scheduledFor,
      timezone: "UTC",
    };

    const selected = await findBirthdayAudiencePage({
      ...params,
      recipientChatIds: ["123456", "654321"],
    });
    const empty = await findBirthdayAudiencePage({
      ...params,
      recipientChatIds: [],
    });

    expect(selected.recipients.map(recipient => recipient.chatId)).toEqual([
      "123456",
      "654321",
    ]);
    expect(empty.recipients).toEqual([]);
  });

  it.each([
    [
      "2027-02-28T09:00:00Z",
      "UTC",
      [
        { "profileDates.birthday.month": 2, "profileDates.birthday.day": 28 },
        { "profileDates.birthday.month": 2, "profileDates.birthday.day": 29 },
      ],
    ],
    [
      "2028-02-28T09:00:00Z",
      "UTC",
      [{ "profileDates.birthday.month": 2, "profileDates.birthday.day": 28 }],
    ],
    [
      "2026-07-22T22:00:00Z",
      "Asia/Qyzylorda",
      [{ "profileDates.birthday.month": 7, "profileDates.birthday.day": 23 }],
    ],
  ])(
    "matches the local birthday date for %s in %s",
    async (date, timezone, clauses) => {
      mockCustomerFind.mockReturnValue(customerQuery([]));

      await findBirthdayAudiencePage({
        workspaceId: "workspace-1",
        scheduledFor: new Date(date),
        timezone,
      });

      expect(mockCustomerFind.mock.calls[0][0].$or).toEqual(clauses);
    }
  );

  it("keeps customer cursor pagination when a customer expands into multiple recipients", async () => {
    const record = customer([
      phoneIdentity("15550000001"),
      phoneIdentity("15550000002"),
    ]);
    mockCustomerFind.mockReturnValue(customerQuery([record]));

    const page = await findBirthdayAudiencePage({
      workspaceId: "workspace-1",
      scheduledFor,
      timezone: "UTC",
      recipientPhones: ["15550000001", "15550000002"],
      limit: 1,
      deferMarketingPolicy: true,
    });

    expect(page.recipients).toHaveLength(2);
    expect(page.nextCursor).toBe(record._id.toHexString());
  });

  it("counts and pages eligible recipients after expansion, dedupe and opt-out exclusion", async () => {
    const first = customer([
      phoneIdentity("15550000001"),
      phoneIdentity("15550000002"),
    ]);
    const second = customer([
      phoneIdentity("15550000002"),
      phoneIdentity("15550000003"),
    ]);
    mockCustomerFind.mockReturnValue(customerQuery([first, second]));
    mockCustomerCountDocuments.mockResolvedValue(2);
    mockFilterKnownMarketingOptOutRecipients.mockImplementation(
      async ({ recipients }) => ({
        recipients: recipients.filter(
          (recipient: { phone: string }) => recipient.phone !== "15550000002"
        ),
        skippedOptIn: 1,
        marketingOptInWarningCount: 1,
      })
    );

    const preview = await buildBirthdayAudiencePreview({
      workspaceId: "workspace-1",
      scheduledFor,
      timezone: "UTC",
      templateCategory: "MARKETING",
      recipientPhones: ["15550000001", "15550000002", "15550000003"],
      page: 2,
      limit: 1,
    });

    expect(preview.total).toBe(3);
    expect(preview.eligibleTotal).toBe(2);
    expect(preview.items).toEqual([
      expect.objectContaining({
        _id: second._id.toHexString(),
        recipient: "15550000003",
      }),
    ]);
    expect(preview.marketingOptInWarningCount).toBe(1);
    expect(preview.birthdayAudience).toEqual({
      storedTotal: 2,
      scanCapped: false,
    });
  });

  it("reports missing-consent warnings without counting excluded opt-outs as warnings", async () => {
    mockCustomerFind.mockReturnValue(
      customerQuery([customer([phoneIdentity("15550000001")])])
    );
    mockCustomerCountDocuments.mockResolvedValue(1);
    mockFilterKnownMarketingOptOutRecipients.mockImplementation(
      async ({ recipients }) => ({
        recipients,
        skippedOptIn: 0,
        marketingOptInWarningCount: 1,
      })
    );

    const preview = await buildBirthdayAudiencePreview({
      workspaceId: "workspace-1",
      scheduledFor,
      timezone: "UTC",
      templateCategory: "MARKETING",
    });

    expect(preview.marketingOptInWarningCount).toBe(1);
  });

  it("does not report an excluded opt-out as a missing-consent warning", async () => {
    mockCustomerFind.mockReturnValue(
      customerQuery([customer([phoneIdentity("15550000001")])])
    );
    mockCustomerCountDocuments.mockResolvedValue(1);
    mockFilterKnownMarketingOptOutRecipients.mockResolvedValue({
      recipients: [],
      skippedOptIn: 1,
      marketingOptInWarningCount: 0,
    });

    const preview = await buildBirthdayAudiencePreview({
      workspaceId: "workspace-1",
      scheduledFor,
      timezone: "UTC",
      templateCategory: "MARKETING",
    });

    expect(preview.total).toBe(1);
    expect(preview.eligibleTotal).toBe(0);
    expect(preview.items).toEqual([]);
    expect(preview.marketingOptInWarningCount).toBe(0);
  });

  it("preserves scan-capped metadata without inflating scanned recipient counts with duplicate customers", async () => {
    mockCustomerFind.mockReturnValue(
      customerQuery([customer([phoneIdentity("15550000001")])])
    );
    mockCustomerCountDocuments.mockResolvedValue(10_001);

    const preview = await buildBirthdayAudiencePreview({
      workspaceId: "workspace-1",
      scheduledFor,
      timezone: "UTC",
    });

    expect(preview.total).toBe(1);
    expect(preview.eligibleTotal).toBe(1);
    expect(preview.birthdayAudience.scanCapped).toBe(true);
  });
});
