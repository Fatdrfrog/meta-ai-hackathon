import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import { cancelCampaignDispatch } from "@/lib/campaign/campaign-history-store";
import { isCampaignOperationUuid } from "@/lib/campaign/campaign-operation-route-utils";
import type { CampaignCancellationResponse } from "@/lib/campaign/campaign-operations-contracts";
import { logger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";
import { cancelBulkCampaignDispatchWorkflow } from "@/lib/temporal/bulk-campaign-dispatch";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ campaignId: string }>;
};

function invalidRequest() {
  return NextResponse.json(
    {
      code: "invalid_request",
      error: "A valid campaign ID and workspaceId are required.",
    },
    { status: 400 }
  );
}

function temporalCancellationFailed(campaignId: string) {
  return NextResponse.json(
    {
      code: "temporal_cancel_failed",
      error:
        "Campaign was cancelled locally, but workflow cancellation could not be confirmed.",
      campaignId,
      status: "cancelled",
      retryable: true,
    },
    { status: 502 }
  );
}

export async function POST(request: Request, context: RouteContext) {
  const { campaignId } = await context.params;
  if (!isCampaignOperationUuid(campaignId)) {
    return invalidRequest();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest();
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalidRequest();
  }
  const entries = Object.entries(body);
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== "workspaceId" ||
    !isCampaignOperationUuid(entries[0]?.[1])
  ) {
    return invalidRequest();
  }
  const workspaceId = entries[0][1];

  const access = await getAuthenticatedWorkspaceMembership(workspaceId);
  if (access.error) {
    return access.error;
  }
  if (!isWorkspaceManagerRole(access.membership.role)) {
    return NextResponse.json(
      { code: "forbidden", error: "Forbidden" },
      { status: 403 }
    );
  }

  let localCancellation;
  try {
    localCancellation = await cancelCampaignDispatch({
      supabase: supabaseAdmin,
      workspaceId,
      campaignId,
    });
  } catch (error) {
    logger.error("campaign.cancel_local_failed", error, {
      event: "campaign.cancel_local_failed",
      campaignId,
      workspaceId,
    });
    return NextResponse.json(
      {
        code: "campaign_cancel_failed",
        error: "Campaign could not be cancelled.",
        retryable: true,
      },
      { status: 503 }
    );
  }

  if (localCancellation.outcome === "not_found") {
    return NextResponse.json(
      { code: "campaign_not_found", error: "Campaign not found." },
      { status: 404 }
    );
  }
  if (
    localCancellation.outcome === "already_terminal" ||
    localCancellation.outcome === "not_cancellable"
  ) {
    return NextResponse.json(
      {
        code: "campaign_not_cancellable",
        error: "Campaign is no longer cancellable.",
        status: localCancellation.status,
      },
      { status: 409 }
    );
  }
  if (
    localCancellation.outcome !== "cancelled" &&
    localCancellation.outcome !== "already_cancelled"
  ) {
    return NextResponse.json(
      {
        code: "campaign_cancel_failed",
        error: "Campaign could not be cancelled.",
        retryable: true,
      },
      { status: 503 }
    );
  }

  const workflowId = localCancellation.workflowId;
  if (typeof workflowId !== "string" || !workflowId.trim()) {
    return temporalCancellationFailed(campaignId);
  }

  try {
    const temporalCancellation =
      await cancelBulkCampaignDispatchWorkflow(workflowId);
    const response: CampaignCancellationResponse = {
      campaignId,
      status: "cancelled",
      outcome: localCancellation.outcome,
      temporalCancellation: temporalCancellation.outcome,
    };
    return NextResponse.json(response);
  } catch (error) {
    logger.error("campaign.cancel_temporal_failed", error, {
      event: "campaign.cancel_temporal_failed",
      campaignId,
      workspaceId,
    });
    return temporalCancellationFailed(campaignId);
  }
}
