import { requireBillingWorkspaceAdmin } from "@/lib/billing/access";
import { getPaddleBillingUnavailableMessage } from "@/lib/billing/config";
import {
  createPaddleCheckoutSession,
  type BillingCycle,
} from "@/lib/billing/service";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

async function readBillingCycle(request: Request): Promise<
  | {
      ok: true;
      billingCycle: BillingCycle;
    }
  | {
      ok: false;
      response: NextResponse;
    }
> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { ok: true, billingCycle: "monthly" };
  }

  const body = (await request.json().catch(() => null)) as {
    billingCycle?: unknown;
  } | null;
  const billingCycle = body?.billingCycle ?? "monthly";

  if (billingCycle !== "monthly" && billingCycle !== "annual") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "billingCycle must be monthly or annual" },
        { status: 400 }
      ),
    };
  }

  return { ok: true, billingCycle };
}

export async function POST(request: Request, context: RouteContext) {
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

  const cycleResult = await readBillingCycle(request);
  if (!cycleResult.ok) {
    return cycleResult.response;
  }

  try {
    const result = await createPaddleCheckoutSession({
      workspaceId,
      companyId: access.companyId,
      userId: access.user.id,
      billingCycle: cycleResult.billingCycle,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    logger.error("billing.checkout_failed", error, {
      event: "billing.checkout_failed",
      workspaceId,
      companyId: access.companyId,
    });
    return NextResponse.json(
      { error: "Failed to create billing checkout" },
      { status: 500 }
    );
  }
}
