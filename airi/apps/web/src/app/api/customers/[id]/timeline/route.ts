import { buildCustomerTimeline } from "@/lib/customers/service";
import connectDB from "@/lib/mongoose";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import Customer from "@/models/customer";
import { NextRequest, NextResponse } from "next/server";

type Params = Promise<{ id: string }>;

export async function GET(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await connectDB();

    const customer = await Customer.findById(id)
      .select("workspaceId")
      .lean<{ workspaceId?: string } | null>();
    if (!customer?.workspaceId) {
      return NextResponse.json(
        { error: "Customer not found" },
        { status: 404 }
      );
    }

    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      customer.workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const flags = await getWorkspaceFeatureFlags(customer.workspaceId, [
      "customer_identity",
      "customer_timeline",
    ]);
    if (!flags.customer_identity || !flags.customer_timeline) {
      return NextResponse.json({ error: "Feature disabled" }, { status: 404 });
    }

    const parsedLimit = parseInt(
      request.nextUrl.searchParams.get("limit") || "120",
      10
    );
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 250)
        : 120;

    const timeline = await buildCustomerTimeline({
      customerId: id,
      limit,
    });

    return NextResponse.json({ timeline });
  } catch (error) {
    console.error("[Customers Timeline API] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load customer timeline" },
      { status: 500 }
    );
  }
}
