jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: jest.fn(),
  },
}));

const { Conversation } = jest.requireMock("@/models/conversation") as {
  Conversation: { find: jest.Mock };
};

import { filterKnownMarketingOptOutRecipients } from "./marketing-opt-in";

function mockConversationFind(rows: unknown[]) {
  const lean = jest.fn().mockResolvedValue(rows);
  const select = jest.fn(() => ({ lean }));
  Conversation.find.mockReturnValue({ select });
  return { select, lean };
}

describe("filterKnownMarketingOptOutRecipients", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("returns an empty consent result without querying when no marketing recipients are supplied", async () => {
    await expect(
      filterKnownMarketingOptOutRecipients({
        workspaceId: "workspace-1",
        recipients: [],
      })
    ).resolves.toEqual({
      recipients: [],
      skippedRecipients: [],
      skippedOptIn: 0,
      skippedPhones: [],
      marketingOptInWarningRecipients: [],
      marketingOptInWarningCount: 0,
      marketingOptInWarningPhones: [],
    });
    expect(Conversation.find).not.toHaveBeenCalled();
  });

  it("allows recipients without positive explicit marketing consent and reports warning metadata", async () => {
    const query = mockConversationFind([
      {
        user: "wa_77010000001",
        whatsapp_opt_in: {
          status: false,
          source: null,
        },
      },
      {
        user: "wa_77010000002",
        whatsapp_opt_in: {
          status: true,
          source: "manual_import_with_proof",
        },
      },
    ]);

    const result = await filterKnownMarketingOptOutRecipients({
      workspaceId: "workspace-1",
      recipients: [
        { phone: "+7 701 000 00 01" },
        { phone: "+7 701 000 00 02" },
      ],
    });

    expect(Conversation.find).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        channel: "whatsapp",
      })
    );
    expect(Conversation.find.mock.calls[0]?.[0]).not.toHaveProperty(
      "whatsapp_opt_in.status"
    );
    expect(Conversation.find.mock.calls[0]?.[0]).not.toHaveProperty(
      "whatsapp_opt_in.source"
    );
    expect(query.select).toHaveBeenCalledWith("chat user whatsapp_opt_in");
    expect(result.recipients).toEqual([
      { phone: "+7 701 000 00 01" },
      { phone: "+7 701 000 00 02" },
    ]);
    expect(result.skippedRecipients).toEqual([]);
    expect(result.skippedOptIn).toBe(0);
    expect(result.marketingOptInWarningRecipients).toEqual([
      { phone: "+7 701 000 00 01" },
    ]);
    expect(result.marketingOptInWarningCount).toBe(1);
    expect(result.marketingOptInWarningPhones).toEqual(["77010000001"]);
  });

  it("excludes an explicit opt-out but does not treat the default false status as an opt-out", async () => {
    mockConversationFind([
      {
        user: "wa_77010000001",
        whatsapp_opt_in: {
          status: false,
          source: "whatsapp_user_preferences",
        },
      },
      {
        user: "wa_77010000002",
        whatsapp_opt_in: {
          status: false,
          source: null,
        },
      },
      {
        user: "wa_77010000003",
        whatsapp_opt_in: {
          status: true,
          source: "manual_import_with_proof",
        },
      },
    ]);

    const result = await filterKnownMarketingOptOutRecipients({
      workspaceId: "workspace-1",
      recipients: [
        { phone: "+7 701 000 00 01" },
        { phone: "+7 701 000 00 02" },
        { phone: "+7 701 000 00 03" },
      ],
    });

    expect(result.recipients).toEqual([
      { phone: "+7 701 000 00 02" },
      { phone: "+7 701 000 00 03" },
    ]);
    expect(result.skippedRecipients).toEqual([{ phone: "+7 701 000 00 01" }]);
    expect(result.skippedOptIn).toBe(1);
    expect(result.skippedPhones).toEqual(["77010000001"]);
    expect(result.marketingOptInWarningRecipients).toEqual([
      { phone: "+7 701 000 00 02" },
    ]);
    expect(result.marketingOptInWarningPhones).toEqual(["77010000002"]);
  });

  it("matches an explicit opt-out stored under the legacy national WhatsApp identity", async () => {
    Conversation.find.mockImplementation(
      (filter: {
        $or: Array<{
          chat?: { $in: Array<string | number> };
        }>;
      }) => {
        const lookupValues = filter.$or[0]?.chat?.$in || [];
        const rows = lookupValues.includes("wa_87010000001")
          ? [
              {
                user: "wa_87010000001",
                whatsapp_opt_in: {
                  status: false,
                  source: "whatsapp_user_preferences",
                  updatedAt: "2026-07-25T10:00:00.000Z",
                },
              },
            ]
          : [];
        const lean = jest.fn().mockResolvedValue(rows);
        const select = jest.fn(() => ({ lean }));
        return { select };
      }
    );

    const result = await filterKnownMarketingOptOutRecipients({
      workspaceId: "workspace-1",
      recipients: [{ phone: "+7 701 000 00 01" }],
    });

    expect(result.recipients).toEqual([]);
    expect(result.skippedRecipients).toEqual([{ phone: "+7 701 000 00 01" }]);
    expect(result.skippedPhones).toEqual(["77010000001"]);
    for (const [filter] of Conversation.find.mock.calls as Array<
      [{ $or: Array<Record<string, { $in: unknown[] }>> }]
    >) {
      for (const clause of filter.$or) {
        expect(Object.values(clause)[0]?.$in.length).toBeLessThanOrEqual(500);
      }
    }
  });

  it("uses the latest recorded preference when duplicate conversations disagree", async () => {
    mockConversationFind([
      {
        user: "wa_77010000001",
        whatsapp_opt_in: {
          status: false,
          source: "whatsapp_user_preferences",
          updatedAt: "2026-07-25T08:00:00.000Z",
        },
      },
      {
        user: "wa_77010000001",
        whatsapp_opt_in: {
          status: true,
          source: "whatsapp_user_preferences",
          updatedAt: "2026-07-25T09:00:00.000Z",
        },
      },
      {
        user: "wa_77010000002",
        whatsapp_opt_in: {
          status: true,
          source: "whatsapp_user_preferences",
          updatedAt: "2026-07-25T08:00:00.000Z",
        },
      },
      {
        user: "wa_77010000002",
        whatsapp_opt_in: {
          status: false,
          source: "whatsapp_user_preferences",
          updatedAt: "2026-07-25T09:00:00.000Z",
        },
      },
    ]);

    const result = await filterKnownMarketingOptOutRecipients({
      workspaceId: "workspace-1",
      recipients: [
        { phone: "+7 701 000 00 01" },
        { phone: "+7 701 000 00 02" },
      ],
    });

    expect(result.recipients).toEqual([{ phone: "+7 701 000 00 01" }]);
    expect(result.skippedRecipients).toEqual([{ phone: "+7 701 000 00 02" }]);
    expect(result.skippedPhones).toEqual(["77010000002"]);
    expect(result.marketingOptInWarningRecipients).toEqual([]);
  });

  it("applies an explicit opt-out when a BSUID is stored before the recipient phone identity", async () => {
    mockConversationFind([
      {
        user: { _id: "wa_bsuid_123456789" },
        chat: { whatsapp: { waId: "77010000001" } },
        whatsapp_opt_in: {
          status: false,
          source: "whatsapp_user_preferences",
          updatedAt: "2026-07-25T10:00:00.000Z",
        },
      },
    ]);

    const result = await filterKnownMarketingOptOutRecipients({
      workspaceId: "workspace-1",
      recipients: [{ phone: "+7 701 000 00 01" }],
    });

    expect(result.recipients).toEqual([]);
    expect(result.skippedRecipients).toEqual([{ phone: "+7 701 000 00 01" }]);
    expect(result.skippedOptIn).toBe(1);
    expect(result.skippedPhones).toEqual(["77010000001"]);
  });

  it("excludes a recipient with no canonical WhatsApp identity even when every phone lookup opted in", async () => {
    mockConversationFind([
      {
        user: "wa_77010000002",
        whatsapp_opt_in: {
          status: true,
          source: "manual_import_with_proof",
        },
      },
    ]);

    const result = await filterKnownMarketingOptOutRecipients({
      workspaceId: "workspace-1",
      recipients: [{ phone: "+7 701 000 00 02" }, { name: "Missing number" }],
    });

    expect(result.recipients).toEqual([{ phone: "+7 701 000 00 02" }]);
    expect(result.skippedRecipients).toEqual([{ name: "Missing number" }]);
    expect(result.skippedOptIn).toBe(1);
    expect(result.marketingOptInWarningRecipients).toEqual([]);
    expect(result.marketingOptInWarningCount).toBe(0);
    expect(result.marketingOptInWarningPhones).toEqual([]);
  });

  it("chunks consent identity lookups without changing explicit opt-out results", async () => {
    const phones = Array.from({ length: 501 }, (_, index) =>
      String(900_000_000_000 + index)
    );
    const optedOutPhones = new Set([phones[0], phones[500]]);
    Conversation.find.mockImplementation(
      (filter: {
        $or: Array<{
          chat?: { $in: Array<string | number> };
        }>;
      }) => {
        const lookupValues = filter.$or[0]?.chat?.$in || [];
        const rows = Array.from(optedOutPhones)
          .filter(phone => lookupValues.includes(`wa_${phone}`))
          .map(phone => ({
            user: `wa_${phone}`,
            whatsapp_opt_in: {
              status: false,
              source: "whatsapp_user_preferences",
              updatedAt: "2026-07-25T10:00:00.000Z",
            },
          }));
        const lean = jest.fn().mockResolvedValue(rows);
        const select = jest.fn(() => ({ lean }));
        return { select };
      }
    );

    const result = await filterKnownMarketingOptOutRecipients({
      workspaceId: "workspace-1",
      recipients: phones.map(phone => ({ phone })),
    });

    expect(result.skippedPhones).toEqual([phones[0], phones[500]]);
    expect(result.skippedRecipients).toEqual([
      { phone: phones[0] },
      { phone: phones[500] },
    ]);
    expect(result.recipients).toHaveLength(499);
    expect(Conversation.find.mock.calls.length).toBeGreaterThan(1);
    for (const [filter] of Conversation.find.mock.calls as Array<
      [
        {
          $or: Array<
            Record<
              string,
              {
                $in: unknown[];
              }
            >
          >;
        },
      ]
    >) {
      for (const clause of filter.$or) {
        const values = Object.values(clause)[0]?.$in || [];
        expect(values.length).toBeLessThanOrEqual(500);
      }
    }
  });
});
