jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { find: jest.fn(), updateOne: jest.fn(), bulkWrite: jest.fn() },
}));
jest.mock("@/models/message-delivery-event", () => ({
  __esModule: true,
  default: { find: jest.fn(), updateOne: jest.fn(), bulkWrite: jest.fn() },
}));
jest.mock("@/models/conversation", () => ({
  Conversation: { findOne: jest.fn() },
}));
jest.mock("./webhooks", () => ({ listActiveWebhookEventTypes: jest.fn() }));
import Message from "@/models/message";
import MessageDeliveryEvent from "@/models/message-delivery-event";
import { listActiveWebhookEventTypes } from "./webhooks";
import {
  buildCustomerMessageWebhookIntent,
  buildCustomerStatusWebhookIntent,
  reconcileCustomerWebhookIntents,
} from "./customer-webhook-intents";

const eventAt = new Date("2026-10-03T04:00:00Z");
const message = {
  _id: "507f1f77bcf86cd799439011",
  workspaceId: "workspace-1",
  conversation: "507f1f77bcf86cd799439012",
  channel: "whatsapp",
  direction: "inbound",
  messageId: "wamid.inbound",
  date: eventAt,
  text: "Hello",
  origin: { sourceId: "source-1" },
};

function pendingRows(kind: "message" | "status", count: number) {
  return Array.from({ length: count }, (_, index) => ({
    _id: `${kind}-${index}`,
    workspaceId: "workspace-1",
    customerWebhookIntent:
      kind === "message"
        ? buildCustomerMessageWebhookIntent({
            ...message,
            _id: `message-${index}`,
            messageId: `wamid.message-${index}`,
          })!
        : buildCustomerStatusWebhookIntent({
            workspaceId: "workspace-1",
            sourceId: "source-1",
            messageId: `wamid.status-${index}`,
            status: "read",
            eventAt,
          })!,
  }));
}

function setPendingRows(
  model: typeof Message | typeof MessageDeliveryEvent,
  rows: ReturnType<typeof pendingRows>
) {
  (model.find as jest.Mock).mockReturnValue({
    sort: () => ({
      limit: (limit: number) => ({
        select: () => ({ lean: async () => rows.slice(0, limit) }),
      }),
    }),
  });
  (model.updateOne as jest.Mock).mockResolvedValue({ modifiedCount: 1 });
}

