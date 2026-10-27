import { getBillingSummary } from "@/lib/billing/service";
import { requireBillingWorkspaceAccess } from "@/lib/billing/access";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireBillingWorkspaceAccess(workspaceId);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error },
      { status: access.status }
    );
  }

  try {
    return NextResponse.json(
      await getBillingSummary(access.supabase, access.companyId)
    );
  } catch (error) {
    logger.error("billing.summary_failed", error, {
      event: "billing.summary_failed",
      workspaceId,
      companyId: access.companyId,
    });
    return NextResponse.json(
      { error: "Failed to load billing summary" },
      { status: 500 }
    );
  }
}
