import { getCrmBoard, resolveCrmOwnerFilter } from "@/lib/crm/board";
import { logger } from "@/lib/logger";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";

type Params = Promise<{ workspaceId: string }>;

const CRM_BOARD_FIRST_PAGE_LIMIT = 10;

function parseBoundedLimit(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 100);
}

function parseStageLimits(
  searchParams: URLSearchParams
): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const [key, value] of searchParams.entries()) {
    if (!key.startsWith("stageLimit.")) continue;
    const stageKey = key.slice("stageLimit.".length);
    if (!stageKey) continue;
    limits[stageKey] = parseBoundedLimit(value, CRM_BOARD_FIRST_PAGE_LIMIT);
  }
  return limits;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId } = await params;

  try {
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;
    const { supabase, userId } = access;

    const flags = await getWorkspaceFeatureFlags(workspaceId, [
      "customer_identity",
    ]);
    if (!flags.customer_identity) {
      return NextResponse.json({ error: "Feature disabled" }, { status: 404 });
    }

    const searchParams = new URL(request.url).searchParams;
    const board = await getCrmBoard({
      supabase,
      workspaceId,
      status: searchParams.get("status") || "active",
      search: searchParams.get("search") || "",
      limitPerStage: parseBoundedLimit(
        searchParams.get("limitPerStage"),
        CRM_BOARD_FIRST_PAGE_LIMIT
      ),
      stageLimits: parseStageLimits(searchParams),
      attention: searchParams.get("attention"),
      salesOnly: searchParams.get("salesOnly") === "1",
      hideSupportSpam: searchParams.get("support") !== "1",
      ownerUserId: resolveCrmOwnerFilter(searchParams.get("owner"), userId),
    });

    return NextResponse.json(board);
  } catch (error) {
    logger.error("[CRM Board API] GET failed", error, {
      event: "crm.board.get_failed",
      workspaceId,
    });
    return NextResponse.json(
      { error: "Failed to load CRM board" },
      { status: 500 }
    );
  }
}
