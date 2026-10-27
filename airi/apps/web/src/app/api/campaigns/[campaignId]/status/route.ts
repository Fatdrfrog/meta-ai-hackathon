import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import { getCampaignDispatchStatus } from "@/lib/campaign/campaign-history-store";
import {
  isCampaignOperationUuid,
  serializeCampaignOperationStatus,
} from "@/lib/campaign/campaign-operation-route-utils";
import { logger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ campaignId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { campaignId } = await context.params;
  const workspaceIds = new URL(request.url).searchParams.getAll("workspaceId");
  const workspaceId = workspaceIds[0];

  if (
    !isCampaignOperationUuid(campaignId) ||
    workspaceIds.length !== 1 ||
    !isCampaignOperationUuid(workspaceId)
  ) {
    return NextResponse.json(
      {
        code: "invalid_request",
        error: "Valid campaign and workspace IDs are required.",
      },
      { status: 400 }
    );
  }

  const access = await getAuthenticatedWorkspaceMembership(workspaceId);
  if (access.error) {
    return access.error;
  }

  try {
    const status = await getCampaignDispatchStatus({
      supabase: supabaseAdmin,
      workspaceId,
      campaignId,
    });
    if (!status) {
      return NextResponse.json(
        { code: "campaign_not_found", error: "Campaign not found." },
        { status: 404 }
      );
    }

    return NextResponse.json(serializeCampaignOperationStatus(status), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    logger.error("campaign.status_load_failed", error, {
      event: "campaign.status_load_failed",
      campaignId,
      workspaceId,
    });
    return NextResponse.json(
      {
        code: "campaign_status_unavailable",
        error: "Campaign status is temporarily unavailable.",
        retryable: true,
      },
      { status: 503 }
    );
  }
}
