const mockCheckMessagingWindowForConversation = jest.fn();
const mockFindOne = jest.fn();
const mockPersistManagerOutboundMessage = jest.fn();
const mockResolveInstagramSendContext = jest.fn();
const mockResolveInstagramHumanAgentCapability = jest.fn();
const mockUpsertManagerAuthor = jest.fn();

jest.mock("@/lib/conversation-messages", () => ({
  persistManagerOutboundMessage: (...args: unknown[]) =>
    mockPersistManagerOutboundMessage(...args),
  upsertManagerAuthor: (...args: unknown[]) => mockUpsertManagerAuthor(...args),
}));

jest.mock("@/lib/instagram/outbound", () => ({
  ...jest.requireActual("@/lib/instagram/outbound"),
  buildInstagramAttachmentMessagePayload: (
    params: Record<string, unknown>
  ) => ({
    attachment: params,
  }),
  buildInstagramDmMessageBody: (params: Record<string, unknown>) => params,
  buildInstagramPrivateReplyMessageBody: (params: Record<string, unknown>) =>
    params,
}));

jest.mock("@/lib/instagram/send-context", () => ({
  resolveInstagramSendContext: (...args: unknown[]) =>
    mockResolveInstagramSendContext(...args),
  resolveInstagramSendContextHumanAgent: (...args: unknown[]) =>
    mockResolveInstagramHumanAgentCapability(...args),
}));

jest.mock("@/lib/messaging-window", () => ({
  checkMessagingWindowForConversation: (...args: unknown[]) =>
    mockCheckMessagingWindowForConversation(...args),
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { findOne: (...args: unknown[]) => mockFindOne(...args) },
}));

import { handleInstagramReply } from "@/app/api/conversations/[id]/reply/handleInstagramReply";
import { InstagramPartialSendError } from "@/lib/instagram/send-errors";
import type { OutboundAttachment } from "@/types/outbound-attachment";

const manager = {
  id: "manager_1",
  name: "Manager",
  namePromise: Promise.resolve("Alice"),
};

function buildDmConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: "conversation_1",
    chat: { _id: "chat_1" },
    sourceId: "source_1",
    workspaceId: "workspace_1",
    channel: "instagram",
    last_inbound_at: new Date(),
    external_thread: {
      provider: "instagram",
      threadId: "recipient_1",
    },
    ...overrides,
  };
}

function buildCommentConversation(overrides: Record<string, unknown> = {}) {
  return {
    ...buildDmConversation({
      external_thread: {
        provider: "instagram",
        type: "comment",
        threadId: "comment_thread_1",
      },
    }),
    ...overrides,
  };
}

function reply(
  conversation: Record<string, unknown>,
  text: string,
  options: {
    attachments?: OutboundAttachment[];
    replyToMessageId?: string;
    instagramReplyMode?: "comment" | "private";
  } = {}
) {
  return handleInstagramReply({
    conversation: conversation as never,
    text,
    workspaceId: "workspace_1",
    manager,
    attachments: options.attachments ?? [],
    replyToMessageId: options.replyToMessageId,
    instagramReplyMode: options.instagramReplyMode ?? "comment",
  });
}

function buildFetchResponse(payload: Record<string, unknown>) {
  return {
    ok: true,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(""),
    statusText: "OK",
  };
}

