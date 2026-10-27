import { getFollowUpAudienceAnalysis } from "@/lib/analytics/follow-up-audience";
import {
  isFollowUpAudienceStatus,
  type FollowUpAudienceStatus,
} from "@/lib/campaign/follow-up-audience-status";
import { NextRequest, NextResponse } from "next/server";
import { parsePositiveInt } from "@/lib/api/query-params";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";

export const runtime = "nodejs";

type Params = Promise<{ workspaceId: string }>;

function parseStatus(value: string | null): FollowUpAudienceStatus | null {
  return isFollowUpAudienceStatus(value) ? value : null;
}

function parseOptionalFilter(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "all") {
    return null;
  }
  return trimmed;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    const searchParams = request.nextUrl.searchParams;
    const bypassWorkspaceStateCache = searchParams.get("refresh") === "1";
    const internalLabelRaw = searchParams.get("internalLabel")?.trim();
    const response = await getFollowUpAudienceAnalysis({
      workspaceId,
      bypassWorkspaceStateCache,
      filters: {
        category: parseOptionalFilter(searchParams.get("category")),
        status: parseStatus(searchParams.get("status")),
        channel: parseOptionalFilter(searchParams.get("channel")),
        q: parseOptionalFilter(searchParams.get("q")),
        page: parsePositiveInt(searchParams.get("page"), 1, 1, 10_000),
        pageSize: parsePositiveInt(searchParams.get("pageSize"), 25, 1, 100),
        internalLabel:
          internalLabelRaw && internalLabelRaw.toLowerCase() !== "all"
            ? internalLabelRaw
            : null,
      },
    });

    return NextResponse.json(response);
  } catch {
    return NextResponse.json(
      { error: "Failed to load follow-up audience analysis" },
      { status: 500 }
    );
  }
}
