const mockConnectDB = jest.fn();
const mockMessageFindOne = jest.fn();
const mockConversationFindById = jest.fn();
const mockPendingMutationFind = jest.fn();
const mockAppendMessageToConversationById = jest.fn();

jest.mock("@icecore/airi-runtime/mongoose", () => ({
  __esModule: true,
  default: (...args: Parameters<typeof mockConnectDB>) =>
    mockConnectDB(...args),
}));
jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (
    ...args: Parameters<typeof mockAppendMessageToConversationById>
  ) => mockAppendMessageToConversationById(...args),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {},
}));
jest.mock("@/lib/whatsapp/identity/indexes", () => ({
  ensureWhatsAppIdentityIndexes: jest.fn(async () => undefined),
}));
jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    find: () => {
      throw new Error("A replay must not recreate its customer");
    },
  },
}));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    findOne: (...args: Parameters<typeof mockMessageFindOne>) =>
      mockMessageFindOne(...args),
  },
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: Parameters<typeof mockConversationFindById>) =>
      mockConversationFindById(...args),
  },
}));
jest.mock("@/models/whatsapp-pending-message-mutation", () => ({
  __esModule: true,
  default: {
    find: (...args: Parameters<typeof mockPendingMutationFind>) =>
      mockPendingMutationFind(...args),
  },
}));

import { processWhatsAppMessage } from "@icecore/airi-runtime/whatsapp-message-processor";
import { buildRawSourcePayload } from "@icecore/shared/lib/raw-source-payload";

function pendingMutationQuery(value: unknown[] = []) {
  return {
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

function outboundEchoParams() {
  return {
    messageData: {
      id: "wamid.echo-retry",
      timestamp: "1786348800",
      type: "text" as const,
      text: { body: "Hello" },
      to: "77010000201",
    },
    contactData: {
      waId: "77010000201",
      profile: { name: "Customer" },
      primaryIdType: "wa_id" as const,
    },
    phoneNumberId: "phone-1",
    workspaceId: "workspace-1",
    direction: "outbound" as const,
    sourceId: "source-1",
    messageDate: new Date("2026-08-10T00:00:00.000Z"),
  };
}

describe("WhatsApp outbound echo retry linkage", () => {
  const existingMessage = {
    _id: "64d000000000000000000001",
    messageId: "wamid.echo-retry",
    conversation: "64d000000000000000000002",
  };
  const existingConversation = {
    _id: "64d000000000000000000002",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    const existingMessageQuery = {
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(existingMessage),
      then: (resolve: (value: typeof existingMessage) => unknown) =>
        Promise.resolve(existingMessage).then(resolve),
    };
    mockMessageFindOne.mockReturnValue(existingMessageQuery);
    mockConversationFindById.mockResolvedValue(existingConversation);
    mockPendingMutationFind.mockReturnValue(pendingMutationQuery());
    mockAppendMessageToConversationById.mockResolvedValue({
      appended: false,
      revision: 1,
      generation: 1,
    });
  });

  it("repairs the canonical conversation link before duplicate success", async () => {
    await expect(processWhatsAppMessage(outboundEchoParams())).resolves.toEqual(
      expect.objectContaining({
        message: existingMessage,
        conversationId: "64d000000000000000000002",
        messageWasNew: false,
      })
    );

    expect(mockAppendMessageToConversationById).toHaveBeenCalledWith(
      existingConversation._id,
      existingMessage._id,
      expect.objectContaining({
        direction: "outbound",
        lastMessageAt: new Date("2026-08-10T00:00:00.000Z"),
        set: expect.objectContaining({
          workspaceId: "workspace-1",
        }),
      })
    );
  });

  it("reuses an inbound message on history replay and repairs its conversation link", async () => {
    const params = {
      ...outboundEchoParams(),
      direction: "inbound" as const,
      rawSourcePayload: buildRawSourcePayload({
        provider: "whatsapp",
        eventType: "history_message",
        payload: {},
      }),
    };
    await expect(processWhatsAppMessage(params)).resolves.toEqual(
      expect.objectContaining({
        message: existingMessage,
        messageWasNew: false,
      })
    );
    expect(mockMessageFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1" })
    );
    expect(mockAppendMessageToConversationById).toHaveBeenCalledWith(
      existingConversation._id,
      existingMessage._id,
      expect.objectContaining({ direction: "inbound" })
    );
  });

  it("keeps live inbound retries on the complete processing path", async () => {
    // The later duplicate-key recovery must still run cart handoff and supply
    // media recovery context. An early history-only success would skip both.
    await expect(
      processWhatsAppMessage({ ...outboundEchoParams(), direction: "inbound" })
    ).rejects.toThrow("A replay must not recreate its customer");
    expect(mockMessageFindOne).not.toHaveBeenCalled();
  });

  it("rejects a duplicate echo retry when canonical append fails", async () => {
    const appendError = new Error("append unavailable");
    mockAppendMessageToConversationById.mockRejectedValueOnce(appendError);

    await expect(processWhatsAppMessage(outboundEchoParams())).rejects.toBe(
      appendError
    );
  });
});
