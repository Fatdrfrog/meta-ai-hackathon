import { moveCustomerToCrmStage } from "@/lib/crm/board";
import { logger } from "@/lib/logger";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";

type Params = Promise<{ workspaceId: string; customerId: string }>;

type CrmStageUpdateRequest = {
  stageKey?: string | null;
  expectedStageKey?: string | null;
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId, customerId } = await params;

  try {
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;
    const { supabase } = access;

    const flags = await getWorkspaceFeatureFlags(workspaceId, [
      "customer_identity",
    ]);
    if (!flags.customer_identity) {
      return NextResponse.json({ error: "Feature disabled" }, { status: 404 });
    }

    const body = (await request
      .json()
      .catch(() => ({}))) as CrmStageUpdateRequest | null;

    const result = await moveCustomerToCrmStage({
      supabase,
      workspaceId,
      customerId,
      stageKey: body?.stageKey ?? null,
      expectedStageKey:
        body && "expectedStageKey" in body ? body.expectedStageKey : undefined,
      actor: {
        type: "manager",
        userId: access.userId,
        label: "crm_board",
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "CRM_STAGE_CONFLICT") {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Stage changed",
          currentStageKey:
            (error as { currentStageKey?: string | null } | null)
              ?.currentStageKey ?? null,
        },
        { status: 409 }
      );
    }

    if ((error as { code?: string } | null)?.code === "CRM_STAGE_VALIDATION") {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : "Invalid CRM stage update",
        },
        { status: 400 }
      );
    }

    logger.error("[CRM Customer Stage API] PATCH failed", error, {
      event: "crm.customer_stage.patch_failed",
      workspaceId,
      customerId,
    });
    return NextResponse.json(
      { error: "Failed to update customer stage" },
      { status: 500 }
    );
  }
}
