const mockConnectDb = jest.fn();
const mockTurnContextFindOneLean = jest.fn();
const mockTurnContextFindOneAndUpdate = jest.fn();
const mockTurnContextUpdateOne = jest.fn();
const mockMessageFindByIdLean = jest.fn();
const mockConversationFindByIdSelect = jest.fn();
const mockConversationFindByIdLean = jest.fn();
const mockChatFindByIdLean = jest.fn();
const mockFetchSourceWithCredentials = jest.fn();
const mockResolveWhatsAppSendContext = jest.fn();
const mockDecryptMaybeString = jest.fn((value: unknown) => value);
const mockHydrateConfirmedPaymentTurn = jest.fn();

jest.mock("@/lib/conversions/confirmed-payment-runtime", () => ({
  hydrateConfirmedPaymentTurn: (...args: unknown[]) =>
    mockHydrateConfirmedPaymentTurn(...args),
}));

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDb(...args),
}));

jest.mock("@/models/airi-turn-context", () => ({
  ...jest.requireActual("@/models/airi-turn-context"),
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockTurnContextFindOneLean(...args),
    }),
    findOneAndUpdate: (...args: unknown[]) =>
      mockTurnContextFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mockTurnContextUpdateOne(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    findById: (...args: unknown[]) => {
      const query = {
        populate: () => query,
        lean: () => mockMessageFindByIdLean(...args),
      };
      return query;
    },
  },
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => ({
      select: (projection: string) => {
        mockConversationFindByIdSelect(projection);
        return {
          lean: () => mockConversationFindByIdLean(...args),
        };
      },
      lean: () => mockConversationFindByIdLean(...args),
    }),
  },
}));

jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: {
    findById: (...args: unknown[]) => ({
      lean: () => mockChatFindByIdLean(...args),
    }),
  },
}));

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: (...args: unknown[]) =>
    mockFetchSourceWithCredentials(args[0], args[1], args[2]),
}));

jest.mock("@/lib/whatsapp/send-context", () => ({
  resolveWhatsAppSendContext: (arg: unknown) =>
    mockResolveWhatsAppSendContext(arg),
}));

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (arg: unknown) => mockDecryptMaybeString(arg),
}));

import type { AiriAutoReplyParams } from "@icecore/airi-runtime/auto-reply";
import {
  buildAiriTurnContextDocument,
  buildAiriConversationIngressIntent,
  buildAiriConversationIngressKey,
  buildStoredAiriConversationTurnSignal,
  buildAiriConversationTurnSignalFromContext,
  type AiriTurnContextInput,
  createAiriConversationTurnContext,
  hydrateAiriAutoReplyParamsFromTurn,
  hydrateStoredAiriAutoReplyParamsFromTurn,
  persistAiriConversationIngressIntent,
} from "@/lib/temporal/airi-turn-context";

