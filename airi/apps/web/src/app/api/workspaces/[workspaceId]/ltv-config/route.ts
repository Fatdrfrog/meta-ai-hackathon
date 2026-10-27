import { createClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { ltvConfigPayloadSchema } from "@/lib/ltv-config";
import { buildCacheKey, cache } from "@/lib/cache";
import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify workspace access
    const { data: companyUser, error: accessError } = await supabase
      .from("company_users")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (accessError) {
      return NextResponse.json(
        { error: "Could not verify workspace access" },
        { status: 500 }
      );
    }
    if (!companyUser) {
      return NextResponse.json(
        { error: "Workspace not found or unauthorized" },
        { status: 404 }
      );
    }

    if (!isWorkspaceManagerRole(companyUser.role)) {
      return NextResponse.json(
        { error: "Workspace manager access required" },
        { status: 403 }
      );
    }

    const parsed = ltvConfigPayloadSchema.safeParse(
      await req.json().catch(() => null)
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Enter a positive value and a 3-letter currency code" },
        { status: 400 }
      );
    }
    const { baseValue, currency } = parsed.data;

    // Update workspace LTV configuration
    const { data, error } = await supabase
      .from("workspaces")
      .update({
        ltv_base_value: baseValue,
        ltv_currency: currency,
      })
      .eq("id", workspaceId)
      .select()
      .single();

    if (error) {
      console.error("Error updating LTV config:", error);
      return NextResponse.json(
        { error: "Failed to update LTV configuration" },
        { status: 500 }
      );
    }

    await cache
      .del(buildCacheKey("health:ltv-config:v1", [workspaceId]))
      .catch(() => undefined);

    return NextResponse.json({
      success: true,
      workspace: {
        ltv_base_value: data.ltv_base_value,
        ltv_currency: data.ltv_currency,
      },
    });
  } catch (error) {
    console.error("LTV config update error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify workspace access
    const { data: companyUser, error: accessError } = await supabase
      .from("company_users")
      .select("workspace_id")
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (accessError) {
      return NextResponse.json(
        { error: "Could not verify workspace access" },
        { status: 500 }
      );
    }
    if (!companyUser) {
      return NextResponse.json(
        { error: "Workspace not found or unauthorized" },
        { status: 404 }
      );
    }

    // Fetch workspace LTV configuration
    const { data, error } = await supabase
      .from("workspaces")
      .select("ltv_base_value, ltv_currency")
      .eq("id", workspaceId)
      .single();

    if (error) {
      console.error("Error fetching LTV config:", error);
      return NextResponse.json(
        { error: "Failed to fetch LTV configuration" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      baseValue: data.ltv_base_value,
      currency: data.ltv_currency || "USD",
    });
  } catch (error) {
    console.error("LTV config fetch error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
