import { loadPostHogClient } from "./posthog/client";
import { getPostHogClient } from "./posthog/server";
import {
  resolveServerCapturePolicy,
  type ServerCapturePolicy,
  type ServerTrackingConsent,
} from "./tracking-consent-cookie";
import type { ConversationClassificationEffectInputs } from "@/models/conversation-analysis-revision";

// Detect if we're running on the server
const isServer = typeof window === "undefined";

interface UserProperties {
  company_id?: string;
  workspace_id?: string;
  role?: string;
  registration_source?: string;
  email?: string;
  name?: string;
  agent_skill_level?: string;
  [key: string]: string | number | boolean | undefined;
}

interface CompanyProperties {
  company_name?: string;
  company_slug?: string;
  business_context?: string;
  language?: string;
  airi_language?: string;
  trial_starts_at?: string;
  trial_ends_at?: string;
  dynamic_context_tags?: string[];
  created_at?: string;
  [key: string]: string | string[] | number | boolean | undefined;
}

interface EventProperties {
  [key: string]: string | number | boolean | string[] | undefined;
}

/** Server callers pass the request's cookie choice; see tracking-consent-cookie. */
export type PersonTrackingOptions = { consent?: ServerTrackingConsent };

// Without a consent value the caller predates the gate (browser code), so the
// SDK's own consent handling applies.
function resolvePersonTracking(
  options: PersonTrackingOptions | undefined
): ServerCapturePolicy {
  return options?.consent === undefined
    ? "identified"
    : resolveServerCapturePolicy(options.consent);
}

const PERSONLESS_EVENT_PROPERTIES = { $process_person_profile: false };

export type OnboardingAnalyticsEvent =
  | "onboarding_step_completed"
  | "onboarding_training_started"
  | "onboarding_training_failed"
  | "onboarding_training_ready";

export type OnboardingStepId =
  | "workspace_created"
  | "product_context_training"
  | "product_context_ready"
  | "test_airi_opened"
  | "integrations_handoff";

type LoadedPostHogClient = NonNullable<
  Awaited<ReturnType<typeof loadPostHogClient>>
>;

function withPostHogClient(
  operation: (posthog: LoadedPostHogClient) => void,
  errorLabel: string
): void {
  void loadPostHogClient()
    .then(posthog => {
      if (!posthog) return;
      operation(posthog);
    })
    .catch(error => {
      console.error(`PostHog ${errorLabel} error:`, error);
    });
}

const identifyUser = (userId: string, userProperties: UserProperties) => {
  try {
    if (isServer) {
      // Server-side: use posthog-node
      const posthog = getPostHogClient();
      if (posthog) {
        posthog.identify({
          distinctId: userId,
          properties: userProperties,
        });
      }
    } else {
      // Client-side: use posthog-js
      withPostHogClient(
        posthog => posthog.identify(userId, userProperties),
        "identify"
      );
    }
  } catch (error) {
    // Silently fail - don't break the app if PostHog fails
    console.error("PostHog identify error:", error);
  }
};

export const setCompanyProperties = (
  companyId: string,
  companyProperties: CompanyProperties
) => {
  try {
    if (isServer) {
      // Server-side: use posthog-node
      const posthog = getPostHogClient();
      if (posthog) {
        // posthog-node uses groupIdentify for group properties
        posthog.groupIdentify({
          groupType: "company",
          groupKey: companyId,
          properties: companyProperties,
        });
      }
    } else {
      // Client-side: use posthog-js
      withPostHogClient(
        posthog => posthog.group("company", companyId, companyProperties),
        "setCompanyProperties"
      );
    }
  } catch (error) {
    // Silently fail - don't break the app if PostHog fails
    console.error("PostHog setCompanyProperties error:", error);
  }
};

