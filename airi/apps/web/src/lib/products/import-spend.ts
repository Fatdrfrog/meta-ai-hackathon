import "server-only";

import {
  reserveWorkspaceAiSpend,
  settleWorkspaceAiSpend,
  type WorkspaceAiSpendReservation,
} from "@icecore/airi-runtime/workspace-ai-spend";

type TrialCompany = {
  subscription_type?: string | null;
  trial_ends_at?: string | null;
};

/**
 * Whether the workspace's company is on the free plan with no trial running,
 * as admit_workspace_text_ai_action rules it: such a company can't start an
 * AI action, whatever its allowance says. A trial that never started (no end
 * date) counts as ended, unlike the panel's limits, which call it active.
 */
async function trialEnded(workspaceId: string): Promise<boolean> {
  const [{ supabaseAdmin }, { WorkspaceAiPolicyUnavailableError }] =
    await Promise.all([
      import("@/lib/supabase/admin"),
      import("@/lib/ai/workspace-ai-policy"),
    ]);
  const { data, error } = await supabaseAdmin
    .from("workspaces")
    .select(
      "companies!workspaces_company_id_fkey(subscription_type, trial_ends_at)"
    )
    .eq("id", workspaceId)
    .maybeSingle();
  const joined = (data as { companies?: TrialCompany | TrialCompany[] } | null)
    ?.companies;
  const company = Array.isArray(joined) ? joined[0] : joined;
  // Database errors can carry URLs and payloads; only the code goes on.
  if (error || !company) throw new WorkspaceAiPolicyUnavailableError();
  if ((company.subscription_type ?? "free") !== "free") return false;
  return (
    !company.trial_ends_at || Date.parse(company.trial_ends_at) <= Date.now()
  );
}

/**
 * A product video import's AI spend against the workspace's limits, like the
 * transcription billing in conversation media analysis. airi always pays:
 * Meta's models and airi's ElevenLabs key have no customer equivalent, so a
 * workspace that can't pay for platform AI can't import.
 */
export const productImportSpend = {
  /** The workspace's allowance as projected now; unlike a reservation, it admits no action. */
  async allowance(workspaceId: string) {
    const { getWorkspaceTextAiAllowance } = await import(
      "@/lib/ai/workspace-ai-policy"
    );
    const [allowance, ended] = await Promise.all([
      getWorkspaceTextAiAllowance(workspaceId),
      trialEnded(workspaceId),
    ]);
    return {
      includedActions: allowance.includedActions,
      remainingActions: allowance.remainingActions,
      spendLimitReached: allowance.spendLimitReached,
      trialEnded: ended,
    };
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
