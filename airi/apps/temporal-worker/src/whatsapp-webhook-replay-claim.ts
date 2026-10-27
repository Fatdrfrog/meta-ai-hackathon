import { buildWhatsAppWebhookReplayablePayloadFilter } from "@icecore/airi-runtime/whatsapp-webhook-event-retention";
import { buildWhatsAppNotPlanSkippedReceiptFilter } from "@icecore/airi-runtime/whatsapp-intake-plan-gate";
import { randomUUID } from "node:crypto";

type ReplayModel = {
  updateOne: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => Promise<{ matchedCount: number }>;
};

export async function claimWhatsAppWebhookEventForReplay(params: {
  model: ReplayModel;
  eventId: unknown;
  status: string;
  processingLeaseId?: string;
  now?: Date;
  /** Leave plan-skipped receipts to the processor replay (--plan-skipped). */
  excludePlanSkipped?: boolean;
}): Promise<{ status: "ready" } | { status: "skipped"; reason: string }> {
  const reset = await params.model.updateOne(
    {
      _id: params.eventId,
      status: params.status,
      ...buildWhatsAppWebhookReplayablePayloadFilter(),
      ...(params.excludePlanSkipped
        ? buildWhatsAppNotPlanSkippedReceiptFilter()
        : {}),
    },
    {
      $set: {
        status: params.processingLeaseId ? "processing" : "failed",
        attempts: 0,
        nextRetryAt: params.now || new Date(),
        completedAt: null,
        processingStartedAt: params.processingLeaseId
          ? params.now || new Date()
          : null,
        ...(params.processingLeaseId
          ? { processingLeaseId: params.processingLeaseId }
          : {}),
        lastError: null,
      },
    },
  );
  return reset.matchedCount === 1
    ? { status: "ready" }
    : { status: "skipped", reason: "payload_unavailable_or_state_changed" };
}

export async function runWhatsAppWebhookFastReplay<
  T extends { status: "completed"; runtimeCode: string },
>(params: {
  model: ReplayModel;
  eventId: unknown;
  status: string;
  run: () => Promise<T>;
}): Promise<T | { status: "skipped"; runtimeCode: string }> {
  const processingLeaseId = randomUUID();
  // Fast import completes a receipt even when it imports nothing (edits,
  // revokes, reactions, history children), so it must never claim a
  // plan-skipped receipt: only the processor replay restores one and clears
  // its marker.
  const claim = await claimWhatsAppWebhookEventForReplay({
    ...params,
    processingLeaseId,
    excludePlanSkipped: true,
  });
  if (claim.status === "skipped") {
    return { status: "skipped", runtimeCode: claim.reason };
  }
  const owned = {
    _id: params.eventId,
    status: "processing",
    processingLeaseId,
  };
  let result: T;
  try {
    result = await params.run();
  } catch (error) {
    await params.model.updateOne(owned, {
      $set: {
        status: "failed",
        processingLeaseId: null,
        processingStartedAt: null,
        nextRetryAt: new Date(),
        lastError: (error instanceof Error
          ? error.message
          : String(error)
        ).slice(0, 1_000),
      },
    });
    throw error;
  }
  const completion = await params.model.updateOne(owned, {
    $set: {
      status: "completed",
      completedAt: new Date(),
      processingLeaseId: null,
      lastError: null,
    },
  });
  return completion.matchedCount === 1
    ? result
    : { status: "skipped", runtimeCode: "event_claim_lost" };
}
