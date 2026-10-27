import { getBirthdayProtectionSummary } from "@/lib/campaign/campaign-birthday-protection";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

export const runtime = "nodejs";

function parseDailyLimit(value: string | null): number | null {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    if (!workspaceId) return requiredFieldResponse("workspaceId");

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const summary = await getBirthdayProtectionSummary({
      workspaceId,
      dailyLimit: parseDailyLimit(searchParams.get("dailyLimit")),
    });

    return NextResponse.json(summary);
  } catch (error) {
    console.error("[Campaign birthday protection] Failed", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