function createBaseParams(
  overrides: Partial<AiriAutoReplyParams> = {}
): AiriAutoReplyParams {
  return {
    type: "telegram",
    workspaceId: "workspace-1",
    newMessage: {
      _id: "message-1",
      text: "hello",
      date: new Date("2026-03-29T06:00:00.000Z"),
      direction: "inbound",
      channel: "telegram",
      conversation: "conversation-1",
    } as unknown as AiriAutoReplyParams["newMessage"],
    conversation: {
      _id: "conversation-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      chat: "chat-1",
      channel: "telegram",
      createdAt: new Date("2026-03-29T05:59:00.000Z"),
      updatedAt: new Date("2026-03-29T06:00:00.000Z"),
      lastMessageAt: new Date("2026-03-29T06:00:00.000Z"),
    } as unknown as AiriAutoReplyParams["conversation"],
    chatDocument: {
      _id: "chat-1",
      sourceId: "source-1",
      workspaceId: "workspace-1",
      type: "private",
    } as unknown as AiriAutoReplyParams["chatDocument"],
    chatId: "chat-1",
    chatType: "private",
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForQueuedWork(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe("airi turn context", () => {
  function mockRecoveredWhatsAppMedia(mediaType: "audio" | "video") {
    const base = createBaseParams();
    const revision = "c".repeat(64);
    mockMessageFindByIdLean.mockResolvedValue({
      ...base.newMessage,
      channel: "whatsapp",
      mediaType,
      whatsappRecoveryRevision: revision,
    });
    mockConversationFindByIdLean.mockResolvedValue({
      ...base.conversation,
      channel: "whatsapp",
    });
    mockChatFindByIdLean.mockResolvedValue({
      ...base.chatDocument,
      whatsapp: { waId: "77015551212", primaryIdType: "wa_id" },
    });
    return revision;
  }

  it.each(["audio", "video"] as const)(
    "keeps the recovered %s revision when media analysis admits a stored message without context",
    async mediaType => {
      const revision = mockRecoveredWhatsAppMedia(mediaType);
      const hydrated = await hydrateStoredAiriAutoReplyParamsFromTurn({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        channel: "whatsapp",
      });
      expect(hydrated.messageRecoveryRevision).toBe(revision);
      expect(hydrated.newMessage.mediaType).toBe(mediaType);
      expect(buildAiriConversationIngressKey(hydrated)).not.toBe(
        buildAiriConversationIngressKey({
          ...hydrated,
          messageRecoveryRevision: undefined,
        })
      );
      expect(
        buildAiriConversationTurnSignalFromContext({
          autoReplyParams: hydrated,
          turnContextId: "media-context",
        }).messageRecoveryRevision
      ).toBe(revision);
    }
  );

  it("preserves an explicit stored-turn signal revision instead of replacing it with a later message revision", async () => {
    mockRecoveredWhatsAppMedia("audio");
    const explicit = "a".repeat(64);
    const hydrated = await hydrateStoredAiriAutoReplyParamsFromTurn({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "whatsapp",
      messageRecoveryRevision: explicit,
    });
    expect(hydrated.messageRecoveryRevision).toBe(explicit);
  });

  it.each([undefined, "b".repeat(64)])(
    "preserves an existing context's revision %s during stored hydration",
    async explicit => {
      mockRecoveredWhatsAppMedia("video");
      mockTurnContextFindOneLean.mockResolvedValue(
        buildAiriTurnContextDocument(
          createBaseParams({
            type: "whatsapp",
            messageRecoveryRevision: explicit,
          }),
          { turnContextId: "existing-context" }
        )
      );
      const hydrated = await hydrateStoredAiriAutoReplyParamsFromTurn({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        channel: "whatsapp",
        turnContextId: "existing-context",
      });
      expect(hydrated.messageRecoveryRevision).toBe(explicit);
    }
  );

  it("admits recovered content once without changing the canonical message identity", () => {
    const original = createBaseParams({ type: "whatsapp" });
    const recovered = { ...original, messageRecoveryRevision: "a".repeat(64) };
    const firstKey = buildAiriConversationIngressKey(original);
    const recoveryKey = buildAiriConversationIngressKey(recovered);
    expect(recoveryKey).not.toBe(firstKey);
    expect(buildAiriConversationIngressKey({ ...recovered })).toBe(recoveryKey);
    const context = buildAiriConversationIngressIntent(recovered);
    expect(context.messageId).toBe("message-1");
    expect(buildStoredAiriConversationTurnSignal(context)).toMatchObject({
      messageId: "message-1",
      messageRecoveryRevision: recovered.messageRecoveryRevision,
    });
  });

  it("preserves unavailable-message provenance after the canonical message becomes readable", async () => {
    mockRecoveredWhatsAppMedia("audio");
    const original = createBaseParams({
      type: "whatsapp",
      whatsappMessageContentUnavailable: true,
    });
    const context = buildAiriConversationIngressIntent(original);
    expect(context.whatsappMessageContentUnavailable).toBe(true);
    expect(
      buildStoredAiriConversationTurnSignal(context)
        .whatsappMessageContentUnavailable
    ).toBe(true);
    expect(
      buildAiriConversationTurnSignalFromContext({
        autoReplyParams: original,
        turnContextId: context.turnContextId,
      }).whatsappMessageContentUnavailable
    ).toBe(true);
    mockTurnContextFindOneLean.mockResolvedValue(context);
    const hydrated = await hydrateAiriAutoReplyParamsFromTurn({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "whatsapp",
      turnContextId: context.turnContextId,
    });
    expect(hydrated.whatsappMessageContentUnavailable).toBe(true);
    expect(hydrated.messageRecoveryRevision).toBeUndefined();
    expect(hydrated.newMessage.whatsappRecoveryRevision).toBe("c".repeat(64));
  });

  it("retains explicit unavailable provenance on a contextless stored signal", async () => {
    mockRecoveredWhatsAppMedia("video");
    const hydrated = await hydrateStoredAiriAutoReplyParamsFromTurn({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "whatsapp",
      whatsappMessageContentUnavailable: true,
    });
    expect(hydrated.whatsappMessageContentUnavailable).toBe(true);
  });

  it("omits unavailable provenance from ordinary turn contracts", () => {
    const ordinary = createBaseParams({ type: "whatsapp" });
    const context = buildAiriConversationIngressIntent(ordinary);
    expect(context).not.toHaveProperty("whatsappMessageContentUnavailable");
    expect(buildStoredAiriConversationTurnSignal(context)).not.toHaveProperty(
      "whatsappMessageContentUnavailable"
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDb.mockResolvedValue(undefined);
    mockTurnContextFindOneLean.mockResolvedValue(null);
    mockTurnContextFindOneAndUpdate.mockResolvedValue(null);
    mockTurnContextUpdateOne.mockResolvedValue({ acknowledged: true });
    mockMessageFindByIdLean.mockResolvedValue(null);
    mockConversationFindByIdLean.mockResolvedValue(null);
    mockChatFindByIdLean.mockResolvedValue(null);
    mockFetchSourceWithCredentials.mockResolvedValue(null);
    mockResolveWhatsAppSendContext.mockResolvedValue(null);
  });

  it("persists a structural synthetic timer message without requiring a Mongo document", () => {
    const messageId =
      "scenario-timeout:post_action_no_reply_timeout:scenario-1:2026-03-29T06:00:00.000Z";
    const params: AiriTurnContextInput = {
      ...createBaseParams(),
      newMessage: {
        _id: messageId,
        text: "",
        date: new Date("2026-03-29T06:15:00.000Z"),
      },
      scenarioOverrideId: "scenario-1",
      proactiveTrigger: true,
      triggerEventKind: "no_human_reply_timeout",
    };
    const document = buildAiriTurnContextDocument(params, {
      turnContextId: "timer-context-1",
    });
    const signal = buildAiriConversationTurnSignalFromContext({
      autoReplyParams: params,
      turnContextId: document.turnContextId,
    });
    expect(document).toMatchObject({
      messageId,
      conversationId: "conversation-1",
      proactiveTrigger: true,
      scenarioOverrideId: "scenario-1",
      triggerEventKind: "no_human_reply_timeout",
    });
    expect(signal).toMatchObject({
      messageId,
      conversationId: "conversation-1",
      turnContextId: "timer-context-1",
      textPreview: null,
      messageDate: "2026-03-29T06:15:00.000Z",
      scenarioOverrideId: "scenario-1",
      triggerEventKind: "no_human_reply_timeout",
    });
  });

  it("stores only safe turn metadata outside Temporal history", () => {
    const document = buildAiriTurnContextDocument(
      createBaseParams({
        type: "whatsapp",
        botToken: "telegram-secret",
        skipTriggerMatch: true,
        quickReplyPayload: "branch-1",
        whatsAppInfo: {
          phoneNumberId: "phone-1",
          accessToken: "whatsapp-secret",
          contactData: {
            waId: "77015551212",
            profile: { name: "Customer", username: "cust" },
            primaryIdType: "wa_id",
          },
        },
        instagramInfo: {
          pageId: "page-1",
          accessToken: "instagram-secret",
          recipientId: "recipient-1",
          authMethod: "facebook_login",
          threadType: "dm",
        },
        suppressGeneralAutoReply: true,
      })
    );

    expect(document.turnContextId).toEqual(expect.any(String));
    expect(document.skipTriggerMatch).toBe(true);
    expect(document.suppressGeneralAutoReply).toBe(true);
    expect(document.quickReplyPayload).toBe("branch-1");
    expect(document.channelHints.whatsapp.recipientTarget).toEqual({
      kind: "phone",
      value: "77015551212",
    });
    expect(document.channelHints.whatsapp.contactName).toBe("Customer");
    expect(document.channelHints.instagram.recipientId).toBe("recipient-1");
    expect(document).not.toHaveProperty("botToken");
    expect(document).not.toHaveProperty("autoReplyPayload");
    expect(document).not.toHaveProperty("whatsAppInfo.accessToken");
    expect(document).not.toHaveProperty("instagramInfo.accessToken");
  });

  it("keeps the conversation's source when another workspace took over the shared chat", () => {
    const params = createBaseParams({
      type: "whatsapp",
      chatDocument: {
        ...createBaseParams().chatDocument,
        workspaceId: "workspace-2",
        sourceId: "source-2",
      } as unknown as AiriAutoReplyParams["chatDocument"],
    });

    expect(buildAiriTurnContextDocument(params).sourceId).toBe("source-1");
    expect(
      buildAiriConversationTurnSignalFromContext({
        autoReplyParams: params,
        turnContextId: "turn-1",
      }).sourceId
    ).toBe("source-1");
  });

  it("hydrates a turn with the conversation's source when another workspace took over the shared chat", async () => {
    mockTurnContextFindOneLean.mockResolvedValue({
      turnContextId: "turn-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "telegram",
    });
    mockMessageFindByIdLean.mockResolvedValue(createBaseParams().newMessage);
    mockConversationFindByIdLean.mockResolvedValue(
      createBaseParams().conversation
    );
    mockChatFindByIdLean.mockResolvedValue({
      ...createBaseParams().chatDocument,
      workspaceId: "workspace-2",
      sourceId: "source-2",
    });
    mockFetchSourceWithCredentials.mockResolvedValue({
      type: "telegram",
      credentials: { bot_token: "tg-token" },
    });

    await hydrateAiriAutoReplyParamsFromTurn({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "telegram",
      turnContextId: "turn-1",
    });

    expect(mockFetchSourceWithCredentials).toHaveBeenCalledWith(
      "source-1",
      "telegram",
      undefined
    );
  });

  it("reuses one deterministic context for idempotent ingress attempts", async () => {
    const params = createBaseParams();
    const ingressKey = "airi-ingress:message-1";
    const expectedDocument = buildAiriConversationIngressIntent(
      params,
      ingressKey
    );
    mockTurnContextFindOneAndUpdate.mockResolvedValue({
      toObject: () => ({
        ...expectedDocument,
        ingressStatus: "pending",
        ingressAttempts: 1,
      }),
    });

    const result = await createAiriConversationTurnContext(params, {
      ingressKey,
    });

    expect(result.turnContextId).toBe(expectedDocument.turnContextId);
    expect(mockTurnContextFindOneAndUpdate).toHaveBeenCalledWith(
      { ingressKey: { $eq: ingressKey, $type: "string" } },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          turnContextId: expectedDocument.turnContextId,
          ingressKey,
          ingressStatus: "pending",
        }),
      }),
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    const update = mockTurnContextFindOneAndUpdate.mock.calls[0][1];
    expect(update.$setOnInsert.expiresAt).toBeNull();
    expect(update.$setOnInsert.ingressKind).toBe("conversation_turn");
    expect(update.$setOnInsert.ingressAttempts).toBe(0);
    expect(update).not.toHaveProperty("$inc");
    expect(update).not.toHaveProperty("$set");
  });

  it("builds a durable sanitized intent before saving an accepted message", () => {
    const params = createBaseParams();
    const first = buildAiriConversationIngressIntent(params);
    const second = buildAiriConversationIngressIntent(params);

    expect(first.turnContextId).toBe(second.turnContextId);
    expect(first.ingressKey).toBe(second.ingressKey);
    expect(first.ingressStatus).toBe("pending");
    expect(first.expiresAt).toBeNull();
    expect(first.messageDate).toEqual(params.newMessage.date);
    expect(first.enqueuedAt).toBeInstanceOf(Date);
    expect(first).not.toHaveProperty("botToken");
    expect(first).not.toHaveProperty("whatsAppInfo");
  });

  it("keeps completed legacy ingress completed when its message is retried", async () => {
    const pending = buildAiriConversationIngressIntent(createBaseParams());
    const accepted = {
      ...pending,
      ingressKind: undefined,
      ingressStatus: "signaled",
    };
    mockTurnContextFindOneAndUpdate.mockResolvedValue({
      toObject: () => accepted,
    });
    expect(await persistAiriConversationIngressIntent(pending)).toEqual(
      accepted
    );
    expect(mockTurnContextFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("recovers a competing upsert through the partial ingress-key index", async () => {
    const pending = buildAiriConversationIngressIntent(createBaseParams());
    mockTurnContextFindOneAndUpdate.mockRejectedValue({ code: 11000 });
    mockTurnContextFindOneLean.mockResolvedValue(pending);

    expect(await persistAiriConversationIngressIntent(pending)).toEqual(pending);
    expect(mockTurnContextFindOneLean).toHaveBeenCalledWith({
      ingressKey: { $eq: pending.ingressKey, $type: "string" },
    });
  });

  it("adopts a failed legacy attempt into the queue without changing its original enqueue time", async () => {
    const pending = buildAiriConversationIngressIntent(createBaseParams());
    const createdAt = new Date("2026-09-01T00:00:00Z");
    mockTurnContextFindOneAndUpdate
      .mockResolvedValueOnce({
        toObject: () => ({
          ...pending,
          ingressKind: undefined,
          ingressStatus: "failed",
          createdAt,
        }),
      })
      .mockResolvedValueOnce({
        toObject: () => ({ ...pending, enqueuedAt: createdAt }),
      });
    const stored = await persistAiriConversationIngressIntent(pending);
    expect(stored.ingressStatus).toBe("pending");
    expect(stored.enqueuedAt).toEqual(createdAt);
    expect(mockTurnContextFindOneAndUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ingressKey: { $eq: pending.ingressKey, $type: "string" },
        ingressKind: { $exists: false },
        ingressStatus: { $ne: "signaled" },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          enqueuedAt: createdAt,
          expiresAt: null,
        }),
      }),
      { new: true }
    );
  });

  it("stores Instagram referral hints from conversation metadata", () => {
    const document = buildAiriTurnContextDocument(
      createBaseParams({
        type: "instagram",
        conversation: {
          ...createBaseParams().conversation,
          channel: "instagram",
          external_thread: {
            provider: "instagram",
            threadId: "recipient-1",
            referral: {
              source: "ADS",
              type: "OPEN_THREAD",
              ref: "spring-campaign",
              adId: "ad-1",
              productId: "product-1",
            },
          },
        } as unknown as AiriAutoReplyParams["conversation"],
        instagramInfo: {
          pageId: "page-1",
          accessToken: "instagram-secret",
          recipientId: "recipient-1",
          threadType: "dm",
        },
      })
    );

    expect(document.channelHints.instagram.referral).toEqual({
      source: "ADS",
      type: "OPEN_THREAD",
      ref: "spring-campaign",
      adId: "ad-1",
      productId: "product-1",
    });
  });

  it("stores factual WhatsApp ad referral hints for AI turns", () => {
    const document = buildAiriTurnContextDocument(
      createBaseParams({
        type: "whatsapp",
        newMessage: {
          ...createBaseParams().newMessage,
          channel: "whatsapp",
          whatsappReferral: {
            sourceType: "ad",
            sourceId: "120249144478770472",
            sourceUrl: "https://www.instagram.com/p/example",
            campaignId: "120249144478750472",
            campaignName: '21/06/26 "Вовлеченность WA"',
            adSetId: "120249144478760472",
            adSetName: "21/06/26 Вовлеченность WA",
            headline: "Airi.chat",
            body: "Автоматизация продаж через WABA",
            ctwaClid: "clid-1",
          },
        } as unknown as AiriAutoReplyParams["newMessage"],
      })
    );

    expect(document.channelHints.whatsapp.referral).toEqual({
      sourceType: "ad",
      sourceId: "120249144478770472",
      sourceUrl: "https://www.instagram.com/p/example",
      sourcePlatform: "instagram",
      campaignId: "120249144478750472",
      campaignName: '21/06/26 "Вовлеченность WA"',
      adSetId: "120249144478760472",
      adSetName: "21/06/26 Вовлеченность WA",
      headline: "Airi.chat",
      body: "Автоматизация продаж через WABA",
      ctwaClid: "clid-1",
    });
  });

  it("hydrates Telegram turns with canonical bot credentials", async () => {
    mockTurnContextFindOneLean.mockResolvedValue({
      turnContextId: "turn-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "telegram",
      sourceId: "source-1",
      skipTriggerMatch: true,
      proactiveTrigger: false,
      channelHints: {
        telegram: { businessConnectionId: "biz-1" },
        whatsapp: { recipientTarget: null, contactName: null, username: null },
        instagram: {
          recipientId: null,
          threadType: null,
          commentId: null,
          authMethod: null,
        },
      },
    });
    mockMessageFindByIdLean.mockResolvedValue(createBaseParams().newMessage);
    mockConversationFindByIdLean.mockResolvedValue(
      createBaseParams().conversation
    );
    mockChatFindByIdLean.mockResolvedValue(createBaseParams().chatDocument);
    mockFetchSourceWithCredentials.mockResolvedValue({
      type: "telegram",
      credentials: { bot_token: "tg-token" },
    });

    const hydrated = await hydrateAiriAutoReplyParamsFromTurn({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "telegram",
      turnContextId: "turn-1",
    });

    expect(hydrated.botToken).toBe("tg-token");
    expect(hydrated.telegramReactionsEnabled).toBe(false);
    expect(hydrated.skipTriggerMatch).toBe(true);
    expect(hydrated.workspaceId).toBe("workspace-1");
    expect(String(hydrated.newMessage._id)).toBe("message-1");
  });

  it("decrypts the stored Telegram bot token for the turn", async () => {
    const storedToken = { iv: "aXY=", tag: "dGFn", ciphertext: "c2VjcmV0" };
    mockDecryptMaybeString.mockImplementation((value: unknown) =>
      value === storedToken ? "tg-decrypted" : value
    );
    mockTurnContextFindOneLean.mockResolvedValue({
      turnContextId: "turn-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "telegram",
      sourceId: "source-1",
    });
    mockMessageFindByIdLean.mockResolvedValue(createBaseParams().newMessage);
    mockConversationFindByIdLean.mockResolvedValue(
      createBaseParams().conversation
    );
    mockChatFindByIdLean.mockResolvedValue(createBaseParams().chatDocument);
    mockFetchSourceWithCredentials.mockResolvedValue({
      type: "telegram",
      credentials: { bot_token: storedToken },
    });

    try {
      const hydrated = await hydrateAiriAutoReplyParamsFromTurn({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        channel: "telegram",
        turnContextId: "turn-1",
      });

      expect(hydrated.botToken).toBe("tg-decrypted");
    } finally {
      mockDecryptMaybeString.mockImplementation((value: unknown) => value);
    }
  });

  it.each([
    ["explicit opt-in", true, true],
    ["disabled setting", false, false],
    ["missing setting", undefined, false],
    ["string setting", "true", false],
  ])(
    "hydrates Telegram reactions from the source's %s",
    async (_, setting, expected) => {
      mockTurnContextFindOneLean.mockResolvedValue({
        turnContextId: "turn-1",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        channel: "telegram",
        sourceId: "source-1",
      });
      mockMessageFindByIdLean.mockResolvedValue(createBaseParams().newMessage);
      mockConversationFindByIdLean.mockResolvedValue(
        createBaseParams().conversation
      );
      mockChatFindByIdLean.mockResolvedValue(createBaseParams().chatDocument);
      mockFetchSourceWithCredentials.mockResolvedValue({
        type: "telegram",
        credentials: {
          bot_token: "tg-token",
          ai_reactions_enabled: setting,
        },
      });

      const hydrated = await hydrateAiriAutoReplyParamsFromTurn({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        channel: "telegram",
        turnContextId: "turn-1",
      });

      expect(hydrated.botToken).toBe("tg-token");
      expect(hydrated.telegramReactionsEnabled).toBe(expected);
      expect(mockFetchSourceWithCredentials).toHaveBeenCalledTimes(1);
    }
  );

  it("disables Telegram reactions when the integration source is unavailable", async () => {
    mockTurnContextFindOneLean.mockResolvedValue({
      turnContextId: "turn-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "telegram",
      sourceId: "source-1",
    });
    mockMessageFindByIdLean.mockResolvedValue(createBaseParams().newMessage);
    mockConversationFindByIdLean.mockResolvedValue(
      createBaseParams().conversation
    );
    mockChatFindByIdLean.mockResolvedValue(createBaseParams().chatDocument);
    mockFetchSourceWithCredentials.mockResolvedValue(null);

    const hydrated = await hydrateAiriAutoReplyParamsFromTurn({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "telegram",
      turnContextId: "turn-1",
    });

    expect(hydrated.telegramReactionsEnabled).toBe(false);
  });

  it("hydrates turns without pulling unbounded conversation payloads", async () => {
    mockTurnContextFindOneLean.mockResolvedValue({
      turnContextId: "turn-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "telegram",
      sourceId: "source-1",
      skipTriggerMatch: false,
      proactiveTrigger: false,
      channelHints: {
        telegram: { businessConnectionId: null },
        whatsapp: { recipientTarget: null, contactName: null, username: null },
        instagram: {
          recipientId: null,
          threadType: null,
          commentId: null,
          authMethod: null,
        },
      },
    });
    mockMessageFindByIdLean.mockResolvedValue(createBaseParams().newMessage);
    mockConversationFindByIdLean.mockResolvedValue({
      ...createBaseParams().conversation,
      messages: ["message-1", "message-2"],
      embedding: [0.1, 0.2, 0.3],
    });
    mockChatFindByIdLean.mockResolvedValue(createBaseParams().chatDocument);
    mockFetchSourceWithCredentials.mockResolvedValue({
      type: "telegram",
      credentials: { bot_token: "tg-token" },
    });

    await hydrateAiriAutoReplyParamsFromTurn({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "telegram",
      turnContextId: "turn-1",
    });

    expect(mockConversationFindByIdSelect).toHaveBeenCalledWith(
      "-messages -embedding"
    );
  });

  it("loads turn context, message, and conversation concurrently", async () => {
    const turnContext = createDeferred<Record<string, unknown> | null>();
    mockTurnContextFindOneLean.mockReturnValue(turnContext.promise);
    mockMessageFindByIdLean.mockResolvedValue(createBaseParams().newMessage);
    mockConversationFindByIdLean.mockResolvedValue(
      createBaseParams().conversation
    );
    mockChatFindByIdLean.mockResolvedValue(createBaseParams().chatDocument);
    mockFetchSourceWithCredentials.mockResolvedValue({
      type: "telegram",
      credentials: { bot_token: "tg-token" },
    });

    const hydration = hydrateAiriAutoReplyParamsFromTurn({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "telegram",
      turnContextId: "turn-1",
    });

    await waitForQueuedWork();
    expect(mockMessageFindByIdLean).toHaveBeenCalledWith("message-1");
    expect(mockConversationFindByIdLean).toHaveBeenCalledWith("conversation-1");

    turnContext.resolve({
      turnContextId: "turn-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "telegram",
      sourceId: "source-1",
      proactiveTrigger: false,
      channelHints: {
        telegram: { businessConnectionId: null },
        whatsapp: { recipientTarget: null, contactName: null, username: null },
        instagram: {
          recipientId: null,
          threadType: null,
          commentId: null,
          authMethod: null,
        },
      },
    });

    await expect(hydration).resolves.toEqual(
      expect.objectContaining({ workspaceId: "workspace-1" })
    );
  });

  it("hydrates WhatsApp turns without resolving send credentials", async () => {
    mockTurnContextFindOneLean.mockResolvedValue({
      turnContextId: "turn-wa",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "whatsapp",
      sourceId: "source-wa",
      triggerEventKind: "telegram_quick_reply",
      quickReplyPayload: "branch-a",
      proactiveTrigger: false,
      channelHints: {
        telegram: { businessConnectionId: null },
        whatsapp: {
          recipientTarget: { kind: "phone", value: "77015551212" },
          contactName: "Customer",
          username: "customer-1",
        },
        instagram: {
          recipientId: null,
          threadType: null,
          commentId: null,
          authMethod: null,
        },
      },
    });
    mockMessageFindByIdLean.mockResolvedValue(
      createBaseParams({
        type: "whatsapp",
      }).newMessage
    );
    mockConversationFindByIdLean.mockResolvedValue(
      createBaseParams({
        type: "whatsapp",
        conversation: {
          ...createBaseParams().conversation,
          channel: "whatsapp",
          sourceId: "source-wa",
        } as unknown as AiriAutoReplyParams["conversation"],
      }).conversation
    );
    mockChatFindByIdLean.mockResolvedValue(
      createBaseParams({
        type: "whatsapp",
        chatDocument: {
          ...createBaseParams().chatDocument,
          sourceId: "source-wa",
          whatsapp: {
            waId: "77015551212",
            profileName: "Customer",
            username: "customer-1",
            primaryIdType: "wa_id",
          },
        } as unknown as AiriAutoReplyParams["chatDocument"],
      }).chatDocument
    );
    const hydrated = await hydrateAiriAutoReplyParamsFromTurn({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "whatsapp",
      turnContextId: "turn-wa",
    });

    expect(hydrated.quickReplyPayload).toBe("branch-a");
    expect(hydrated.whatsAppInfo).toEqual(
      expect.objectContaining({
        contactData: expect.objectContaining({
          waId: "77015551212",
        }),
      })
    );
    expect(hydrated.whatsAppInfo?.phoneNumberId).toBeUndefined();
    expect(hydrated.whatsAppInfo?.accessToken).toBeUndefined();
    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
  });

  it("hydrates Instagram comment turns with canonical source credentials", async () => {
    mockTurnContextFindOneLean.mockResolvedValue({
      turnContextId: "turn-ig",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "instagram",
      sourceId: "source-ig",
      proactiveTrigger: false,
      channelHints: {
        telegram: { businessConnectionId: null },
        whatsapp: { recipientTarget: null, contactName: null, username: null },
        instagram: {
          recipientId: null,
          threadType: "comment",
          commentId: "comment-1",
          authMethod: "facebook_login",
        },
      },
    });
    mockMessageFindByIdLean.mockResolvedValue(
      createBaseParams({
        type: "instagram",
      }).newMessage
    );
    mockConversationFindByIdLean.mockResolvedValue(
      createBaseParams({
        type: "instagram",
        conversation: {
          ...createBaseParams().conversation,
          channel: "instagram",
          sourceId: "source-ig",
          external_thread: {
            provider: "instagram",
            type: "comment",
            comment: { id: "comment-1" },
          },
        } as unknown as AiriAutoReplyParams["conversation"],
      }).conversation
    );
    mockChatFindByIdLean.mockResolvedValue(createBaseParams().chatDocument);
    mockFetchSourceWithCredentials.mockResolvedValue({
      type: "instagram",
      workspace_id: "workspace-1",
      credentials: {
        page_access_token: "ig-token",
        page_id: "page-1",
        auth_method: "facebook_login",
      },
    });

    const hydrated = await hydrateAiriAutoReplyParamsFromTurn({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "instagram",
      turnContextId: "turn-ig",
    });

    expect(hydrated.instagramInfo).toEqual({
      pageId: "page-1",
      accessToken: "ig-token",
      recipientId: undefined,
      authMethod: "facebook_login",
      threadType: "comment",
      commentId: "comment-1",
    });
  });

  it("hydrates synthetic scenario timeout turns without querying a Mongo message id", async () => {
    const syntheticMessageId =
      "scenario-timeout:post_action_no_reply_timeout:scenario-1:2026-04-30T07:45:50.000Z";

    mockTurnContextFindOneLean.mockResolvedValue({
      turnContextId: "turn-scenario-timeout",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: syntheticMessageId,
      channel: "whatsapp",
      sourceId: "source-wa",
      triggerEventKind: "no_human_reply_timeout",
      scenarioOverrideId: "scenario-1",
      scenarioTriggerNodeId: "condition-1",
      skipTriggerMatch: false,
      proactiveTrigger: false,
      quickReplyPayload: null,
      whatsAppFlowResponseJson: null,
      followUpInstruction: null,
      systemPromptOverride: null,
      chatId: "chat-1",
      chatType: "private",
      channelHints: {
        telegram: { businessConnectionId: null },
        whatsapp: {
          recipientTarget: { kind: "phone", value: "77015551212" },
          contactName: "Customer",
          username: null,
        },
        instagram: {
          recipientId: null,
          threadType: null,
          commentId: null,
          authMethod: null,
        },
      },
    });
    mockConversationFindByIdLean.mockResolvedValue(
      createBaseParams({
        type: "whatsapp",
        conversation: {
          ...createBaseParams().conversation,
          channel: "whatsapp",
          sourceId: "source-wa",
        } as unknown as AiriAutoReplyParams["conversation"],
      }).conversation
    );
    mockChatFindByIdLean.mockResolvedValue(
      createBaseParams({
        type: "whatsapp",
        chatDocument: {
          ...createBaseParams().chatDocument,
          sourceId: "source-wa",
          whatsapp: {
            waId: "77015551212",
            profileName: "Customer",
            primaryIdType: "wa_id",
          },
        } as unknown as AiriAutoReplyParams["chatDocument"],
      }).chatDocument
    );
    const hydrated = await hydrateAiriAutoReplyParamsFromTurn({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: syntheticMessageId,
      channel: "whatsapp",
      turnContextId: "turn-scenario-timeout",
      textPreview: "",
      messageDate: "2026-05-01T07:45:50.000Z",
      triggerEventKind: "no_human_reply_timeout",
      scenarioOverrideId: "scenario-1",
      enqueuedAt: "2026-05-01T07:45:50.000Z",
    });

    expect(mockMessageFindByIdLean).not.toHaveBeenCalled();
    expect(String(hydrated.newMessage._id)).toBe(syntheticMessageId);
    expect(hydrated.newMessage.direction).toBe("inbound");
    expect(hydrated.newMessage.date).toEqual(
      new Date("2026-05-01T07:45:50.000Z")
    );
    expect(hydrated.triggerEventKind).toBe("no_human_reply_timeout");
    expect(hydrated.scenarioOverrideId).toBe("scenario-1");
    expect(hydrated.whatsAppInfo?.contactData.waId).toBe("77015551212");
    expect(mockResolveWhatsAppSendContext).not.toHaveBeenCalled();
  });

  it("falls back to legacy inline payloads for in-flight histories", async () => {
    const legacyPayload = createBaseParams();

    const hydrated = await hydrateAiriAutoReplyParamsFromTurn({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      channel: "telegram",
      autoReplyPayload: legacyPayload as unknown as Record<string, unknown>,
    });

    expect(hydrated.workspaceId).toBe("workspace-1");
    expect(String(hydrated.newMessage._id)).toBe("message-1");
  });

  it("loads payment authority before considering a supplied legacy payload or message lookup", async () => {
    const authoritative = createBaseParams();
    mockHydrateConfirmedPaymentTurn.mockResolvedValue(authoritative);
    const turn = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "confirmed-payment:11111111-1111-4111-8111-111111111111",
      autoReplyPayload: { confirmedPaymentScenario: { scenarioId: "forged" } },
    };
    await expect(hydrateAiriAutoReplyParamsFromTurn(turn)).resolves.toBe(
      authoritative
    );
    expect(mockHydrateConfirmedPaymentTurn).toHaveBeenCalledWith(turn);
    expect(mockMessageFindByIdLean).not.toHaveBeenCalled();
  });

  it("removes claimed payment authority from ordinary legacy payloads", async () => {
    const params = createBaseParams();
    const hydrated = await hydrateAiriAutoReplyParamsFromTurn({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      autoReplyPayload: {
        ...params,
        confirmedPaymentScenario: { scenarioId: "forged" },
      },
    });
    expect(hydrated.confirmedPaymentScenario).toBeUndefined();
  });
});
