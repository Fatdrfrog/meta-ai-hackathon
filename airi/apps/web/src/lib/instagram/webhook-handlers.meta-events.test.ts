const mockConnectDb = jest.fn();
const mockInvalidateRequestsForWorkspace = jest.fn();
const mockTriggerConversationRealtime = jest.fn();
const mockRealtimeTrigger = jest.fn();
const mockUserFindOneAndUpdate = jest.fn();
const mockUserFindById = jest.fn();
const mockChatFindOneAndUpdate = jest.fn();
const mockConversationFindOne = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockMessageFindOne = jest.fn();
const mockMessageFindById = jest.fn();
const mockMessageUpdateOne = jest.fn();
const mockMessageSave = jest.fn();
const mockAppendMessageToConversationById = jest.fn();
const mockTriggerConversationReopened = jest.fn();
const mockSavedMessages: unknown[] = [];
const mockAcceptAiriIngress = jest.fn();
const mockDetectLanguage = jest.fn();
const mockHandleInstagramMedia = jest.fn();
const mockMessageExists = jest.fn();
const mockMessageFind = jest.fn();

jest.mock("@/lib/media/handler", () => ({
  handleInstagramMedia: (...args: unknown[]) =>
    mockHandleInstagramMedia(...args),
}));

jest.mock("@/lib/temporal/airi-direct-ingress", () => ({
  acceptAiriConversationIngress: (...args: unknown[]) =>
    mockAcceptAiriIngress(...args),
  directIngressAiriConversation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/airi/coach/coach-utils-server", () => ({
  detectAndUpdateConversationLanguage: (...args: unknown[]) =>
    mockDetectLanguage(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDb(...args),
}));

jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (...args: unknown[]) =>
    mockAppendMessageToConversationById(...args),
}));

jest.mock("@/lib/cache", () => ({
  invalidateRequestsForWorkspace: (...args: unknown[]) =>
    mockInvalidateRequestsForWorkspace(...args),
}));

jest.mock("@/lib/realtime-updates", () => ({
  triggerConversationRealtime: (...args: unknown[]) =>
    mockTriggerConversationRealtime(...args),
}));

jest.mock("@/lib/realtime/server", () => ({
  realtime: {
    trigger: (...args: unknown[]) => mockRealtimeTrigger(...args),
  },
}));

jest.mock("@/lib/webhook-events", () => ({
  triggerConversationReopened: (...args: unknown[]) =>
    mockTriggerConversationReopened(...args),
}));

jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("@/lib/limits/company-limits", () => ({
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE:
    "company_conversation_limit_exceeded",
  ensureCompanyConversationCapacity: jest.fn(async () => ({ allowed: true })),
}));

jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceBotDefault: jest.fn(async () => true),
  getWorkspaceCoachDefault: jest.fn(async () => false),
  getWorkspaceScenariosDefault: jest.fn(async () => true),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {},
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) => mockUserFindOneAndUpdate(...args),
    findById: (...args: unknown[]) => mockUserFindById(...args),
  },
}));

jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) => mockChatFindOneAndUpdate(...args),
  },
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: (...args: unknown[]) => mockConversationFindOne(...args),
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
  },
}));

jest.mock("@/models/message", () => {
  function MockMessage(
    this: Record<string, unknown>,
    doc: Record<string, unknown>
  ) {
    Object.assign(this, doc);
    this._id = doc._id || "saved-message-1";
    this.save = async () => {
      mockSavedMessages.push(this);
      return mockMessageSave(this);
    };
  }

  Object.assign(MockMessage, {
    findOne: (...args: unknown[]) => mockMessageFindOne(...args),
    findById: (...args: unknown[]) => mockMessageFindById(...args),
    updateOne: (...args: unknown[]) => mockMessageUpdateOne(...args),
    exists: (...args: unknown[]) => mockMessageExists(...args),
    find: (...args: unknown[]) => {
      mockMessageFind(...args);
      const chain = {
        sort: () => chain,
        limit: () => chain,
        populate: async () => [],
      };
      return chain;
    },
  });

  return {
    __esModule: true,
    default: MockMessage,
  };
});

import {
  handleIncomingMessage,
  handleMessageEcho,
  handlePostback,
  handleReaction,
  handleStandby,
} from "@/lib/instagram/webhook-handlers";
import type { InstagramSourceData } from "@/lib/instagram/webhook-shared";
import {
  NON_READY_CLASSIFICATION_CASES,
  readyClassificationFields,
} from "@/lib/classifier/classified-conversation-test-utils";

