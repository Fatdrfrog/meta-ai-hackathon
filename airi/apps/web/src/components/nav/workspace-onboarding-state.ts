"use client";

import type { WorkspaceOnboardingState } from "@/lib/onboarding/workspace-onboarding";
import { useMemo } from "react";
import useSWR from "swr";

type WorkspaceOnboardingResponse =
  | {
      success: true;
      onboarding: WorkspaceOnboardingState;
    }
  | {
      error?: string;
    };

async function fetchWorkspaceOnboarding(
  url: string
): Promise<WorkspaceOnboardingState | null> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return null;

  const payload = (await response.json()) as WorkspaceOnboardingResponse;
  if ("success" in payload && payload.success) {
    return payload.onboarding;
  }

  return null;
}

/** SWR key of the setup checklist; mutate it after a step-completing action. */
export function workspaceOnboardingKey(workspaceId: string): string {
  return `/api/workspaces/${workspaceId}/onboarding`;
}

export function useWorkspaceOnboarding(workspaceId: string) {
  const { data } = useSWR(
    workspaceId ? workspaceOnboardingKey(workspaceId) : null,
    fetchWorkspaceOnboarding,
    {
      dedupingInterval: 30_000,
      revalidateOnFocus: false,
    }
  );

  return data ?? null;
}

export function useCurrentOnboardingStep(workspaceId: string) {
  const onboarding = useWorkspaceOnboarding(workspaceId);

  return useMemo(() => {
    if (!onboarding || onboarding.completed) return null;

    const currentStep =
      onboarding.steps.find(step => step.id === onboarding.currentStepId) ||
      onboarding.steps.find(step => !step.completed) ||
      null;

    if (!currentStep) return null;

    const percent = Math.round(
      Math.max(0, Math.min(1, onboarding.progress)) * 100
    );

    return { currentStep, percent };
  }, [onboarding]);
}
