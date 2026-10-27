let mockStored: any;
let mockConversation: any;
let mockCanonicalWrites = 0;
let mockReferralResolve: () => Promise<any>;
let mockHydrateDefaults = false;
let mockSelectedConversation: typeof mockConversation;
let mockCanonicalChat: typeof mockConversation;
let mockInsertNewMessage = false;
const mockAppendMessage = jest.fn();
const mockChatFindById = jest.fn();
const mockQuery = (value: any) => ({
  select: () => mockQuery(value),
  limit: () => mockQuery(value),
  lean: async () => value,
  populate: () => mockQuery(value),
  then: (
    resolve: (value: any) => unknown,
    reject: (error: unknown) => unknown
  ) =>
    Promise.resolve(
      mockHydrateDefaults && value?._id && value.whatsappReferral === undefined
        ? {
            ...value,
            whatsappReferral: {
              sourceId: null,
              ctwaClid: null,
              sourceType: null,
            },
          }
        : value
    ).then(resolve, reject),
});
const mockIdentityModel = {
  find: () => mockQuery([]),
  findOneAndUpdate: () => ({
    exec: async () => ({ _id: "wa_70000000000", isBot: false }),
  }),
};
const mockMessageModel = class {
  $locals = {};
  constructor(data: any) {
    Object.assign(this, data);
  }
  async save() {
    if (mockInsertNewMessage) {
      Object.assign(this, { _id: "new-history-message" });
      mockStored = this;
      return;
    }
    throw Object.assign(new Error("duplicate"), { code: 11000 });
  }
  static findOne() {
    return mockQuery(mockStored);
  }
  static findById() {
    return mockQuery(mockStored);
  }
  static findOneAndUpdate(filter: any, update: any) {
    const matches = Object.entries(filter).every(
      ([key, value]) =>
        JSON.stringify(mockStored[key] ?? null) === JSON.stringify(value)
    );
    if (!matches) return mockQuery(null);
    mockStored = { ...mockStored, ...update.$set };
    mockCanonicalWrites++;
    return mockQuery(mockStored);
  }
};

jest.mock("@icecore/airi-runtime/mongoose", () => ({
  __esModule: true,
  default: async () => undefined,
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: mockMessageModel,
}));
jest.mock("@/models/user", () => ({
  __esModule: true,
  default: mockIdentityModel,
}));
jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: {
    ...mockIdentityModel,
    findOneAndUpdate: async () => ({ _id: "wa_70000000000" }),
    findById: (...args: unknown[]) => mockChatFindById(...args),
  },
}));
jest.mock("@/models/conversation", () => ({
  Conversation: class {
    _id = "losing-conversation";
    constructor(data: Record<string, unknown>) {
      Object.assign(this, data);
    }
    async save() {}
    static findById(id: unknown) {
      return mockQuery(
        String(id) === "conversation-1"
          ? mockConversation
          : mockSelectedConversation
      );
    }
    static async updateOne(_filter: any, update: any) {
      Object.assign(mockConversation, update.$set);
      return { modifiedCount: 1 };
    }
    static async findOneAndUpdate(filter: any, update: any) {
      if (
        JSON.stringify(mockConversation.whatsappReferral ?? null) !==
        JSON.stringify(filter.whatsappReferral)
      )
        return null;
      mockConversation = { ...mockConversation, ...update.$set };
      return mockConversation;
    }
  },
}));
jest.mock("@/lib/whatsapp/conversation-lookup", () => ({
  getOrCreateWhatsAppConversation: async ({ create }: { create: (key: string, aliases: string[]) => Promise<unknown> }) =>
    mockSelectedConversation
      ? { conversation: mockSelectedConversation, created: false }
      : { conversation: await create("test-identity-key", ["test-identity-key"]), created: true },
}));
jest.mock("@/models/whatsapp-pending-message-mutation", () => ({
  __esModule: true,
  default: {
    find: () => ({ sort: () => ({ lean: async () => [] }) }),
  },
}));
jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (...args: unknown[]) =>
    mockAppendMessage(...args),
}));
jest.mock("@/lib/whatsapp/identity/indexes", () => ({
  ensureWhatsAppIdentityIndexes: async () => undefined,
}));
jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceBotRuntimeSettings: async () => ({}),
}));
jest.mock("@/lib/posthog/server", () => ({ getPostHogClient: () => null }));
jest.mock("@/lib/meta-ads/meta-ad-metadata", () => ({
  isConfirmedCampaignLabelStatus: (status: string) =>
    status === "present" || status === "absent",
  resolveMetaAdMetadataForWorkspace: () => mockReferralResolve(),
}));