const source: InstagramSourceData = {
  id: "source-1",
  workspace_id: "workspace-1",
  pageAccessToken: "token",
  pageId: "page-1",
};

const conversation = {
  _id: "conversation-1",
  save: jest.fn(async () => undefined),
};
const reactionEmoji = "\u2764\ufe0f";
const NOW = new Date("2026-08-11T16:00:00.000Z");
const EXISTING_CLASSIFICATION = {
  category: "Support",
  priority: "high",
  sentiment: "neutral",
  summary: "Customer returned through Instagram",
  action: "Review the new message",
  tags: ["instagram"],
  confidence: {
    category: 0.9,
    priority: 0.84,
    sentiment: 0.76,
  },
};

function buildClosedConversation() {
  return {
    _id: "conversation-1",
    workspaceId: "workspace-1",
    channel: "instagram",
    status: "closed",
    createdAt: new Date("2026-08-10T16:00:00.000Z"),
    ...readyClassificationFields(21),
    classification: {
      ...EXISTING_CLASSIFICATION,
      tags: [...EXISTING_CLASSIFICATION.tags],
      confidence: { ...EXISTING_CLASSIFICATION.confidence },
    },
    save: jest.fn().mockResolvedValue(undefined),
  };
}

const NON_CURRENT_CLASSIFICATION_CASES: ReadonlyArray<{
  name: string;
  mutate: (conversation: ReturnType<typeof buildClosedConversation>) => void;
}> = [
  ...NON_READY_CLASSIFICATION_CASES,
  {
    name: "revision mismatch",
    mutate: conversation => {
      conversation.classification_meta.source_revision = 20;
    },
  },
  {
    name: "blank analysis id",
    mutate: conversation => {
      conversation.classification_meta.analysis_revision_id = " ";
    },
  },
  {
    name: "partial root",
    mutate: conversation => {
      delete (conversation as Partial<typeof conversation>)
        .classification_state;
    },
  },
];

const standbyEvent = {
  sender: { id: "ig_user_1", name: "Alice" },
  recipient: { id: "ig_business_1" },
  timestamp: 1_768_995_100_000,
  standby: true,
};

async function reopenThroughStandby(
  closedConversation: ReturnType<typeof buildClosedConversation>
) {
  mockConversationFindOne
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(() => ({
      sort: jest.fn().mockResolvedValue(closedConversation),
    }));
  mockMessageFindOne.mockResolvedValueOnce(null);

  return handleStandby(standbyEvent, source);
}

