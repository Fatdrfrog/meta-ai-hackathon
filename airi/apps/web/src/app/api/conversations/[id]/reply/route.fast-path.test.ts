const mockConversationFindById = jest.fn();
const mockGetHiddenConversationPlanGateResponse = jest.fn();
const mockHandleEmailReply = jest.fn();
const mockHandleInstagramReply = jest.fn();
const mockHandleTelegramReply = jest.fn();
const mockHandleWebWidget = jest.fn();
const mockHandleWhatsAppReply = jest.fn();
const mockGetWorkspaceMemberDisplayName = jest.fn();
const mockVerifyWorkspaceAccess = jest.fn();

jest.mock("@/lib/cache", () => ({
  invalidateConversationCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  getHiddenConversationPlanGateResponse: (...args: unknown[]) =>
    mockGetHiddenConversationPlanGateResponse(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: (...args: unknown[]) =>
    mockVerifyWorkspaceAccess(...args),
}));

jest.mock("@/lib/observability/server-logs", () => ({
  createRequestLogger: () => ({
    start: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("@/lib/supabase/company-users", () => ({
  getWorkspaceMemberDisplayName: (...args: unknown[]) =>
    mockGetWorkspaceMemberDisplayName(...args),
}));

jest.mock("@/lib/supabase/route-auth", () => ({
  getSupabaseRouteAuth: jest.fn().mockResolvedValue({
    supabase: {},
    user: {
      id: "manager_1",
      email: "fallback@example.com",
      user_metadata: {
        full_name: "Fallback Manager",
      },
    },
  }),
  isSupabaseRouteAuthError: (auth: { error?: unknown }) => Boolean(auth.error),
}));

jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("@/app/api/conversations/[id]/reply/handleEmailReply", () => ({
  handleEmailReply: (...args: unknown[]) => mockHandleEmailReply(...args),
}));

jest.mock("@/app/api/conversations/[id]/reply/handleInstagramReply", () => ({
  handleInstagramReply: (...args: unknown[]) =>
    mockHandleInstagramReply(...args),
}));

jest.mock("@/app/api/conversations/[id]/reply/handleTelegramReply", () => ({
  handleTelegramReply: (...args: unknown[]) => mockHandleTelegramReply(...args),
}));

jest.mock("@/app/api/conversations/[id]/reply/handleWebWidget", () => ({
  handleWebWidget: (...args: unknown[]) => mockHandleWebWidget(...args),
}));

jest.mock("@/app/api/conversations/[id]/reply/handleWhatsAppReply", () => ({
  handleWhatsAppReply: (...args: unknown[]) => mockHandleWhatsAppReply(...args),
}));

// Marks the stored Supabase media URLs the real helper would sign.
jest.mock("@/lib/media/customer-media-read-url", () => {
  const sign = (value: unknown) =>
    typeof value === "string" && value.includes("/object/public/")
      ? `signed:${value}`
      : value;
  return {
    withCustomerMediaReadUrls: async (items: Array<Record<string, unknown>>) =>
      items.map(item => ({
        ...item,
        ...("imageUrl" in item ? { imageUrl: sign(item.imageUrl) } : {}),
        ...(Array.isArray(item.attachments)
          ? {
              attachments: item.attachments.map(
                (attachment: { url?: unknown }) => ({
                  ...attachment,
                  url: sign(attachment.url),
                })
              ),
            }
          : {}),
      })),
  };
});

import { POST } from "@/app/api/conversations/[id]/reply/route";
import {
  InstagramPartialSendError,
  InstagramSendError,
} from "@/lib/instagram/send-errors";
import type { NextRequest } from "next/server";

function buildRequest(): NextRequest {
  return new Request("https://app.airi.chat/api/conversations/conv_1/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Hello" }),
  }) as unknown as NextRequest;
}

function buildRequestWithBody(body: Record<string, unknown>): NextRequest {
  return new Request("https://app.airi.chat/api/conversations/conv_1/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function buildConversation(
  channel: "whatsapp" | "instagram" | "telegram" | "email"
) {
  return {
    _id: "conv_1",
    workspaceId: "workspace_1",
    channel,
    chat: { _id: "chat_1" },
    user: { _id: "customer_1" },
    handled_by_agent_id: null,
  };
}

function mockConversationQuery(
  conversation: ReturnType<typeof buildConversation>
) {
  const query = {
    select: jest.fn(),
    populate: jest.fn(),
  };
  query.select.mockReturnValue(query);
  query.populate
    .mockReturnValueOnce(query)
    .mockReturnValueOnce(Promise.resolve(conversation));
  return query;
}

function handlerContext(handler: jest.Mock) {
  return handler.mock.calls[0][0] as {
    manager: { id: string; name: string; namePromise: Promise<string> };
  };
}

describe("conversation reply route fast Meta path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // A request rejected before the load leaves its queued conversation.
    mockConversationFindById.mockReset();
    mockGetHiddenConversationPlanGateResponse.mockResolvedValue(null);
    mockHandleInstagramReply.mockResolvedValue({
      _id: "message_1",
      text: "Hello",
    });
    mockHandleWhatsAppReply.mockResolvedValue({
      _id: "message_1",
      text: "Hello",
    });
    mockHandleTelegramReply.mockResolvedValue({
      _id: "message_1",
      text: "Hello",
    });
    mockVerifyWorkspaceAccess.mockResolvedValue(true);
    mockGetWorkspaceMemberDisplayName.mockResolvedValue("Resolved Manager");
  });

  it.each([
    ["whatsapp", mockHandleWhatsAppReply],
    ["instagram", mockHandleInstagramReply],
    ["telegram", mockHandleTelegramReply],
  ] as const)(
    "invokes the %s handler after required access check",
    async (channel, handler) => {
      mockConversationFindById.mockReturnValueOnce(
        mockConversationQuery(buildConversation(channel))
      );

      const response = await POST(buildRequest(), {
        params: Promise.resolve({ id: "conv_1" }),
      });

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockVerifyWorkspaceAccess).toHaveBeenCalledTimes(1);
      expect(
        mockVerifyWorkspaceAccess.mock.invocationCallOrder[0]
      ).toBeLessThan(handler.mock.invocationCallOrder[0]);
      expect(
        mockGetHiddenConversationPlanGateResponse.mock.invocationCallOrder[0]
      ).toBeLessThan(handler.mock.invocationCallOrder[0]);

      const { manager } = handlerContext(handler);
      expect(manager).toEqual({
        id: "manager_1",
        name: "Fallback Manager",
        namePromise: expect.any(Promise),
      });
      await expect(manager.namePromise).resolves.toBe("Resolved Manager");
      expect(mockGetWorkspaceMemberDisplayName).toHaveBeenCalledWith(
        {},
        "manager_1",
        "workspace_1"
      );
    }
  );

  it("loads only the last linked message id with the conversation", async () => {
    const query = mockConversationQuery(buildConversation("whatsapp"));
    mockConversationFindById.mockReturnValueOnce(query);

    await POST(buildRequest(), { params: Promise.resolve({ id: "conv_1" }) });

    expect(query.select).toHaveBeenCalledWith({ messages: { $slice: -1 } });
  });

  it("does not look up a display name for email replies", async () => {
    mockHandleEmailReply.mockResolvedValueOnce({ success: true });
    mockConversationFindById.mockReturnValueOnce(
      mockConversationQuery(buildConversation("email"))
    );

    const response = await POST(buildRequest(), {
      params: Promise.resolve({ id: "conv_1" }),
    });

    expect(response.status).toBe(200);
    expect(mockHandleEmailReply).toHaveBeenCalledTimes(1);
    expect(mockGetWorkspaceMemberDisplayName).not.toHaveBeenCalled();
  });

  it("starts Telegram preparation while the optional display lookup is pending", async () => {
    jest.useFakeTimers();
    try {
      mockGetWorkspaceMemberDisplayName.mockImplementationOnce(
        () =>
          new Promise(resolve => setTimeout(() => resolve("Late Manager"), 500))
      );
      mockConversationFindById.mockReturnValueOnce(
        mockConversationQuery(buildConversation("telegram"))
      );
      const reply = POST(buildRequest(), {
        params: Promise.resolve({ id: "conv_1" }),
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(mockHandleTelegramReply).toHaveBeenCalledTimes(1);
      expect(mockGetWorkspaceMemberDisplayName).toHaveBeenCalledTimes(1);
      expect(
        handlerContext(mockHandleTelegramReply).manager.namePromise
      ).toEqual(expect.any(Promise));
      await jest.advanceTimersByTimeAsync(500);
      expect((await reply).status).toBe(200);
    } finally {
      await jest.runAllTimersAsync();
      jest.useRealTimers();
    }
  });

  it.each(["workspace", "plan"])(
    "does not start Telegram preparation when the %s gate denies sending",
    async gate => {
      mockConversationFindById.mockReturnValueOnce(
        mockConversationQuery(buildConversation("telegram"))
      );
      if (gate === "workspace")
        mockVerifyWorkspaceAccess.mockResolvedValueOnce(false);
      else
        mockGetHiddenConversationPlanGateResponse.mockResolvedValueOnce(
          new Response("Denied", { status: 403 })
        );
      const response = await POST(buildRequest(), {
        params: Promise.resolve({ id: "conv_1" }),
      });
      expect(response.status).toBe(403);
      expect(mockHandleTelegramReply).not.toHaveBeenCalled();
      expect(mockGetWorkspaceMemberDisplayName).not.toHaveBeenCalled();
    }
  );

  it("rejects unauthenticated sends before loading or preparing a conversation", async () => {
    const { getSupabaseRouteAuth } = jest.requireMock(
      "@/lib/supabase/route-auth"
    );
    getSupabaseRouteAuth.mockResolvedValueOnce({
      error: "Unauthorized",
      status: 401,
    });
    const response = await POST(buildRequest(), {
      params: Promise.resolve({ id: "conv_1" }),
    });
    expect(response.status).toBe(401);
    expect(mockConversationFindById).not.toHaveBeenCalled();
    expect(mockVerifyWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockHandleTelegramReply).not.toHaveBeenCalled();
    expect(mockGetWorkspaceMemberDisplayName).not.toHaveBeenCalled();
  });

  it("does not deny access when the optional manager display lookup fails", async () => {
    mockGetWorkspaceMemberDisplayName.mockRejectedValueOnce(
      new Error("profile join denied")
    );
    mockConversationFindById.mockReturnValueOnce(
      mockConversationQuery(buildConversation("whatsapp"))
    );

    const response = await POST(buildRequest(), {
      params: Promise.resolve({ id: "conv_1" }),
    });

    expect(response.status).toBe(200);
    expect(mockVerifyWorkspaceAccess).toHaveBeenCalledTimes(1);
    expect(mockHandleWhatsAppReply).toHaveBeenCalledTimes(1);
    await expect(
      handlerContext(mockHandleWhatsAppReply).manager.namePromise
    ).resolves.toBe("Fallback Manager");
  });

  it("passes WhatsApp document attachments to the channel handler", async () => {
    mockConversationFindById.mockReturnValueOnce(
      mockConversationQuery(buildConversation("whatsapp"))
    );

    const response = await POST(
      buildRequestWithBody({
        text: "",
        attachments: [
          {
            url: "https://cdn.example.com/contract.pdf",
            whatsappMediaId: "media_pdf_1",
            mediaType: "document",
            mimeType: "application/pdf",
            fileName: "contract.pdf",
            fileSize: 3,
          },
        ],
      }),
      {
        params: Promise.resolve({ id: "conv_1" }),
      }
    );

    expect(response.status).toBe(200);
    expect(mockHandleWhatsAppReply).toHaveBeenCalledWith({
      conversation: expect.any(Object),
      text: "",
      workspaceId: "workspace_1",
      manager: expect.objectContaining({
        id: "manager_1",
        name: "Fallback Manager",
      }),
      attachments: [
        {
          url: "https://cdn.example.com/contract.pdf",
          whatsappMediaId: "media_pdf_1",
          mediaType: "document",
          mimeType: "application/pdf",
          fileName: "contract.pdf",
          fileSize: 3,
        },
      ],
      replyToMessageId: undefined,
      instagramReplyMode: "comment",
    });
  });

  it.each([
    [
      "the app's WhatsApp media proxy",
      "/api/conversations/conv_1/whatsapp-media/media_1",
      true,
    ],
    ["a public link", "https://cdn.example.com/a.jpg", true],
    [
      "a protocol-relative link",
      "//evil.example/api/conversations/conv_1/whatsapp-media/media_1",
      false,
    ],
    ["another app path", "/api/other/file.jpg", false],
  ])("accepts %s as an attachment URL: %s", async (_case, url, accepted) => {
    mockConversationFindById.mockReturnValueOnce(
      mockConversationQuery(buildConversation("whatsapp"))
    );

    const response = await POST(
      buildRequestWithBody({
        text: "",
        attachments: [{ url, mediaType: "image", mimeType: "image/jpeg" }],
      }),
      { params: Promise.resolve({ id: "conv_1" }) }
    );

    if (accepted) {
      expect(response.status).toBe(200);
      expect(
        (
          mockHandleWhatsAppReply.mock.calls[0][0] as {
            attachments: Array<{ url?: string }>;
          }
        ).attachments[0].url
      ).toBe(url);
    } else {
      expect(response.status).toBe(400);
      expect(mockHandleWhatsAppReply).not.toHaveBeenCalled();
    }
  });

  it("rejects Instagram office documents before invoking the handler", async () => {
    mockConversationFindById.mockReturnValueOnce(
      mockConversationQuery(buildConversation("instagram"))
    );

    const response = await POST(
      buildRequestWithBody({
        text: "",
        attachments: [
          {
            url: "https://cdn.example.com/contract.docx",
            mediaType: "document",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            fileName: "contract.docx",
            fileSize: 3,
          },
        ],
      }),
      {
        params: Promise.resolve({ id: "conv_1" }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Instagram accepts"),
    });
    expect(mockHandleInstagramReply).not.toHaveBeenCalled();
  });

  it("returns coded Instagram send errors with their HTTP status", async () => {
    mockConversationFindById.mockReturnValueOnce(
      mockConversationQuery(buildConversation("instagram"))
    );
    mockHandleInstagramReply.mockRejectedValueOnce(
      new InstagramSendError({ code: "instagram_human_agent_window_expired" })
    );

    const response = await POST(buildRequest(), {
      params: Promise.resolve({ id: "conv_1" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining("7 days"),
      code: "instagram_human_agent_window_expired",
    });
  });

  // The thread shows this message right away; an unsigned private-bucket link
  // answered 400 "Bucket not found" until the next refetch.
  it("returns the sent message with signed attachment URLs", async () => {
    const stored =
      "https://project.supabase.co/storage/v1/object/public/conversation-attachments/outbound/telegram/ws/c/1-a-photo.jpg";
    mockConversationFindById.mockReturnValueOnce(
      mockConversationQuery(buildConversation("telegram"))
    );
    // Like a Mongoose document: _id has a getter, internals are own keys and
    // the fields come from toJSON.
    const saved = {
      _id: "message_2",
      text: "",
      imageUrl: stored,
      attachments: [{ url: stored, mediaType: "image" }],
    };
    mockHandleTelegramReply.mockResolvedValueOnce({
      _id: "message_2",
      $__: {},
      _doc: saved,
      toJSON: () => saved,
    });

    const response = await POST(buildRequest(), {
      params: Promise.resolve({ id: "conv_1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.message).toEqual({
      _id: "message_2",
      text: "",
      imageUrl: `signed:${stored}`,
      attachments: [{ url: `signed:${stored}`, mediaType: "image" }],
    });
  });

  it("returns the saved part of a partially delivered Instagram reply", async () => {
    mockConversationFindById.mockReturnValueOnce(
      mockConversationQuery(buildConversation("instagram"))
    );
    mockHandleInstagramReply.mockRejectedValueOnce(
      new InstagramPartialSendError(
        new InstagramSendError({ code: "instagram_attachment_rejected" }),
        { _id: "message_text_1", text: "Hello" }
      )
    );

    const response = await POST(buildRequest(), {
      params: Promise.resolve({ id: "conv_1" }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "instagram_attachment_rejected",
      partial: true,
      message: { _id: "message_text_1", text: "Hello" },
    });
  });
});