export const trackCompanyEvent = (
  event: string,
  properties: EventProperties,
  companyId: string,
  workspaceId?: string
) => {
  try {
    if (isServer) {
      // Server-side: use posthog-node
      const posthog = getPostHogClient();
      if (posthog) {
        // For server-side, we need a distinctId - use companyId as fallback
        // In practice, this should be called with a user context when available
        const userId = properties.user_id as string | undefined;
        const distinctId = userId || companyId;

        posthog.capture({
          distinctId,
          event,
          properties: {
            // A company id is not a person; keep it out of person profiles.
            ...(userId ? {} : PERSONLESS_EVENT_PROPERTIES),
            ...properties,
            company_id: companyId,
            workspace_id: workspaceId,
          },
          groups: {
            company: companyId,
          },
        });
      }
    } else {
      // Client-side: use posthog-js
      withPostHogClient(
        posthog =>
          posthog.capture(event, {
            ...properties,
            company_id: companyId,
            workspace_id: workspaceId,
            $groups: { company: companyId },
          }),
        "trackCompanyEvent"
      );
    }
  } catch (error) {
    // Silently fail - don't break the app if PostHog fails
    console.error("PostHog trackCompanyEvent error:", error);
  }
};

/**
 * Identify a visitor in PostHog
 * Used for widget analytics to create person profiles for anonymous visitors
 */
export const identifyVisitor = (
  visitorId: string,
  properties: {
    workspace_id: string;
    company_id: string;
    [key: string]: string | number | boolean | undefined;
  }
) => {
  try {
    if (isServer) {
      // Server-side: use posthog-node
      const posthog = getPostHogClient();
      if (posthog) {
        posthog.identify({
          distinctId: visitorId,
          properties,
        });
      }
    } else {
      // Client-side: use posthog-js
      withPostHogClient(
        posthog => posthog.identify(visitorId, properties),
        "identifyVisitor"
      );
    }
  } catch (error) {
    // Silently fail - don't break the app if PostHog fails
    console.error("PostHog identifyVisitor error:", error);
  }
};

/**
 * Track widget event with proper visitor identification
 * Uses visitor_id as distinctId for proper session tracking
 */
export const trackWidgetEvent = (
  event: string,
  properties: EventProperties,
  visitorId: string,
  companyId: string,
  workspaceId: string
) => {
  try {
    if (isServer) {
      // Server-side: use posthog-node
      const posthog = getPostHogClient();
      if (posthog) {
        posthog.capture({
          distinctId: visitorId,
          event,
          properties: {
            ...properties,
            workspace_id: workspaceId,
            company_id: companyId,
          },
          groups: {
            company: companyId,
          },
        });
      }
    } else {
      // Client-side: use posthog-js
      withPostHogClient(
        posthog =>
          posthog.capture(event, {
            ...properties,
            workspace_id: workspaceId,
            company_id: companyId,
            $groups: { company: companyId },
          }),
        "trackWidgetEvent"
      );
    }
  } catch (error) {
    // Silently fail - don't break the app if PostHog fails
    console.error("PostHog trackWidgetEvent error:", error);
  }
};

export const trackUserRegistration = (
  userId: string,
  companyId: string,
  workspaceId: string,
  role: string,
  source: string,
  email?: string,
  name?: string,
  options?: PersonTrackingOptions
) => {
  const policy = resolvePersonTracking(options);
  if (policy === "skip") return;
  if (policy === "identified") {
    identifyUser(userId, {
      company_id: companyId,
      workspace_id: workspaceId,
      role,
      registration_source: source,
      email,
      name,
    });
  }

  trackCompanyEvent(
    "sign up",
    {
      user_id: userId,
      role,
      source,
      ...(policy === "anonymous" ? PERSONLESS_EVENT_PROPERTIES : {}),
    },
    companyId,
    workspaceId
  );
};

export const trackUserSignIn = (
  userId: string,
  companyId: string,
  workspaceId: string,
  method: string,
  email?: string,
  options?: PersonTrackingOptions
) => {
  const policy = resolvePersonTracking(options);
  if (policy === "skip") return;
  if (policy === "identified") {
    identifyUser(userId, {
      company_id: companyId,
      workspace_id: workspaceId,
      email,
    });
  }

  trackCompanyEvent(
    "sign in",
    {
      user_id: userId,
      sign_in_method: method,
      ...(policy === "anonymous" ? PERSONLESS_EVENT_PROPERTIES : {}),
    },
    companyId,
    workspaceId
  );
};

