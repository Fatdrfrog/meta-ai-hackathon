import { requireBillingWorkspaceAdmin } from "@/lib/billing/access";
import { getPaddleBillingUnavailableMessage } from "@/lib/billing/config";
import { reactivatePaddleSubscription } from "@/lib/billing/service";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireBillingWorkspaceAdmin(workspaceId);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error },
      { status: access.status }
    );
  }

  const unavailableMessage = getPaddleBillingUnavailableMessage();
  if (unavailableMessage) {
    return NextResponse.json({ error: unavailableMessage }, { status: 503 });
  }

  try {
    return NextResponse.json({
      subscription: await reactivatePaddleSubscription(access.companyId),
    });
  } catch (error) {
    logger.error("billing.reactivate_failed", error, {
      event: "billing.reactivate_failed",
      workspaceId,
      companyId: access.companyId,
    });
    return NextResponse.json(
      { error: "Failed to reactivate subscription" },
      { status: 500 }
    );
  }
}
