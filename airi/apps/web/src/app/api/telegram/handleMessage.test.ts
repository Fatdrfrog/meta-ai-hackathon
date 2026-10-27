const mockAcceptAiriConversationIngress = jest.fn();
const mockHasTelegramPersistableContent = jest.fn();
const mockIsBusinessOwner = jest.fn();
const mockGetExistingBusinessConnection = jest.fn();
const mockUpsertBusinessConnectionFromMessage = jest.fn();
const mockEnsureTelegramUser = jest.fn();
const mockEnsureChatDocument = jest.fn();
const mockResolveWorkspaceId = jest.fn();
const mockShouldUseBusinessConnectionId = jest.fn();
const mockHandleCommands = jest.fn();
const mockEnsureConversation = jest.fn();
const mockPersistInboundMessage = jest.fn();
const mockRunPostSaveSideEffects = jest.fn();
const mockResolveGroupChatBusinessConnection = jest.fn();
const mockSafeParseChatId = jest.fn();
const mockDetectAndUpdateConversationLanguage = jest.fn();
const mockUpdateMessage = jest.fn();
const mockSendTelegramMessage = jest.fn();
const mockUpsertTelegramSubscriberFromMessage = jest.fn();

jest.mock("@/lib/temporal/airi-direct-ingress", () => ({
  acceptAiriConversationIngress: (...args: unknown[]) =>
    mockAcceptAiriConversationIngress(...args),
}));

jest.mock("@/lib/airi/coach/coach-utils-server", () => ({
  detectAndUpdateConversationLanguage: (...args: unknown[]) =>
    mockDetectAndUpdateConversationLanguage(...args),
}));

jest.mock("@/lib/telegram", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
}));

jest.mock("@/lib/telegram/subscribers", () => ({
  upsertTelegramSubscriberFromMessage: (...args: unknown[]) =>
    mockUpsertTelegramSubscriberFromMessage(...args),
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    updateOne: (...args: unknown[]) => mockUpdateMessage(...args),
  },
}));

jest.mock("./business-owner-detector", () => ({
  isBusinessOwner: (...args: unknown[]) => mockIsBusinessOwner(...args),
}));

jest.mock("./handleBusinessConnectionUpdate", () => ({
  getExistingBusinessConnection: (...args: unknown[]) =>
    mockGetExistingBusinessConnection(...args),
  upsertBusinessConnectionFromMessage: (...args: unknown[]) =>
    mockUpsertBusinessConnectionFromMessage(...args),
}));

jest.mock("./helpers", () => ({
  ensureTelegramUser: (...args: unknown[]) => mockEnsureTelegramUser(...args),
  ensureChatDocument: (...args: unknown[]) => mockEnsureChatDocument(...args),
  resolveWorkspaceId: (...args: unknown[]) => mockResolveWorkspaceId(...args),
  shouldUseBusinessConnectionId: (...args: unknown[]) =>
    mockShouldUseBusinessConnectionId(...args),
  handleCommands: (...args: unknown[]) => mockHandleCommands(...args),
  ensureConversation: (...args: unknown[]) => mockEnsureConversation(...args),
  persistInboundMessage: (...args: unknown[]) =>
    mockPersistInboundMessage(...args),
  runPostSaveSideEffects: (...args: unknown[]) =>
    mockRunPostSaveSideEffects(...args),
  resolveGroupChatBusinessConnection: (...args: unknown[]) =>
    mockResolveGroupChatBusinessConnection(...args),
  safeParseChatId: (...args: unknown[]) => mockSafeParseChatId(...args),
}));

jest.mock("./message-content", () => ({
  hasTelegramPersistableContent: (...args: unknown[]) =>
    mockHasTelegramPersistableContent(...args),
}));

import { handleMessage } from "@/app/api/telegram/handleMessage";

