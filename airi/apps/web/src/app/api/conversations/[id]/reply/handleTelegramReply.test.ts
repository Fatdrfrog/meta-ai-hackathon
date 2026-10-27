const mockFindOne = jest.fn();
const mockUpsertManagerAuthor = jest.fn();
const mockPersistManagerOutboundMessage = jest.fn();
const mockSendTelegramMessage = jest.fn();
const mockSendTelegramMedia = jest.fn();
const mockEnqueueAiriCoachJobBestEffort = jest.fn();
const mockShouldUseBusinessConnectionId = jest.fn();
const mockResolveTelegramSendContext = jest.fn();

jest.mock("@/app/api/telegram/helpers", () => ({
  shouldUseBusinessConnectionId: (...args: unknown[]) =>
    mockShouldUseBusinessConnectionId(...args),
}));

jest.mock("@/lib/airi/coach/coach-jobs", () => ({
  enqueueAiriCoachJobBestEffort: (...args: unknown[]) =>
    mockEnqueueAiriCoachJobBestEffort(...args),
}));

jest.mock("@/lib/conversation-messages", () => ({
  persistManagerOutboundMessage: (...args: unknown[]) =>
    mockPersistManagerOutboundMessage(...args),
  upsertManagerAuthor: (...args: unknown[]) => mockUpsertManagerAuthor(...args),
}));

jest.mock("@/lib/telegram", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
  sendTelegramMedia: (...args: unknown[]) => mockSendTelegramMedia(...args),
}));

jest.mock("@/lib/telegram/source-context", () => ({
  resolveTelegramSendContext: (...args: unknown[]) =>
    mockResolveTelegramSendContext(...args),
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { findOne: (...args: unknown[]) => mockFindOne(...args) },
}));

import {
  handleTelegramReply,
  resolveTelegramReplyContext,
} from "@/app/api/conversations/[id]/reply/handleTelegramReply";
import type { OutboundAttachment } from "@/types/outbound-attachment";

function reply(
  conversation: Record<string, unknown>,
  text: string,
  options: {
    name?: string;
    namePromise?: Promise<string>;
    attachments?: OutboundAttachment[];
  } = {}
) {
  return handleTelegramReply({
    conversation: conversation as never,
    text,
    workspaceId: "workspace_1",
    manager: {
      id: "manager_1",
      name: options.name ?? "Alice",
      namePromise: options.namePromise,
    },
    attachments: options.attachments ?? [],
    instagramReplyMode: "comment",
  });
}

function persistedMessage(call = 0) {
  return mockPersistManagerOutboundMessage.mock.calls[call][0].message;
}

