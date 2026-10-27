const mockPublishGooglePubSubJsonMessage = jest.fn();
const mockMarkConversationClassificationEnqueued = jest.fn();
const mockAfter = jest.fn();

jest.mock("next/server", () => ({
  after: (callback: unknown) => mockAfter(callback),
}));
jest.mock("@/lib/google/pubsub-json-publisher", () => ({
  publishGooglePubSubJsonMessage: (input: unknown) =>
    mockPublishGooglePubSubJsonMessage(input),
}));
jest.mock("./conversation-classification-store", () => ({
  markConversationClassificationEnqueued: (input: unknown) =>
    mockMarkConversationClassificationEnqueued(input),
}));

import {
  getConversationClassificationPubSubTopic,
  publishConversationClassificationWake,
  scheduleConversationClassificationWakeBestEffort,
} from "./classification-pubsub";
import { CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC_DEFAULT } from "@icecore/temporal";
import { useCleanEnv } from "@/test-support/env-test-utils";

describe("conversation classification Pub/Sub publisher", () => {
  useCleanEnv([
    "CONVERSATION_CLASSIFICATION_PUBLISHING_ENABLED",
    "CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID",
    "CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC",
  ]);
  const request = {
    conversationId: "68a000000000000000000001",
    requestedRevision: 4,
    generation: 2,
    requestedAt: new Date("2026-08-10T06:00:00.123Z"),
  };
  const eventId =
    "conversation-classification:v1:68a000000000000000000001:r4:g2";

  beforeEach(() => {
    jest.clearAllMocks();
    mockAfter.mockImplementation(() => {
      throw new Error("after was called outside a request scope");
    });
    process.env.CONVERSATION_CLASSIFICATION_PUBLISHING_ENABLED = "true";
    mockPublishGooglePubSubJsonMessage.mockResolvedValue({
      ok: true,
      messageId: "pubsub-message-1",
    });
    mockMarkConversationClassificationEnqueued.mockResolvedValue(true);
  });

  it("publishes the strict durable wake identity before marking the matching classification state", async () => {
    process.env.CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC = "classification-v2";

    await expect(
      publishConversationClassificationWake({
        ...request,
        marker: { kind: "classification" },
      })
    ).resolves.toEqual({
      status: "published_marked",
      eventId,
      messageId: "pubsub-message-1",
    });

    expect(mockPublishGooglePubSubJsonMessage).toHaveBeenCalledWith({
      projectIdEnvName: "CONVERSATION_CLASSIFICATION_PUBSUB_PROJECT_ID",
      topic: "classification-v2",
      message: {
        schemaVersion: 1,
        eventId,
        conversationId: request.conversationId,
        requestedRevision: 4,
        generation: 2,
        requestedAt: "2026-08-10T06:00:00.123Z",
      },
      orderingKey: request.conversationId,
      attributes: {
        eventType: "conversation.classification.wake",
        schemaVersion: "1",
        eventId,
        requestedRevision: "4",
        generation: "2",
      },
    });
    expect(mockMarkConversationClassificationEnqueued).toHaveBeenCalledWith({
      conversationId: request.conversationId,
      revision: 4,
      generation: 2,
      marker: { kind: "classification" },
    });
    expect(
      mockPublishGooglePubSubJsonMessage.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mockMarkConversationClassificationEnqueued.mock.invocationCallOrder[0]
    );
  });

  it("uses the shared default topic and a compact configured override", () => {
    expect(getConversationClassificationPubSubTopic()).toBe(
      CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC_DEFAULT
    );

    process.env.CONVERSATION_CLASSIFICATION_PUBSUB_TOPIC = "  custom-topic  ";
    expect(getConversationClassificationPubSubTopic()).toBe("custom-topic");
  });

  it("keeps pending Mongo state unpublished unless the reviewed release enables publishing", async () => {
    delete process.env.CONVERSATION_CLASSIFICATION_PUBLISHING_ENABLED;

    await expect(
      publishConversationClassificationWake({
        ...request,
        marker: { kind: "classification" },
      })
    ).resolves.toEqual({
      status: "publishing_disabled",
      eventId,
    });

    expect(mockPublishGooglePubSubJsonMessage).not.toHaveBeenCalled();
    expect(mockMarkConversationClassificationEnqueued).not.toHaveBeenCalled();
  });

  it("keeps the event identity idempotent across repeated transport attempts", async () => {
    mockPublishGooglePubSubJsonMessage
      .mockResolvedValueOnce({ ok: true, messageId: "message-a" })
      .mockResolvedValueOnce({ ok: true, messageId: "message-b" });

    const first = await publishConversationClassificationWake({
      ...request,
      marker: { kind: "classification" },
    });
    const second = await publishConversationClassificationWake({
      ...request,
      marker: { kind: "classification" },
    });

    expect(first.eventId).toBe(eventId);
    expect(second.eventId).toBe(eventId);
    expect(mockPublishGooglePubSubJsonMessage.mock.calls[0]?.[0]).toEqual(
      mockPublishGooglePubSubJsonMessage.mock.calls[1]?.[0]
    );
  });

  it.each([
    ["typed failure", { ok: false }, "ok=false"],
    ["thrown failure", new Error("transport exploded"), "transport exploded"],
  ])(
    "separates %s from marker outcomes",
    async (_label, failure, errorText) => {
      if (failure instanceof Error) {
        mockPublishGooglePubSubJsonMessage.mockRejectedValue(failure);
      } else {
        mockPublishGooglePubSubJsonMessage.mockResolvedValue(failure);
      }

      const outcome = await publishConversationClassificationWake({
        ...request,
        marker: { kind: "classification" },
      });

      expect(outcome).toMatchObject({
        status: "publish_failed",
        eventId,
        error: expect.stringContaining(errorText),
      });
      expect(mockMarkConversationClassificationEnqueued).not.toHaveBeenCalled();
    }
  );

  it("reports a successful transport with a stale marker CAS separately", async () => {
    mockMarkConversationClassificationEnqueued.mockResolvedValue(false);

    await expect(
      publishConversationClassificationWake({
        ...request,
        marker: { kind: "classification" },
      })
    ).resolves.toEqual({
      status: "published_stale",
      eventId,
      messageId: "pubsub-message-1",
    });
  });

  it("reports marker failure without reclassifying the transport as failed", async () => {
    mockPublishGooglePubSubJsonMessage.mockResolvedValue({
      ok: true,
      messageId: null,
    });
    mockMarkConversationClassificationEnqueued.mockRejectedValue(
      new Error("marker unavailable")
    );

    await expect(
      publishConversationClassificationWake({
        ...request,
        marker: { kind: "classification" },
      })
    ).resolves.toEqual({
      status: "published_marker_failed",
      eventId,
      messageId: null,
      error: "marker unavailable",
    });
  });

  it("passes the exact effects identity to the guarded post-publish marker", async () => {
    await publishConversationClassificationWake({
      ...request,
      marker: {
        kind: "effects",
        analysisRevisionId: "analysis-revision-4",
      },
    });

    expect(mockMarkConversationClassificationEnqueued).toHaveBeenCalledWith({
      conversationId: request.conversationId,
      revision: 4,
      generation: 2,
      marker: {
        kind: "effects",
        analysisRevisionId: "analysis-revision-4",
      },
    });
  });

  it("fails closed before transport when the shared wake contract rejects identity", async () => {
    await expect(
      publishConversationClassificationWake({
        ...request,
        generation: 0,
        marker: { kind: "classification" },
      })
    ).rejects.toThrow("generation");
    expect(mockPublishGooglePubSubJsonMessage).not.toHaveBeenCalled();
    expect(mockMarkConversationClassificationEnqueued).not.toHaveBeenCalled();
  });

  it("binds the best-effort scheduler to the classification marker and swallows transport failure", async () => {
    await scheduleConversationClassificationWakeBestEffort(request);
    expect(mockMarkConversationClassificationEnqueued).toHaveBeenCalledWith(
      expect.objectContaining({ marker: { kind: "classification" } })
    );

    jest.clearAllMocks();
    mockPublishGooglePubSubJsonMessage.mockRejectedValue(
      new Error("transport unavailable")
    );
    await expect(
      scheduleConversationClassificationWakeBestEffort(request)
    ).resolves.toBeUndefined();
    expect(mockMarkConversationClassificationEnqueued).not.toHaveBeenCalled();
  });

  it("hands a request wake to after-response work without blocking the committed message", async () => {
    mockAfter.mockImplementation(() => undefined);
    let finishPublish!: (value: { ok: boolean; messageId: string }) => void;
    mockPublishGooglePubSubJsonMessage.mockImplementation(
      () =>
        new Promise(resolve => {
          finishPublish = resolve;
        })
    );

    await scheduleConversationClassificationWakeBestEffort(request);

    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockPublishGooglePubSubJsonMessage).not.toHaveBeenCalled();
    const wake = mockAfter.mock.calls[0][0] as () => Promise<void>;
    const pending = wake();
    expect(mockPublishGooglePubSubJsonMessage).toHaveBeenCalledTimes(1);
    expect(mockMarkConversationClassificationEnqueued).not.toHaveBeenCalled();
    finishPublish({ ok: true, messageId: "pubsub-message-late" });
    await pending;
    expect(mockMarkConversationClassificationEnqueued).toHaveBeenCalledWith({
      conversationId: request.conversationId,
      revision: request.requestedRevision,
      generation: request.generation,
      marker: { kind: "classification" },
    });
  });

  it("awaits a wake outside request scope and leaves its identity unmarked when publish fails", async () => {
    let failPublish!: (reason: Error) => void;
    mockPublishGooglePubSubJsonMessage.mockImplementation(
      () =>
        new Promise((_, reject) => {
          failPublish = reject;
        })
    );
    let settled = false;
    const pending = scheduleConversationClassificationWakeBestEffort(
      request
    ).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mockPublishGooglePubSubJsonMessage).toHaveBeenCalledTimes(1);
    failPublish(new Error("transport unavailable"));
    await pending;
    expect(mockMarkConversationClassificationEnqueued).not.toHaveBeenCalled();
  });
});
