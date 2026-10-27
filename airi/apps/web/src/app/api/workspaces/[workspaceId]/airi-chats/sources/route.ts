import { listAiriChatSourceOptions } from "@/lib/airi-chats/sources";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { NextRequest, NextResponse } from "next/server";
import { parsePositiveInt } from "@/lib/api/query-params";

export const runtime = "nodejs";

type Params = { params: Promise<{ workspaceId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { workspaceId } = await params;
    const auth = await getSupabaseRouteAuth(request);
    if (isSupabaseRouteAuthError(auth)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const hasAccess = await verifyWorkspaceAccess(
      auth.supabase,
      auth.user.id,
      workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const requestUrl = new URL(request.url);
    const sources = await listAiriChatSourceOptions({
      supabase: auth.supabase,
      workspaceId,
      userId: auth.user.id,
      query: requestUrl.searchParams.get("q"),
      limit: parsePositiveInt(requestUrl.searchParams.get("limit"), 50, 1, 100),
      mode:
        requestUrl.searchParams.get("mode") === "chats" ? "chats" : "sources",
    });

    return NextResponse.json({ sources });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load Airi sources";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
