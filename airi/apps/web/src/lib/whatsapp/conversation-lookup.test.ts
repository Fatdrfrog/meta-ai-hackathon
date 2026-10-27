const mockConversationFindOne = jest.fn();

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: (...args: unknown[]) => mockConversationFindOne(...args),
    find: (filter: Record<string, unknown>) => ({
      select: () => ({
        sort: () => ({
          limit: async () => {
            if (!filter.chat && !filter.user) return [];
            if (
              filter.whatsappConversationIdentityKey ||
              filter.$or ||
              filter["airi_scenario_state.lockedScenarioId"]
            )
              return [];
            const result = await mockConversationFindOne(filter)?.sort();
            return result ? [result] : [];
          },
        }),
      }),
    }),
  },
}));

jest.mock("@icecore/shared/lib/whatsapp/contact-identities", () => ({
  parseWhatsAppRecipientTarget: jest.fn().mockReturnValue(null),
  normalizeWhatsAppPhone: jest.fn((value: unknown) => {
    const digits = String(value || "").replace(/\D+/g, "");
    if (!digits) return undefined;
    if (/^8\d{10}$/.test(digits)) return `7${digits.slice(1)}`;
    return digits;
  }),
  listWhatsAppPhoneIdentityVariants: jest.fn((value: unknown) => {
    const digits = String(value || "").replace(/\D+/g, "");
    if (!digits) return [];
    const canonical = /^8\d{10}$/.test(digits) ? `7${digits.slice(1)}` : digits;
    const variants = [canonical];
    if (/^7\d{10}$/.test(canonical)) {
      variants.push(`8${canonical.slice(1)}`);
    }
    if (!variants.includes(digits)) variants.push(digits);
    return variants;
  }),
}));

import { findExistingWhatsAppConversationForRecipient } from "./conversation-lookup";

function findOneResult<T>(value: T) {
  return {
    sort: jest.fn().mockResolvedValue(value),
  };
}

describe("WhatsApp conversation lookup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses indexed source-scoped identity lookups with legacy no-source fallback", async () => {
    mockConversationFindOne
      .mockReturnValueOnce(findOneResult(null))
      .mockReturnValueOnce(findOneResult(null))
      .mockReturnValueOnce(findOneResult({ _id: "conversation-1" }));

    await expect(
      findExistingWhatsAppConversationForRecipient({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        recipient: "+7 700 123 45 67",
      })
    ).resolves.toEqual({ _id: "conversation-1" });

    expect(mockConversationFindOne).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      channel: "whatsapp",
      sourceId: "source-1",
      chat: {
        $in: [
          "+7 700 123 45 67",
          "77001234567",
          "wa_77001234567",
          "87001234567",
          "wa_87001234567",
        ],
      },
    });
    expect(mockConversationFindOne).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      channel: "whatsapp",
      sourceId: "source-1",
      user: {
        $in: [
          "+7 700 123 45 67",
          "77001234567",
          "wa_77001234567",
          "87001234567",
          "wa_87001234567",
        ],
      },
    });
    expect(mockConversationFindOne).toHaveBeenNthCalledWith(3, {
      workspaceId: "workspace-1",
      channel: "whatsapp",
      sourceId: null,
      chat: {
        $in: [
          "+7 700 123 45 67",
          "77001234567",
          "wa_77001234567",
          "87001234567",
          "wa_87001234567",
        ],
      },
    });
    expect(JSON.stringify(mockConversationFindOne.mock.calls)).not.toContain(
      '"$or"'
    );
  });
});
