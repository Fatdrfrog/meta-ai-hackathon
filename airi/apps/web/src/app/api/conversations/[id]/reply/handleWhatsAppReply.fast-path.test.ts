const mockCheckMessagingWindowForConversation = jest.fn();
const mockEnqueueAiriCoachJobBestEffort = jest.fn();
const mockFindOne = jest.fn();
const mockPersistManagerOutboundMessage = jest.fn();
const mockResolveStoredWhatsAppRecipientTarget = jest.fn();
const mockResolveWhatsAppSendContext = jest.fn();
const mockSendWhatsappMedia = jest.fn();
const mockSendWhatsappMessage = jest.fn();
const mockUpsertManagerAuthor = jest.fn();
const mockUserFindById = jest.fn();

jest.mock("@/lib/airi/coach/coach-jobs", () => ({
  enqueueAiriCoachJobBestEffort: (...args: unknown[]) =>
    mockEnqueueAiriCoachJobBestEffort(...args),
}));

jest.mock("@/lib/conversation-messages", () => ({
  persistManagerOutboundMessage: (...args: unknown[]) =>
    mockPersistManagerOutboundMessage(...args),
  upsertManagerAuthor: (...args: unknown[]) => mockUpsertManagerAuthor(...args),
}));

jest.mock("@/lib/messaging-window", () => ({
  checkMessagingWindowForConversation: (...args: unknown[]) =>
    mockCheckMessagingWindowForConversation(...args),
  formatWindowMessage: () => "window closed",
}));

jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappMedia: (...args: unknown[]) => mockSendWhatsappMedia(...args),
  sendWhatsappMessage: (...args: unknown[]) => mockSendWhatsappMessage(...args),
}));

jest.mock("@icecore/shared/lib/whatsapp/contact-identities", () => ({
  resolveStoredWhatsAppRecipientTarget: (...args: unknown[]) =>
    mockResolveStoredWhatsAppRecipientTarget(...args),
}));

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (...args: unknown[]) =>
    mockResolveWhatsAppSendContext(...args),
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { findOne: (...args: unknown[]) => mockFindOne(...args) },
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: { findById: (...args: unknown[]) => mockUserFindById(...args) },
}));

import { handleWhatsAppReply } from "@/app/api/conversations/[id]/reply/handleWhatsAppReply";
import type { OutboundAttachment } from "@/types/outbound-attachment";

const manager = {
  id: "manager_1",
  name: "Manager",
  namePromise: Promise.resolve("Alice"),
};

function buildConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: "conversation_1",
    chat: { _id: "chat_1" },
    user: {
      _id: "customer_1",
      whatsapp: { waId: "77001234567" },
    },
    sourceId: "source_1",
    workspaceId: "workspace_1",
    channel: "whatsapp",
    last_inbound_at: new Date(),
    ...overrides,
  };
}

function reply(
  text: string,
  attachments: OutboundAttachment[] = [],
  replyToMessageId?: string,
  conversation = buildConversation()
) {
  return handleWhatsAppReply({
    conversation: conversation as never,
    text,
    workspaceId: "workspace_1",
    manager,
    attachments,
    replyToMessageId,
    instagramReplyMode: "comment",
  });
}