describe("WhatsApp customer webhook facts committed with local persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Message.updateOne as jest.Mock).mockResolvedValue({ modifiedCount: 1 });
    (MessageDeliveryEvent.updateOne as jest.Mock).mockResolvedValue({
      modifiedCount: 1,
    });
    (listActiveWebhookEventTypes as jest.Mock).mockResolvedValue(
      new Map([
        [
          "workspace-1",
          new Set([
            "message.received",
            "message.sent",
            "message.status_updated",
          ]),
        ],
      ])
    );
  });
  afterEach(() => jest.restoreAllMocks());
  it.each(["inbound", "outbound"])(
    "captures %s with stable persisted identity and time",
    direction => {
      const intent = buildCustomerMessageWebhookIntent({
        ...message,
        direction,
      });
      expect(intent).toMatchObject({
        workspaceId: "workspace-1",
        eventType:
          direction === "inbound" ? "message.received" : "message.sent",
        resourceId: "wamid.inbound",
        timestamp: eventAt.toISOString(),
        data: {
          message_id: String(message._id),
          provider_message_id: "wamid.inbound",
          source_id: "source-1",
          direction,
        },
      });
    }
  );
  it("excludes drafts, unaccepted dispatch owners and imported history", () => {
    for (const changed of [
      { messageId: null },
      { channel: "telegram" },
      { temporalDispatch: { state: "dispatching" } },
      { rawSourcePayload: { eventType: "history_message" } },
      { rawSourcePayload: { eventType: "history_message_echo" } },
    ])
      expect(
        buildCustomerMessageWebhookIntent({ ...message, ...changed })
      ).toBeNull();
  });
  it("uses the canonical ID when the conversation ref is populated", () => {
    expect(
      buildCustomerMessageWebhookIntent({
        ...message,
        conversation: {
          _id: message.conversation,
          sourceId: "source-1",
          status: "open",
        },
      })?.data.conversation_id
    ).toBe(message.conversation);
  });
  it.each(["inbound", "outbound"])(
    "exposes the same Meta message ID for a stored %s message and its status facts",
    direction => {
      const storedMessageId = "ws_wamid.provider-1";
      const messageIntent = buildCustomerMessageWebhookIntent({
        ...message,
        direction,
        messageId: storedMessageId,
      });
      const statusIntent = buildCustomerStatusWebhookIntent({
        workspaceId: message.workspaceId,
        messageId: "wamid.provider-1",
        status: "read",
        eventAt,
      });
      const storedStatusIntent = buildCustomerStatusWebhookIntent({
        workspaceId: message.workspaceId,
        messageId: storedMessageId,
        status: "read",
        eventAt,
      });
      expect(messageIntent?.data.provider_message_id).toBe("wamid.provider-1");
      expect(statusIntent?.data.provider_message_id).toBe("wamid.provider-1");
      expect(storedStatusIntent?.data.provider_message_id).toBe(
        "wamid.provider-1"
      );
      expect(messageIntent?.resourceId).toBe(storedMessageId);
    }
  );
  it("records every supported delivery fact independently, including late status arrivals", () => {
    for (const status of ["sent", "delivered", "read", "failed"]) {
      expect(
        buildCustomerStatusWebhookIntent({
          workspaceId: "workspace-1",
          sourceId: "source-1",
          messageId: "wamid.outbound",
          status,
          eventAt,
        })
      ).toMatchObject({
        eventType: "message.status_updated",
        resourceId: `wamid.outbound:${status}:${eventAt.toISOString()}`,
        data: {
          provider_message_id: "wamid.outbound",
          source_id: "source-1",
          status,
        },
      });
    }
    expect(
      buildCustomerStatusWebhookIntent({
        workspaceId: "workspace-1",
        messageId: "wamid.outbound",
        status: "played",
        eventAt,
      })
    ).toBeNull();
  });
  it("keeps the immutable intent when enqueue fails and clears it only after durable admission", async () => {
    const intent = buildCustomerMessageWebhookIntent(message)!;
    (Message.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: async () => [
              {
                _id: message._id,
                workspaceId: message.workspaceId,
                customerWebhookIntent: intent,
              },
            ],
          }),
        }),
      }),
    });
    (MessageDeliveryEvent.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({ select: () => ({ lean: async () => [] }) }),
      }),
    });
    const enqueue = jest
      .fn()
      .mockRejectedValueOnce(new Error("outbox unavailable"));
    await reconcileCustomerWebhookIntents({ enqueue, limit: 10 });
    expect(Message.updateOne).not.toHaveBeenCalled();
    enqueue.mockResolvedValue(undefined);
    await reconcileCustomerWebhookIntents({ enqueue, limit: 10 });
    expect(enqueue).toHaveBeenLastCalledWith(intent);
    expect(Message.updateOne).toHaveBeenCalledWith(
      {
        _id: message._id,
        workspaceId: "workspace-1",
        "customerWebhookIntent.resourceId": "wamid.inbound",
        "customerWebhookIntent.timestamp": eventAt.toISOString(),
      },
      { $unset: { customerWebhookIntent: 1 } }
    );
  });
  it("does not admit an intent whose workspace differs from its canonical fact", async () => {
    const intent = buildCustomerMessageWebhookIntent(message)!;
    (Message.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: async () => [
              {
                _id: message._id,
                workspaceId: "workspace-2",
                customerWebhookIntent: intent,
              },
            ],
          }),
        }),
      }),
    });
    (MessageDeliveryEvent.find as jest.Mock).mockReturnValue({
      sort: () => ({
        limit: () => ({ select: () => ({ lean: async () => [] }) }),
      }),
    });
    const enqueue = jest.fn();
    await reconcileCustomerWebhookIntents({ enqueue, limit: 10 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(Message.updateOne).not.toHaveBeenCalled();
  });

  it("shares bounded admission slots between messages and statuses before slow facts complete", async () => {
    setPendingRows(Message, pendingRows("message", 10));
    setPendingRows(MessageDeliveryEvent, pendingRows("status", 10));
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    const started: string[] = [];
    let active = 0;
    let peakActive = 0;
    const reconcile = reconcileCustomerWebhookIntents({
      limit: 10,
      enqueue: async intent => {
        started.push(intent.eventType);
        active += 1;
        peakActive = Math.max(peakActive, active);
        await blocked;
        active -= 1;
      },
    });
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    const initialTypes = new Set(started);
    const initialActive = active;
    release();
    const result = await reconcile;

    expect(initialTypes).toEqual(
      new Set(["message.received", "message.status_updated"])
    );
    expect(initialActive).toBeGreaterThan(1);
    expect(peakActive).toBeLessThanOrEqual(8);
    expect(started).toHaveLength(20);
    expect(result).toEqual({ admitted: 20, skipped: 0, hasMore: false });
  });

  it("reports more recovery work without admitting beyond each bounded page", async () => {
    setPendingRows(Message, pendingRows("message", 3));
    setPendingRows(MessageDeliveryEvent, pendingRows("status", 3));
    const enqueue = jest.fn(async () => undefined);

    await expect(
      reconcileCustomerWebhookIntents({ enqueue, limit: 2 })
    ).resolves.toEqual({ admitted: 4, skipped: 0, hasMore: true });
    expect(enqueue).toHaveBeenCalledTimes(4);
  });

  it("stops taking new facts at the deadline while awaiting admitted facts from both collections", async () => {
    setPendingRows(Message, pendingRows("message", 10));
    setPendingRows(MessageDeliveryEvent, pendingRows("status", 10));
    let now = 0;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const admittedTypes: string[] = [];

    const result = await reconcileCustomerWebhookIntents({
      limit: 10,
      deadlineAtMs: 3_000,
      enqueue: async intent => {
        admittedTypes.push(intent.eventType);
        now += 1_000;
      },
    });

    expect(result).toEqual({ admitted: 3, skipped: 0, hasMore: true });
    expect(new Set(admittedTypes)).toEqual(
      new Set(["message.received", "message.status_updated"])
    );
    expect(Message.updateOne).toHaveBeenCalledTimes(2);
    expect(MessageDeliveryEvent.updateOne).toHaveBeenCalledTimes(1);
  });

  it("keeps one failed marker while admitting unrelated facts in both collections", async () => {
    const messages = pendingRows("message", 2);
    setPendingRows(Message, messages);
    setPendingRows(MessageDeliveryEvent, pendingRows("status", 2));
    const enqueue = jest.fn(async intent => {
      if (intent.resourceId === "wamid.message-0")
        throw new Error("admission unavailable for this fact");
    });

    await expect(
      reconcileCustomerWebhookIntents({ enqueue, limit: 2 })
    ).resolves.toEqual({ admitted: 3, skipped: 0, hasMore: true });
    expect(Message.updateOne).not.toHaveBeenCalledWith(
      expect.objectContaining({ _id: "message-0" }),
      expect.anything()
    );
    expect(Message.updateOne).toHaveBeenCalledTimes(1);
    expect(MessageDeliveryEvent.updateOne).toHaveBeenCalledTimes(2);
  });

  it("does not report catch-up progress when marker removal fails or loses its CAS", async () => {
    setPendingRows(Message, pendingRows("message", 2));
    setPendingRows(MessageDeliveryEvent, []);
    (Message.updateOne as jest.Mock)
      .mockRejectedValueOnce(new Error("marker write unavailable"))
      .mockResolvedValueOnce({ modifiedCount: 0 });

    await expect(
      reconcileCustomerWebhookIntents({
        enqueue: async () => undefined,
        limit: 2,
      })
    ).resolves.toEqual({ admitted: 0, skipped: 0, hasMore: true });
  });
});

