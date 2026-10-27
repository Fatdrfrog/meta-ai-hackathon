const mockConnectDB = jest.fn();
const mockEnsureRealtimeEventIndexes = jest.fn();
const mockRealtimeEventCreate = jest.fn();
const mockRealtimeEventFindOne = jest.fn();
const mockPublishGooglePubSubJsonMessage = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/realtime-event", () => ({
  ensureRealtimeEventIndexes: (...args: unknown[]) =>
    mockEnsureRealtimeEventIndexes(...args),
  RealtimeEvent: {
    create: (...args: unknown[]) => mockRealtimeEventCreate(...args),
    findOne: (...args: unknown[]) => mockRealtimeEventFindOne(...args),
  },
}));

jest.mock("@/lib/google/pubsub-json-publisher", () => ({
  publishGooglePubSubJsonMessage: (...args: unknown[]) =>
    mockPublishGooglePubSubJsonMessage(...args),
}));

const mockCreateSignedUrls = jest.fn();
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        createSignedUrls: (...args: unknown[]) =>
          mockCreateSignedUrls(...args),
      }),
    },
  },
}));

import {
  buildConversationClassificationReadyRealtimeEvent,
  buildConversationCallUpdatedRealtimeEvent,
  buildCrmBoardChangedRealtimeEvent,
  buildProductsChangedRealtimeEvent,
  enqueueConversationClassificationReadyRealtimeEvent,
  enqueueWhatsAppMessageRealtimeEvent,
  mapChannelEventToRealtimeEvent,
  resolveRealtimePubSubConfig,
} from "./server";

