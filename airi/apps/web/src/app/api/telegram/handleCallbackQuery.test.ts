const mockAnswerCallbackQuery = jest.fn();
const mockRemoveInlineKeyboard = jest.fn();
const mockEditTelegramMessage = jest.fn();
const mockFindConversationById = jest.fn();
const mockFindConversationByIdAndUpdate = jest.fn();
const mockAppendMessageToConversationById = jest.fn();
const mockAcceptAiriConversationIngress = jest.fn();
const mockMessageSave = jest.fn();
const mockMessageFindOne = jest.fn();
const mockTriggerConversationResolved = jest.fn();
const mockTriggerCsatSubmitted = jest.fn();

jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: jest.fn() } }));

jest.mock("@/lib/telegram", () => ({
  answerCallbackQuery: (...args: unknown[]) => mockAnswerCallbackQuery(...args),
  removeInlineKeyboard: (...args: unknown[]) =>
    mockRemoveInlineKeyboard(...args),
  editTelegramMessage: (...args: unknown[]) => mockEditTelegramMessage(...args),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockFindConversationById(...args),
    findByIdAndUpdate: (...args: unknown[]) =>
      mockFindConversationByIdAndUpdate(...args),
  },
}));

jest.mock("@/lib/webhook-events", () => ({
  triggerConversationResolved: (...args: unknown[]) =>
    mockTriggerConversationResolved(...args),
  triggerCsatSubmitted: (...args: unknown[]) =>
    mockTriggerCsatSubmitted(...args),
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: Object.assign(
    jest.fn().mockImplementation(doc => ({
      ...doc,
      _id: "msg_1",
      save: mockMessageSave,
    })),
    { findOne: (...args: unknown[]) => mockMessageFindOne(...args) }
  ),
}));

jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (...args: unknown[]) =>
    mockAppendMessageToConversationById(...args),
}));

jest.mock("@/lib/temporal/airi-direct-ingress", () => ({
  acceptAiriConversationIngress: (...args: unknown[]) =>
    mockAcceptAiriConversationIngress(...args),
}));

jest.mock("@/lib/temporal/airi-turn-context", () => ({
  buildAiriConversationIngressIntent: (payload: {
    newMessage: { _id: string };
    quickReplyPayload?: string;
    triggerEventKind?: string;
  }) => ({
    messageId: payload.newMessage._id,
    quickReplyPayload: payload.quickReplyPayload,
    triggerEventKind: payload.triggerEventKind,
    ingressStatus: "pending",
  }),
}));

import { handleCallbackQuery } from "@/app/api/telegram/handleCallbackQuery";
import {
  NON_READY_CLASSIFICATION_CASES,
  readyClassificationFields,
} from "@/lib/classifier/classified-conversation-test-utils";

const EXISTING_CLASSIFICATION = {
  category: "Support",
  priority: "high",
  sentiment: "negative",
  summary: "Customer needs urgent help",
  action: "Escalate",
  tags: ["vip"],
  confidence: {
    category: 0.94,
    priority: 0.91,
    sentiment: 0.88,
  },
};

function buildRatedConversation() {
  return {
    _id: "conv_1",
    workspaceId: "ws_1",
    channel: "telegram",
    user: "customer_1",
    createdAt: new Date("2026-08-10T10:00:00.000Z"),
    ...readyClassificationFields(5),
    classification: {
      ...EXISTING_CLASSIFICATION,
      tags: [...EXISTING_CLASSIFICATION.tags],
      confidence: { ...EXISTING_CLASSIFICATION.confidence },
    },
  };
}