describe("handleWhatsAppReply fast Meta path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckMessagingWindowForConversation.mockResolvedValue({
      isWithinWindow: true,
      hoursRemaining: 12,
      lastCustomerMessageAt: new Date(),
    });
    mockFindOne.mockImplementation(() => ({
      select: () => ({
        lean: () => Promise.resolve(null),
      }),
    }));
    mockPersistManagerOutboundMessage.mockImplementation(
      async ({
        message,
      }: {
        message: { messageId: string; text: string };
      }) => ({
        _id: `saved_${message.messageId}`,
        text: message.text,
      })
    );
    mockResolveStoredWhatsAppRecipientTarget.mockReturnValue({
      type: "phone",
      value: "77001234567",
    });
    mockResolveWhatsAppSendContext.mockResolvedValue({
      sourceId: "source_1",
      workspaceId: "workspace_1",
      phoneNumberId: "phone_1",
      accessToken: "token_1",
    });
    mockSendWhatsappMedia
      .mockResolvedValueOnce({ messageId: "wa_media_1", date: 1_772_640_001 })
      .mockResolvedValueOnce({ messageId: "wa_media_2", date: 1_772_640_002 });
    mockSendWhatsappMessage.mockResolvedValue({
      messageId: "wa_text_1",
      date: 1_772_640_000,
    });
    mockUpsertManagerAuthor.mockResolvedValue({
      _id: "manager_1",
      firstName: "Alice",
      isBot: false,
    });
  });

  it("sends text to Meta before the manager upsert, persistence and coach", async () => {
    const conversation = buildConversation();

    const result = await reply("Hello customer", [], undefined, conversation);

    const metaOrder = mockSendWhatsappMessage.mock.invocationCallOrder[0];
    expect(metaOrder).toBeLessThan(
      mockUpsertManagerAuthor.mock.invocationCallOrder[0]
    );
    expect(metaOrder).toBeLessThan(
      mockPersistManagerOutboundMessage.mock.invocationCallOrder[0]
    );
    expect(metaOrder).toBeLessThan(
      mockEnqueueAiriCoachJobBestEffort.mock.invocationCallOrder[0]
    );
    expect(mockResolveWhatsAppSendContext).toHaveBeenCalledWith({
      sourceId: "source_1",
      workspaceId: "workspace_1",
    });
    expect(mockCheckMessagingWindowForConversation).toHaveBeenCalledWith(
      conversation
    );
    // The populated customer is used; no second lookup.
    expect(mockUserFindById).not.toHaveBeenCalled();
    expect(mockUpsertManagerAuthor).toHaveBeenCalledWith(manager);
    expect(mockPersistManagerOutboundMessage).toHaveBeenCalledWith({
      conversation,
      workspaceId: "workspace_1",
      channel: "whatsapp",
      managerId: "manager_1",
      managerUser: { _id: "manager_1", firstName: "Alice", isBot: false },
      message: {
        messageId: "ws_wa_text_1",
        date: new Date(1_772_640_000 * 1000),
        text: "Hello customer",
        fields: {},
      },
      logTag: "Reply:WhatsApp",
    });
    expect(mockEnqueueAiriCoachJobBestEffort).toHaveBeenCalledWith(
      {
        workspaceId: "workspace_1",
        conversationId: "conversation_1",
        messageId: "saved_ws_wa_text_1",
      },
      "Reply:WhatsApp"
    );
    expect(result).toEqual({
      _id: "saved_ws_wa_text_1",
      text: "Hello customer",
    });
  });

  it("sends text and attachments to Meta before the first persistence call", async () => {
    await reply("Hello customer", [
      {
        mediaType: "image",
        url: "https://cdn.example.com/a.jpg",
        mimeType: "image/jpeg",
      },
      {
        mediaType: "document",
        whatsappMediaId: "media_pdf_1",
        url: "https://cdn.example.com/a.pdf",
        fileName: "a.pdf",
      },
    ]);

    const textOrder = mockSendWhatsappMessage.mock.invocationCallOrder[0];
    const firstMediaOrder = mockSendWhatsappMedia.mock.invocationCallOrder[0];
    const secondMediaOrder = mockSendWhatsappMedia.mock.invocationCallOrder[1];
    const firstPersistOrder =
      mockPersistManagerOutboundMessage.mock.invocationCallOrder[0];

    expect(textOrder).toBeLessThan(firstMediaOrder);
    expect(firstMediaOrder).toBeLessThan(secondMediaOrder);
    expect(secondMediaOrder).toBeLessThan(firstPersistOrder);
    expect(mockSendWhatsappMedia).toHaveBeenNthCalledWith(
      2,
      "phone_1",
      "token_1",
      expect.any(Object),
      { type: "document", id: "media_pdf_1", fileName: "a.pdf" },
      undefined
    );
    expect(mockPersistManagerOutboundMessage).toHaveBeenCalledTimes(3);
    expect(
      mockPersistManagerOutboundMessage.mock.calls[2][0].message
    ).toMatchObject({
      messageId: "ws_wa_media_2",
      text: "[document attachment]",
      fields: {
        imageUrl: "https://cdn.example.com/a.pdf",
        mediaType: "document",
        fileName: "a.pdf",
        whatsappMediaId: "media_pdf_1",
      },
    });
  });

  it("looks the customer up when the conversation user is not populated", async () => {
    mockUserFindById.mockReturnValue({
      select: () => ({
        lean: () =>
          Promise.resolve({
            _id: "customer_1",
            whatsapp: { waId: "77001234567" },
          }),
      }),
    });

    await reply(
      "Hello",
      [],
      undefined,
      buildConversation({ user: "customer_1" })
    );

    expect(mockUserFindById).toHaveBeenCalledWith("customer_1");
    expect(mockResolveStoredWhatsAppRecipientTarget).toHaveBeenCalledWith(
      { _id: "customer_1", whatsapp: { waId: "77001234567" } },
      "customer_1",
      { _id: "chat_1" }
    );
  });

  it("resolves reply-to platform message id before sending", async () => {
    mockFindOne.mockImplementationOnce(() => ({
      select: () => ({
        lean: () =>
          Promise.resolve({
            messageId: "ws_wamid.reply_target_1",
          }),
      }),
    }));

    await reply("Replying", [], "message_1");

    expect(mockFindOne.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendWhatsappMessage.mock.invocationCallOrder[0]
    );
    expect(mockSendWhatsappMessage).toHaveBeenCalledWith(
      "phone_1",
      "token_1",
      expect.any(Object),
      "Replying",
      "wamid.reply_target_1"
    );
    expect(
      mockPersistManagerOutboundMessage.mock.calls[0][0].message.fields
    ).toEqual({ whatsappMeta: expect.any(Object) });
  });

  it("refuses to send outside the messaging window", async () => {
    mockCheckMessagingWindowForConversation.mockResolvedValueOnce({
      isWithinWindow: false,
      hoursRemaining: 0,
      lastCustomerMessageAt: null,
    });

    await expect(reply("Hello")).rejects.toThrow("window closed");
    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(mockUpsertManagerAuthor).not.toHaveBeenCalled();
  });
});