describe("WhatsApp customer webhook facts nobody subscribes to", () => {
  function rowsIn(
    workspaceId: string,
    kind: "message" | "status",
    count: number
  ) {
    return pendingRows(kind, count).map(row => ({
      ...row,
      _id: `${workspaceId}-${row._id}`,
      workspaceId,
      customerWebhookIntent: { ...row.customerWebhookIntent, workspaceId },
    }));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    for (const model of [Message, MessageDeliveryEvent])
      (model.bulkWrite as jest.Mock).mockImplementation(
        async (operations: unknown[]) => ({ modifiedCount: operations.length })
      );
    (listActiveWebhookEventTypes as jest.Mock).mockResolvedValue(
      new Map([["workspace-1", new Set(["message.received"])]])
    );
  });

  it("clears unsubscribed facts in one compare-and-unset write without an outbox row", async () => {
    const statuses = rowsIn("workspace-2", "status", 3);
    setPendingRows(Message, rowsIn("workspace-1", "message", 2));
    setPendingRows(MessageDeliveryEvent, statuses);
    const enqueue = jest.fn(async () => undefined);

    await expect(
      reconcileCustomerWebhookIntents({ enqueue, limit: 10 })
    ).resolves.toEqual({ admitted: 2, skipped: 3, hasMore: false });

    expect(listActiveWebhookEventTypes).toHaveBeenCalledTimes(1);
    expect(listActiveWebhookEventTypes).toHaveBeenCalledWith([
      "workspace-1",
      "workspace-2",
    ]);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-2" })
    );
    expect(MessageDeliveryEvent.updateOne).not.toHaveBeenCalled();
    expect(MessageDeliveryEvent.bulkWrite).toHaveBeenCalledWith(
      statuses.map(row => ({
        updateOne: {
          filter: {
            _id: row._id,
            workspaceId: "workspace-2",
            "customerWebhookIntent.resourceId":
              row.customerWebhookIntent.resourceId,
            "customerWebhookIntent.timestamp":
              row.customerWebhookIntent.timestamp,
          },
          update: { $unset: { customerWebhookIntent: 1 } },
        },
      })),
      { ordered: false }
    );
    expect(Message.bulkWrite).not.toHaveBeenCalled();
  });

  it("checks the event type, not just the workspace", async () => {
    setPendingRows(Message, rowsIn("workspace-1", "message", 1));
    setPendingRows(MessageDeliveryEvent, rowsIn("workspace-1", "status", 2));
    const enqueue = jest.fn(async () => undefined);

    await expect(
      reconcileCustomerWebhookIntents({ enqueue, limit: 10 })
    ).resolves.toEqual({ admitted: 1, skipped: 2, hasMore: false });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "message.received" })
    );
  });

  it("clears unsubscribed facts beyond the admission page", async () => {
    setPendingRows(Message, []);
    setPendingRows(MessageDeliveryEvent, rowsIn("workspace-2", "status", 250));
    const enqueue = jest.fn(async () => undefined);

    await expect(
      reconcileCustomerWebhookIntents({ enqueue, limit: 10 })
    ).resolves.toEqual({ admitted: 0, skipped: 250, hasMore: false });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("keeps the outbox path for every fact when subscriptions cannot be read", async () => {
    (listActiveWebhookEventTypes as jest.Mock).mockRejectedValue(
      new Error("Supabase unavailable")
    );
    setPendingRows(Message, rowsIn("workspace-2", "message", 2));
    setPendingRows(MessageDeliveryEvent, rowsIn("workspace-2", "status", 2));
    const enqueue = jest.fn(async () => undefined);

    await expect(
      reconcileCustomerWebhookIntents({ enqueue, limit: 10 })
    ).resolves.toEqual({ admitted: 4, skipped: 0, hasMore: false });
    expect(Message.bulkWrite).not.toHaveBeenCalled();
    expect(MessageDeliveryEvent.bulkWrite).not.toHaveBeenCalled();
  });

  it("reports more work when a bulk clear fails or loses its compare-and-unset", async () => {
    setPendingRows(Message, rowsIn("workspace-2", "message", 2));
    setPendingRows(MessageDeliveryEvent, rowsIn("workspace-2", "status", 3));
    (Message.bulkWrite as jest.Mock).mockRejectedValueOnce(
      new Error("write unavailable")
    );
    (MessageDeliveryEvent.bulkWrite as jest.Mock).mockResolvedValueOnce({
      modifiedCount: 2,
    });

    await expect(
      reconcileCustomerWebhookIntents({
        enqueue: async () => undefined,
        limit: 10,
      })
    ).resolves.toEqual({ admitted: 0, skipped: 2, hasMore: true });
  });

  it("still admits one fact per worker when the scan used up the admission budget", async () => {
    setPendingRows(Message, rowsIn("workspace-1", "message", 12));
    setPendingRows(MessageDeliveryEvent, []);
    let now = 0;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    (listActiveWebhookEventTypes as jest.Mock).mockImplementation(async () => {
      now = 5_000;
      return new Map([["workspace-1", new Set(["message.received"])]]);
    });
    const enqueue = jest.fn(async () => undefined);

    await expect(
      reconcileCustomerWebhookIntents({
        enqueue,
        limit: 12,
        deadlineAtMs: 3_000,
      })
    ).resolves.toEqual({ admitted: 8, skipped: 0, hasMore: true });
    expect(enqueue).toHaveBeenCalledTimes(8);
    jest.restoreAllMocks();
  });

  it("matches a subscription whose workspace id differs only in letter case", async () => {
    setPendingRows(Message, rowsIn("Workspace-2", "message", 1));
    setPendingRows(MessageDeliveryEvent, []);
    (listActiveWebhookEventTypes as jest.Mock).mockResolvedValue(
      new Map([["workspace-2", new Set(["message.received"])]])
    );
    const enqueue = jest.fn(async () => undefined);

    await expect(
      reconcileCustomerWebhookIntents({ enqueue, limit: 10 })
    ).resolves.toEqual({ admitted: 1, skipped: 0, hasMore: false });
    expect(Message.bulkWrite).not.toHaveBeenCalled();
  });

  it("neither clears nor admits a fact whose workspace differs from its intent", async () => {
    const [row] = rowsIn("workspace-2", "status", 1);
    setPendingRows(Message, []);
    setPendingRows(MessageDeliveryEvent, [
      { ...row, workspaceId: "workspace-3" },
    ]);
    const enqueue = jest.fn(async () => undefined);

    await expect(
      reconcileCustomerWebhookIntents({ enqueue, limit: 10 })
    ).resolves.toEqual({ admitted: 0, skipped: 0, hasMore: true });
    expect(MessageDeliveryEvent.bulkWrite).not.toHaveBeenCalled();
    expect(MessageDeliveryEvent.updateOne).not.toHaveBeenCalled();
    expect(listActiveWebhookEventTypes).not.toHaveBeenCalled();
  });
});