const NON_CURRENT_CLASSIFICATION_CASES: ReadonlyArray<{
  name: string;
  mutate: (conversation: ReturnType<typeof buildRatedConversation>) => void;
}> = [
  ...NON_READY_CLASSIFICATION_CASES,
  {
    name: "revision mismatch",
    mutate: conversation => {
      conversation.classification_state.requestedRevision = 6;
    },
  },
  {
    name: "blank analysis id",
    mutate: conversation => {
      conversation.classification_meta.analysis_revision_id = "\t";
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

function ratingCallbackQuery() {
  return {
    id: "callback_rating_1",
    data: "rate:4:conv_1",
    from: {
      id: 5001,
      is_bot: false,
      first_name: "Customer",
    },
    message: {
      message_id: 7001,
      chat: {
        id: 9001,
        type: "private" as const,
        first_name: "Customer",
      },
      date: 1_700_000_000,
      text: "Rate the conversation",
    },
  };
}

describe("handleCallbackQuery", () => {
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    mockAnswerCallbackQuery.mockResolvedValue(true);
    mockRemoveInlineKeyboard.mockResolvedValue(true);
    mockEditTelegramMessage.mockResolvedValue(true);
    mockMessageSave.mockResolvedValue(undefined);
    mockAppendMessageToConversationById.mockResolvedValue(undefined);
    mockAcceptAiriConversationIngress.mockResolvedValue({ queued: true });
    mockTriggerConversationResolved.mockResolvedValue(undefined);
    mockTriggerCsatSubmitted.mockResolvedValue(undefined);
    mockFindConversationById.mockResolvedValue({
      _id: "conv_1",
      workspaceId: "ws_1",
      sourceId: "source_1",
      chat: { _id: "chat_doc_1" },
      business_connection_id: "biz_1",
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it("removes scenario quick-reply keyboard with the conversation business connection context", async () => {
    await handleCallbackQuery(
      {
        id: "callback_1",
        data: "sqr:conv_1:airi_chat",
        from: {
          id: 5001,
          is_bot: false,
          first_name: "Customer",
        },
        message: {
          message_id: 7001,
          chat: {
            id: 9001,
            type: "private",
            first_name: "Customer",
          },
          date: 1_700_000_000,
          text: "Choose one",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "What is Airi.chat?",
                  callback_data: "sqr:conv_1:airi_chat",
                },
              ],
            ],
          },
        },
      },
      {
        sourceId: "source_1",
        workspaceId: "ws_1",
        botToken: "bot_token_1",
      }
    );

    expect(mockRemoveInlineKeyboard).toHaveBeenCalledWith("9001", "7001", {
      botToken: "bot_token_1",
      businessConnectionId: "biz_1",
    });
    expect(mockMessageSave).toHaveBeenCalled();
    expect(mockAcceptAiriConversationIngress).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "msg_1",
        messageId: "callback:callback_1",
      }),
      expect.objectContaining({
        quickReplyPayload: "airi_chat",
        chatDocument: expect.objectContaining({
          businessConnectionId: "biz_1",
        }),
      })
    );
  });

  it("keeps an accepted callback recoverable when immediate Temporal delivery is deferred", async () => {
    const callback = {
      ...ratingCallbackQuery(),
      id: "callback_deferred_1",
      data: "sqr:conv_1:continue",
    };
    mockMessageSave.mockImplementationOnce(function (
      this: Record<string, unknown>
    ) {
      expect(this.messageId).toBe("callback:callback_deferred_1");
      expect(this.airiIngressIntent).toEqual({
        messageId: "msg_1",
        quickReplyPayload: "continue",
        triggerEventKind: "telegram_quick_reply",
        ingressStatus: "pending",
      });
      return Promise.resolve();
    });
    mockAcceptAiriConversationIngress.mockResolvedValueOnce({ queued: false });
    mockAppendMessageToConversationById.mockImplementationOnce(async () => {
      expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(1);
    });

    await expect(handleCallbackQuery(callback)).resolves.toBeUndefined();
    expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(1);
  });

  it("retries a saved callback with the original message identity", async () => {
    const savedCallback = {
      _id: "original_callback_message",
      text: "continue",
      date: new Date("2026-01-01T00:00:00.000Z"),
      conversation: "conv_1",
      direction: "inbound",
      channel: "telegram",
    };
    mockMessageSave.mockRejectedValueOnce({ code: 11000 });
    mockMessageFindOne.mockResolvedValueOnce(savedCallback);

    await handleCallbackQuery({
      ...ratingCallbackQuery(),
      id: "callback_retry_1",
      data: "sqr:conv_1:continue",
    });

    expect(mockMessageFindOne).toHaveBeenCalledWith({
      chat: "chat_doc_1",
      messageId: "callback:callback_retry_1",
    });
    expect(mockAcceptAiriConversationIngress).toHaveBeenCalledWith(
      savedCallback,
      expect.objectContaining({
        newMessage: savedCallback,
        quickReplyPayload: "continue",
      })
    );
  });

  it("retains grounded option metadata in the saved callback intent", async () => {
    mockMessageFindOne.mockReturnValueOnce({
      select: () => ({
        lean: async () => ({
          groundedReplyOptions: {
            options: [
              {
                id: "option_1",
                label: "Plan A",
                sourceKind: "kb",
                sourceIds: ["article_1"],
              },
            ],
          },
        }),
      }),
    });
    mockMessageSave.mockImplementationOnce(function (this: {
      airiIngressIntent: { quickReplyPayload: string };
    }) {
      expect(
        JSON.parse(this.airiIngressIntent.quickReplyPayload)
      ).toMatchObject({
        kind: "grounded_option",
        id: "option_1",
        label: "Plan A",
        sourceKind: "kb",
        sourceIds: ["article_1"],
      });
      return Promise.resolve();
    });

    await handleCallbackQuery({
      ...ratingCallbackQuery(),
      data: "gqr:conv_1:option_1",
    });

    expect(mockAcceptAiriConversationIngress).toHaveBeenCalledTimes(1);
  });

  it("rejects callbacks until their ingress has durable acceptance", async () => {
    mockAcceptAiriConversationIngress.mockRejectedValueOnce(
      new Error("intent persistence unavailable")
    );

    await expect(
      handleCallbackQuery({
        ...ratingCallbackQuery(),
        data: "sqr:conv_1:continue",
      })
    ).rejects.toThrow("intent persistence unavailable");
    expect(mockAppendMessageToConversationById).not.toHaveBeenCalled();
  });

  it("keeps the complete classification on an exact current-ready Telegram resolution", async () => {
    mockFindConversationByIdAndUpdate.mockResolvedValue(
      buildRatedConversation()
    );

    await handleCallbackQuery(ratingCallbackQuery());

    expect(mockTriggerCsatSubmitted).toHaveBeenCalledWith(
      "ws_1",
      expect.objectContaining({
        conversation_id: "conv_1",
        score: 4,
        channel: "telegram",
      })
    );
    expect(mockTriggerConversationResolved.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        conversation_id: "conv_1",
        status: "closed",
        channel: "telegram",
        customer_phone: "customer_1",
        classification: EXISTING_CLASSIFICATION,
        resolution_kind: "customer_csat",
        created_at: "2026-08-10T10:00:00.000Z",
      })
    );
  });

  it("reports measured Telegram service time in whole seconds", async () => {
    mockFindConversationByIdAndUpdate.mockResolvedValue({
      ...buildRatedConversation(),
      status: "closed",
      service_episode_started_at: new Date("2026-08-10T10:00:00.000Z"),
      service_resolved_at: new Date("2026-08-10T10:02:05.700Z"),
      service_resolution_kind: "customer_csat",
    });

    await handleCallbackQuery(ratingCallbackQuery());

    expect(mockTriggerConversationResolved.mock.calls[0]?.[1]).toMatchObject({
      resolution_kind: "customer_csat",
      resolution_time_seconds: 126,
    });
  });

  it.each(NON_CURRENT_CLASSIFICATION_CASES)(
    "omits the classification own property for a $name Telegram resolution",
    async ({ mutate }) => {
      const conversation = buildRatedConversation();
      mutate(conversation);
      mockFindConversationByIdAndUpdate.mockResolvedValue(conversation);

      await handleCallbackQuery(ratingCallbackQuery());

      const payload = mockTriggerConversationResolved.mock.calls[0]?.[1];
      expect(payload).toEqual(
        expect.objectContaining({
          conversation_id: "conv_1",
          status: "closed",
          channel: "telegram",
          customer_phone: "customer_1",
          created_at: "2026-08-10T10:00:00.000Z",
        })
      );
      expect(Object.hasOwn(payload, "classification")).toBe(false);
    }
  );

  it("does not await the best-effort resolved webhook", async () => {
    mockFindConversationByIdAndUpdate.mockResolvedValue(
      buildRatedConversation()
    );
    mockTriggerConversationResolved.mockReturnValue(
      new Promise<never>(() => undefined)
    );

    await expect(
      handleCallbackQuery(ratingCallbackQuery())
    ).resolves.toBeUndefined();
  });
});