describe("realtime server mapping", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockEnsureRealtimeEventIndexes.mockResolvedValue(undefined);
    mockRealtimeEventCreate.mockResolvedValue({ _id: "outbox-1" });
  });

  it("maps campaign delivery callbacks to compact workspace invalidations", async () => {
    const map = (status: string) =>
      mapChannelEventToRealtimeEvent(
        "private-campaign-campaign_1",
        "message-status-update",
        {
          workspaceId: "workspace_1",
          messageId: "wamid-1",
          status,
          timestamp: "2026-09-15T10:00:00.000Z",
          phone: "private-recipient",
        }
      );
    const delivered = await map("delivered");
    const read = await map("read");
    expect(delivered).toMatchObject({
      channel: "workspace:workspace_1",
      name: "campaign.delivery.changed",
      workspaceId: "workspace_1",
      conversationId: null,
      payload: { campaignId: "campaign_1" },
    });
    expect(delivered.payload).toEqual({ campaignId: "campaign_1" });
    expect(delivered.dedupeKey).not.toBe(read.dedupeKey);
    expect((await map("read")).dedupeKey).toBe(read.dedupeKey);
    await expect(
      mapChannelEventToRealtimeEvent(
        "private-campaign-campaign_1",
        "message-status-update",
        { messageId: "wamid-1" }
      )
    ).rejects.toThrow("workspaceId");
  });

  it("maps workspace request-list events to typed row invalidations", async () => {
    const event = await mapChannelEventToRealtimeEvent(
      "tenant-workspace_1",
      "requests.update",
      { _id: "507f1f77bcf86cd799439011" }
    );

    expect(event).toMatchObject({
      channel: "workspace:workspace_1",
      name: "conversation.row.changed",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
      payload: {
        legacyEvent: "requests.update",
        changeType: "updated",
        conversationId: "507f1f77bcf86cd799439011",
      },
    });
  });

  it("maps conversation message channels to conversation-scoped events", async () => {
    const event = await mapChannelEventToRealtimeEvent(
      "private-conversation-507f1f77bcf86cd799439011",
      "new-message",
      {
        _id: "507f1f77bcf86cd799439012",
        workspaceId: "workspace_1",
      }
    );

    expect(event).toMatchObject({
      channel: "conversation:workspace_1:507f1f77bcf86cd799439011",
      name: "conversation.message.created",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
      payload: {
        legacyEvent: "new-message",
        messageId: "507f1f77bcf86cd799439012",
        data: {
          _id: "507f1f77bcf86cd799439012",
          workspaceId: "workspace_1",
        },
      },
    });
  });

  describe("customer media in message events", () => {
    const ORIGIN = "https://project.supabase.co";
    const stored = `${ORIGIN}/storage/v1/object/public/conversation-images/whatsapp/ws/c/m.jpg`;
    const original = process.env.NEXT_PUBLIC_SUPABASE_URL;

    beforeEach(() => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGIN;
      mockCreateSignedUrls.mockImplementation(async (paths: string[]) => ({
        data: paths.map(path => ({ path, signedUrl: `signed:${path}` })),
        error: null,
      }));
    });

    afterEach(() => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = original;
    });

    it("sends browsers signed URLs, top level and under message", async () => {
      const event = await mapChannelEventToRealtimeEvent(
        "private-conversation-507f1f77bcf86cd799439011",
        "new-message",
        {
          _id: "507f1f77bcf86cd799439012",
          workspaceId: "workspace_1",
          imageUrl: stored,
          mediaUrl: stored,
          message: { attachments: [{ url: stored, name: "m.jpg" }] },
        }
      );

      expect(event.payload).toMatchObject({
        data: {
          imageUrl: "signed:whatsapp/ws/c/m.jpg",
          mediaUrl: "signed:whatsapp/ws/c/m.jpg",
          message: {
            attachments: [{ url: "signed:whatsapp/ws/c/m.jpg", name: "m.jpg" }],
          },
        },
      });
      expect(mockCreateSignedUrls).toHaveBeenCalledTimes(1);
    });

    it("signs a Mongoose document's fields, including the author's avatar", async () => {
      const avatar = `${ORIGIN}/storage/v1/object/public/avatars/telegram/5001.jpg`;
      // Like a Mongoose document: internals are its own keys, fields are
      // non-enumerable getters, and toJSON returns the plain fields.
      const fields: Record<string, unknown> = {
        _id: "507f1f77bcf86cd799439012",
        workspaceId: "workspace_1",
        text: "hi",
        imageUrl: stored,
        author: { _id: 5001, firstName: "Ada", avatar_url: avatar },
      };
      const document: Record<string, unknown> = {
        $__: { activePaths: {} },
        _doc: fields,
      };
      for (const [key, value] of Object.entries(fields)) {
        Object.defineProperty(document, key, { get: () => value });
      }
      Object.defineProperty(document, "toJSON", { value: () => fields });

      const event = await mapChannelEventToRealtimeEvent(
        "private-conversation-507f1f77bcf86cd799439011",
        "new-message",
        document
      );

      expect(JSON.parse(JSON.stringify(event.payload))).toMatchObject({
        data: {
          _id: "507f1f77bcf86cd799439012",
          text: "hi",
          imageUrl: "signed:whatsapp/ws/c/m.jpg",
          author: {
            _id: 5001,
            firstName: "Ada",
            avatar_url: "signed:telegram/5001.jpg",
          },
        },
      });
      expect(JSON.stringify(event.payload)).not.toContain("$__");
    });

    it("leaves events without stored media untouched", async () => {
      await mapChannelEventToRealtimeEvent(
        "private-conversation-507f1f77bcf86cd799439011",
        "new-message",
        { _id: "507f1f77bcf86cd799439012", workspaceId: "workspace_1" }
      );

      expect(mockCreateSignedUrls).not.toHaveBeenCalled();
    });
  });

  it("maps legacy delivery callbacks to typed message updates with payload data", async () => {
    const event = await mapChannelEventToRealtimeEvent(
      "private-conversation-507f1f77bcf86cd799439011",
      "message-delivery",
      {
        workspaceId: "workspace_1",
        messageId: "wamid.delivery-1",
        delivery: {
          status: "read",
          readAt: "2026-01-03T12:00:00.000Z",
        },
      }
    );

    expect(event).toMatchObject({
      name: "conversation.message.updated",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
      payload: {
        legacyEvent: "message-delivery",
        messageId: "wamid.delivery-1",
        data: {
          workspaceId: "workspace_1",
          messageId: "wamid.delivery-1",
          delivery: {
            status: "read",
            readAt: "2026-01-03T12:00:00.000Z",
          },
        },
      },
    });
  });

  it("maps quick-note changes to conversation-scoped note events", async () => {
    const event = await mapChannelEventToRealtimeEvent(
      "private-conversation-507f1f77bcf86cd799439011",
      "conversation.note.changed",
      {
        workspaceId: "workspace_1",
        conversationId: "507f1f77bcf86cd799439011",
        note: "Pinned detail",
        updatedAt: "2026-06-21T12:00:00.000Z",
        updatedBy: "manager-1",
      }
    );

    expect(event).toMatchObject({
      name: "conversation.note.changed",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
      payload: {
        legacyEvent: "conversation.note.changed",
        conversationId: "507f1f77bcf86cd799439011",
        data: {
          workspaceId: "workspace_1",
          conversationId: "507f1f77bcf86cd799439011",
          note: "Pinned detail",
          updatedAt: "2026-06-21T12:00:00.000Z",
          updatedBy: "manager-1",
        },
      },
    });
  });

  it("preserves widget thinking details as canonical typing payload", async () => {
    const event = await mapChannelEventToRealtimeEvent(
      "conversation-507f1f77bcf86cd799439011",
      "airi.thinking",
      {
        workspaceId: "workspace_1",
        reasoning: "Checking order history",
        phase: "lookup",
      }
    );

    expect(event).toMatchObject({
      name: "airi.typing",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
      payload: {
        legacyEvent: "airi.thinking",
        started: true,
        data: {
          reasoning: "Checking order history",
          phase: "lookup",
        },
      },
    });
  });

  it("builds compact conversation call update events", () => {
    const event = buildConversationCallUpdatedRealtimeEvent({
      eventId: "evt_call_1",
      createdAt: "2026-06-19T00:01:00.000Z",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
      callSessionId: "session_1",
      state: "incoming",
    });

    expect(event).toMatchObject({
      channel: "conversation:workspace_1:507f1f77bcf86cd799439011",
      name: "conversation.call.updated",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
      dedupeKey:
        "conversation.call.updated:workspace_1:507f1f77bcf86cd799439011:session_1:incoming",
      payload: {
        callSessionId: "session_1",
        state: "incoming",
      },
    });
  });

  it("maps worker call updates to canonical conversation call events", async () => {
    const event = await mapChannelEventToRealtimeEvent(
      "private-conversation-507f1f77bcf86cd799439011",
      "conversation.call.updated",
      {
        workspaceId: "workspace_1",
        conversationId: "507f1f77bcf86cd799439011",
        callSessionId: "session_1",
        state: "incoming",
      }
    );

    expect(event).toMatchObject({
      channel: "conversation:workspace_1:507f1f77bcf86cd799439011",
      name: "conversation.call.updated",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
      dedupeKey:
        "conversation.call.updated:workspace_1:507f1f77bcf86cd799439011:session_1:incoming:conversation.call.updated",
      payload: {
        legacyEvent: "conversation.call.updated",
        conversationId: "507f1f77bcf86cd799439011",
        data: {
          workspaceId: "workspace_1",
          conversationId: "507f1f77bcf86cd799439011",
          callSessionId: "session_1",
          state: "incoming",
        },
      },
    });
  });

  it("builds command-specific call update events without changing the channel", () => {
    const event = buildConversationCallUpdatedRealtimeEvent({
      eventId: "evt_call_command_1",
      createdAt: "2026-06-19T00:01:01.000Z",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
      callSessionId: "session_1",
      state: "incoming",
      reason: "command",
      dedupeKeySuffix: "command_1",
    });

    expect(event).toMatchObject({
      channel: "conversation:workspace_1:507f1f77bcf86cd799439011",
      name: "conversation.call.updated",
      dedupeKey:
        "conversation.call.updated:workspace_1:507f1f77bcf86cd799439011:session_1:incoming:command_1",
      payload: {
        callSessionId: "session_1",
        state: "incoming",
        reason: "command",
      },
    });
  });

  it("uses the production realtime topic and standard project env", () => {
    expect(resolveRealtimePubSubConfig()).toEqual({
      enabled: true,
      projectIdEnvName: "GCP_PROJECT_ID",
      topic: "icecore-realtime-events",
    });
  });

  it("builds the deterministic classification-ready workspace invalidation", () => {
    expect(
      buildConversationClassificationReadyRealtimeEvent({
        analysisRevisionId: "analysis-revision-1",
        conversationId: "507f1f77bcf86cd799439011",
        workspaceId: "workspace-1",
        completedAt: new Date("2026-08-10T06:06:03.645Z"),
      })
    ).toEqual({
      eventId: "classification-ready:analysis-revision-1",
      version: 1,
      name: "conversation.row.changed",
      workspaceId: "workspace-1",
      conversationId: "507f1f77bcf86cd799439011",
      createdAt: "2026-08-10T06:06:03.645Z",
      dedupeKey: "classification-ready:analysis-revision-1",
      payload: {
        legacyEvent: "requests.update",
        conversationId: "507f1f77bcf86cd799439011",
        changeType: "updated",
      },
      channel: "workspace:workspace-1",
    });
  });

  it("builds a workspace CRM board invalidation", () => {
    expect(
      buildCrmBoardChangedRealtimeEvent({
        workspaceId: "workspace-1",
        reason: "stage_moved",
        customerId: "customer-1",
        conversationId: "507f1f77bcf86cd799439011",
        stageKey: "qualified",
        eventId: "crm-evt-1",
        createdAt: "2026-08-28T12:00:00.000Z",
      })
    ).toEqual({
      eventId: "crm-evt-1",
      version: 1,
      name: "crm.board.changed",
      workspaceId: "workspace-1",
      conversationId: "507f1f77bcf86cd799439011",
      createdAt: "2026-08-28T12:00:00.000Z",
      dedupeKey:
        "crm.board.changed:workspace-1:stage_moved:customer-1:crm-evt-1",
      payload: {
        reason: "stage_moved",
        customerId: "customer-1",
        stageKey: "qualified",
      },
      channel: "workspace:workspace-1",
    });
  });

  it("builds a workspace Products invalidation for an import", () => {
    expect(
      buildProductsChangedRealtimeEvent({
        workspaceId: "workspace-1",
        importId: "import-1",
        reason: "photo",
        productId: "product-3",
        eventId: "products-evt-1",
        createdAt: "2026-10-28T12:00:00.000Z",
      })
    ).toEqual({
      eventId: "products-evt-1",
      version: 1,
      name: "products.changed",
      workspaceId: "workspace-1",
      conversationId: null,
      createdAt: "2026-10-28T12:00:00.000Z",
      dedupeKey:
        "products.changed:workspace-1:import-1:photo:product-3:products-evt-1",
      payload: {
        importId: "import-1",
        reason: "photo",
        productId: "product-3",
      },
      channel: "workspace:workspace-1",
    });
  });

  it("ensures indexes and inserts the classification event without publishing", async () => {
    await enqueueConversationClassificationReadyRealtimeEvent({
      analysisRevisionId: "analysis-revision-1",
      conversationId: "507f1f77bcf86cd799439011",
      workspaceId: "workspace-1",
      completedAt: new Date("2026-08-10T06:06:03.645Z"),
    });

    expect(mockEnsureRealtimeEventIndexes).toHaveBeenCalledTimes(1);
    expect(mockRealtimeEventCreate).toHaveBeenCalledWith({
      eventId: "classification-ready:analysis-revision-1",
      version: 1,
      name: "conversation.row.changed",
      workspaceId: "workspace-1",
      conversationId: "507f1f77bcf86cd799439011",
      channel: "workspace:workspace-1",
      dedupeKey: "classification-ready:analysis-revision-1",
      event: {
        eventId: "classification-ready:analysis-revision-1",
        version: 1,
        name: "conversation.row.changed",
        workspaceId: "workspace-1",
        conversationId: "507f1f77bcf86cd799439011",
        createdAt: "2026-08-10T06:06:03.645Z",
        dedupeKey: "classification-ready:analysis-revision-1",
        payload: {
          legacyEvent: "requests.update",
          conversationId: "507f1f77bcf86cd799439011",
          changeType: "updated",
        },
      },
      status: "pending",
    });
    expect(mockPublishGooglePubSubJsonMessage).not.toHaveBeenCalled();
  });

  it.each(["pending", "replaying", "failed", "published"])(
    "accepts an identical %s duplicate without republishing",
    async status => {
      const event = buildConversationClassificationReadyRealtimeEvent({
        analysisRevisionId: "analysis-revision-1",
        conversationId: "507f1f77bcf86cd799439011",
        workspaceId: "workspace-1",
        completedAt: new Date("2026-08-10T06:06:03.645Z"),
      });
      mockRealtimeEventCreate.mockRejectedValue(
        Object.assign(new Error("duplicate eventId"), { code: 11000 })
      );
      mockRealtimeEventFindOne.mockReturnValue({
        lean: () => ({
          exec: async () => ({
            eventId: event.eventId,
            version: event.version,
            name: event.name,
            workspaceId: event.workspaceId,
            conversationId: event.conversationId,
            channel: event.channel,
            dedupeKey: event.dedupeKey,
            event: {
              eventId: event.eventId,
              version: event.version,
              name: event.name,
              workspaceId: event.workspaceId,
              conversationId: event.conversationId,
              createdAt: event.createdAt,
              dedupeKey: event.dedupeKey,
              payload: event.payload,
            },
            status,
          }),
        }),
      });

      await expect(
        enqueueConversationClassificationReadyRealtimeEvent({
          analysisRevisionId: "analysis-revision-1",
          conversationId: "507f1f77bcf86cd799439011",
          workspaceId: "workspace-1",
          completedAt: new Date("2026-08-10T06:06:03.645Z"),
        })
      ).resolves.toBeUndefined();
      expect(mockPublishGooglePubSubJsonMessage).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["payload", { payload: { legacyEvent: "requests.update" } }],
    ["dedupe key", { dedupeKey: "classification-ready:other" }],
    ["created time", { createdAt: "2026-08-10T06:06:04.000Z" }],
  ])("rejects a duplicate with conflicting %s", async (_label, override) => {
    const event = buildConversationClassificationReadyRealtimeEvent({
      analysisRevisionId: "analysis-revision-1",
      conversationId: "507f1f77bcf86cd799439011",
      workspaceId: "workspace-1",
      completedAt: new Date("2026-08-10T06:06:03.645Z"),
    });
    mockRealtimeEventCreate.mockRejectedValue(
      Object.assign(new Error("duplicate eventId"), { code: 11000 })
    );
    mockRealtimeEventFindOne.mockReturnValue({
      lean: () => ({
        exec: async () => ({
          eventId: event.eventId,
          version: event.version,
          name: event.name,
          workspaceId: event.workspaceId,
          conversationId: event.conversationId,
          channel: event.channel,
          dedupeKey: event.dedupeKey,
          event: {
            eventId: event.eventId,
            version: event.version,
            name: event.name,
            workspaceId: event.workspaceId,
            conversationId: event.conversationId,
            createdAt: event.createdAt,
            dedupeKey: event.dedupeKey,
            payload: event.payload,
            ...override,
          },
          status: "pending",
        }),
      }),
    });

    await expect(
      enqueueConversationClassificationReadyRealtimeEvent({
        analysisRevisionId: "analysis-revision-1",
        conversationId: "507f1f77bcf86cd799439011",
        workspaceId: "workspace-1",
        completedAt: new Date("2026-08-10T06:06:03.645Z"),
      })
    ).rejects.toThrow("conflicts");
  });

  it("rejects a duplicate whose row is missing", async () => {
    mockRealtimeEventCreate.mockRejectedValue(
      Object.assign(new Error("duplicate eventId"), { code: 11000 })
    );
    mockRealtimeEventFindOne.mockReturnValue({
      lean: () => ({ exec: async () => null }),
    });

    await expect(
      enqueueConversationClassificationReadyRealtimeEvent({
        analysisRevisionId: "analysis-revision-1",
        conversationId: "507f1f77bcf86cd799439011",
        workspaceId: "workspace-1",
        completedAt: new Date("2026-08-10T06:06:03.645Z"),
      })
    ).rejects.toThrow("missing");
  });
});


