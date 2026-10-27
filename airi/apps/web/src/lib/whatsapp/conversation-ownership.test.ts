const mockCreateIndex = jest.fn();
const mockFind = jest.fn();
const mockUpdate = jest.fn();
jest.mock("@/models/conversation", () => ({
  Conversation: {
    collection: {
      createIndex: (...args: unknown[]) => mockCreateIndex(...args),
    },
    find: (...args: unknown[]) => ({
      select: () => ({ sort: () => ({ limit: () => mockFind(...args) }) }),
    }),
    findOneAndUpdate: (...args: unknown[]) => mockUpdate(...args),
  },
  CONVERSATION_WHATSAPP_IDENTITY_INDEX_SPEC: {
    keys: { whatsappConversationIdentityKey: 1 },
    options: {
      name: "conversations_whatsapp_identity_owner_v1",
      unique: true,
      partialFilterExpression: {
        channel: "whatsapp",
        whatsappConversationIdentityKey: { $type: "string" },
      },
    },
  },
}));

describe("WhatsApp conversation ownership prerequisites", () => {
  beforeEach(() => {
    jest.resetModules();
    mockCreateIndex.mockReset();
    mockFind.mockReset();
    mockUpdate.mockReset();
  });

  it("fails closed before lookup or creation if the unique index cannot be established, then retries provisioning", async () => {
    const { getOrCreateWhatsAppConversation } = await import(
      "./conversation-lookup"
    );
    const error = Object.assign(new Error("conflicting index options"), {
      code: 85,
    });
    mockCreateIndex
      .mockRejectedValueOnce(error)
      .mockResolvedValue("identity-index");
    const create = jest.fn();
    const params = {
      workspaceId: "workspace",
      sourceId: "source",
      chatId: "wa_77010000202",
      candidateIds: ["wa_77010000202"],
      create,
    };
    await expect(getOrCreateWhatsAppConversation(params)).rejects.toBe(error);
    expect(mockFind).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    mockFind.mockResolvedValue([{ _id: "winner" }]);
    mockUpdate.mockResolvedValue({ _id: "winner" });
    await expect(getOrCreateWhatsAppConversation(params)).resolves.toEqual({
      conversation: { _id: "winner" },
      created: false,
    });
    expect(mockCreateIndex).toHaveBeenCalledTimes(4);
    expect(create).not.toHaveBeenCalled();
  });

  it("preserves BSUID case and group identities while normalizing phone and BSUID aliases", async () => {
    const { buildWhatsAppConversationIdentityKey: key } = await import(
      "./conversation-lookup"
    );
    const scope = { workspaceId: "workspace", sourceId: "source" };
    expect(key({ ...scope, chatId: "wa_87010000202" })).toBe(
      key({ ...scope, chatId: "wa_77010000202" })
    );
    expect(key({ ...scope, chatId: "wa_bsuid_US.Customer" })).toBe(
      key({ ...scope, chatId: "US.Customer" })
    );
    expect(key({ ...scope, chatId: "wa_bsuid_US.Customer" })).not.toBe(
      key({ ...scope, chatId: "wa_bsuid_US.customer" })
    );
    expect(key({ ...scope, chatId: "wa_group_123" })).not.toBe(
      key({ ...scope, chatId: "wa_123" })
    );
  });
});
