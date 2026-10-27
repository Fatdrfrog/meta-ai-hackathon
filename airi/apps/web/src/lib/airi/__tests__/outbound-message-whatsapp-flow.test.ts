const mockSendWhatsappInteractiveFlow = jest.fn();
const mockSendWhatsappInteractiveReplyButtons = jest.fn();
const mockSendWhatsappInteractiveList = jest.fn();
const mockSendWhatsappInteractiveReplyButtonsMessage = jest.fn();
const mockSendWhatsappMedia = jest.fn();
const mockSendWhatsappMessage = jest.fn();
const mockSendWhatsappTemplate = jest.fn();
const mockSendWhatsappContacts = jest.fn();
const mockSendWhatsappLocation = jest.fn();
const mockAppendMessageToConversationById = jest.fn();
const mocktriggerRealtimeEvent = jest.fn();
const mockTrackScenarioFlowSent = jest.fn();
const mockGetActiveScenarioFlowSuppression = jest.fn();
const mockSuppressScenarioFlowAfterIntegrityBlock = jest.fn();
const mockCheckMessagingWindow = jest.fn();
const mockCheckMessagingWindowForConversation = jest.fn();
const mockGetWorkspaceEmailSource = jest.fn();
const mockResolveEmailProviderForWorkspaceSource = jest.fn();
const mockGetWorkspaceEmailProviderConfig = jest.fn();
const mockIsManagedEmailProviderPending = jest.fn();
const mockPostmarkSendEmail = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockSave = jest.fn();
const mockPopulate = jest.fn();
const mockFetch = jest.fn();
const mockSendWhatsAppLlmHelpfulnessPrompt = jest.fn();
const mockUpsertWhatsAppLlmAnswerReviewItem = jest.fn();
const mockEnqueueWhatsAppLlmHelpfulnessPromptWithOutbox = jest.fn();
const mockMessagePayloads: Record<string, unknown>[] = [];
const mockFetchSourceWithCredentialsResult = jest.fn();

jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappInteractiveFlow: (...args: unknown[]) =>
    mockSendWhatsappInteractiveFlow(...args),
  sendWhatsappInteractiveReplyButtons: (...args: unknown[]) =>
    mockSendWhatsappInteractiveReplyButtons(...args),
  sendWhatsappInteractiveList: (...args: unknown[]) =>
    mockSendWhatsappInteractiveList(...args),
  sendWhatsappInteractiveReplyButtonsMessage: (...args: unknown[]) =>
    mockSendWhatsappInteractiveReplyButtonsMessage(...args),
  sendWhatsappMedia: (...args: unknown[]) => mockSendWhatsappMedia(...args),
  sendWhatsappMessage: (...args: unknown[]) => mockSendWhatsappMessage(...args),
  sendWhatsappTemplate: (...args: unknown[]) =>
    mockSendWhatsappTemplate(...args),
  sendWhatsappContacts: (...args: unknown[]) =>
    mockSendWhatsappContacts(...args),
  sendWhatsappLocation: (...args: unknown[]) =>
    mockSendWhatsappLocation(...args),
}));

jest.mock("@/lib/telegram", () => ({
  sendTelegramMessage: jest.fn(),
  sendTelegramPhoto: jest.fn(),
  sendTelegramDocument: jest.fn(),
}));

jest.mock("@icecore/shared/lib/whatsapp/contact-identities", () => ({
  getWhatsAppLogIdentity: () => "77012345678",
  buildNormalizedWhatsAppContact: (value: Record<string, unknown>) => ({
    waId: value.waId,
    userId: value.userId,
    parentUserId: value.parentUserId,
    profile: { name: value.profileName },
    primaryIdType: value.waId ? "wa_id" : "bsuid",
  }),
  normalizeWhatsAppPhone: (value: unknown) =>
    typeof value === "string" ? value.replace(/\D/g, "") : "",
  resolveStoredWhatsAppRecipientTarget: (...sources: unknown[]) => {
    for (const source of sources) {
      if (source && typeof source === "object") {
        const whatsapp = (source as { whatsapp?: { waId?: unknown } }).whatsapp;
        if (typeof whatsapp?.waId === "string") {
          return { kind: "phone", value: whatsapp.waId.replace(/\D/g, "") };
        }
      }
    }
    return null;
  },
  resolveWhatsAppRecipientTarget: (
    contact?: { waId?: string; userId?: string; parentUserId?: string } | null
  ) => {
    if (contact?.waId) return { kind: "phone", value: contact.waId };
    if (contact?.userId) return { kind: "bsuid", value: contact.userId };
    if (contact?.parentUserId) {
      return { kind: "parent_bsuid", value: contact.parentUserId };
    }
    return null;
  },
}));

jest.mock("@/lib/airi/reply/delivery/reply-rich-text-format", () => ({
  formatReplyMarkdownForInstagram: (value: string) => value,
  formatReplyMarkdownForTelegramHtml: (value: string) => value,
  formatReplyMarkdownForWhatsApp: (value: string) => value,
}));

jest.mock("@/lib/airi/conversation", () => ({
  isGreetingMessage: () => false,
  markGreetingSentToday: jest.fn(),
}));

jest.mock("@/lib/airi/reply/delivery/temporal-outbound", () => ({
  reserveTemporalOutboundDispatch: () => {
    throw new Error("Temporal outbound capture is not active");
  },
}));

jest.mock("@/lib/messaging-window", () => ({
  checkMessagingWindow: (...args: unknown[]) =>
    mockCheckMessagingWindow(...args),
  checkMessagingWindowForConversation: (...args: unknown[]) =>
    mockCheckMessagingWindowForConversation(...args),
}));

jest.mock("@/lib/email/provider-config", () => ({
  getWorkspaceEmailProviderConfig: (...args: unknown[]) =>
    mockGetWorkspaceEmailProviderConfig(...args),
  isManagedEmailProviderPending: (...args: unknown[]) =>
    mockIsManagedEmailProviderPending(...args),
}));

jest.mock("@/lib/email/email-source", () => ({
  getWorkspaceEmailSource: (...args: unknown[]) =>
    mockGetWorkspaceEmailSource(...args),
  resolveEmailProviderForWorkspaceSource: (...args: unknown[]) =>
    mockResolveEmailProviderForWorkspaceSource(...args),
}));

jest.mock("@/lib/postmark", () => ({
  postmarkSendEmail: (...args: unknown[]) => mockPostmarkSendEmail(...args),
}));

jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: (...args: unknown[]) =>
    mockAppendMessageToConversationById(...args),
}));

jest.mock("@/lib/realtime/server", () => ({
  triggerRealtimeEvent: (...args: unknown[]) =>
    mocktriggerRealtimeEvent(...args),
}));

jest.mock("@/lib/scenarios/scenario-flow-analytics", () => ({
  trackScenarioFlowSent: (...args: unknown[]) =>
    mockTrackScenarioFlowSent(...args),
}));

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: jest.fn(async () => null),
  fetchSourceWithCredentialsResult: (...args: unknown[]) =>
    mockFetchSourceWithCredentialsResult(...args),
}));

jest.mock("@/lib/scenarios/scenario-flow-suppression", () => ({
  WHATSAPP_FLOW_INTEGRITY_BLOCK_CODE: 139000,
  getActiveScenarioFlowSuppression: (...args: unknown[]) =>
    mockGetActiveScenarioFlowSuppression(...args),
  getWhatsAppFlowErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  isWhatsAppFlowIntegrityBlockError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return /\b139000\b/.test(message) || /integrity block/i.test(message);
  },
  suppressScenarioFlowAfterIntegrityBlock: (...args: unknown[]) =>
    mockSuppressScenarioFlowAfterIntegrityBlock(...args),
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
  },
}));

jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateModel: {
    findOne: jest.fn(() => ({
      select: jest.fn(() => ({
        lean: jest.fn(async () => null),
      })),
    })),
  },
}));

jest.mock("@/lib/llm-analytics/whatsapp-feedback", () => ({
  sendWhatsAppLlmHelpfulnessPrompt: (...args: unknown[]) =>
    mockSendWhatsAppLlmHelpfulnessPrompt(...args),
  upsertWhatsAppLlmAnswerReviewItem: (...args: unknown[]) =>
    mockUpsertWhatsAppLlmAnswerReviewItem(...args),
}));

jest.mock("@/lib/cross-store-outbox", () => ({
  enqueueWhatsAppLlmHelpfulnessPromptWithOutbox: (...args: unknown[]) =>
    mockEnqueueWhatsAppLlmHelpfulnessPromptWithOutbox(...args),
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  buildTemporalDeliveryKeyFilter: (...args: unknown[]) =>
    jest
      .requireActual("@/models/message")
      .buildTemporalDeliveryKeyFilter(...args),
  default: Object.assign(
    jest.fn(function MockMessage(
      this: Record<string, unknown>,
      payload: Record<string, unknown>
    ) {
      Object.assign(this, payload);
      this._id = payload._id || { toString: () => "outbound-message-id" };
      mockMessagePayloads.push(this);
      this.save = (...args: unknown[]) => mockSave(...args);
    }),
    {
      findOne: jest.fn(),
      findById: jest.fn(() => ({
        populate: (...args: unknown[]) => mockPopulate(...args),
      })),
    }
  ),
}));

import { sendAndPersistOutbound } from "@/lib/airi/reply/delivery/outbound-message";

beforeAll(() => {
  Object.defineProperty(global, "fetch", {
    writable: true,
    value: mockFetch,
  });
});

beforeEach(() => {
  mockGetWorkspaceEmailSource.mockResolvedValue(null);
  mockResolveEmailProviderForWorkspaceSource.mockResolvedValue(null);
});