export const trackWorkspaceCreated = (
  companyId: string,
  workspaceId: string,
  workspaceName: string,
  userId?: string,
  options?: PersonTrackingOptions
) => {
  const policy = resolvePersonTracking(options);
  if (policy === "skip") return;
  trackCompanyEvent(
    "workspace_created",
    {
      workspace_name: workspaceName,
      ...(userId ? { user_id: userId } : {}),
      ...(policy === "anonymous" ? PERSONLESS_EVENT_PROPERTIES : {}),
    },
    companyId,
    workspaceId
  );
};

export const trackOnboardingLifecycleEvent = (
  companyId: string,
  workspaceId: string,
  event: OnboardingAnalyticsEvent,
  stepId: OnboardingStepId,
  metadata: EventProperties = {}
) => {
  // The wizard sends its own `source` (for example "self_signup"); keep it as
  // signup_source so it cannot replace the event's origin.
  const { source: signupSource, ...rest } = metadata;
  trackCompanyEvent(
    event,
    {
      ...rest,
      step_id: stepId,
      source: "setup_wizard",
      ...(signupSource !== undefined ? { signup_source: signupSource } : {}),
    },
    companyId,
    workspaceId
  );
};

export const trackSourceConnected = (
  companyId: string,
  workspaceId: string,
  sourceType: string,
  status: string
) => {
  trackCompanyEvent(
    "source_connected",
    {
      source_type: sourceType,
      integration_status: status,
    },
    companyId,
    workspaceId
  );
};

export async function trackConversationClassificationCompleted(input: {
  analysisRevisionId: string;
  conversationId: string;
  sourceRevision: number;
  completedAt: Date;
  workspaceId: string;
  effectInputs: ConversationClassificationEffectInputs;
}): Promise<{ status: "accepted" | "disabled" }> {
  const posthog = getPostHogClient();
  if (!posthog) {
    return { status: "disabled" };
  }

  const { effectInputs } = input;
  posthog.capture({
    distinctId: effectInputs.companyId,
    event: "message_classified",
    properties: {
      ...PERSONLESS_EVENT_PROPERTIES,
      $insert_id: input.analysisRevisionId,
      company_id: effectInputs.companyId,
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      analysis_revision_id: input.analysisRevisionId,
      source_revision: input.sourceRevision,
      completed_at: input.completedAt.toISOString(),
      ...(effectInputs.source.id ? { source_id: effectInputs.source.id } : {}),
      ...(effectInputs.source.type
        ? { source_type: effectInputs.source.type }
        : {}),
      classification_confidence: effectInputs.predictedCategoryConfidence,
      processing_time_ms: effectInputs.processingTimeMs,
      ai_provider: effectInputs.provider,
      ai_model_used: effectInputs.model,
    },
    groups: {
      company: effectInputs.companyId,
    },
  });
  await posthog.flush();

  return { status: "accepted" };
}

export const trackAiriSession = (
  companyId: string,
  workspaceId: string,
  agentId: string,
  tipCount: number,
  latency: number,
  modelUsed: string,
  tokensUsed: number,
  estimatedCost: number,
  skipped: boolean
) => {
  trackCompanyEvent(
    "airi_session_completed",
    {
      agent_id: agentId,
      tip_count: tipCount,
      latency_ms: latency,
      model_used: modelUsed,
      tokens_used: tokensUsed,
      estimated_cost_usd: estimatedCost,
      skipped,
    },
    companyId,
    workspaceId
  );
};

// Error and performance tracking
export const trackError = (
  companyId: string,
  workspaceId: string,
  errorType: string,
  errorMessage: string,
  context?: EventProperties
) => {
  trackCompanyEvent(
    "error_occurred",
    {
      error_type: errorType,
      error_message: errorMessage,
      ...context,
    },
    companyId,
    workspaceId
  );
};

export const trackPerformance = (
  companyId: string,
  workspaceId: string,
  operation: string,
  duration: number,
  metadata?: EventProperties
) => {
  trackCompanyEvent(
    "performance_metric",
    {
      operation,
      duration_ms: duration,
      ...metadata,
    },
    companyId,
    workspaceId
  );
};