describe("handleInstagramReply fast Meta path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue(
      buildFetchResponse({
        message_id: "ig_message_1",
      })
    ) as never;
    mockCheckMessagingWindowForConversation.mockResolvedValue({
      isWithinWindow: true,
      hoursRemaining: 12,
      lastCustomerMessageAt: new Date(),
    });
    mockFindOne.mockResolvedValue(null);
    mockPersistManagerOutboundMessage.mockImplementation(
      async ({
        message,
      }: {
        message: {
          messageId?: string;
          text: string;
          fields?: Record<string, unknown>;
        };
      }) => ({
        _id: "saved_instagram_message_1",
        messageId: message.messageId,
        text: message.text,
        ...message.fields,
      })
    );
    mockResolveInstagramHumanAgentCapability.mockReturnValue({
      enabled: true,
    });
    mockResolveInstagramSendContext.mockResolvedValue({
      sourceId: "source_1",
      workspaceId: "workspace_1",
      accessToken: "page_token_1",
      senderId: "page_1",
      graphApiBase: "https://graph.facebook.com/v25.0",
      grantedPermissionsRaw: ["instagram_business_manage_messages"],
      humanAgentEnabledRaw: true,
      cacheHit: false,
    });
    mockUpsertManagerAuthor.mockResolvedValue({
      _id: "manager_1",
      firstName: "Alice",
      isBot: false,
    });
  });

  it("sends DM text to Meta before manager upsert and persistence", async () => {
    const conversation = buildDmConversation();

    await reply(conversation, "Hello customer");

    const fetchOrder = (global.fetch as jest.Mock).mock.invocationCallOrder[0];
    expect(fetchOrder).toBeLessThan(
      mockUpsertManagerAuthor.mock.invocationCallOrder[0]
    );
    expect(fetchOrder).toBeLessThan(
      mockPersistManagerOutboundMessage.mock.invocationCallOrder[0]
    );
    expect(mockResolveInstagramSendContext).toHaveBeenCalledWith({
      sourceId: "source_1",
      workspaceId: "workspace_1",
    });
    expect(mockCheckMessagingWindowForConversation).toHaveBeenCalledWith(
      conversation
    );
    expect(mockUpsertManagerAuthor).toHaveBeenCalledWith(manager);
    expect(mockPersistManagerOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation,
        workspaceId: "workspace_1",
        channel: "instagram",
        managerId: "manager_1",
        message: expect.objectContaining({
          messageId: "ig_message_1",
          text: "Hello customer",
        }),
        logTag: "Reply:Instagram",
      })
    );
  });

  it("sends DM text and attachments to Meta before the first persistence call", async () => {
    await reply(buildDmConversation(), "Hello customer", {
      attachments: [
        {
          mediaType: "image",
          url: "https://cdn.example.com/a.jpg",
          mimeType: "image/jpeg",
        },
      ],
    });

    const textFetchOrder = (global.fetch as jest.Mock).mock
      .invocationCallOrder[0];
    const attachmentFetchOrder = (global.fetch as jest.Mock).mock
      .invocationCallOrder[1];
    const firstPersistOrder =
      mockPersistManagerOutboundMessage.mock.invocationCallOrder[0];

    expect(textFetchOrder).toBeLessThan(attachmentFetchOrder);
    expect(attachmentFetchOrder).toBeLessThan(firstPersistOrder);
    expect(
      mockPersistManagerOutboundMessage.mock.calls[0][0].message.fields
    ).toMatchObject({
      imageUrl: "https://cdn.example.com/a.jpg",
      mediaType: "image",
    });
  });

  it("rejects DM sends outside the messaging window when Human Agent is unavailable", async () => {
    mockCheckMessagingWindowForConversation.mockResolvedValueOnce({
      isWithinWindow: false,
      hoursRemaining: 0,
      lastCustomerMessageAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });
    mockResolveInstagramHumanAgentCapability.mockReturnValueOnce({
      enabled: false,
    });

    await expect(
      reply(buildDmConversation(), "Hello customer")
    ).rejects.toMatchObject({
      code: "instagram_window_closed",
      httpStatus: 409,
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPersistManagerOutboundMessage).not.toHaveBeenCalled();
  });

  it("keeps comment replies text-only and uses the selected comment target", async () => {
    mockFindOne.mockResolvedValueOnce({
      messageId: "comment_1",
    });

    await reply(buildCommentConversation(), "Thanks", {
      replyToMessageId: "message_1",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://graph.facebook.com/v25.0/comment_1/replies",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "Thanks" }),
      })
    );

    await expect(
      reply(buildCommentConversation(), "Thanks", {
        attachments: [
          {
            mediaType: "image",
            url: "https://cdn.example.com/a.jpg",
          },
        ],
        replyToMessageId: "message_1",
      })
    ).rejects.toThrow("Instagram comment replies support text only");
  });

  it("tags replies with HUMAN_AGENT within 7 days of the last customer message", async () => {
    mockCheckMessagingWindowForConversation.mockResolvedValueOnce({
      isWithinWindow: false,
      hoursRemaining: 0,
      lastCustomerMessageAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });

    await reply(buildDmConversation(), "Following up");

    const [, request] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(String(request.body))).toMatchObject({
      useHumanAgentTag: true,
    });
  });

  it("blocks Human Agent replies once 7 days have passed since the last customer message", async () => {
    mockCheckMessagingWindowForConversation.mockResolvedValueOnce({
      isWithinWindow: false,
      hoursRemaining: 0,
      lastCustomerMessageAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });

    await expect(
      reply(buildDmConversation(), "Following up")
    ).rejects.toMatchObject({
      code: "instagram_human_agent_window_expired",
      httpStatus: 409,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects text over Meta's 1000-byte limit before calling Meta", async () => {
    await expect(
      reply(buildDmConversation(), "я".repeat(501))
    ).rejects.toMatchObject({ code: "instagram_text_too_long" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("maps Meta's outside-window rejection to a coded error without raw JSON", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () =>
        Promise.resolve(
          JSON.stringify({
            error: {
              message: "This message is sent outside of allowed window.",
              type: "OAuthException",
              code: 10,
              error_subcode: 2534022,
            },
          })
        ),
    }) as never;

    const error = await reply(buildDmConversation(), "Hello customer").catch(
      caught => caught
    );

    expect(error).toMatchObject({ code: "instagram_outside_allowed_window" });
    expect(String(error.message)).not.toContain("{");
    expect(mockPersistManagerOutboundMessage).not.toHaveBeenCalled();
  });

  it("does not report a permissions error as missing Human Agent when no tag was sent", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: () =>
        Promise.resolve(
          JSON.stringify({
            error: { message: "(#200) Permissions error", code: 200 },
          })
        ),
    }) as never;

    await expect(
      reply(buildDmConversation(), "Hello customer")
    ).rejects.toMatchObject({ code: "instagram_permission_missing" });
  });

  it("saves the delivered text when a later attachment is rejected", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(buildFetchResponse({ message_id: "ig_text_1" }))
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: { message: "Upload attachment failure.", code: 100 },
            })
          ),
      }) as never;

    const error = await reply(buildDmConversation(), "Here is the photo", {
      attachments: [
        {
          mediaType: "image",
          url: "https://cdn.example.com/a.jpg",
          mimeType: "image/jpeg",
        },
      ],
    }).catch(caught => caught);

    expect(error).toBeInstanceOf(InstagramPartialSendError);
    expect(error.code).toBe("instagram_attachment_rejected");
    expect(error.persistedMessage).toMatchObject({
      messageId: "ig_text_1",
      text: "Here is the photo",
    });
    expect(mockPersistManagerOutboundMessage).toHaveBeenCalledTimes(1);
    expect(
      mockPersistManagerOutboundMessage.mock.calls[0][0].message.fields
    ).not.toHaveProperty("imageUrl");
  });

  it("maps an expired private-reply window to the window error, not a comments permission error", async () => {
    mockFindOne.mockResolvedValueOnce({ messageId: "comment_1" });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: () =>
        Promise.resolve(
          JSON.stringify({
            error: {
              message: "This message is sent outside of allowed window.",
              code: 10,
              error_subcode: 2534022,
            },
          })
        ),
    }) as never;

    await expect(
      reply(buildCommentConversation(), "Thanks for the comment", {
        replyToMessageId: "message_1",
        instagramReplyMode: "private",
      })
    ).rejects.toMatchObject({ code: "instagram_outside_allowed_window" });
  });
});