describe("sendAndPersistOutbound WhatsApp Flow delivery", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMessagePayloads.length = 0;
    jest.requireMock("@/models/message").default.findOne.mockReset();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFindOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ _id: "bot-user-id" }),
    });
    mockCheckMessagingWindow.mockResolvedValue({ isWithinWindow: true });
    mockCheckMessagingWindowForConversation.mockResolvedValue({
      isWithinWindow: true,
    });
    mockSendWhatsappInteractiveReplyButtons.mockResolvedValue({
      messageId: "wamid.buttons",
    });
    mockSendWhatsappInteractiveList.mockResolvedValue({
      messageId: "wamid.list",
    });
    mockSendWhatsappInteractiveReplyButtonsMessage.mockResolvedValue({
      messageId: "wamid.service-buttons",
    });
    mockSendWhatsappMedia.mockResolvedValue({ messageId: "wamid.media" });
    mockSendWhatsappMessage.mockResolvedValue({ messageId: "wamid.text" });
    mockSendWhatsappContacts.mockResolvedValue({ messageId: "wamid.contact" });
    mockSendWhatsappLocation.mockResolvedValue({
      messageId: "wamid.location",
    });
    mockPopulate.mockResolvedValue({});
    mockGetWorkspaceEmailProviderConfig.mockResolvedValue({
      status: "active",
      transactionalStream: "outbound",
      postmarkServerToken: "postmark-token",
    });
    mockIsManagedEmailProviderPending.mockReturnValue(false);
    mockPostmarkSendEmail.mockResolvedValue({ MessageID: "postmark-id" });
    mockSendWhatsAppLlmHelpfulnessPrompt.mockResolvedValue(undefined);
    mockUpsertWhatsAppLlmAnswerReviewItem.mockResolvedValue({
      item: { _id: "review-item-id" },
      inserted: true,
    });
    mockEnqueueWhatsAppLlmHelpfulnessPromptWithOutbox.mockResolvedValue({
      queuedToOutbox: true,
    });
    mockGetActiveScenarioFlowSuppression.mockResolvedValue(null);
    mockSuppressScenarioFlowAfterIntegrityBlock.mockResolvedValue(undefined);
    mockFetchSourceWithCredentialsResult.mockImplementation(
      async (sourceId: string | undefined) => ({
        ok: true,
        source: {
          id: sourceId || "source-1",
          workspace_id: "workspace-1",
          credentials: {
            phone_number_id: "phone-number-id",
            access_token: "access-token",
            waba_id: "waba-1",
          },
        },
      })
    );
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("sends WhatsApp text before resolving the Airi bot author or persisting locally", async () => {
    const order: string[] = [];
    mockSendWhatsappMessage.mockImplementationOnce(async () => {
      order.push("meta-send");
      return { messageId: "wamid.text" };
    });
    mockFindOneAndUpdate.mockImplementationOnce(() => {
      order.push("bot-user");
      return {
        exec: jest.fn().mockResolvedValue({ _id: "bot-user-id" }),
      };
    });
    mockSave.mockImplementationOnce(async () => {
      order.push("message-save");
    });
    mockAppendMessageToConversationById.mockImplementationOnce(async () => {
      order.push("conversation-append");
    });

    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1" } as never,
      content: "Thanks, I can help.",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Customer" },
          primaryIdType: "wa_id",
        },
      },
    } as never);

    expect(mockSendWhatsappMessage).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      "Thanks, I can help."
    );
    expect(mockCheckMessagingWindowForConversation).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "conversation-1" })
    );
    expect(mockCheckMessagingWindow).not.toHaveBeenCalled();
    expect(order).toEqual([
      "meta-send",
      "bot-user",
      "message-save",
      "conversation-append",
    ]);
  });

  it("uses the resolved WhatsApp recipient, not chatId, for feedback tester gating", async () => {
    const previousEnabled = process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED;
    const previousTesters = process.env.LLM_WHATSAPP_FEEDBACK_TESTERS;
    process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED = "true";
    process.env.LLM_WHATSAPP_FEEDBACK_TESTERS = "7012345678";

    try {
      await sendAndPersistOutbound({
        type: "whatsapp",
        chatId: "conversation-chat-id",
        workspaceId: "workspace-1",
        conversation: {
          _id: "conversation-1",
          sourceId: "source-1",
        } as never,
        chatDocument: { _id: "chat-1" } as never,
        content: "Thanks, I can help.",
        whatsAppInfo: {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          contactData: {
            waId: "77012345678",
            profile: { name: "Customer" },
            primaryIdType: "wa_id",
          },
        },
      } as never);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED;
      } else {
        process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED = previousEnabled;
      }
      if (previousTesters === undefined) {
        delete process.env.LLM_WHATSAPP_FEEDBACK_TESTERS;
      } else {
        process.env.LLM_WHATSAPP_FEEDBACK_TESTERS = previousTesters;
      }
    }

    expect(mockUpsertWhatsAppLlmAnswerReviewItem).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        sourceMessageId: "ws_wamid.text",
      })
    );
    expect(
      mockEnqueueWhatsAppLlmHelpfulnessPromptWithOutbox
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      sourceId: "source-1",
      recipient: { kind: "phone", value: "77012345678" },
      sourceMessageId: "ws_wamid.text",
    });
    expect(mockSendWhatsAppLlmHelpfulnessPrompt).not.toHaveBeenCalled();
  });

  it("binds the durable feedback prompt to the chat source before the conversation fallback", async () => {
    const previousEnabled = process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED;
    const previousTesters = process.env.LLM_WHATSAPP_FEEDBACK_TESTERS;
    process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED = "true";
    process.env.LLM_WHATSAPP_FEEDBACK_TESTERS = "77012345678";

    try {
      await sendAndPersistOutbound({
        type: "whatsapp",
        workspaceId: "workspace-1",
        conversation: { _id: "conversation-1" } as never,
        chatDocument: {
          _id: "chat-1",
          sourceId: "chat-source-1",
        } as never,
        content: "Thanks, I can help.",
        whatsAppInfo: {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          contactData: {
            waId: "77012345678",
            profile: { name: "Customer" },
            primaryIdType: "wa_id",
          },
        },
      } as never);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED;
      } else {
        process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED = previousEnabled;
      }
      if (previousTesters === undefined) {
        delete process.env.LLM_WHATSAPP_FEEDBACK_TESTERS;
      } else {
        process.env.LLM_WHATSAPP_FEEDBACK_TESTERS = previousTesters;
      }
    }

    expect(
      mockEnqueueWhatsAppLlmHelpfulnessPromptWithOutbox
    ).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "chat-source-1" })
    );
  });

  it("sends from the conversation's number after another workspace took over the shared chat", async () => {
    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        workspaceId: "workspace-1",
        sourceId: "source-own",
      } as never,
      // The customer's latest message went to another business on airi.chat.
      chatDocument: {
        _id: "wa_77012345678",
        workspaceId: "workspace-2",
        sourceId: "source-other",
      } as never,
      content: "Thanks, I can help.",
      whatsAppInfo: {
        contactData: {
          waId: "77012345678",
          profile: { name: "Customer" },
          primaryIdType: "wa_id",
        },
      },
    } as never);

    expect(mockFetchSourceWithCredentialsResult).toHaveBeenCalledWith(
      "source-own",
      "whatsapp"
    );
    expect(mockFetchSourceWithCredentialsResult).not.toHaveBeenCalledWith(
      "source-other",
      expect.anything()
    );
    expect(mockSendWhatsappMessage).toHaveBeenCalledTimes(1);
  });

  it("routes concurrent direct prompt requests through the durable outbox boundary", async () => {
    const previousEnabled = process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED;
    const previousTesters = process.env.LLM_WHATSAPP_FEEDBACK_TESTERS;
    process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED = "true";
    process.env.LLM_WHATSAPP_FEEDBACK_TESTERS = "77012345678";
    mockUpsertWhatsAppLlmAnswerReviewItem
      .mockResolvedValueOnce({
        item: { _id: "review-item-id" },
        inserted: true,
      })
      .mockResolvedValueOnce({
        item: { _id: "review-item-id" },
        inserted: false,
      });

    const context = {
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      },
      chatDocument: { _id: "chat-1" },
      content: "Thanks, I can help.",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Customer" },
          primaryIdType: "wa_id",
        },
      },
    };

    try {
      await Promise.all([
        sendAndPersistOutbound(context as never),
        sendAndPersistOutbound(context as never),
      ]);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED;
      } else {
        process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED = previousEnabled;
      }
      if (previousTesters === undefined) {
        delete process.env.LLM_WHATSAPP_FEEDBACK_TESTERS;
      } else {
        process.env.LLM_WHATSAPP_FEEDBACK_TESTERS = previousTesters;
      }
    }

    expect(mockUpsertWhatsAppLlmAnswerReviewItem).toHaveBeenCalledTimes(2);
    expect(
      mockEnqueueWhatsAppLlmHelpfulnessPromptWithOutbox
    ).toHaveBeenCalledTimes(2);
    expect(mockSendWhatsAppLlmHelpfulnessPrompt).not.toHaveBeenCalled();
  });

  it("does not match feedback testers by arbitrary phone substring", async () => {
    const previousEnabled = process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED;
    const previousTesters = process.env.LLM_WHATSAPP_FEEDBACK_TESTERS;
    process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED = "true";
    process.env.LLM_WHATSAPP_FEEDBACK_TESTERS = "1234567";

    try {
      await sendAndPersistOutbound({
        type: "whatsapp",
        chatId: "conversation-chat-id",
        workspaceId: "workspace-1",
        conversation: {
          _id: "conversation-1",
          sourceId: "source-1",
        } as never,
        chatDocument: { _id: "chat-1" } as never,
        content: "Thanks, I can help.",
        whatsAppInfo: {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          contactData: {
            waId: "77012345678",
            profile: { name: "Customer" },
            primaryIdType: "wa_id",
          },
        },
      } as never);
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED;
      } else {
        process.env.LLM_WHATSAPP_FEEDBACK_PROMPT_ENABLED = previousEnabled;
      }
      if (previousTesters === undefined) {
        delete process.env.LLM_WHATSAPP_FEEDBACK_TESTERS;
      } else {
        process.env.LLM_WHATSAPP_FEEDBACK_TESTERS = previousTesters;
      }
    }

    expect(mockUpsertWhatsAppLlmAnswerReviewItem).not.toHaveBeenCalled();
    expect(mockSendWhatsAppLlmHelpfulnessPrompt).not.toHaveBeenCalled();
  });
  it("dispatches a canonical service message without entering the legacy priority chain", async () => {
    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
      content: "Airi: Choose one",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Ada" },
          primaryIdType: "wa_id",
        },
      },
      whatsappServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose one" },
          options: [{ id: "yes", label: "Yes" }],
        },
      },
    });

    expect(
      mockSendWhatsappInteractiveReplyButtonsMessage
    ).toHaveBeenCalledTimes(1);
    expect(mockSendWhatsappInteractiveReplyButtons).not.toHaveBeenCalled();
    expect(mockSendWhatsappInteractiveList).not.toHaveBeenCalled();
    expect(mockSendWhatsappMedia).not.toHaveBeenCalled();
    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
  });

  it("keeps canonical service ownership over every stale WhatsApp projection", async () => {
    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
      content: "Choose one",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Ada" },
          primaryIdType: "wa_id",
        },
      },
      scenarioOrigin: {
        scenarioId: "scenario-1",
        actionNodeId: "action-1",
      },
      whatsappServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose one" },
          options: [{ id: "yes", label: "Yes" }],
        },
      },
      whatsappTemplate: {
        name: "stale_template",
        languageCode: "en",
      },
      whatsappFlowCta: {
        flowId: "stale-flow",
        flowCta: "Stale Flow",
      },
      whatsappCtaLink: {
        title: "Stale link",
        url: "https://example.com/stale",
      },
      whatsappContact: {
        formattedName: "Stale contact",
        phone: "+77010000000",
      },
      whatsappLocation: {
        latitude: 43.2,
        longitude: 76.9,
        name: "Stale location",
      },
      groundedReplyOptions: [{ id: "stale", label: "Stale option" }],
    } as never);

    expect(
      mockSendWhatsappInteractiveReplyButtonsMessage
    ).toHaveBeenCalledTimes(1);
    expect(mockSendWhatsappTemplate).not.toHaveBeenCalled();
    expect(mockSendWhatsappContacts).not.toHaveBeenCalled();
    expect(mockSendWhatsappLocation).not.toHaveBeenCalled();
    expect(mockSendWhatsappInteractiveReplyButtons).not.toHaveBeenCalled();
    expect(mockMessagePayloads).toHaveLength(1);
    expect(mockMessagePayloads[0]).toEqual(
      expect.objectContaining({
        whatsappServiceMessage: expect.objectContaining({
          kind: "reply_buttons",
        }),
        origin: expect.objectContaining({ templateName: null }),
      })
    );
    expect(mockMessagePayloads[0]?.whatsappTemplate).toBeUndefined();
    expect(mockMessagePayloads[0]?.whatsappFlow).toBeUndefined();
    expect(mockMessagePayloads[0]?.whatsappCtaLink).toBeUndefined();
    expect(mockMessagePayloads[0]?.whatsappContacts).toBeUndefined();
    expect(mockMessagePayloads[0]?.whatsappLocation).toBeUndefined();
    expect(mockMessagePayloads[0]?.groundedReplyOptions).toBeUndefined();
  });

  it("sends authored canonical service-message copy verbatim", async () => {
    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
      content: "Airi: welcome",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Ada" },
          primaryIdType: "wa_id",
        },
      },
      whatsappServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Airi: welcome" },
          options: [{ id: "continue", label: "Continue" }],
        },
      },
    });

    expect(mockSendWhatsappInteractiveReplyButtonsMessage).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        bodyText: "Airi: welcome",
        buttons: [{ id: "continue", title: "Continue" }],
      }
    );
  });

  it("uses the managed provider id and one persisted endpoint token for canonical Flow delivery", async () => {
    mockSendWhatsappInteractiveFlow.mockResolvedValueOnce({
      messageId: "wamid.canonical-flow",
    });

    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
      content: "Complete the form",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Ada" },
          primaryIdType: "wa_id",
        },
      },
      scenarioOrigin: {
        scenarioId: "scenario-1",
        actionNodeId: "action-flow",
      },
      whatsappFlowCta: {
        flowId: "stale-flow",
        flowCta: "Stale Flow",
      },
      whatsappCtaLink: {
        title: "Stale link",
        url: "https://example.com/stale",
      },
      whatsappServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Complete the form" },
          flowConfig: {
            templateId: "local-flow",
            ctaText: "Open flow",
            metaFlowId: "stale-meta-flow-id",
            managedProvisioning: {
              operationId: "operation-1",
              sourceId: "source-1",
              wabaId: "waba-1",
              contentRevision: 2,
              contentDigest: "digest-2",
              flowId: "managed-flow-id",
              providerStatus: "PUBLISHED",
            },
            flowNavigationMode: "data_endpoint",
            screens: [
              { id: "DETAILS", title: "Details", fields: [] },
              { id: "CONFIRM", title: "Confirm", fields: [] },
            ],
          },
        },
      },
    });

    const sentFlowPayload = mockSendWhatsappInteractiveFlow.mock.calls[0]?.[3];
    const persistedPreview = mockMessagePayloads[0]?.whatsappServiceMessage as
      | { command?: { flowToken?: string } }
      | undefined;
    const sentFlowToken = (sentFlowPayload as { flowToken?: string })
      ?.flowToken;

    expect(sentFlowToken).toMatch(/^airi1\./);
    expect(sentFlowPayload).toEqual(
      expect.objectContaining({ flowId: "managed-flow-id" })
    );
    expect(persistedPreview?.command?.flowToken).toBe(sentFlowToken);
    expect(mockMessagePayloads[0]?.whatsappFlow).toBeUndefined();
    expect(mockMessagePayloads[0]?.whatsappCtaLink).toBeUndefined();
    expect(mockTrackScenarioFlowSent).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: "managed-flow-id",
        flowToken: sentFlowToken,
      })
    );
  });

  it("does not send a canonical managed Flow through another source", async () => {
    await expect(
      sendAndPersistOutbound({
        type: "whatsapp",
        workspaceId: "workspace-1",
        conversation: {
          _id: "conversation-1",
          sourceId: "source-b",
        } as never,
        chatDocument: { _id: "chat-1", sourceId: "source-b" } as never,
        content: "Complete the form",
        whatsAppInfo: {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          contactData: {
            waId: "77012345678",
            profile: { name: "Ada" },
            primaryIdType: "wa_id",
          },
        },
        whatsappServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Complete the form" },
            flowConfig: {
              templateId: "local-flow",
              ctaText: "Open flow",
              managedProvisioning: {
                operationId: "operation-1",
                sourceId: "source-a",
                wabaId: "waba-a",
                contentRevision: 2,
                contentDigest: "digest-2",
                flowId: "managed-flow-id",
                providerStatus: "PUBLISHED",
              },
              screens: [],
            },
          },
        },
      })
    ).rejects.toThrow("does not match outbound source");

    expect(mockSendWhatsappInteractiveFlow).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("does not send a template-bound managed Flow through another source", async () => {
    await expect(
      sendAndPersistOutbound({
        type: "whatsapp",
        workspaceId: "workspace-1",
        conversation: {
          _id: "conversation-1",
          sourceId: "source-b",
        } as never,
        chatDocument: { _id: "chat-1", sourceId: "source-b" } as never,
        content: "[Template: appointment]",
        whatsAppInfo: {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          contactData: {
            waId: "77012345678",
            profile: { name: "Ada" },
            primaryIdType: "wa_id",
          },
        },
        whatsappTemplate: {
          name: "appointment",
          languageCode: "en",
          components: [],
        },
        whatsappFlowCta: {
          flowId: "managed-flow-id",
          managedSourceId: "source-a",
        },
      })
    ).rejects.toThrow("does not match outbound source");

    expect(mockSendWhatsappTemplate).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("propagates a canonical service-message provider failure", async () => {
    mockSendWhatsappInteractiveReplyButtonsMessage.mockRejectedValueOnce(
      new Error("Meta rejected canonical buttons")
    );

    await expect(
      sendAndPersistOutbound({
        type: "whatsapp",
        workspaceId: "workspace-1",
        conversation: {
          _id: "conversation-1",
          sourceId: "source-1",
        } as never,
        chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
        content: "Airi: Choose one",
        whatsAppInfo: {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          contactData: {
            waId: "77012345678",
            profile: { name: "Ada" },
            primaryIdType: "wa_id",
          },
        },
        whatsappServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose one" },
            options: [{ id: "yes", label: "Yes" }],
          },
        },
      })
    ).rejects.toThrow("Meta rejected canonical buttons");

    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("fails a canonical service message when the service window is closed", async () => {
    mockCheckMessagingWindowForConversation.mockResolvedValueOnce({
      isWithinWindow: false,
    });

    await expect(
      sendAndPersistOutbound({
        type: "whatsapp",
        workspaceId: "workspace-1",
        conversation: {
          _id: "conversation-1",
          sourceId: "source-1",
        } as never,
        chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
        content: "Airi: Hello",
        whatsAppInfo: {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          contactData: {
            waId: "77012345678",
            profile: { name: "Ada" },
            primaryIdType: "wa_id",
          },
        },
        whatsappServiceMessage: {
          version: 1,
          message: {
            kind: "text",
            body: { mode: "fixed", text: "Hello" },
          },
        },
      })
    ).rejects.toMatchObject({ name: "WhatsAppServiceWindowClosedError" });

    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("sends and persists canonical WhatsApp contacts without legacy projections", async () => {
    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1" } as never,
      content: "",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Customer" },
          primaryIdType: "wa_id",
        },
      },
      scenarioOrigin: {
        scenarioId: "scenario-1",
        actionNodeId: "action-contact",
      },
      whatsappServiceMessage: {
        version: 1,
        message: {
          kind: "contacts",
          contacts: [
            {
              formattedName: "Admissions Team",
              phone: "+7 701 234 56 78",
              email: "HELLO@EXAMPLE.COM",
              company: "EduDemo",
              title: "Admissions",
              websiteUrl: "example.com",
            },
          ],
        },
      },
    } as never);

    expect(mockSendWhatsappContacts).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      [
        expect.objectContaining({
          name: expect.objectContaining({
            formatted_name: "Admissions Team",
          }),
          phones: [{ phone: "77012345678", type: "WORK" }],
          emails: [{ email: "hello@example.com", type: "WORK" }],
          org: { company: "EduDemo", title: "Admissions" },
          urls: [{ url: "https://example.com/", type: "WORK" }],
        }),
      ]
    );
    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(mockSendWhatsappMedia).not.toHaveBeenCalled();
    expect(mockMessagePayloads).toHaveLength(1);
    expect(mockMessagePayloads[0]).toEqual(
      expect.objectContaining({
        messageId: "ws_wamid.contact",
        whatsappServiceMessage: expect.objectContaining({
          version: 1,
          kind: "contacts",
          command: {
            kind: "contacts",
            contacts: [
              expect.objectContaining({
                formattedName: "Admissions Team",
                email: "HELLO@EXAMPLE.COM",
              }),
            ],
          },
        }),
      })
    );
    expect(mockMessagePayloads[0]?.whatsappContacts).toBeUndefined();
    expect(mockMessagePayloads[0]?.whatsappLocation).toBeUndefined();
  });

  it("sends and persists a canonical WhatsApp location without legacy projections", async () => {
    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1" } as never,
      content: "",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Customer" },
          primaryIdType: "wa_id",
        },
      },
      scenarioOrigin: {
        scenarioId: "scenario-1",
        actionNodeId: "action-location",
      },
      whatsappServiceMessage: {
        version: 1,
        message: {
          kind: "location",
          location: {
            latitude: 43.238949,
            longitude: "76.889709",
            name: "EduDemo Campus",
            address: "Almaty",
          },
        },
      },
    } as never);

    expect(mockSendWhatsappLocation).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        latitude: 43.238949,
        longitude: 76.889709,
        name: "EduDemo Campus",
        address: "Almaty",
      }
    );
    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(mockSendWhatsappContacts).not.toHaveBeenCalled();
    expect(mockSendWhatsappMedia).not.toHaveBeenCalled();
    expect(mockMessagePayloads).toHaveLength(1);
    expect(mockMessagePayloads[0]).toEqual(
      expect.objectContaining({
        messageId: "ws_wamid.location",
        whatsappServiceMessage: expect.objectContaining({
          version: 1,
          kind: "location",
          command: {
            kind: "location",
            location: {
              latitude: 43.238949,
              longitude: "76.889709",
              name: "EduDemo Campus",
              address: "Almaty",
            },
          },
        }),
      })
    );
    expect(mockMessagePayloads[0]?.whatsappContacts).toBeUndefined();
    expect(mockMessagePayloads[0]?.whatsappLocation).toBeUndefined();
  });

  it("does not fall back to text or persist when a scenario WhatsApp Flow send fails", async () => {
    mockSendWhatsappInteractiveFlow.mockRejectedValueOnce(
      new Error("Meta rejected the Flow")
    );

    await expect(
      sendAndPersistOutbound({
        type: "whatsapp",
        workspaceId: "workspace-1",
        conversation: {
          _id: "conversation-1",
          sourceId: "source-1",
        } as never,
        chatDocument: { _id: "chat-1" } as never,
        content: "Please complete this flow.",
        whatsAppInfo: {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          contactData: {
            waId: "77012345678",
            profile: { name: "Customer" },
            primaryIdType: "wa_id",
          },
        },
        whatsappFlowCta: {
          flowId: "flow-1",
          scenarioId: "scenario-1",
          actionNodeId: "action-1",
        },
      })
    ).rejects.toThrow(/WhatsApp Flow/);

    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockAppendMessageToConversationById).not.toHaveBeenCalled();
    expect(mockTrackScenarioFlowSent).not.toHaveBeenCalled();
  });

  it("does not call Meta when a scenario WhatsApp Flow is actively suppressed", async () => {
    mockGetActiveScenarioFlowSuppression.mockResolvedValueOnce({
      workspaceId: "workspace-1",
      flowId: "1337918164854692",
      reason: "meta_integrity_block",
      errorMessage:
        "Meta integrity block (139000): Integrity requirements not met",
      suppressedAt: new Date("2026-06-11T00:00:00.000Z"),
    });

    await expect(
      sendAndPersistOutbound({
        type: "whatsapp",
        workspaceId: "workspace-1",
        conversation: {
          _id: "conversation-1",
          sourceId: "source-1",
        } as never,
        chatDocument: { _id: "chat-1" } as never,
        content: "Please complete this flow.",
        whatsAppInfo: {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          contactData: {
            waId: "77012345678",
            profile: { name: "Customer" },
            primaryIdType: "wa_id",
          },
        },
        whatsappFlowCta: {
          flowId: "1337918164854692",
          scenarioId: "scenario-1",
          actionNodeId: "action-1",
        },
      })
    ).rejects.toThrow(/suppressed/i);

    expect(mockSendWhatsappInteractiveFlow).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockAppendMessageToConversationById).not.toHaveBeenCalled();
    expect(mockTrackScenarioFlowSent).not.toHaveBeenCalled();
  });

  it("marks a Flow as suppressed when Meta returns an integrity block", async () => {
    mockSendWhatsappInteractiveFlow.mockRejectedValueOnce(
      new Error("Meta integrity block (139000): Integrity requirements not met")
    );

    await expect(
      sendAndPersistOutbound({
        type: "whatsapp",
        workspaceId: "workspace-1",
        conversation: {
          _id: "conversation-1",
          sourceId: "source-1",
        } as never,
        chatDocument: { _id: "chat-1" } as never,
        content: "Please complete this flow.",
        whatsAppInfo: {
          phoneNumberId: "phone-number-id",
          accessToken: "access-token",
          contactData: {
            waId: "77012345678",
            profile: { name: "Customer" },
            primaryIdType: "wa_id",
          },
        },
        whatsappFlowCta: {
          flowId: "1337918164854692",
          scenarioId: "scenario-1",
          actionNodeId: "action-1",
        },
      })
    ).rejects.toThrow(/suppressed/i);

    expect(mockSuppressScenarioFlowAfterIntegrityBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        flowId: "1337918164854692",
        conversationId: "conversation-1",
        scenarioId: "scenario-1",
        actionNodeId: "action-1",
        errorCode: 139000,
        errorMessage:
          "Meta integrity block (139000): Integrity requirements not met",
      })
    );
  });

  it("persists WhatsApp Flow field metadata for readable reply rendering without sending it to Meta", async () => {
    const responseFieldMetadata = [
      {
        id: "911CBF",
        label: "Product",
        screenTitle: "Choose preferences",
        options: [{ id: "opt_medal", title: "Medal hanger" }],
      },
    ];
    mockSendWhatsappInteractiveFlow.mockResolvedValueOnce({
      messageId: "wamid.flow",
    });

    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1" } as never,
      content: "Please complete this flow.",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Customer" },
          primaryIdType: "wa_id",
        },
      },
      whatsappFlowCta: {
        flowId: "flow-1",
        flowCta: "Open flow",
        responseFieldMetadata,
        scenarioId: "scenario-1",
        actionNodeId: "action-1",
      },
    });

    expect(mockSendWhatsappInteractiveFlow).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      expect.not.objectContaining({ responseFieldMetadata })
    );
    expect(mockMessagePayloads).toHaveLength(1);
    expect(mockMessagePayloads[0]).toEqual(
      expect.objectContaining({
        whatsappFlow: expect.objectContaining({
          flowId: "flow-1",
          responseFieldMetadata,
        }),
      })
    );
    expect(
      (mockMessagePayloads[0]?.whatsappFlow as Record<string, unknown>)
        ?.flowConfig
    ).toBeUndefined();
  });

  it("persists and tracks the Flow a template's FLOW button opens, with no managed source", async () => {
    mockSendWhatsappTemplate.mockResolvedValueOnce({
      messageId: "wamid.template-flow",
    });

    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1", sourceId: "source-1" } as never,
      content: "[Template: medal_pick_1]",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Customer" },
          primaryIdType: "wa_id",
        },
      },
      scenarioOrigin: {
        scenarioId: "scenario-1",
        actionNodeId: "medal-pick",
      },
      whatsappTemplate: {
        name: "medal_pick_1",
        languageCode: "kk",
        components: [
          {
            type: "button",
            sub_type: "flow",
            index: 0,
            parameters: [
              {
                type: "action",
                action: { flow_token: "flow_1767225600000_abc123def4" },
              },
            ],
          },
        ],
      },
      whatsappFlowCta: {
        flowId: "2244981489363579",
        flowToken: "flow_1767225600000_abc123def4",
        flowCta: "Open flow",
        responseFieldMetadata: null,
        scenarioId: "scenario-1",
        scenarioName: "Medal order",
        actionNodeId: "medal-pick",
      },
    });

    expect(mockSendWhatsappTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendWhatsappInteractiveFlow).not.toHaveBeenCalled();
    expect(mockMessagePayloads).toHaveLength(1);
    expect(mockMessagePayloads[0]?.whatsappFlow).toEqual(
      expect.objectContaining({
        flowId: "2244981489363579",
        flowToken: "flow_1767225600000_abc123def4",
        scenarioId: "scenario-1",
        actionNodeId: "medal-pick",
        status: "sent",
      })
    );
    expect(mockTrackScenarioFlowSent).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: "2244981489363579",
        flowToken: "flow_1767225600000_abc123def4",
        scenarioId: "scenario-1",
        actionNodeId: "medal-pick",
      })
    );
  });

  it("sends and persists canonical WhatsApp reply buttons", async () => {
    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1" } as never,
      content: "Pick an option",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Customer" },
          primaryIdType: "wa_id",
        },
      },
      scenarioOrigin: {
        scenarioId: "scenario-1",
        actionNodeId: "action-1",
      },
      whatsappServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Pick an option" },
          options: [
            { id: "wsc:action-1:pricing", label: "Pricing" },
            { id: "wsc:action-1:support", label: "Support" },
          ],
        },
      },
    } as never);

    expect(mockSendWhatsappInteractiveReplyButtonsMessage).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        bodyText: "Pick an option",
        buttons: [
          { id: "wsc:action-1:pricing", title: "Pricing" },
          { id: "wsc:action-1:support", title: "Support" },
        ],
      }
    );
    expect(mockSendWhatsappInteractiveReplyButtons).not.toHaveBeenCalled();
    expect(mockSendWhatsappInteractiveList).not.toHaveBeenCalled();
    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(mockMessagePayloads).toHaveLength(1);
    expect(mockMessagePayloads[0]).toEqual(
      expect.objectContaining({
        messageId: "ws_wamid.service-buttons",
        whatsappServiceMessage: expect.objectContaining({
          version: 1,
          kind: "reply_buttons",
          bodyText: "Pick an option",
          command: {
            kind: "reply_buttons",
            body: "Pick an option",
            options: [
              { id: "wsc:action-1:pricing", label: "Pricing" },
              { id: "wsc:action-1:support", label: "Support" },
            ],
          },
        }),
      })
    );
    expect(mockMessagePayloads[0]?.groundedReplyOptions).toBeUndefined();
  });

  it("sends and persists a canonical media header with WhatsApp reply buttons", async () => {
    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1" } as never,
      content: "Pick an option",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Customer" },
          primaryIdType: "wa_id",
        },
      },
      scenarioOrigin: {
        scenarioId: "scenario-1",
        actionNodeId: "action-1",
      },
      whatsappServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Pick an option" },
          header: {
            kind: "media",
            attachment: {
              url: "https://cdn.example.com/catalog.pdf",
              mediaType: "document",
            },
          },
          options: [{ id: "wsc:action-1:pricing", label: "Pricing" }],
        },
      },
    } as never);

    expect(
      mockSendWhatsappInteractiveReplyButtonsMessage
    ).toHaveBeenCalledTimes(1);
    expect(mockSendWhatsappInteractiveReplyButtonsMessage).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        bodyText: "Pick an option",
        header: {
          type: "document",
          link: "https://cdn.example.com/catalog.pdf",
        },
        buttons: [{ id: "wsc:action-1:pricing", title: "Pricing" }],
      }
    );
    expect(mockSendWhatsappInteractiveReplyButtons).not.toHaveBeenCalled();
    expect(mockSendWhatsappMedia).not.toHaveBeenCalled();
    expect(mockMessagePayloads).toHaveLength(1);
    expect(mockMessagePayloads[0]).toEqual(
      expect.objectContaining({
        messageId: "ws_wamid.service-buttons",
        whatsappServiceMessage: expect.objectContaining({
          version: 1,
          kind: "reply_buttons",
          bodyText: "Pick an option",
          command: {
            kind: "reply_buttons",
            body: "Pick an option",
            header: {
              kind: "media",
              attachment: {
                url: "https://cdn.example.com/catalog.pdf",
                mediaType: "document",
              },
            },
            options: [{ id: "wsc:action-1:pricing", label: "Pricing" }],
          },
        }),
      })
    );
    expect(mockMessagePayloads[0]?.imageUrl).toBeUndefined();
    expect(mockMessagePayloads[0]?.mediaType).toBeUndefined();
  });

  it("sends configured PDF attachments as one plain WhatsApp media reply", async () => {
    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1" } as never,
      content: "Here is your PDF.",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Customer" },
          primaryIdType: "wa_id",
        },
      },
      scenarioOrigin: {
        scenarioId: "scenario-1",
        actionNodeId: "action-1",
      },
      scenarioImageUrls: ["https://cdn.example.com/create-ai-agent.pdf"],
    } as never);

    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(mockSendWhatsappMedia).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        type: "document",
        link: "https://cdn.example.com/create-ai-agent.pdf",
        caption: "Here is your PDF.",
      }
    );
    expect(mockMessagePayloads).toHaveLength(1);
    expect(mockMessagePayloads[0]).toEqual(
      expect.objectContaining({
        messageId: "ws_wamid.media",
        text: "Here is your PDF.",
        mediaType: "document",
        imageUrl: "https://cdn.example.com/create-ai-agent.pdf",
      })
    );
  });

  it("uses the primary Temporal reservation for the single WhatsApp media message", async () => {
    const MessageModel = jest.requireMock("@/models/message").default;
    MessageModel.findOne.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValue(null),
    });

    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1" } as never,
      content: "Here is your PDF.",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Customer" },
          primaryIdType: "wa_id",
        },
      },
      scenarioOrigin: {
        scenarioId: "scenario-1",
        actionNodeId: "action-1",
      },
      scenarioImageUrls: ["https://cdn.example.com/create-ai-agent.pdf"],
      temporalDeliveryKey: "delivery-key-1",
      temporalReservedMessageId: "reserved-message-id",
    } as never);

    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(mockSendWhatsappMedia).toHaveBeenCalledWith(
      "phone-number-id",
      "access-token",
      { kind: "phone", value: "77012345678" },
      {
        type: "document",
        link: "https://cdn.example.com/create-ai-agent.pdf",
        caption: "Here is your PDF.",
      }
    );
    expect(mockMessagePayloads).toHaveLength(1);
    expect(mockMessagePayloads[0]).toEqual(
      expect.objectContaining({
        _id: "reserved-message-id",
        temporalDeliveryKey: "delivery-key-1",
        text: "Here is your PDF.",
        mediaType: "document",
        imageUrl: "https://cdn.example.com/create-ai-agent.pdf",
      })
    );
  });

  it.each([true, false])("does not resend a primary Temporal reply using an indexed key filter, reserved id=%s", async hasReservedId => {
    const MessageModel = jest.requireMock("@/models/message").default;
    MessageModel.findOne.mockReturnValueOnce({
      sort: jest.fn().mockResolvedValue({
        _id: "reserved-message-id",
        messageId: "ws_wamid.media",
        date: new Date("2026-05-19T10:00:00Z"),
      }),
    });

    await sendAndPersistOutbound({
      type: "whatsapp",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1" } as never,
      content: "Here is your PDF.",
      whatsAppInfo: {
        phoneNumberId: "phone-number-id",
        accessToken: "access-token",
        contactData: {
          waId: "77012345678",
          profile: { name: "Customer" },
          primaryIdType: "wa_id",
        },
      },
      scenarioOrigin: {
        scenarioId: "scenario-1",
        actionNodeId: "action-1",
      },
      scenarioImageUrls: ["https://cdn.example.com/create-ai-agent.pdf"],
      temporalDeliveryKey: "delivery-key-1",
      temporalReservedMessageId: hasReservedId ? "reserved-message-id" : undefined,
    } as never);

    expect(MessageModel.findOne).toHaveBeenCalledWith({
      conversation: "conversation-1",
      direction: "outbound",
      ...(hasReservedId ? {
        $or: [
          { temporalDeliveryKey: { $eq: "delivery-key-1", $type: "string" } },
          { _id: "reserved-message-id" },
        ],
      } : { temporalDeliveryKey: { $eq: "delivery-key-1", $type: "string" } }),
    });
    expect(mockSendWhatsappMessage).not.toHaveBeenCalled();
    expect(mockSendWhatsappMedia).not.toHaveBeenCalled();
    expect(mockMessagePayloads).toHaveLength(0);
  });
});

