import { getPostHogClient } from "@/lib/posthog/server";
import {
  resolveServerCapturePolicy,
  type ServerTrackingConsent,
} from "@/lib/tracking-consent-cookie";
import { readServerTrackingConsent } from "@/lib/tracking-consent-server";

/**
 * Activation funnel from sign-up to first send. Template approval and real
 * delivery happen in the worker without a user, so the database report
 * (scripts/report-activation-funnel.ts) covers those steps.
 */
export const FUNNEL_EVENTS = [
  "account_created",
  "email_confirmed",
  "whatsapp_connected",
  "template_submitted",
  "campaign_queued",
  "campaign_send_blocked",
  "scenario_created",
  "scenario_activated",
  "scenario_activation_blocked",
  "test_sent",
] as const;

export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

type FunnelPropertyValue = string | number | boolean | null | undefined;

export type FunnelEventInput = {
  event: FunnelEvent;
  userId?: string | null;
  workspaceId?: string | null;
  companyId?: string | null;
  properties?: Record<string, FunnelPropertyValue>;
  /** Stable id for events that can fire twice for one fact (retries, replays). */
  insertId?: string;
  /** Defaults to the request's cookie choice. */
  consent?: ServerTrackingConsent;
};

export type FunnelCaptureResult = "captured" | "skipped";

async function resolveCompanyId(workspaceId: string): Promise<string | null> {
  try {
    // Lazy: the admin client is server-only and the worker reaches this module.
    const [{ supabaseAdmin }, { getCompanyIdForWorkspace }] = await Promise.all(
      [
        import("@/lib/supabase/admin"),
        import("@icecore/shared/lib/workspace-company"),
      ]
    );
    return await getCompanyIdForWorkspace(supabaseAdmin, workspaceId);
  } catch {
    return null;
  }
}

function definedProperties(
  properties: Record<string, FunnelPropertyValue> | undefined
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Captures one funnel step under the visitor's cookie choice. Never throws. */
export async function captureFunnelEvent(
  input: FunnelEventInput
): Promise<FunnelCaptureResult> {
  try {
    const consent = input.consent ?? (await readServerTrackingConsent());
    const policy = resolveServerCapturePolicy(consent);
    if (policy === "skip") return "skipped";

    const posthog = getPostHogClient();
    if (!posthog) return "skipped";

    const workspaceId = input.workspaceId || null;
    const companyId =
      input.companyId ||
      (workspaceId ? await resolveCompanyId(workspaceId) : null);
    const userId = input.userId || null;
    const distinctId =
      userId ||
      companyId ||
      (workspaceId ? `airi:workspace:${workspaceId}` : null);
    if (!distinctId) return "skipped";

    const personless = policy === "anonymous" || !userId;
    posthog.capture({
      distinctId,
      event: input.event,
      properties: {
        ...definedProperties(input.properties),
        funnel: true,
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
        ...(companyId ? { company_id: companyId } : {}),
        ...(personless ? { $process_person_profile: false } : {}),
        ...(input.insertId ? { $insert_id: input.insertId } : {}),
      },
      ...(companyId ? { groups: { company: companyId } } : {}),
    });
    return "captured";
  } catch (error) {
    console.error("PostHog funnel capture error:", error);
    return "skipped";
  }
}