describe("durable WhatsApp message delivery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockEnsureRealtimeEventIndexes.mockResolvedValue(undefined);
    mockRealtimeEventCreate.mockResolvedValue({ _id: "outbox-1" });
  });
  const input = {
    workspaceId: "workspace_1",
    conversationId: "conversation_1",
    message: {
      _id: "message_1",
      messageId: "wamid.provider-1",
      direction: "inbound",
      text: "hello",
    },
  };
  it("persists a deterministic immediately recoverable intent without publishing", async () => {
    const first = await enqueueWhatsAppMessageRealtimeEvent(input);
    const second = await enqueueWhatsAppMessageRealtimeEvent(input);
    expect(first?.eventId).toBe(second?.eventId);
    expect(mockRealtimeEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        nextAttemptAt: expect.any(Date),
        event: expect.objectContaining({
          payload: expect.objectContaining({
            data: expect.objectContaining(input.message),
          }),
        }),
      }),
    );
    expect(mockPublishGooglePubSubJsonMessage).not.toHaveBeenCalled();
  });
  it("reuses the stored event after a crash even if the hydrated message changed", async () => {
    const event = await enqueueWhatsAppMessageRealtimeEvent(input);
    const row = mockRealtimeEventCreate.mock.calls[0][0];
    mockRealtimeEventCreate.mockRejectedValueOnce({ code: 11000 });
    mockRealtimeEventFindOne.mockReturnValue({
      lean: () => ({ exec: async () => row }),
    });
    expect(
      await enqueueWhatsAppMessageRealtimeEvent({
        ...input,
        message: { ...input.message, text: "edited" },
      }),
    ).toEqual(event);
  });
  it("does not republish completed events or steal an active replay lease", async () => {
    await enqueueWhatsAppMessageRealtimeEvent(input);
    const row = mockRealtimeEventCreate.mock.calls[0][0];
    for (const status of ["published", "replaying"]) {
      mockRealtimeEventCreate.mockRejectedValueOnce({ code: 11000 });
      mockRealtimeEventFindOne.mockReturnValue({
        lean: () => ({ exec: async () => ({ ...row, status }) }),
      });
      expect(await enqueueWhatsAppMessageRealtimeEvent(input)).toBeNull();
    }
  });
  it("keeps recovered update identity distinct and stable with both provider and Mongo IDs", async () => {
    const recovered = { ...input, recoveryRevision: "revision-1" };
    const event = await enqueueWhatsAppMessageRealtimeEvent(recovered);
    expect(event?.payload.messageId).toBe(input.message._id);
    expect((event?.payload.data as Record<string, unknown>)._id).toBe(
      input.message._id,
    );
    const row = mockRealtimeEventCreate.mock.calls[0][0];
    mockRealtimeEventCreate.mockRejectedValueOnce({ code: 11000 });
    mockRealtimeEventFindOne.mockReturnValue({
      lean: () => ({ exec: async () => row }),
    });
    expect(await enqueueWhatsAppMessageRealtimeEvent(recovered)).toEqual(event);
  });
  it("rejects a conflicting inner routing envelope while retaining the original payload", async () => {
    await enqueueWhatsAppMessageRealtimeEvent(input);
    const row = mockRealtimeEventCreate.mock.calls[0][0];
    for (const corruption of [
      { workspaceId: "other" },
      { conversationId: "other" },
      { version: 99 },
      { dedupeKey: "other" },
      { name: "airi.typing" },
    ]) {
      mockRealtimeEventCreate.mockRejectedValueOnce({ code: 11000 });
      mockRealtimeEventFindOne.mockReturnValue({
        lean: () => ({
          exec: async () => ({
            ...row,
            event: { ...row.event, ...corruption },
          }),
        }),
      });
      await expect(enqueueWhatsAppMessageRealtimeEvent(input)).rejects.toThrow(
        "conflict",
      );
    }
  });
  it("does not accept conflicting ownership or swallow persistence errors", async () => {
    await enqueueWhatsAppMessageRealtimeEvent(input);
    const row = mockRealtimeEventCreate.mock.calls[0][0];
    mockRealtimeEventCreate.mockRejectedValueOnce({ code: 11000 });
    mockRealtimeEventFindOne.mockReturnValue({
      lean: () => ({ exec: async () => ({ ...row, workspaceId: "other" }) }),
    });
    await expect(enqueueWhatsAppMessageRealtimeEvent(input)).rejects.toThrow(
      "conflict",
    );
    mockRealtimeEventCreate.mockRejectedValueOnce(new Error("mongo offline"));
    await expect(enqueueWhatsAppMessageRealtimeEvent(input)).rejects.toThrow(
      "mongo offline",
    );
  });
});