describe("Instagram webhook meta event persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSavedMessages.length = 0;
    mockConnectDb.mockResolvedValue(undefined);
    mockAcceptAiriIngress.mockResolvedValue({
      accepted: true,
      status: "pending",
    });
    mockDetectLanguage.mockResolvedValue(undefined);
    mockMessageFindOne.mockReset().mockResolvedValue(null);
    mockInvalidateRequestsForWorkspace.mockResolvedValue(undefined);
    mockTriggerConversationRealtime.mockResolvedValue(undefined);
    mockRealtimeTrigger.mockResolvedValue(undefined);
    mockUserFindOneAndUpdate.mockResolvedValue({
      _id: 101,
      firstName: "Alice",
      username: "alice",
    });
    mockUserFindById.mockResolvedValue({
      _id: 101,
      firstName: "Alice",
      username: "alice",
      avatar_url: "https://example.com/alice.jpg",
    });
    mockChatFindOneAndUpdate.mockResolvedValue({
      _id: 202,
      sourceId: "source-1",
      workspaceId: "workspace-1",
    });
    mockConversationFindOne.mockResolvedValue(conversation);
    mockConversationUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockMessageSave.mockResolvedValue(undefined);
    mockAppendMessageToConversationById
      .mockReset()
      .mockResolvedValue({ appended: true });
    mockTriggerConversationReopened.mockResolvedValue(undefined);
    mockMessageFindById.mockReturnValue({
      populate: jest.fn(async () => ({ _id: "saved-message-1" })),
    });
  });

  describe.each([
    {
      name: "message",
      handle: handleIncomingMessage,
      event: {
        message: {
          mid: "provider-message-1",
          text: "Hello",
          quick_reply: { payload: "option-1" },
        },
      },
    },
    {
      name: "postback",
      handle: handlePostback,
      event: {
        postback: {
          mid: "provider-postback-1",
          title: "Option",
          payload: "option-1",
        },
      },
    },
  ])("durable $name ingress", ({ handle, event }) => {
    const incoming = {
      sender: { id: "customer-1", name: "Customer" },
      recipient: { id: "page-1" },
      timestamp: 1_768_995_000_000,
      ...event,
    };

    it("saves a sanitized recovery intent before conversation linkage can fail", async () => {
      mockMessageSave.mockImplementationOnce(
        async (message: Record<string, unknown>) => {
          expect(message.airiIngressIntent).toEqual(
            expect.objectContaining({
              ingressStatus: "pending",
              messageId: "saved-message-1",
              sourceId: "source-1",
              quickReplyPayload: "option-1",
              triggerEventKind: "instagram_quick_reply",
            })
          );
          expect(JSON.stringify(message.airiIngressIntent)).not.toContain(
            '"accessToken"'
          );
        }
      );
      mockAppendMessageToConversationById.mockRejectedValueOnce(
        new Error("append unavailable")
      );

      await expect(handle(incoming, source)).rejects.toThrow(
        "append unavailable"
      );
      expect(mockMessageSave).toHaveBeenCalledTimes(1);
    });

    it("accepts the persisted owner again when a provider retries a saved message", async () => {
      const existing = {
        _id: "persisted-owner",
        date: NOW,
        conversation: "conversation-1",
        workspaceId: "workspace-1",
        channel: "instagram",
        direction: "inbound",
      };
      mockMessageFindOne.mockResolvedValueOnce(existing);

      await expect(handle(incoming, source)).resolves.toEqual(
        expect.objectContaining({ status: "ok", duplicate: true })
      );

      expect(mockAcceptAiriIngress).toHaveBeenCalledWith(
        existing,
        expect.objectContaining({
          newMessage: expect.objectContaining({ _id: "persisted-owner" }),
          quickReplyPayload: "option-1",
        })
      );
      expect(mockMessageSave).not.toHaveBeenCalled();
    });

    it("acknowledges durable acceptance when Temporal dispatch remains pending", async () => {
      await expect(handle(incoming, source)).resolves.toEqual(
        expect.objectContaining({ status: "ok" })
      );

      expect(mockAcceptAiriIngress).toHaveBeenCalledTimes(1);
      expect(mockTriggerConversationRealtime).toHaveBeenCalledTimes(1);
    });
  });

  it("does not arm unsupported message notifications for Airi", async () => {
    await handleIncomingMessage(
      {
        sender: { id: "customer-1", name: "Customer" },
        recipient: { id: "page-1" },
        message: { mid: "unsupported-1", is_unsupported: true },
      },
      source
    );

    expect(mockAcceptAiriIngress).not.toHaveBeenCalled();
    expect(mockSavedMessages[0]).not.toHaveProperty("airiIngressIntent");
  });

  describe("inbound media", () => {
    const cdnUrl = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1";
    const mediaEvent = (type: string) => ({
      sender: { id: "customer-1", name: "Customer" },
      recipient: { id: "page-1" },
      timestamp: 1_768_995_000_000,
      message: {
        mid: "media-mid-1",
        attachments: [{ type, payload: { url: cdnUrl } }],
      },
    });

    it("saves an unsupported_type clip as the stored video it is", async () => {
      mockHandleInstagramMedia.mockResolvedValueOnce({
        publicUrl: "https://storage.test/instagram/media-mid-1.mp4",
        storagePath: "instagram/workspace-1/conversation-1/media-mid-1.mp4",
        contentType: "video/mp4",
        size: 4_442_851,
        mediaType: "video",
      });

      await handleIncomingMessage(mediaEvent("unsupported_type"), source);

      expect(mockHandleInstagramMedia).toHaveBeenCalledWith(
        cdnUrl,
        "workspace-1",
        "conversation-1",
        "media-mid-1"
      );
      expect(mockSavedMessages[0]).toMatchObject({
        text: "[video attachment]",
        imageUrl: "https://storage.test/instagram/media-mid-1.mp4",
        mediaType: "video",
        mimeType: "video/mp4",
        fileSize: 4_442_851,
      });
    });

    it("keeps a story mention's label over its stored media", async () => {
      mockHandleInstagramMedia.mockResolvedValueOnce({
        publicUrl: "https://storage.test/instagram/media-mid-1.mp4",
        storagePath: "instagram/workspace-1/conversation-1/media-mid-1.mp4",
        contentType: "video/mp4",
        size: 10,
        mediaType: "video",
      });

      await handleIncomingMessage(mediaEvent("story_mention"), source);

      expect(mockSavedMessages[0]).toMatchObject({
        text: "Tagged in Instagram story",
        mediaType: "video",
        mimeType: "video/mp4",
      });
    });

    it("still saves the message with the CDN link when the copy fails", async () => {
      mockHandleInstagramMedia.mockRejectedValueOnce(new Error("timeout"));

      await handleIncomingMessage(mediaEvent("unsupported_type"), source);

      expect(mockSavedMessages[0]).toMatchObject({
        text: "[file attachment]",
        imageUrl: cdnUrl,
        mediaType: "file",
      });
      expect(mockSavedMessages[0]).not.toHaveProperty("mimeType");
    });

    it("does not copy media again for a retried webhook", async () => {
      mockMessageFindOne.mockResolvedValue({
        _id: "persisted-owner",
        date: NOW,
        conversation: "conversation-1",
        workspaceId: "workspace-1",
        channel: "instagram",
        direction: "inbound",
      });

      await expect(
        handleIncomingMessage(mediaEvent("unsupported_type"), source)
      ).resolves.toEqual(expect.objectContaining({ duplicate: true }));
      expect(mockHandleInstagramMedia).not.toHaveBeenCalled();
    });
  });

  describe("message echoes", () => {
    const cdnUrl = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=2";
    const businessAuthorId = "instagram_business_page-1";
    const echoEvent = (message: Record<string, unknown>) => ({
      sender: { id: "page-1" },
      recipient: { id: "customer-1" },
      timestamp: 1_768_995_000_000,
      message: { mid: "echo-mid-1", is_echo: true, ...message },
    });

    beforeEach(() => {
      mockMessageExists.mockReset().mockResolvedValue(null);
      mockMessageFind.mockReset();
      mockUserFindOneAndUpdate.mockImplementation(
        async (filter: { _id?: unknown }) =>
          filter._id === businessAuthorId
            ? { _id: businessAuthorId, firstName: "Business Account" }
            : { _id: 101, firstName: "Alice", username: "alice" }
      );
    });

    it("saves a reply typed in the Instagram app as the business, not Airi", async () => {
      await handleMessageEcho(echoEvent({ text: "We open at 10" }), source);

      expect(mockUserFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: businessAuthorId },
        { firstName: "Business Account", isBot: false },
        { upsert: true, new: true }
      );
      expect(mockSavedMessages[0]).toMatchObject({
        text: "We open at 10",
        author: businessAuthorId,
        direction: "outbound",
        origin: {
          kind: "manager",
          sourceId: "source-1",
          sentByUserId: businessAuthorId,
        },
      });
      // An earlier app reply with the same text is not a send to match.
      expect(mockMessageFind).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "We open at 10",
          author: { $ne: businessAuthorId },
        })
      );
    });

    it("copies media sent from the Instagram app", async () => {
      mockHandleInstagramMedia.mockResolvedValueOnce({
        publicUrl: "https://storage.test/instagram/echo-mid-1.jpg",
        storagePath: "instagram/workspace-1/conversation-1/echo-mid-1.jpg",
        contentType: "image/jpeg",
        size: 2048,
        mediaType: "image",
      });

      await handleMessageEcho(
        echoEvent({
          attachments: [{ type: "image", payload: { url: cdnUrl } }],
        }),
        source
      );

      expect(mockHandleInstagramMedia).toHaveBeenCalledWith(
        cdnUrl,
        "workspace-1",
        "conversation-1",
        "echo-mid-1"
      );
      expect(mockSavedMessages[0]).toMatchObject({
        text: "[image attachment]",
        imageUrl: "https://storage.test/instagram/echo-mid-1.jpg",
        mediaType: "image",
        mimeType: "image/jpeg",
        author: businessAuthorId,
      });
    });

    it("does not duplicate a photo that one of our replies sent with its text", async () => {
      mockMessageExists.mockResolvedValueOnce({ _id: "manager-reply" });

      await expect(
        handleMessageEcho(
          echoEvent({
            attachments: [{ type: "image", payload: { url: cdnUrl } }],
          }),
          source
        )
      ).resolves.toEqual(expect.objectContaining({ duplicate: true }));

      expect(mockMessageExists).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation: "conversation-1",
          direction: "outbound",
          author: { $ne: businessAuthorId },
        })
      );
      expect(mockHandleInstagramMedia).not.toHaveBeenCalled();
      expect(mockSavedMessages).toHaveLength(0);
    });

    it("ignores the card templates our own sends produce", async () => {
      await expect(
        handleMessageEcho(
          echoEvent({
            attachments: [
              { type: "template", payload: { template_type: "generic" } },
            ],
          }),
          source
        )
      ).resolves.toEqual({ status: "ignored", reason: "missing_data" });
      expect(mockSavedMessages).toHaveLength(0);
    });
  });

  it("persists Instagram reactions on the target message before triggering realtime", async () => {
    mockMessageFindOne.mockResolvedValueOnce({
      _id: "target-message-1",
      messageId: "ig_mid_1",
    });
    mockMessageUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockMessageFindById.mockReturnValueOnce({
      populate: jest.fn(async () => ({
        _id: "target-message-1",
        reactions: [{ emoji: reactionEmoji, authorId: "101" }],
      })),
    });

    const result = await handleReaction(
      {
        sender: { id: "ig_user_1", name: "Alice" },
        recipient: { id: "ig_business_1" },
        timestamp: 1_768_995_000_000,
        reaction: {
          mid: "ig_mid_1",
          action: "react",
          emoji: reactionEmoji,
        },
      },
      source
    );

    expect(result).toEqual({
      status: "ok",
      type: "reaction",
      messageId: "target-message-1",
    });
    expect(mockMessageUpdateOne).toHaveBeenNthCalledWith(
      1,
      { _id: "target-message-1" },
      { $pull: { reactions: { authorId: "101" } } }
    );
    expect(mockMessageUpdateOne).toHaveBeenNthCalledWith(
      2,
      { _id: "target-message-1" },
      {
        $push: {
          reactions: expect.objectContaining({
            emoji: reactionEmoji,
            authorId: "101",
            authorName: "Alice",
            reactionMessageId: "ig_mid_1:react",
          }),
        },
      }
    );
    expect(mockRealtimeTrigger).toHaveBeenCalledWith(
      "private-conversation-conversation-1",
      "message-reaction",
      expect.objectContaining({
        messageId: "target-message-1",
        reactions: [{ emoji: reactionEmoji, authorId: "101" }],
      })
    );
  });

  it("stores Instagram standby events as raw source messages", async () => {
    mockMessageFindOne.mockResolvedValueOnce(null);

    const result = await handleStandby(
      {
        sender: { id: "ig_user_1", name: "Alice" },
        recipient: { id: "ig_business_1" },
        timestamp: 1_768_995_100_000,
        standby: true,
      },
      source
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: "ok",
        type: "standby",
        conversationId: "conversation-1",
      })
    );
    expect(mockSavedMessages[0]).toEqual(
      expect.objectContaining({
        text: "Instagram standby event received",
        channel: "instagram",
        direction: "inbound",
        rawSourcePayload: expect.objectContaining({
          provider: "instagram",
          eventType: "standby",
        }),
      })
    );
    expect(mockAppendMessageToConversationById).toHaveBeenCalledWith(
      "conversation-1",
      "saved-message-1",
      expect.objectContaining({
        direction: "inbound",
        set: { workspaceId: "workspace-1" },
      })
    );
  });

  describe("conversation reopen classification freshness", () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(NOW);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("keeps the complete classification and payload for an exact current-ready reopen", async () => {
      const closedConversation = buildClosedConversation();

      await expect(reopenThroughStandby(closedConversation)).resolves.toEqual(
        expect.objectContaining({
          status: "ok",
          type: "standby",
          conversationId: "conversation-1",
        })
      );

      expect(closedConversation.status).toBe("open");
      expect(mockTriggerConversationReopened).toHaveBeenCalledWith(
        "workspace-1",
        {
          conversation_id: "conversation-1",
          status: "open",
          previous_status: "closed",
          channel: "instagram",
          customer_phone: "2356106426",
          classification: EXISTING_CLASSIFICATION,
          created_at: "2026-08-10T16:00:00.000Z",
          updated_at: NOW.toISOString(),
        }
      );
    });

    it.each(NON_CURRENT_CLASSIFICATION_CASES)(
      "omits the classification own property for a $name reopen root",
      async ({ mutate }) => {
        const closedConversation = buildClosedConversation();
        mutate(closedConversation);

        await reopenThroughStandby(closedConversation);

        const payload = mockTriggerConversationReopened.mock.calls[0]?.[1];
        expect(payload).toEqual({
          conversation_id: "conversation-1",
          status: "open",
          previous_status: "closed",
          channel: "instagram",
          customer_phone: "2356106426",
          created_at: "2026-08-10T16:00:00.000Z",
          updated_at: NOW.toISOString(),
        });
        expect(Object.hasOwn(payload, "classification")).toBe(false);
      }
    );

    it("does not await the best-effort reopened webhook", async () => {
      mockTriggerConversationReopened.mockReturnValue(
        new Promise<never>(() => undefined)
      );

      await expect(
        reopenThroughStandby(buildClosedConversation())
      ).resolves.toEqual(
        expect.objectContaining({
          status: "ok",
          type: "standby",
          conversationId: "conversation-1",
        })
      );
    });
  });
});