const { processWhatsAppMessage } =
  require("@icecore/airi-runtime/whatsapp-message-processor") as typeof import("@icecore/airi-runtime/whatsapp-message-processor");
const { buildWhatsAppMessageRawSourcePayload } =
  require("@icecore/shared/lib/whatsapp/webhook-payload") as typeof import("@icecore/shared/lib/whatsapp/webhook-payload");
const { buildCustomerMessageWebhookIntent } =
  require("@/lib/customer-webhook-intents") as typeof import("@/lib/customer-webhook-intents");

const unavailable: any = {
  id: "wamid-1",
  type: "unsupported",
  unsupported: { type: "unknown" },
  errors: [{ code: 131060 }],
};
const rich: any = {
  id: "wamid-1",
  type: "text",
  text: { body: "Interested in a medal" },
  referral: { source_type: "ad", source_id: "ad-1", ctwa_clid: "click-1" },
};
function raw(messageData: any, eventType = "message") {
  return buildWhatsAppMessageRawSourcePayload({
    body: { object: "whatsapp_business_account", entry: [] },
    entry: { id: "waba-1", changes: [] },
    change: { field: "messages", value: {} },
    value: {},
    messageData,
    sourceId: "source-1",
    direction: "inbound",
    capturedAt: new Date("2026-10-07T00:00:00Z"),
    eventType,
  });
}
async function processMessage(
  messageData: any,
  eventType = "message",
  overrides: Partial<Parameters<typeof processWhatsAppMessage>[0]> = {}
) {
  return processWhatsAppMessage({
    messageData,
    contactData: {
      waId: "70000000000",
      profile: { name: "Customer" },
      primaryIdType: "wa_id",
    },
    phoneNumberId: "phone-1",
    workspaceId: "workspace-1",
    direction: "inbound",
    sourceId: "source-1",
    messageDate: new Date("2026-10-07T00:00:00Z"),
    conversationId:
      eventType === "history_message" ? undefined : "conversation-1",
    rawSourcePayload: raw(messageData, eventType),
    deferReferralEnrichment: true,
    ...overrides,
  });
}
// Deferral keeps the raw referral (the webhook runtime queues Meta ad
// metadata); cases that assert enrichment use the inline path instead.
const inlineReferralEnrichment = { deferReferralEnrichment: false };

