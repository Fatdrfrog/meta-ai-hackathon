const mockConversationFind = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    find: (...args: unknown[]) => mockConversationFind(...args),
  },
}));

import {
  resolveWhatsAppConversationHistoryEligibility,
  resolveWhatsAppServiceWindowEligibility,
} from "./whatsapp-bulk-preflight";

function selectLeanResult<T>(value: T) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

describe("resolveWhatsAppConversationHistoryEligibility", () => {
  beforeEach(() => {
    mockConversationFind.mockReset();
  });

  it("returns only requested phones found through exact-source indexed identity fields", async () => {
    mockConversationFind.mockReturnValue(
      selectLeanResult([{ chat: "wa_77010000001" }])
    );

    const result = await resolveWhatsAppConversationHistoryEligibility({
      workspaceId: "workspace-1",
      sourceId: "source-a",
      phones: ["+7 701 000 00 01", "+7 701 000 00 02"],
    });

    expect(result).toEqual({
      eligiblePhones: ["77010000001"],
      skippedPhones: ["77010000002"],
    });
    expect(mockConversationFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      channel: "whatsapp",
      sourceId: "source-a",
      $or: [
        {
          chat: {
            $in: [
              "77010000001",
              "wa_77010000001",
              "87010000001",
              "wa_87010000001",
              "77010000002",
              "wa_77010000002",
              "87010000002",
              "wa_87010000002",
            ],
          },
        },
        {
          user: {
            $in: [
              "77010000001",
              "wa_77010000001",
              "87010000001",
              "wa_87010000001",
              "77010000002",
              "wa_77010000002",
              "87010000002",
              "wa_87010000002",
            ],
          },
        },
      ],
    });
    const query = mockConversationFind.mock.results[0]?.value;
    expect(query.select).toHaveBeenCalledWith("chat user");
  });

  it("does not accept wrong-source or source-less conversation history", async () => {
    mockConversationFind.mockReturnValue(selectLeanResult([]));

    const result = await resolveWhatsAppConversationHistoryEligibility({
      workspaceId: "workspace-1",
      sourceId: "source-a",
      phones: ["77010000001"],
    });

    expect(result).toEqual({
      eligiblePhones: [],
      skippedPhones: ["77010000001"],
    });
    expect(mockConversationFind).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        channel: "whatsapp",
        sourceId: "source-a",
      })
    );
    expect(JSON.stringify(mockConversationFind.mock.calls)).not.toContain(
      '"sourceId":null'
    );
    expect(JSON.stringify(mockConversationFind.mock.calls)).not.toContain(
      '"$exists"'
    );
  });

  it("chunks requested identity candidates while preserving every eligible phone", async () => {
    const phones = Array.from({ length: 501 }, (_, index) =>
      String(900_000_000_000 + index)
    );
    mockConversationFind.mockImplementation(
      (filter: { $or: Array<{ chat?: { $in: string[] } }> }) => {
        const candidates = filter.$or[0]?.chat?.$in || [];
        return selectLeanResult(
          candidates
            .filter(value => !value.startsWith("wa_"))
            .map(chat => ({ chat }))
        );
      }
    );

    const result = await resolveWhatsAppConversationHistoryEligibility({
      workspaceId: "workspace-1",
      sourceId: "source-a",
      phones,
    });

    expect(result.eligiblePhones).toEqual(phones);
    expect(result.skippedPhones).toEqual([]);
    expect(mockConversationFind.mock.calls.length).toBeGreaterThan(1);
    for (const [filter] of mockConversationFind.mock.calls as Array<
      [
        {
          sourceId: string;
          $or: Array<{ chat?: { $in: string[] }; user?: { $in: string[] } }>;
        },
      ]
    >) {
      expect(filter.sourceId).toBe("source-a");
      for (const clause of filter.$or) {
        const values = clause.chat?.$in || clause.user?.$in || [];
        expect(values.length).toBeLessThanOrEqual(500);
      }
    }
  });
});

describe("resolveWhatsAppServiceWindowEligibility", () => {
  beforeEach(() => {
    mockConversationFind.mockReset();
  });

  it("admits only recipients with an inbound message inside the source-scoped 24-hour window", async () => {
    const now = new Date("2026-07-28T08:00:00.000Z");
    mockConversationFind.mockReturnValue(
      selectLeanResult([
        {
          chat: "wa_77010000001",
          last_inbound_at: new Date("2026-07-27T08:00:01.000Z"),
        },
        {
          user: "77010000002",
          last_inbound_at: new Date("2026-07-27T07:59:59.000Z"),
        },
      ])
    );

    const result = await resolveWhatsAppServiceWindowEligibility({
      workspaceId: "workspace-1",
      sourceId: "source-a",
      phones: ["+7 701 000 00 01", "+7 701 000 00 02"],
      now,
    });

    expect(result).toEqual({
      eligiblePhones: ["77010000001"],
      skippedPhones: ["77010000002"],
      windowExpiresAtByPhone: {
        "77010000001": "2026-07-28T08:00:01.000Z",
      },
    });
    expect(mockConversationFind).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        channel: "whatsapp",
        sourceId: "source-a",
      })
    );
    const query = mockConversationFind.mock.results[0]?.value;
    expect(query.select).toHaveBeenCalledWith("chat user last_inbound_at");
  });

  it("uses the latest inbound timestamp across matching conversations", async () => {
    const now = new Date("2026-07-28T08:00:00.000Z");
    mockConversationFind.mockReturnValue(
      selectLeanResult([
        {
          chat: "77010000001",
          last_inbound_at: new Date("2026-07-27T07:00:00.000Z"),
        },
        {
          user: "wa_77010000001",
          last_inbound_at: new Date("2026-07-28T07:00:00.000Z"),
        },
      ])
    );

    const result = await resolveWhatsAppServiceWindowEligibility({
      workspaceId: "workspace-1",
      sourceId: "source-a",
      phones: ["77010000001"],
      now,
    });

    expect(result).toEqual({
      eligiblePhones: ["77010000001"],
      skippedPhones: [],
      windowExpiresAtByPhone: {
        "77010000001": "2026-07-29T07:00:00.000Z",
      },
    });
  });

  it("fails closed when the source is missing or no inbound timestamp is stored", async () => {
    const missingSource = await resolveWhatsAppServiceWindowEligibility({
      workspaceId: "workspace-1",
      sourceId: " ",
      phones: ["77010000001"],
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    expect(missingSource).toEqual({
      eligiblePhones: [],
      skippedPhones: ["77010000001"],
      windowExpiresAtByPhone: {},
    });
    expect(mockConversationFind).not.toHaveBeenCalled();

    mockConversationFind.mockReturnValue(
      selectLeanResult([{ chat: "77010000001" }])
    );
    const missingInbound = await resolveWhatsAppServiceWindowEligibility({
      workspaceId: "workspace-1",
      sourceId: "source-a",
      phones: ["77010000001"],
      now: new Date("2026-07-28T08:00:00.000Z"),
    });

    expect(missingInbound.eligiblePhones).toEqual([]);
    expect(missingInbound.skippedPhones).toEqual(["77010000001"]);
  });
});
