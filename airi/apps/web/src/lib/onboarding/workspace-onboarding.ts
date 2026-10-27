import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";
import {
  ONBOARDING_INTEGRATION_PRIORITY,
  isOnboardingIntegrationPriorityChannel,
  type OnboardingIntegrationPriorityChannel,
} from "@icecore/shared/types/sources";

export const WORKSPACE_ONBOARDING_TARGETS = {
  successfulTestAnswersCount: 1,
  connectedSourcesCount: 1,
  activeScenariosCount: 1,
  publishedKbArticlesCount: 5,
  verifiedSnippetsCount: 5,
} as const;

export const WORKSPACE_ONBOARDING_STEP_IDS = [
  "company_profile",
  "test_airi",
  "connect_integration",
  "create_scenario",
  "publish_knowledge",
  "verify_answers",
] as const;

export type WorkspaceOnboardingStepId =
  (typeof WORKSPACE_ONBOARDING_STEP_IDS)[number];

export type WorkspaceOnboardingStatus = "active" | "completed";

export type WorkspaceOnboardingMetrics = {
  successfulTestAnswersCount: number;
  activeScenariosCount: number;
  publishedKbArticlesCount: number;
  verifiedSnippetsCount: number;
  connectedSourcesCount: number;
};

export type WorkspaceOnboardingPersistedProgress = {
  current_step_id?: string | null;
  completed_steps?: unknown;
  status?: string | null;
  completed_at?: string | null;
};

export type WorkspaceOnboardingStep = {
  id: WorkspaceOnboardingStepId;
  current: number;
  target: number;
  completed: boolean;
  href: string;
};

export type WorkspaceOnboardingState = {
  workspaceId: string;
  progress: number;
  completed: boolean;
  status: WorkspaceOnboardingStatus;
  currentStepId: WorkspaceOnboardingStepId | null;
  completedStepIds: WorkspaceOnboardingStepId[];
  metrics: WorkspaceOnboardingMetrics;
  targets: typeof WORKSPACE_ONBOARDING_TARGETS;
  steps: WorkspaceOnboardingStep[];
  integration: {
    suggestedSourceType: OnboardingIntegrationPriorityChannel | null;
    href: string;
  };
};

export type WorkspaceOnboardingProgressUpsert = {
  workspace_id: string;
  current_step_id: WorkspaceOnboardingStepId | null;
  completed_steps: WorkspaceOnboardingStepId[];
  status: WorkspaceOnboardingStatus;
  completed_at: string | null;
  last_seen_at: string;
};

const STEP_ID_SET = new Set<string>(WORKSPACE_ONBOARDING_STEP_IDS);

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normalizeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isWorkspaceOnboardingStepId(
  value: unknown
): value is WorkspaceOnboardingStepId {
  return typeof value === "string" && STEP_ID_SET.has(value);
}

export function normalizeOnboardingCompletedSteps(
  value: unknown
): WorkspaceOnboardingStepId[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<WorkspaceOnboardingStepId>();
  for (const candidate of value) {
    if (isWorkspaceOnboardingStepId(candidate)) {
      seen.add(candidate);
    }
  }

  return WORKSPACE_ONBOARDING_STEP_IDS.filter(stepId => seen.has(stepId));
}

function findSuggestedSourceType(
  connectedSourceTypes: readonly string[]
): OnboardingIntegrationPriorityChannel | null {
  const connected = new Set(
    connectedSourceTypes.filter(isOnboardingIntegrationPriorityChannel)
  );

  return (
    ONBOARDING_INTEGRATION_PRIORITY.find(type => !connected.has(type)) || null
  );
}

function buildIntegrationHref(
  workspaceId: string,
  suggestedSourceType: OnboardingIntegrationPriorityChannel | null
): string {
  if (!suggestedSourceType) {
    return `/panel/w/${workspaceId}/settings/integrations`;
  }

  return `/panel/w/${workspaceId}/settings/integrations?integration=${suggestedSourceType}`;
}