describe("handleTelegramReply", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Drop queued once-implementations a previous test did not consume.
    for (const mock of [
      mockFindOne,
      mockUpsertManagerAuthor,
      mockPersistManagerOutboundMessage,
      mockSendTelegramMessage,
      mockSendTelegramMedia,
      mockShouldUseBusinessConnectionId,
      mockResolveTelegramSendContext,
    ]) {
      mock.mockReset();
    }
    mockResolveTelegramSendContext.mockResolvedValue(null);
    mockUpsertManagerAuthor.mockResolvedValue({ _id: "manager_user" });
    mockPersistManagerOutboundMessage.mockImplementation(
      async ({ message }: { message: { text: string } }) => ({
        _id: "saved_message",
        text: message.text,
      })
    );
    mockFindOne.mockImplementation(() => ({
      sort: () => ({
        select: () => ({
          lean: () => Promise.resolve(null),
        }),
      }),
      select: () => ({
        lean: () => Promise.resolve(null),
      }),
    }));
    mockSendTelegramMessage.mockResolvedValue({
      messageId: 456,
      date: 1_772_640_000,
    });
    mockSendTelegramMedia.mockResolvedValue({
      messageId: 457,
      date: 1_772_640_001,
    });
    mockShouldUseBusinessConnectionId.mockResolvedValue(false);
  });

  it("reads the current inbound topic after slow author preparation", async () => {
    let releaseAuthor!: (value: { _id: string }) => void;
    const authorReady = new Promise<{ _id: string }>(resolve => {
      releaseAuthor = resolve;
    });
    mockUpsertManagerAuthor.mockReturnValueOnce(authorReady);
    let latestThreadId = 77;
    mockFindOne.mockImplementationOnce(() => ({
      sort: () => ({
        select: () => ({
          lean: () =>
            Promise.resolve({
              telegramMeta: { messageThreadId: latestThreadId },
            }),
        }),
      }),
    }));
    const pending = reply(
      { _id: "conversation_1", chat: "telegram_chat_1" },
      "Hello customer"
    );
    try {
      await Promise.resolve();
      latestThreadId = 88;
    } finally {
      releaseAuthor({ _id: "manager_user" });
    }
    await pending;
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "telegram_chat_1",
      "Hello customer",
      { messageThreadId: 88 }
    );
    expect(mockFindOne).toHaveBeenCalledTimes(1);
  });

  it("overlaps independent author and source preparation before reading the topic", async () => {
    jest.useFakeTimers();
    try {
      const startedAt = Date.now();
      mockUpsertManagerAuthor.mockImplementationOnce(
        () =>
          new Promise(resolve =>
            setTimeout(() => resolve({ _id: "manager_user" }), 100)
          )
      );
      mockResolveTelegramSendContext.mockImplementationOnce(
        () => new Promise(resolve => setTimeout(() => resolve(null), 200))
      );
      mockFindOne.mockImplementationOnce(() => ({
        sort: () => ({
          select: () => ({
            lean: () =>
              new Promise(resolve => setTimeout(() => resolve(null), 300)),
          }),
        }),
      }));
      let providerCallMs: number | undefined;
      mockSendTelegramMessage.mockImplementationOnce(async () => {
        providerCallMs = Date.now() - startedAt;
        return { messageId: 456, date: 1_772_640_000 };
      });
      const pending = reply(
        {
          _id: "conversation_1",
          chat: "telegram_chat_1",
          sourceId: "source_1",
        },
        "Hello customer"
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(mockResolveTelegramSendContext).toHaveBeenCalledTimes(1);
      expect(mockFindOne).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(199);
      expect(mockSendTelegramMessage).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(mockFindOne).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(299);
      expect(mockSendTelegramMessage).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await pending;
      expect(providerCallMs).toBe(500);
    } finally {
      await jest.runAllTimersAsync();
      jest.useRealTimers();
    }
  });

  it("prepares source and ownership while display resolution is pending, then reads the topic after author readiness", async () => {
    jest.useFakeTimers();
    try {
      const startedAt = Date.now();
      const displayName = new Promise<string>(resolve =>
        setTimeout(() => resolve("Resolved Alice"), 500)
      );
      mockUpsertManagerAuthor.mockImplementationOnce(
        () =>
          new Promise(resolve =>
            setTimeout(() => resolve({ _id: "manager_user" }), 100)
          )
      );
      mockResolveTelegramSendContext.mockImplementationOnce(
        () => new Promise(resolve => setTimeout(() => resolve(null), 200))
      );
      mockShouldUseBusinessConnectionId.mockImplementationOnce(
        () => new Promise(resolve => setTimeout(() => resolve(true), 250))
      );
      mockFindOne.mockImplementationOnce(() => ({
        sort: () => ({
          select: () => ({
            lean: () =>
              new Promise(resolve =>
                setTimeout(
                  () => resolve({ telegramMeta: { messageThreadId: 77 } }),
                  300
                )
              ),
          }),
        }),
      }));
      let providerCallMs: number | undefined;
      mockSendTelegramMessage.mockImplementationOnce(async () => {
        providerCallMs = Date.now() - startedAt;
        return { messageId: 456, date: 1_772_640_000 };
      });
      const pending = reply(
        {
          _id: "conversation_1",
          chat: { _id: "telegram_chat_1", type: "private" },
          sourceId: "source_1",
          business_connection_id: "owned_business",
        },
        "Hello customer",
        { name: "Fallback Alice", namePromise: displayName }
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(mockResolveTelegramSendContext).toHaveBeenCalledTimes(1);
      expect(mockShouldUseBusinessConnectionId).toHaveBeenCalledTimes(1);
      expect(mockFindOne).not.toHaveBeenCalled();
      expect(mockUpsertManagerAuthor).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(599);
      expect(mockSendTelegramMessage).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(mockFindOne).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(299);
      expect(mockSendTelegramMessage).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await pending;
      expect(providerCallMs).toBe(900);
      expect(mockUpsertManagerAuthor).toHaveBeenCalledWith({
        id: "manager_1",
        name: "Resolved Alice",
      });
      expect(mockSendTelegramMessage).toHaveBeenCalledWith(
        "telegram_chat_1",
        "Hello customer",
        expect.objectContaining({
          businessConnectionId: "owned_business",
          messageThreadId: 77,
        })
      );
      expect(persistedMessage().fields.telegramMeta).toMatchObject({
        senderDisplayName: "Resolved Alice",
      });
    } finally {
      await jest.runAllTimersAsync();
      jest.useRealTimers();
    }
  });

  it.each(["author", "ownership"])(
    "keeps a failed %s preparation from reaching the provider",
    async stage => {
      if (stage === "author")
        mockUpsertManagerAuthor.mockRejectedValueOnce(
          new Error("readiness failed")
        );
      else
        mockShouldUseBusinessConnectionId.mockRejectedValueOnce(
          new Error("readiness failed")
        );
      await expect(
        reply(
          {
            _id: "conversation_1",
            chat: "telegram_chat_1",
            sourceId: "source_1",
            business_connection_id: "owned_business",
          },
          "Hello customer"
        )
      ).rejects.toThrow("readiness failed");
      expect(mockSendTelegramMessage).not.toHaveBeenCalled();
      expect(mockSendTelegramMedia).not.toHaveBeenCalled();
      expect(mockPersistManagerOutboundMessage).not.toHaveBeenCalled();
    }
  );

  it("sends to the numeric chat id inside a composite stored chat id", async () => {
    await reply(
      { _id: "conversation_1", chat: "tg_-100123_source_1" },
      "Hello group"
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "-100123",
      "Hello group",
      {}
    );
  });

  it("uses the supplied name when an optional display promise rejects", async () => {
    await reply(
      { _id: "conversation_1", chat: "telegram_chat_1" },
      "Hello customer",
      {
        name: "Fallback Alice",
        namePromise: Promise.reject(new Error("display unavailable")),
      }
    );
    expect(mockUpsertManagerAuthor).toHaveBeenCalledWith({
      id: "manager_1",
      name: "Fallback Alice",
    });
    expect(persistedMessage().fields.telegramMeta).toMatchObject({
      senderDisplayName: "Fallback Alice",
    });
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(mockResolveTelegramSendContext).not.toHaveBeenCalled();
  });

  it("falls back to the platform bot when the source lookup fails", async () => {
    mockResolveTelegramSendContext.mockRejectedValueOnce(
      new Error("source unavailable")
    );
    await reply(
      {
        _id: "conversation_1",
        chat: "telegram_chat_1",
        sourceId: "source_1",
      },
      "Hello customer"
    );
    expect(mockResolveTelegramSendContext).toHaveBeenCalledTimes(1);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "telegram_chat_1",
      "Hello customer",
      {}
    );
  });

  it("sends with the bot of the workspace's own bound source", async () => {
    mockResolveTelegramSendContext.mockResolvedValueOnce({
      sourceId: "source_1",
      botToken: "synthetic-test-token",
    });
    await reply(
      {
        _id: "conversation_1",
        chat: "telegram_chat_1",
        sourceId: "source_1",
      },
      "Hello customer"
    );
    // The shared resolver refuses a source owned by another workspace.
    expect(mockResolveTelegramSendContext).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      sourceId: "source_1",
    });
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "telegram_chat_1",
      "Hello customer",
      { botToken: "synthetic-test-token" }
    );
  });

  it("keeps provider failures visible without persisting an accepted message", async () => {
    mockSendTelegramMessage.mockRejectedValueOnce(
      new Error("provider rejected")
    );
    await expect(
      reply(
        {
          _id: "conversation_1",
          chat: "telegram_chat_1",
          sourceId: "source_1",
        },
        "Hello customer"
      )
    ).rejects.toThrow("provider rejected");
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(mockUpsertManagerAuthor).toHaveBeenCalledTimes(1);
    expect(mockPersistManagerOutboundMessage).not.toHaveBeenCalled();
    expect(mockEnqueueAiriCoachJobBestEffort).not.toHaveBeenCalled();
  });

  it("stores each part as Telegram accepts it", async () => {
    mockSendTelegramMedia.mockRejectedValueOnce(new Error("media rejected"));

    await expect(
      reply({ _id: "conversation_1", chat: "telegram_chat_1" }, "See photo", {
        attachments: [
          {
            mediaType: "image",
            url: "https://cdn.example.com/a.jpg",
            mimeType: "image/jpeg",
          },
        ],
      })
    ).rejects.toThrow("media rejected");

    // The delivered text is already stored when the attachment fails.
    expect(mockPersistManagerOutboundMessage).toHaveBeenCalledTimes(1);
    expect(persistedMessage()).toMatchObject({
      messageId: "456",
      text: "See photo",
    });
    expect(
      mockPersistManagerOutboundMessage.mock.invocationCallOrder[0]
    ).toBeLessThan(mockSendTelegramMedia.mock.invocationCallOrder[0]);
  });

  it("stores attachments with the media type Telegram delivered", async () => {
    await reply({ _id: "conversation_1", chat: "telegram_chat_1" }, "", {
      attachments: [
        {
          mediaType: "voice",
          url: "https://cdn.example.com/voice-1.ogg",
          mimeType: "audio/ogg",
          fileName: "voice-1.ogg",
        },
      ],
    });

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
    expect(mockSendTelegramMedia).toHaveBeenCalledWith(
      "telegram_chat_1",
      {
        type: "voice",
        url: "https://cdn.example.com/voice-1.ogg",
        fileName: "voice-1.ogg",
      },
      {}
    );
    expect(persistedMessage()).toMatchObject({
      messageId: "457",
      text: "[voice attachment]",
      fields: {
        imageUrl: "https://cdn.example.com/voice-1.ogg",
        mediaType: "voice",
        mimeType: "audio/ogg",
      },
    });
  });

  it("uses the selected reply target first and falls back to the latest inbound thread", async () => {
    mockFindOne
      .mockImplementationOnce(() => ({
        select: () => ({
          lean: () =>
            Promise.resolve({
              messageId: "321",
              telegramMeta: { messageThreadId: 77 },
            }),
        }),
      }))
      .mockImplementationOnce(() => ({
        sort: () => ({
          select: () => ({
            lean: () =>
              Promise.resolve({
                telegramMeta: { messageThreadId: 88 },
              }),
          }),
        }),
      }));

    const result = await resolveTelegramReplyContext(
      "conv_1" as never,
      "msg_1"
    );

    expect(result).toEqual({
      replyToTelegramMessageId: 321,
      messageThreadId: 77,
    });
    expect(mockFindOne).toHaveBeenCalledTimes(1);
  });

  it("falls back to the latest inbound topic when no explicit reply target exists", async () => {
    mockFindOne.mockImplementationOnce(() => ({
      sort: () => ({
        select: () => ({
          lean: () =>
            Promise.resolve({
              telegramMeta: { messageThreadId: 91 },
            }),
        }),
      }),
    }));

    const result = await resolveTelegramReplyContext("conv_2" as never);

    expect(result).toEqual({
      replyToTelegramMessageId: undefined,
      messageThreadId: 91,
    });
  });

  it("sends manager text without adding a manager-name prefix", async () => {
    const conversation = {
      _id: "conversation_1",
      chat: "telegram_chat_1",
      sourceId: null,
      save: jest.fn().mockResolvedValue(undefined),
    };

    await reply(conversation, "Hello customer");

    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "telegram_chat_1",
      "Hello customer",
      expect.any(Object)
    );
    expect(mockPersistManagerOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: { _id: "conversation_1", chat: "telegram_chat_1" },
        workspaceId: "workspace_1",
        channel: "telegram",
        managerId: "manager_1",
        managerUser: { _id: "manager_user" },
        logTag: "Reply:Telegram",
        message: expect.objectContaining({ text: "Hello customer" }),
      })
    );
    expect(persistedMessage()).not.toHaveProperty("origin");
    expect(conversation.save).not.toHaveBeenCalled();
  });

  it("stores a numeric legacy chat id as a string, as before", async () => {
    await reply({ _id: "conversation_1", chat: { _id: 12345 } }, "Hi");

    expect(
      mockPersistManagerOutboundMessage.mock.calls[0][0].conversation
    ).toEqual({ _id: "conversation_1", chat: "12345" });
  });

  it("persists the owned business connection accepted for the provider send", async () => {
    mockShouldUseBusinessConnectionId.mockResolvedValueOnce(true);
    const conversation = {
      _id: "conversation_1",
      chat: { _id: "telegram_chat_1", type: "private" },
      sourceId: null,
      business_connection_id: "business_owned_by_workspace_1",
      save: jest.fn().mockResolvedValue(undefined),
    };

    await reply(conversation, "Hello customer");

    expect(mockShouldUseBusinessConnectionId).toHaveBeenCalledWith(
      "telegram_chat_1",
      "business_owned_by_workspace_1",
      "workspace_1",
      "private"
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "telegram_chat_1",
      "Hello customer",
      expect.objectContaining({
        businessConnectionId: "business_owned_by_workspace_1",
      })
    );
    expect(persistedMessage()).toMatchObject({
      messageId: "456",
      fields: {
        telegramMeta: expect.objectContaining({
          businessConnectionId: "business_owned_by_workspace_1",
        }),
      },
    });
  });

  it("persists null when workspace ownership rejects the business connection", async () => {
    const conversation = {
      _id: "conversation_1",
      chat: { _id: "telegram_chat_1", type: "private" },
      sourceId: null,
      business_connection_id: "business_owned_by_another_workspace",
      save: jest.fn().mockResolvedValue(undefined),
    };

    await reply(conversation, "Hello customer");

    expect(mockShouldUseBusinessConnectionId).toHaveBeenCalledWith(
      "telegram_chat_1",
      "business_owned_by_another_workspace",
      "workspace_1",
      "private"
    );
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      "telegram_chat_1",
      "Hello customer",
      expect.not.objectContaining({ businessConnectionId: expect.anything() })
    );
    expect(persistedMessage()).toMatchObject({
      messageId: "456",
      fields: {
        telegramMeta: expect.objectContaining({ businessConnectionId: null }),
      },
    });
  });

  it("persists null after Telegram rejects an owned business connection and bot delivery succeeds", async () => {
    mockShouldUseBusinessConnectionId.mockResolvedValueOnce(true);
    mockSendTelegramMessage
      .mockRejectedValueOnce(new Error("BUSINESS_PEER_INVALID"))
      .mockResolvedValueOnce({ messageId: 789, date: 1_772_640_001 });
    const conversation = {
      _id: "conversation_1",
      chat: { _id: "telegram_chat_1", type: "private" },
      sourceId: null,
      business_connection_id: "expired_owned_business_connection",
      save: jest.fn().mockResolvedValue(undefined),
    };

    await reply(conversation, "Hello customer");

    expect(mockSendTelegramMessage).toHaveBeenNthCalledWith(
      1,
      "telegram_chat_1",
      "Hello customer",
      expect.objectContaining({
        businessConnectionId: "expired_owned_business_connection",
      })
    );
    expect(mockSendTelegramMessage).toHaveBeenNthCalledWith(
      2,
      "telegram_chat_1",
      "Hello customer",
      expect.not.objectContaining({ businessConnectionId: expect.anything() })
    );
    expect(conversation.business_connection_id).toBeUndefined();
    expect(conversation.save).toHaveBeenCalled();
    expect(persistedMessage()).toMatchObject({
      messageId: "789",
      fields: {
        telegramMeta: expect.objectContaining({ businessConnectionId: null }),
      },
    });
  });

  it("enqueues the coach job for the last stored message without waiting", async () => {
    await expect(
      reply(
        { _id: "conversation_1", chat: "telegram_chat_1", sourceId: null },
        "Hello customer"
      )
    ).resolves.toEqual({ _id: "saved_message", text: "Hello customer" });

    expect(mockEnqueueAiriCoachJobBestEffort).toHaveBeenCalledWith(
      {
        workspaceId: "workspace_1",
        conversationId: "conversation_1",
        messageId: "saved_message",
      },
      "Reply:Telegram"
    );
  });
});
