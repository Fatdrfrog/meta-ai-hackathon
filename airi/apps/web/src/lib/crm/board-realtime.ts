import { logger } from "@/lib/logger";
import {
  emitCrmBoardChangedRealtimeEvent,
  type CrmBoardChangedRealtimeInput,
} from "@/lib/realtime/server";

export async function notifyCrmBoardChanged(
  input: CrmBoardChangedRealtimeInput
): Promise<void> {
  try {
    await emitCrmBoardChangedRealtimeEvent(input);
  } catch (error) {
    logger.error("[CRM] Failed to emit board realtime event", error, {
      event: "crm.board.changed_failed",
      workspaceId: input.workspaceId,
      reason: input.reason,
      customerId: input.customerId || null,
    });
  }
}