describe("sendAndPersistOutbound Temporal attachment retries", () => {
  it("reuses an existing attachment with the string partial-index filter", async () => {
    jest.clearAllMocks();
    const MessageModel = jest.requireMock("@/models/message").default;
    const existingAttachment = { _id: "attachment-id", messageId: "tg_attachment" };
    mockFindOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ _id: "bot-user-id" }),
    });
    MessageModel.findOne
      .mockReturnValueOnce({ sort: jest.fn().mockResolvedValue({ messageId: "tg_primary" }) })
      .mockReturnValueOnce({ sort: jest.fn().mockResolvedValue(existingAttachment) });

    const result = await sendAndPersistOutbound({
      type: "telegram",
      workspaceId: "workspace-1",
      conversation: { _id: "conversation-1" },
      chatDocument: { _id: "chat-1" },
      content: "Here is your PDF.",
      scenarioOrigin: { scenarioId: "scenario-1", actionNodeId: "action-1" },
      scenarioImageUrls: ["https://cdn.example.com/create-ai-agent.pdf"],
      temporalDeliveryKey: "delivery-key-1",
    } as never);

    expect(MessageModel.findOne).toHaveBeenNthCalledWith(2, {
      conversation: "conversation-1",
      direction: "outbound",
      temporalDeliveryKey: {
        $eq: expect.stringMatching(/^delivery-key-1:asset:0:[a-f0-9]{16}$/),
        $type: "string",
      },
    });
    expect(result).toBe(existingAttachment);
    expect(jest.requireMock("@/lib/telegram").sendTelegramDocument).not.toHaveBeenCalled();
  });
});

