import type {
  OnboardingAnalyticsEvent,
  OnboardingStepId,
} from "@/lib/analytics";

type SafeOnboardingMetadata = Record<
  string,
  string | number | boolean | string[] | undefined
>;

export function captureOnboardingAnalytics(params: {
  workspaceId: string;
  event: OnboardingAnalyticsEvent;
  stepId: OnboardingStepId;
  metadata?: SafeOnboardingMetadata;
}): void {
  if (!params.workspaceId) return;

  void fetch(
    `/api/workspaces/${encodeURIComponent(
      params.workspaceId
    )}/onboarding/analytics`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: params.event,
        step_id: params.stepId,
        metadata: params.metadata,
      }),
    }
  ).catch(() => {
    // Analytics is best-effort and must not block onboarding.
  });
}
