import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Params = { params: Promise<{ workspaceId: string }> };

export async function GET(request: Request, { params }: Params) {
  const { workspaceId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const hasAccess = await verifyWorkspaceAccess(supabase, user.id, workspaceId);
  if (!hasAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const redirectUrl = new URL(panelWorkspaceAiriHref(workspaceId), request.url);
  redirectUrl.searchParams.set("source", "onboarding");

  return NextResponse.redirect(redirectUrl);
}