describe("sendAndPersistOutbound email delivery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ _id: "bot-user-id" }),
    });
    mockPopulate.mockResolvedValue({});
    mockGetWorkspaceEmailProviderConfig.mockResolvedValue({
      status: "active",
      transactionalStream: "outbound",
      postmarkServerToken: "postmark-token",
    });
    mockIsManagedEmailProviderPending.mockReturnValue(false);
    mockPostmarkSendEmail.mockResolvedValue({ MessageID: "postmark-id" });
  });

  it("sends scenario replies through the active email provider and persists scenario origin", async () => {
    await sendAndPersistOutbound({
      type: "email",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        subject: "Question",
        participants: {
          from: ["customer@example.com"],
          to: ["support@example.com"],
        },
        messages: [],
      } as never,
      chatDocument: { _id: "email-chat-1" } as never,
      content: "Airi: Thanks for reaching out.",
      scenarioOrigin: {
        scenarioId: "scenario-1",
        actionNodeId: "action-1",
      },
    } as never);

    expect(mockPostmarkSendEmail).toHaveBeenCalledWith({
      from: "support@example.com",
      to: ["customer@example.com"],
      subject: "Question",
      text: "Airi: Thanks for reaching out.",
      headers: {},
      messageStream: "outbound",
      serverToken: "postmark-token",
    });
    expect(mockSave).toHaveBeenCalledTimes(1);
    const MessageModel = jest.requireMock("@/models/message").default;
    expect(MessageModel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "email",
        text: "Airi: Thanks for reaching out.",
        subject: "Question",
        external_ids: { messageId: "postmark-id" },
        origin: expect.objectContaining({
          kind: "scenario",
          scenarioId: "scenario-1",
          nodeId: "action-1",
        }),
      })
    );
    expect(mockAppendMessageToConversationById).toHaveBeenCalledWith(
      "conversation-1",
      expect.anything(),
      expect.objectContaining({ lastMessageAt: expect.any(Date) })
    );
  });
});

