const mockUpdateOne = jest.fn();

jest.mock("@/models/realtime-event", () => ({
  RealtimeEvent: {
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

import { markPendingV3PubSubConfirmed } from "./outbox-lifecycle";

const PUBLISHED_AT = new Date("2026-08-20T12:00:00.000Z");

describe("Requests outbox lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  });

  it("acknowledges a published v3 event only while it is pending and unclaimed", async () => {
    await expect(
      markPendingV3PubSubConfirmed({
        eventId: "requests-row:v3:committed",
        publishedAt: PUBLISHED_AT,
        messageId: "pubsub-1",
      })
    ).resolves.toBe(true);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        eventId: "requests-row:v3:committed",
        status: "pending",
        replayLeaseId: null,
      },
      {
        $set: {
          status: "published",
          publishedAt: PUBLISHED_AT,
          messageId: "pubsub-1",
          lastError: null,
        },
        $unset: {
          replayLeaseId: "",
          replayLeaseExpiresAt: "",
          nextAttemptAt: "",
        },
        $inc: { attempts: 1 },
      }
    );
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(
      markPendingV3PubSubConfirmed({
        eventId: "requests-row:v3:claimed",
        publishedAt: PUBLISHED_AT,
        messageId: "pubsub-1",
      })
    ).resolves.toBe(false);
  });

  it("accepts only a v3 event with a confirmed Pub/Sub message ID", async () => {
    for (const input of [
      { eventId: "requests-row:v4:reserved", messageId: "pubsub-1" },
      { eventId: "requests-row:v3:committed", messageId: "" },
    ]) {
      await expect(
        markPendingV3PubSubConfirmed({ ...input, publishedAt: PUBLISHED_AT })
      ).rejects.toThrow();
    }
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});
