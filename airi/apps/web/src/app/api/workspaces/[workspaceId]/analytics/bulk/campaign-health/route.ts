import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import { isCampaignOperationUuid } from "@/lib/campaign/campaign-operation-route-utils";
import { BulkCampaignHealthRequestError, getBulkCampaignHealth } from "@/lib/analytics/bulk-analytics-campaign-health";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await context.params;
  if (!isCampaignOperationUuid(workspaceId)) return NextResponse.json({ error: "Valid workspace ID required." }, { status: 400 });
  const search = new URL(request.url).searchParams;
  const campaignIds = search.getAll("campaignId");
  const campaignId = campaignIds[0];

  if (campaignIds.length !== 1 || !isCampaignOperationUuid(campaignId)) return NextResponse.json({ error: "One valid campaign ID is required." }, { status: 400 });
  const access = await getAuthenticatedWorkspaceMembership(workspaceId);
  if (access.error) return access.error;
  try {
    const result = await getBulkCampaignHealth({ workspaceId, campaignId: campaignId!, signal: request.signal });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof BulkCampaignHealthRequestError) return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error("bulk_analytics.campaign_health_unavailable", error, { workspaceId, campaignId });
    return NextResponse.json({ error: "Campaign evidence is temporarily unavailable.", retryable: true }, { status: 503 });
  }
}