describe("handleMessage auto-reply ingress guards", () => {
  const baseMessage = {
    message_id: 1001,
    from: {
      id: 5001,
      is_bot: false,
      first_name: "John",
    },
    chat: {
      id: 9001,
      type: "private",
      first_name: "Customer",
    },
    date: 1_700_000_000,
    text: "hello",
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockGetExistingBusinessConnection.mockResolvedValue(null);
    mockUpsertBusinessConnectionFromMessage.mockResolvedValue(null);
    mockResolveGroupChatBusinessConnection.mockResolvedValue({
      businessConnectionId: null,
    });
    mockHandleCommands.mockResolvedValue(false);
    mockHasTelegramPersistableContent.mockReturnValue(true);
    mockSafeParseChatId.mockImplementation(value => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    });
    mockEnsureTelegramUser.mockResolvedValue(undefined);
    mockEnsureChatDocument.mockResolvedValue({
      _id: "chat_1",
      sourceId: "source_1",
      workspaceId: "ws_1",
      businessConnectionId: null,
      save: jest.fn().mockResolvedValue(undefined),
    });
    mockResolveWorkspaceId.mockResolvedValue("ws_1");
    mockShouldUseBusinessConnectionId.mockResolvedValue(false);
    mockEnsureConversation.mockResolvedValue({
      conversation: { _id: "conv_1", sourceId: "source_1" },
      isNew: false,
    });
    mockIsBusinessOwner.mockResolvedValue(false);
    mockPersistInboundMessage.mockResolvedValue({
      message: {
        _id: "msg_1",
        text: "hello",
        ragContext: "",
        date: new Date("2026-01-01T00:00:00.000Z"),
        conversation: "conv_1",
        direction: "inbound",
        channel: "telegram",
      },
      isNew: true,
    });
    mockRunPostSaveSideEffects.mockResolvedValue(undefined);
    mockDetectAndUpdateConversationLanguage.mockResolvedValue("en");
    mockAcceptAiriConversationIngress.mockResolvedValue({ queued: true });
    mockUpdateMessage.mockReturnValue({
      exec: jest.fn().mockResolvedValue(undefined),
    });
    mockSendTelegramMessage.mockResolvedValue(undefined);
    mockUpsertTelegramSubscriberFromMessage.mockResolvedValue(undefined);
  });

  it("does not signal auto-reply for non-persistable messages", async () => {
    mockHasTelegramPersistableContent.mockReturnValue(false);

    await handleMessage(baseMessage as never);

    expect(mockAcceptAiriConversationIngress).not.toHaveBeenCalled();
  });

  it("accepts a previously saved inbound after retrying ancillary work", async () => {
    const savedMessage = {
      _id: "saved_message_1",
      text: "hello",
      date: new Date("2026-01-01T00:00:00.000Z"),
      conversation: "conv_1",
      direction: "inbound",
      channel: "telegram",
    };
    mockPersistInboundMessage.mockResolvedValueOnce({
      message: savedMessage,
      isNew: false,
    });
    mockRunPostSaveSideEffects.mockImplementationOnce(async () => {
      expect(mockAcceptAiriConversationIngress).not.toHaveBeenCalled();
    });

    await handleMessage(baseMessage as never);

    expect(mockAcceptAiriConversationIngress).toHaveBeenCalledWith(
      savedMessage,
      expect.objectContaining({
        type: "telegram",
        workspaceId: "ws_1",
        newMessage: savedMessage,
        chatId: "9001",
      })
    );

    expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(1);
  });

  it("keeps initial notifications before dispatch repairs the conversation link", async () => {
    let linked = false;
    const notify = jest.fn();
    mockRunPostSaveSideEffects.mockImplementationOnce(async () => {
      if (!linked) notify();
      linked = true;
    });
    mockAcceptAiriConversationIngress.mockImplementationOnce(async () => {
      linked = true;
      return { accepted: true, status: "signaled" };
    });

    await handleMessage(baseMessage as never);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(1);
  });

  it("accepts durable ingress even when realtime side effects fail", async () => {
    mockRunPostSaveSideEffects.mockRejectedValueOnce(
      new Error("realtime unavailable")
    );

    await expect(handleMessage(baseMessage as never)).resolves.toBeUndefined();

    expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(1);
  });

  it("keeps durable ingress persistence failures retryable after notifications", async () => {
    mockAcceptAiriConversationIngress.mockRejectedValueOnce(
      new Error("intent persistence unavailable")
    );

    await expect(handleMessage(baseMessage as never)).rejects.toThrow(
      "intent persistence unavailable"
    );

    expect(mockRunPostSaveSideEffects).toHaveBeenCalledTimes(1);
    expect(mockDetectAndUpdateConversationLanguage).not.toHaveBeenCalled();
  });

  it("does not reject an accepted message when language detection fails", async () => {
    mockDetectAndUpdateConversationLanguage.mockRejectedValueOnce(
      new Error("language service unavailable")
    );

    await expect(handleMessage(baseMessage as never)).resolves.toBeUndefined();
    expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(1);
  });

  it("does not attach ingress intent or accept messages from bots", async () => {
    await handleMessage({
      ...baseMessage,
      from: { ...baseMessage.from, is_bot: true },
    } as never);

    expect(mockAcceptAiriConversationIngress).not.toHaveBeenCalled();
    expect(mockPersistInboundMessage.mock.calls[0]?.[7]).toBeUndefined();
  });

  it("upserts a Telegram subscriber for private messages after workspace resolution", async () => {
    await handleMessage(baseMessage as never, {
      sourceId: "source_1",
      workspaceId: "ws_1",
      botToken: "token_1",
    });

    expect(mockUpsertTelegramSubscriberFromMessage).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      sourceId: "source_1",
      message: baseMessage,
    });
  });

  it("does not upsert Telegram subscribers for group messages", async () => {
    const groupMessage = {
      ...baseMessage,
      chat: {
        id: -9001,
        type: "supergroup",
        title: "Ops group",
      },
    };

    await handleMessage(groupMessage as never, {
      sourceId: "source_1",
      workspaceId: "ws_1",
      botToken: "token_1",
    });

    expect(mockUpsertTelegramSubscriberFromMessage).not.toHaveBeenCalled();
  });

  it("does not signal auto-reply for business-owner outbound messages", async () => {
    mockIsBusinessOwner.mockResolvedValue(true);

    await handleMessage(baseMessage as never);

    expect(mockPersistInboundMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      baseMessage.from.id,
      "conv_1",
      "ws_1",
      "outbound",
      undefined,
      undefined
    );
    expect(mockAcceptAiriConversationIngress).not.toHaveBeenCalled();
  });

  it("persists sender_chat messages even when Telegram omits from", async () => {
    const chatOriginMessage = {
      ...baseMessage,
      from: undefined,
      sender_chat: {
        id: -9001,
        type: "supergroup",
        title: "Ops group",
      },
      chat: {
        id: -9001,
        type: "supergroup",
        title: "Ops group",
      },
    };

    await handleMessage(chatOriginMessage as never);

    expect(mockEnsureTelegramUser).not.toHaveBeenCalled();
    expect(mockEnsureChatDocument).toHaveBeenCalledWith(
      chatOriginMessage.chat,
      chatOriginMessage.sender_chat.id,
      "legacy",
      undefined
    );
    expect(mockPersistInboundMessage).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      undefined,
      "conv_1",
      "ws_1",
      "inbound",
      undefined,
      expect.objectContaining({
        type: "telegram",
        chatId: "-9001",
        chatType: "supergroup",
      })
    );
  });

  it("acks and drops when a new conversation is blocked by company limits", async () => {
    mockEnsureConversation.mockResolvedValue(null);

    await handleMessage(baseMessage as never);

    expect(mockEnsureConversation).toHaveBeenCalled();
    expect(mockPersistInboundMessage).not.toHaveBeenCalled();
    expect(mockAcceptAiriConversationIngress).not.toHaveBeenCalled();
  });
});
