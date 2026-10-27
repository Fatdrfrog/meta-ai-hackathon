import { requireBillingWorkspaceAdmin } from "@/lib/billing/access";
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

  return NextResponse.json(
    { error: "Payment methods are managed by Paddle." },
    { status: 409 }
  );
}
