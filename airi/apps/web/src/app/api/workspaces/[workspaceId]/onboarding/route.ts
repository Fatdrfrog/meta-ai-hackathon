import { getWorkspaceAiriReadiness } from "@/lib/airi/readiness-score";
import connectDB from "@/lib/mongoose";
import { logger } from "@icecore/shared/lib/logger";
import {
  buildWorkspaceOnboardingState,
  buildWorkspaceOnboardingUpsert,
  type WorkspaceOnboardingPersistedProgress,
} from "@/lib/onboarding/workspace-onboarding";
import { countSuccessfulAiriChatAnswers } from "@/lib/airi-chats/service";
import type { createClient } from "@/lib/supabase/server";
import {
  isOnboardingIntegrationPriorityChannel,
  isOnboardingTestSource,
} from "@icecore/shared/types/sources";
import { NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";

type Params = Promise<{ workspaceId: string }>;

async function getPersistedProgress(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string
): Promise<WorkspaceOnboardingPersistedProgress | null> {
  const { data, error } = await supabase
    .from("workspace_onboarding_progress")
    .select("current_step_id,completed_steps,status,completed_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) {
    logger.error(
      "[Workspace Onboarding] Failed to load persisted progress",
      error,
      { workspaceId }
    );
    return null;
  }

  return data as WorkspaceOnboardingPersistedProgress | null;
}

async function calculateOnboardingState(
  workspaceId: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
) {
  await connectDB();

  const [
    readiness,
    sourcesResult,
    persistedProgress,
    successfulTestAnswersCount,
  ] = await Promise.all([
    getWorkspaceAiriReadiness({ workspaceId, supabase }),
    supabase
      .from("sources")
      .select("type, credentials")
      .eq("workspace_id", workspaceId),
    getPersistedProgress(supabase, workspaceId),
    countSuccessfulAiriChatAnswers({ workspaceId, userId }),
  ]);

  if (sourcesResult.error) {
    logger.error(
      "[Workspace Onboarding] Failed to fetch sources",
      sourcesResult.error,
      { workspaceId }
    );
  }

  const connectedSourceTypes = new Set<string>();
  for (const source of sourcesResult.data || []) {
    if (isOnboardingTestSource(source)) continue;
    const type = String(source.type || "");
    if (isOnboardingIntegrationPriorityChannel(type)) {
      connectedSourceTypes.add(type);
    }
  }

  const onboarding = buildWorkspaceOnboardingState({
    workspaceId,
    metrics: {
      successfulTestAnswersCount,
      activeScenariosCount: readiness.metrics.activeScenariosCount,
      publishedKbArticlesCount: readiness.metrics.publishedKbArticlesCount,
      verifiedSnippetsCount: readiness.metrics.verifiedSnippetsCount,
      connectedSourcesCount: connectedSourceTypes.size,
    },
    connectedSourceTypes: [...connectedSourceTypes],
    persisted: persistedProgress,
  });

  return { onboarding, persistedProgress };
}

export async function GET(_request: Request, { params }: { params: Params }) {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;
    const { supabase, userId } = access;

    const { onboarding } = await calculateOnboardingState(
      workspaceId,
      supabase,
      userId
    );

    return NextResponse.json({ success: true, onboarding });
  } catch (error) {
    console.error("[Workspace Onboarding] Failed to load onboarding", error);
    return NextResponse.json(
      { error: "Failed to load onboarding" },
      { status: 500 }
    );
  }
}

export async function POST(_request: Request, { params }: { params: Params }) {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;
    const { supabase, userId } = access;

    const { onboarding, persistedProgress } = await calculateOnboardingState(
      workspaceId,
      supabase,
      userId
    );

    const { error: upsertError } = await supabase
      .from("workspace_onboarding_progress")
      .upsert(
        buildWorkspaceOnboardingUpsert(onboarding, {
          previousCompletedAt: persistedProgress?.completed_at,
        }),
        { onConflict: "workspace_id" }
      );

    if (upsertError) {
      logger.error(
        "[Workspace Onboarding] Failed to persist progress",
        upsertError,
        { workspaceId }
      );
    }

    return NextResponse.json({ success: true, onboarding });
  } catch (error) {
    console.error("[Workspace Onboarding] Failed to load onboarding", error);
    return NextResponse.json(
      { error: "Failed to load onboarding" },
      { status: 500 }
    );
  }
}
