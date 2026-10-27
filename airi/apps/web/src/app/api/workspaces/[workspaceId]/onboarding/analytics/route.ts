import {
  trackOnboardingLifecycleEvent,
  type OnboardingAnalyticsEvent,
  type OnboardingStepId,
} from "@/lib/analytics";
import { flushServerPostHog } from "@/lib/posthog/server";
import { getCompanyIdForUserWorkspace } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

type Params = { params: Promise<{ workspaceId: string }> };

const onboardingAnalyticsSchema = z.object({
  event: z.enum([
    "onboarding_step_completed",
    "onboarding_training_started",
    "onboarding_training_failed",
    "onboarding_training_ready",
  ]),
  step_id: z.enum([
    "workspace_created",
    "product_context_training",
    "product_context_ready",
    "test_airi_opened",
    "integrations_handoff",
  ]),
  metadata: z.record(z.unknown()).optional().default({}),
});

const SAFE_METADATA_KEYS = new Set([
  "already_queued",
  "connected_instagram",
  "connected_whatsapp",
  "error_type",
  "has_website",
  "has_signup_referral_source",
  "include_instagram",
  "include_whatsapp",
  "indexed_source_count",
  "pending_source_count",
  "ready_context_source",
  "source",
  "started",
  "training_background",
  "training_ready",
  "training_started",
  "website_count",
  "whatsapp_history_eligible",
  "whatsapp_history_requested",
]);

function sanitizeMetadata(
  metadata: Record<string, unknown>
): Record<string, string | number | boolean | string[] | undefined> {
  const safe: Record<string, string | number | boolean | string[] | undefined> =
    {};

  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;

    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      safe[key] = value;
      continue;
    }

    if (Array.isArray(value) && value.every(item => typeof item === "string")) {
      safe[key] = value.slice(0, 20);
    }
  }

  return safe;
}

export async function POST(request: NextRequest, { params }: Params) {
  const { workspaceId } = await params;
  const body = await request.json().catch(() => ({}));
  const parsed = onboardingAnalyticsSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid analytics event" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const companyId = await getCompanyIdForUserWorkspace(
    supabase,
    user.id,
    workspaceId
  );

  if (!companyId) {
    return NextResponse.json(
      { error: "No company association for this workspace" },
      { status: 403 }
    );
  }

  try {
    trackOnboardingLifecycleEvent(
      companyId,
      workspaceId,
      parsed.data.event as OnboardingAnalyticsEvent,
      parsed.data.step_id as OnboardingStepId,
      sanitizeMetadata(parsed.data.metadata)
    );
    await flushServerPostHog();
  } catch (error) {
    console.error("Onboarding analytics capture skipped", {
      workspaceId,
      error,
    });
  }

  return NextResponse.json({ success: true }, { status: 202 });
}