describe("sendAndPersistOutbound Instagram builder delivery", () => {
  let warnSpy: jest.SpyInstance;

  const instagramContext = (overrides: Record<string, unknown> = {}) =>
    ({
      type: "instagram",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      },
      chatDocument: { _id: "chat-1" },
      content: "Pick one",
      instagramInfo: {
        accessToken: "ig-token",
        pageId: "ig-business-id",
        recipientId: "ig-user-id",
        authMethod: "instagram_business_login",
      },
      ...overrides,
    }) as never;

  const graphError = (error: Record<string, unknown>) => ({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    text: jest.fn().mockResolvedValue(JSON.stringify({ error })),
  });

  const sentBodies = () =>
    mockFetch.mock.calls.map(([, request]) => JSON.parse(String(request.body)));

  beforeEach(() => {
    jest.clearAllMocks();
    mockMessagePayloads.length = 0;
    mockCheckMessagingWindowForConversation.mockResolvedValue({
      isWithinWindow: true,
      hoursRemaining: 20,
      lastCustomerMessageAt: new Date(),
    });
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockFindOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ _id: "bot-user-id" }),
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ message_id: "ig-mid-1" }),
    });
    mockPopulate.mockResolvedValue({});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("sends configured Instagram quick replies as native quick_replies", async () => {
    await sendAndPersistOutbound({
      type: "instagram",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1" } as never,
      content: "Pick one",
      instagramInfo: {
        accessToken: "ig-token",
        pageId: "ig-business-id",
        recipientId: "ig-user-id",
        authMethod: "instagram_business_login",
      },
      instagramMessage: {
        kind: "quick_replies",
        quickReplies: [{ title: "Pricing", payload: "pricing" }],
      },
    } as never);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, request] = mockFetch.mock.calls[0];
    const body = JSON.parse(String(request.body));
    expect(body).toEqual({
      recipient: { id: "ig-user-id" },
      message: {
        text: "Pick one",
        quick_replies: [
          { content_type: "text", title: "Pricing", payload: "pricing" },
        ],
      },
    });
  });

  it("sends configured Instagram postback and URL buttons as a button template", async () => {
    await sendAndPersistOutbound({
      type: "instagram",
      workspaceId: "workspace-1",
      conversation: {
        _id: "conversation-1",
        sourceId: "source-1",
      } as never,
      chatDocument: { _id: "chat-1" } as never,
      content: "Need details?",
      instagramInfo: {
        accessToken: "ig-token",
        pageId: "ig-business-id",
        recipientId: "ig-user-id",
        authMethod: "instagram_business_login",
      },
      instagramMessage: {
        kind: "button_template",
        buttons: [
          { type: "postback", title: "Talk to us", payload: "talk_to_us" },
          {
            type: "web_url",
            title: "Open site",
            url: "https://example.com/ig",
          },
        ],
      },
    } as never);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, request] = mockFetch.mock.calls[0];
    const body = JSON.parse(String(request.body));
    expect(body.message).toEqual({
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Need details?",
          buttons: [
            { type: "postback", title: "Talk to us", payload: "talk_to_us" },
            {
              type: "web_url",
              title: "Open site",
              url: "https://example.com/ig",
            },
          ],
        },
      },
    });
  });

  it("throws a coded error and saves nothing when Meta rejects the reply", async () => {
    mockFetch.mockResolvedValueOnce(
      graphError({
        code: 551,
        message: "This person isn't available right now.",
      })
    );

    await expect(
      sendAndPersistOutbound(instagramContext())
    ).rejects.toMatchObject({ code: "instagram_recipient_unavailable" });
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockMessagePayloads).toHaveLength(0);
  });

  it("does not call Meta once the 24-hour window has closed", async () => {
    mockCheckMessagingWindowForConversation.mockResolvedValueOnce({
      isWithinWindow: false,
      hoursRemaining: 0,
      lastCustomerMessageAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
    });

    await expect(
      sendAndPersistOutbound(instagramContext({ content: "Following up" }))
    ).rejects.toMatchObject({ code: "instagram_window_closed" });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("sends the reply text before generic template cards", async () => {
    await sendAndPersistOutbound(
      instagramContext({
        content: "Here are our courses",
        instagramMessage: {
          kind: "generic_template",
          cards: [{ id: "card-1", title: "Course A" }],
        },
      })
    );

    expect(sentBodies().map(body => body.message)).toEqual([
      { text: "Here are our courses" },
      {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements: [{ title: "Course A" }],
          },
        },
      },
    ]);
    expect(mockMessagePayloads[0]).toMatchObject({
      messageId: "ig-mid-1",
      text: "Here are our courses",
    });
  });

  it("sends cards without reply text and saves their titles", async () => {
    await sendAndPersistOutbound(
      instagramContext({
        content: "",
        instagramMessage: {
          kind: "generic_template",
          cards: [
            { id: "card-1", title: "Course A" },
            { id: "card-2", title: "Course B" },
          ],
        },
      })
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sentBodies()[0].message.attachment.payload.template_type).toBe(
      "generic"
    );
    expect(mockMessagePayloads[0]).toMatchObject({
      text: "Course A · Course B",
    });
  });

  it("sends a media reply without text and saves the media", async () => {
    await sendAndPersistOutbound(
      instagramContext({
        content: "",
        instagramMessage: {
          kind: "media",
          mediaType: "video",
          mediaUrl: "https://cdn.example.com/scenarios/clip.mp4",
        },
      })
    );

    expect(sentBodies()[0].message).toEqual({
      attachment: {
        type: "video",
        payload: { url: "https://cdn.example.com/scenarios/clip.mp4" },
      },
    });
    expect(mockMessagePayloads[0]).toMatchObject({
      imageUrl: "https://cdn.example.com/scenarios/clip.mp4",
      mediaType: "video",
    });
  });

  it("keeps the delivered text when the cards after it are rejected", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ message_id: "ig-text-mid" }),
      })
      .mockResolvedValueOnce(
        graphError({ code: 100, message: "Invalid image_url" })
      );

    await sendAndPersistOutbound(
      instagramContext({
        content: "Here are our courses",
        instagramMessage: {
          kind: "generic_template",
          cards: [{ id: "card-1", title: "Course A" }],
        },
      })
    );

    expect(mockMessagePayloads[0]).toMatchObject({
      messageId: "ig-text-mid",
      text: "Here are our courses",
    });
  });

  it("trims reply text to Meta's 1000-byte limit", async () => {
    await sendAndPersistOutbound(
      instagramContext({ content: "я".repeat(700) })
    );

    const sentText = sentBodies()[0].message.text as string;
    expect(new TextEncoder().encode(sentText).length).toBeLessThanOrEqual(1000);
    expect(sentText).toBe("я".repeat(500));
  });

  it("never cuts an emoji in half when trimming", async () => {
    await sendAndPersistOutbound(
      instagramContext({ content: `${"a".repeat(996)}😀b` })
    );

    expect(sentBodies()[0].message.text).toBe(`${"a".repeat(996)}😀`);
  });

  it("skips scenario documents Instagram cannot send", async () => {
    await sendAndPersistOutbound(
      instagramContext({
        content: "See attached",
        scenarioAttachments: [
          {
            url: "https://cdn.example.com/scenarios/price-list.docx",
            mediaType: "document",
          },
        ],
      })
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sentBodies()[0].message).toEqual({ text: "See attached" });
  });

  it("throws when Meta rejects a scenario attachment", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ message_id: "ig-text-mid" }),
      })
      .mockResolvedValueOnce(
        graphError({ code: 100, message: "Upload attachment failure." })
      );

    await expect(
      sendAndPersistOutbound(
        instagramContext({
          content: "See attached",
          scenarioAttachments: [
            {
              url: "https://cdn.example.com/scenarios/photo.jpg",
              mediaType: "image",
            },
          ],
        })
      )
    ).rejects.toMatchObject({ code: "instagram_attachment_rejected" });
  });
});
jest.mock("@/lib/whatsapp/templates/send-lookup", () => ({
  refreshWhatsAppTemplateMediaForSend: async (params: {
    components?: unknown[];
  }) => params.components,
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

describe("sendAndPersistOutbound Telegram keyboard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMessagePayloads.length = 0;
    mockFindOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ _id: "bot-user-id" }),
    });
    mockPopulate.mockResolvedValue({});
    jest
      .requireMock("@/lib/telegram")
      .sendTelegramMessage.mockResolvedValue({ messageId: 42, date: 1 });
  });

  it("stores exactly the inline keyboard Telegram received", async () => {
    await sendAndPersistOutbound({
      type: "telegram",
      workspaceId: "workspace-1",
      conversation: { _id: "conversation-1" },
      chatDocument: { _id: "chat-1" },
      chatId: "12345",
      botToken: "bot-token",
      content: "Pick one",
      telegramQuickReplies: [
        { text: "Pricing", payload: "pricing" },
        // Over Telegram's 64-byte callback_data budget, so never sent.
        { text: "Too long", payload: "x".repeat(80) },
      ],
      telegramLinkUrls: ["https://www.example.com/a"],
    } as never);

    const sendTelegramMessage =
      jest.requireMock("@/lib/telegram").sendTelegramMessage;
    const [, , options] = sendTelegramMessage.mock.calls[0];
    expect(options.replyMarkup.inline_keyboard).toEqual([
      [{ text: "Pricing", callback_data: "sqr:conversation-1:pricing" }],
      [{ text: "example.com", url: "https://www.example.com/a" }],
    ]);
    expect(mockMessagePayloads[0]?.telegramReplyMarkup).toEqual({
      inlineKeyboard: [
        [{ text: "Pricing", type: "callback", url: null }],
        [
          {
            text: "example.com",
            type: "url",
            url: "https://www.example.com/a",
          },
        ],
      ],
    });
  });
});
