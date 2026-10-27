import "server-only";

import {
  admitWorkspaceAiAction,
  reserveWorkspaceAiSpend,
  settleWorkspaceAiSpend,
  type WorkspaceAiSpendReservation,
} from "@icecore/airi-runtime/workspace-ai-spend";

/**
 * A product video import's AI spend against the workspace's limit, like the
 * transcription billing in conversation media analysis. Meta calls count
 * only where airi pays for the workspace's AI; there is no customer key for
 * them.
 */
export const productImportSpend = {
  async tracked(workspaceId: string, actionId: string): Promise<boolean> {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    const admission = await admitWorkspaceAiAction({
      supabase: supabaseAdmin,
      workspaceId,
      actionId,
    });
    return admission.billingSource === "platform";
  },
  async reserve(
    input: WorkspaceAiSpendReservation & { provider: "meta" | "elevenlabs" }
  ) {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    return reserveWorkspaceAiSpend({ ...input, supabase: supabaseAdmin });
  },
  /** null when the cost is unknown (a call failed after it may have been billed). */
  async settle(
    reservation: WorkspaceAiSpendReservation,
    actualCostMicros: number | null
  ) {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    await settleWorkspaceAiSpend({
      supabase: supabaseAdmin,
      reservation,
      actualCostMicros,
    });
  },
};