export function buildWorkspaceOnboardingState(params: {
  workspaceId: string;
  metrics: WorkspaceOnboardingMetrics;
  connectedSourceTypes: readonly string[];
  persisted?: WorkspaceOnboardingPersistedProgress | null;
}): WorkspaceOnboardingState {
  const metrics: WorkspaceOnboardingMetrics = {
    successfulTestAnswersCount: normalizeCount(
      params.metrics.successfulTestAnswersCount
    ),
    activeScenariosCount: normalizeCount(params.metrics.activeScenariosCount),
    publishedKbArticlesCount: normalizeCount(
      params.metrics.publishedKbArticlesCount
    ),
    verifiedSnippetsCount: normalizeCount(params.metrics.verifiedSnippetsCount),
    connectedSourcesCount: normalizeCount(params.metrics.connectedSourcesCount),
  };

  const suggestedSourceType = findSuggestedSourceType(
    params.connectedSourceTypes
  );
  const integrationHref = buildIntegrationHref(
    params.workspaceId,
    suggestedSourceType
  );

  const steps: WorkspaceOnboardingStep[] = [
    {
      id: "company_profile",
      current: 1,
      target: 1,
      completed: true,
      href: `/panel/w/${params.workspaceId}/settings/profile`,
    },
    {
      id: "test_airi",
      current: metrics.successfulTestAnswersCount,
      target: WORKSPACE_ONBOARDING_TARGETS.successfulTestAnswersCount,
      completed:
        metrics.successfulTestAnswersCount >=
        WORKSPACE_ONBOARDING_TARGETS.successfulTestAnswersCount,
      href: panelWorkspaceAiriHref(params.workspaceId, {
        source: "onboarding",
      }),
    },
    {
      id: "connect_integration",
      current: metrics.connectedSourcesCount,
      target: WORKSPACE_ONBOARDING_TARGETS.connectedSourcesCount,
      completed:
        metrics.connectedSourcesCount >=
        WORKSPACE_ONBOARDING_TARGETS.connectedSourcesCount,
      href: integrationHref,
    },
    {
      id: "create_scenario",
      current: metrics.activeScenariosCount,
      target: WORKSPACE_ONBOARDING_TARGETS.activeScenariosCount,
      completed:
        metrics.activeScenariosCount >=
        WORKSPACE_ONBOARDING_TARGETS.activeScenariosCount,
      href: `/panel/w/${params.workspaceId}/scenarios`,
    },
    {
      id: "publish_knowledge",
      current: metrics.publishedKbArticlesCount,
      target: WORKSPACE_ONBOARDING_TARGETS.publishedKbArticlesCount,
      completed:
        metrics.publishedKbArticlesCount >=
        WORKSPACE_ONBOARDING_TARGETS.publishedKbArticlesCount,
      href: `/panel/w/${params.workspaceId}/kb`,
    },
    {
      id: "verify_answers",
      current: metrics.verifiedSnippetsCount,
      target: WORKSPACE_ONBOARDING_TARGETS.verifiedSnippetsCount,
      completed:
        metrics.verifiedSnippetsCount >=
        WORKSPACE_ONBOARDING_TARGETS.verifiedSnippetsCount,
      href: `/panel/w/${params.workspaceId}/settings/ai-context#qa`,
    },
  ];

  const persistedCompleted = normalizeOnboardingCompletedSteps(
    params.persisted?.completed_steps
  );
  const completedStepIds = WORKSPACE_ONBOARDING_STEP_IDS.filter(stepId => {
    const step = steps.find(candidate => candidate.id === stepId);
    return Boolean(step?.completed || persistedCompleted.includes(stepId));
  });
  const completed =
    completedStepIds.length === WORKSPACE_ONBOARDING_STEP_IDS.length;
  const currentStepId =
    steps.find(step => !completedStepIds.includes(step.id))?.id || null;
  const progress = clamp(
    completedStepIds.length / WORKSPACE_ONBOARDING_STEP_IDS.length,
    0,
    1
  );

  return {
    workspaceId: params.workspaceId,
    progress,
    completed,
    status: completed ? "completed" : "active",
    currentStepId,
    completedStepIds,
    metrics,
    targets: WORKSPACE_ONBOARDING_TARGETS,
    steps: steps.map(step => ({
      ...step,
      completed: completedStepIds.includes(step.id),
    })),
    integration: {
      suggestedSourceType,
      href: integrationHref,
    },
  };
}

export function buildWorkspaceOnboardingUpsert(
  state: WorkspaceOnboardingState,
  options?: {
    now?: string;
    previousCompletedAt?: string | null;
  }
): WorkspaceOnboardingProgressUpsert {
  const now = options?.now || new Date().toISOString();
  const completedAt = state.completed
    ? options?.previousCompletedAt || now
    : null;

  return {
    workspace_id: state.workspaceId,
    current_step_id: state.currentStepId,
    completed_steps: state.completedStepIds,
    status: state.status,
    completed_at: completedAt,
    last_seen_at: now,
  };
}
