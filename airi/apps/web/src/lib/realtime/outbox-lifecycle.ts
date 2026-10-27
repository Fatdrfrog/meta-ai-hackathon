import { RealtimeEvent } from "@/models/realtime-event";

function confirmedUpdate(publishedAt: Date, messageId: string | null = null) {
  return {
    $set: {
      status: "published",
      publishedAt,
      messageId,
      lastError: null,
    },
    $unset: {
      replayLeaseId: "",
      replayLeaseExpiresAt: "",
      nextAttemptAt: "",
    },
  };
}

function casSucceeded(result: { modifiedCount?: number }): boolean {
  return result.modifiedCount === 1;
}

export async function markPendingV3PubSubConfirmed(input: {
  eventId: string;
  publishedAt: Date;
  messageId: string;
}): Promise<boolean> {
  if (
    !input.eventId.startsWith("requests-row:v3:") ||
    !input.messageId.trim()
  ) {
    throw new Error(
      "A v3 Requests event and confirmed Pub/Sub message ID are required"
    );
  }
  const result = await RealtimeEvent.updateOne(
    { eventId: input.eventId, status: "pending", replayLeaseId: null },
    {
      ...confirmedUpdate(input.publishedAt, input.messageId),
      $inc: { attempts: 1 },
    }
  );
  return casSucceeded(result);
}