describe("canonical WhatsApp content recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanonicalWrites = 0;
    mockHydrateDefaults = false;
    mockInsertNewMessage = false;
    mockStored = {
      _id: "message-1",
      workspaceId: "workspace-1",
      conversation: "conversation-1",
      chat: "wa_70000000000",
      direction: "inbound",
      channel: "whatsapp",
      text: "[WhatsApp message unavailable: open WhatsApp Business app to view]",
      rawSourcePayload: raw(unavailable),
    };
    mockConversation = {
      _id: "conversation-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      chat: "wa_70000000000",
      status: "open",
      save: async () => undefined,
    };
    mockSelectedConversation = mockConversation;
    mockCanonicalChat = {
      _id: "wa_canonical_customer",
      workspaceId: "workspace-1",
    };
    mockChatFindById.mockImplementation(async () => mockCanonicalChat);
    mockAppendMessage.mockResolvedValue(undefined);
    mockReferralResolve = async () => ({
      campaignId: "campaign-1",
      campaignName: "Medals",
      adSetId: "adset-1",
      adAccountId: "act-1",
      campaignLabelStatus: "present",
      campaignLabels: [{ id: "medal" }],
    });
  });

  it.each([undefined, "losing-conversation"])(
    "recovers the persisted owner after an insert race with input conversation %s",
    async conversationId => {
      mockSelectedConversation = conversationId
        ? {
            _id: conversationId,
            workspaceId: "workspace-1",
            sourceId: "source-1",
            status: "open",
          }
        : null;
      const claimWebsiteCart = jest.fn();
      const cartMessage = {
        id: "wamid-1",
        type: "text",
        text: { body: `Order\nAIRI-CART:${"a".repeat(48)}` },
      };

      const result = await processMessage(cartMessage, "message", {
        conversationId,
        claimWebsiteCart,
      });

      expect(result).toEqual(
        expect.objectContaining({
          conversationId: "conversation-1",
          conversation: mockConversation,
          messageWasNew: false,
          isNewConversation: false,
          reopenedConversation: false,
          messageRecoveryRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
        })
      );
      expect(result.message?.conversation).toBe(result.conversationId);
      expect(mockAppendMessage).toHaveBeenCalledTimes(1);
      expect(mockAppendMessage).toHaveBeenCalledWith(
        "conversation-1",
        "message-1",
        expect.objectContaining({ direction: "inbound" })
      );
      expect(claimWebsiteCart).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conversation-1",
          messageId: "message-1",
        })
      );
    }
  );

  it("uses the persisted conversation's chat after a duplicate race", async () => {
    mockSelectedConversation = null;
    mockConversation.chat = mockCanonicalChat._id;
    mockStored.chat = mockCanonicalChat._id;
    const result = await processMessage(unavailable, "message", {
      conversationId: undefined,
    });
    expect(result.chatId).toBe(mockCanonicalChat._id);
    expect(result.chat).toBe(mockCanonicalChat);
  });

  it("recovers deferred media under its persisted conversation owner", async () => {
    mockSelectedConversation = null;
    const result = await processMessage(
      {
        id: "wamid-1",
        type: "audio",
        audio: { id: "media-1", mime_type: "audio/ogg" },
      },
      "message",
      { conversationId: undefined, deferMediaHydration: true }
    );
    expect(result.message?.imageUrl).toBe(
      "/api/conversations/conversation-1/whatsapp-media/media-1"
    );
    expect(result.mediaAnalysisType).toBe("audio");
  });

  it.each(["missing", "other-workspace"])(
    "rejects a duplicate whose canonical conversation is %s before appending",
    async failure => {
      mockSelectedConversation = null;
      mockConversation =
        failure === "missing"
          ? null
          : { ...mockConversation, workspaceId: "workspace-2" };
      await expect(
        processMessage(unavailable, "message", { conversationId: undefined })
      ).rejects.toThrow(
        "WhatsApp duplicate message conversation ownership mismatch"
      );
      expect(mockAppendMessage).not.toHaveBeenCalled();
      expect(mockCanonicalWrites).toBe(0);
    }
  );

  it.each(["missing", "other-workspace"])(
    "rejects a duplicate whose canonical chat is %s before appending",
    async failure => {
      mockSelectedConversation = null;
      mockConversation.chat = mockCanonicalChat._id;
      mockStored.chat = mockCanonicalChat._id;
      mockCanonicalChat =
        failure === "missing"
          ? null
          : { ...mockCanonicalChat, workspaceId: "workspace-2" };
      await expect(
        processMessage(unavailable, "message", { conversationId: undefined })
      ).rejects.toThrow("WhatsApp duplicate message chat ownership mismatch");
      expect(mockAppendMessage).not.toHaveBeenCalled();
    }
  );

  it("does not acknowledge duplicate recovery when the canonical append fails", async () => {
    mockSelectedConversation = null;
    const error = new Error("canonical append unavailable");
    mockAppendMessage.mockRejectedValueOnce(error);
    await expect(
      processMessage(unavailable, "message", { conversationId: undefined })
    ).rejects.toBe(error);
    expect(mockAppendMessage.mock.calls[0][0]).toBe("conversation-1");
  });

  it("uses persisted snapshots when Mongoose supplies defaults absent from a legacy row", async () => {
    mockHydrateDefaults = true;
    const result = await processMessage(rich);
    expect(result.message?.text).toBe("Interested in a medal");
    expect(mockCanonicalWrites).toBe(1);
    expect(mockConversation.whatsappReferral.sourceId).toBe("ad-1");
  });

  it("history recovery preserves a closed conversation", async () => {
    mockConversation.status = "closed";
    await processMessage(rich, "history_message");
    expect(mockConversation.status).toBe("closed");
  });

  it("imports a new cart message without reopening or making its conversation unread", async () => {
    mockStored = null;
    mockInsertNewMessage = true;
    mockConversation.status = "closed";
    mockConversation.is_read_by_manager = true;
    mockConversation.last_customer_message_at = new Date("2026-10-09T00:00:00Z");
    const claimWebsiteCart = jest.fn();
    const result = await processMessage(
      {
        id: "wamid-history-cart",
        type: "text",
        text: { body: `Old order\nAIRI-CART:${"a".repeat(48)}` },
      },
      "history_message",
      { importMode: "history", claimWebsiteCart }
    );

    expect(result.messageWasNew).toBe(true);
    expect(result.reopenedConversation).toBe(false);
    expect(result.conversation).toMatchObject({
      status: "closed",
      is_read_by_manager: true,
      last_customer_message_at: new Date("2026-10-09T00:00:00Z"),
    });
    expect(claimWebsiteCart).not.toHaveBeenCalled();
    expect(mockAppendMessage).toHaveBeenCalledWith(
      "conversation-1",
      "new-history-message",
      {
        direction: "inbound",
        lastMessageAt: new Date("2026-10-07T00:00:00Z"),
        historicalUpdatedAt: new Date("2026-10-07T00:00:00Z"),
        importMode: "history",
        set: { workspaceId: "workspace-1" },
      }
    );
    expect(buildCustomerMessageWebhookIntent(result.message!, "source-1")).toBeNull();
    expect(
      buildCustomerMessageWebhookIntent(
        { ...result.message!, rawSourcePayload: { eventType: "message" } },
        "source-1"
      )
    ).toMatchObject({ eventType: "message.received" });
  });

  it("creates a read conversation for a new history import", async () => {
    mockStored = null;
    mockInsertNewMessage = true;
    mockSelectedConversation = null;
    const result = await processMessage(
      { id: "wamid-history-new", type: "text", text: { body: "Past message" } },
      "history_message",
      { importMode: "history" }
    );

    expect(result.messageWasNew).toBe(true);
    expect(result.isNewConversation).toBe(true);
    expect(result.conversation).toMatchObject({ is_read_by_manager: true });
    expect(mockAppendMessage).toHaveBeenCalledWith(
      result.conversationId,
      "new-history-message",
      expect.objectContaining({ importMode: "history" })
    );
    expect(buildCustomerMessageWebhookIntent(result.message!, "source-1")).toBeNull();
  });

  it("does not treat a newly imported rating as the current CSAT answer", async () => {
    mockStored = null;
    mockInsertNewMessage = true;
    mockConversation.awaiting_csat = true;
    const result = await processMessage(
      { id: "wamid-history-rating", type: "text", text: { body: "5" } },
      "history_message",
      { importMode: "history" }
    );

    expect(result.messageWasNew).toBe(true);
    expect(mockConversation.awaiting_csat).toBe(true);
    expect(mockConversation.status).toBe("open");
    expect(mockConversation.customer_satisfaction_score).toBeUndefined();
    expect(buildCustomerMessageWebhookIntent(result.message!, "source-1")).toBeNull();
  });

  it("history recovery repairs content without claiming an old website cart", async () => {
    const oldCart = {
      ...rich,
      text: { body: `Order\nAIRI-CART:${"a".repeat(48)}` },
    };
    const result = await processMessage(oldCart, "history_message");
    expect(result.message?.text).toBe(oldCart.text.body);
  });

  it("history recovery does not consume an old rating as the current CSAT answer", async () => {
    mockConversation.awaiting_csat = true;
    await processMessage({ ...rich, text: { body: "5" } }, "history_message");
    expect(mockConversation.awaiting_csat).toBe(true);
    expect(mockConversation.status).toBe("open");
  });

  it.each(["message", "history_message"])(
    "upgrades a %s placeholder once and returns the durable revision on replay",
    async eventType => {
      const recovered = await processMessage(
        rich,
        eventType,
        inlineReferralEnrichment
      );
      expect(recovered.message?._id).toBe("message-1");
      expect(recovered.message?.text).toBe("Interested in a medal");
      expect(recovered.messageWasNew).toBe(false);
      expect(recovered.messageRecoveryRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(recovered.message?.whatsappReferral?.campaignLabelStatus).toBe(
        "present"
      );
      expect(recovered.conversation?.whatsappReferral?.sourceId).toBe("ad-1");
      const replay = await processMessage(
        rich,
        eventType,
        inlineReferralEnrichment
      );
      expect(replay.messageRecoveryRevision).toBe(
        recovered.messageRecoveryRevision
      );
      expect(mockCanonicalWrites).toBe(1);
      await processMessage(unavailable);
      expect(mockStored.text).toBe("Interested in a medal");
      expect(mockCanonicalWrites).toBe(1);
    }
  );

  it("preserves a first-touch ad with no click id and confirmed metadata through failed enrichment", async () => {
    mockConversation.whatsappReferral = {
      sourceId: "first-ad",
      ctwaClid: null,
      campaignLabelStatus: "present",
      campaignLabels: [{ id: "first-product" }],
    };
    await processMessage(rich, "message", inlineReferralEnrichment);
    mockReferralResolve = async () => null;
    const replay = await processMessage(
      rich,
      "message",
      inlineReferralEnrichment
    );
    expect(mockConversation.whatsappReferral.sourceId).toBe("first-ad");
    expect(mockConversation.whatsappReferral.ctwaClid).toBeNull();
    expect(replay.message?.whatsappReferral?.campaignLabelStatus).toBe(
      "present"
    );
    expect(replay.message?.whatsappReferral?.campaignLabels).toEqual([
      { id: "medal" },
    ]);
    expect(mockCanonicalWrites).toBe(1);
  });
});
