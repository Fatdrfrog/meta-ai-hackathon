import "server-only";

import { resolveWorkspaceElevenLabsGenerationAccess } from "@/lib/elevenlabs/elevenlabs-source";
import { getSingleRelation } from "@/lib/supabase/company-users";

type VoiceReplySourceClient = Parameters<
  typeof resolveWorkspaceElevenLabsGenerationAccess
>[0]["supabase"];

export type WorkspaceVoiceReplyAccess = {
  available: boolean;
  reason: "subscription_required" | "elevenlabs_required" | null;
  apiKey: string | null;
  defaultVoiceId: string | null;
};

type WorkspaceSubscriptionRow = {
  company_id?: string | null;
  companies?:
    | { subscription_type?: unknown }
    | Array<{ subscription_type?: unknown }>
    | null;
};

export function isVoiceReplySubscriptionEligible(
  subscriptionType: unknown
): subscriptionType is "pro" | "enterprise" {
  return subscriptionType === "pro" || subscriptionType === "enterprise";
}

function unavailable(
  reason: Exclude<WorkspaceVoiceReplyAccess["reason"], null>
): WorkspaceVoiceReplyAccess {
  return { available: false, reason, apiKey: null, defaultVoiceId: null };
}

/** Server callers authorize workspace access before exposing only available/reason. */
export async function resolveWorkspaceVoiceReplyAccess(params: {
  workspaceId: string;
  supabase?: VoiceReplySourceClient;
}): Promise<WorkspaceVoiceReplyAccess> {
  // The admin client is cookie-free and shared by the web and Temporal hosts.
  const supabase =
    params.supabase ?? (await import("@/lib/supabase/admin")).supabaseAdmin;
  let subscriptionType: unknown;
  try {
    // Reuse the company-limits FK join without loading/repairing usage counters.
    const { data, error } = await supabase
      .from("workspaces")
      .select(
        "company_id, companies!workspaces_company_id_fkey(subscription_type)"
      )
      .eq("id", params.workspaceId)
      .maybeSingle();
    const workspace = data as WorkspaceSubscriptionRow | null;
    const company = getSingleRelation(workspace?.companies);
    if (error || !workspace?.company_id || !company) {
      throw new Error("Subscription lookup failed");
    }
    subscriptionType = company.subscription_type;
  } catch {
    // Provider/database errors may include request details; do not retain them.
    throw new Error("Voice reply subscription could not be verified");
  }

  if (!isVoiceReplySubscriptionEligible(subscriptionType)) {
    return unavailable("subscription_required");
  }

  const access = await resolveWorkspaceElevenLabsGenerationAccess({
    supabase,
    workspaceId: params.workspaceId,
  });
  // Automatic voice replies never consume the platform creative preview pool.
  if (
    !access.available ||
    access.credentialSource !== "workspace_source" ||
    !access.apiKey
  ) {
    return unavailable("elevenlabs_required");
  }

  return {
    available: true,
    reason: null,
    apiKey: access.apiKey,
    defaultVoiceId: access.defaultVoiceId,
  };
}
