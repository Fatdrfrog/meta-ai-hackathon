import { getAnalyticsPolicy } from "@/lib/analytics/analytics-policy";
import {
  CHAT_LEAKAGE_KINDS,
  getChatLeakageReport,
  type ChatLeakageFilters,
  type ChatLeakageKind,
} from "@/lib/analytics/chat-leakage";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseFilters(search: URLSearchParams): ChatLeakageFilters | null {
  const kind = search.get("kind");
  if (
    kind !== null &&
    !(CHAT_LEAKAGE_KINDS as readonly string[]).includes(kind)
  )
    return null;
  const qualified = search.get("qualifiedOnly");
  if (qualified !== null && qualified !== "0" && qualified !== "1") return null;
  const filters: ChatLeakageFilters = {
    ...(kind ? { kind: kind as ChatLeakageKind } : {}),
    qualifiedOnly: qualified === "1",
  };
  for (const key of ["sourceIds", "adIds", "ownerIds", "channels"] as const) {
    const values = search.getAll(key).map(value => value.trim());
    if (
      values.length > 20 ||
      values.some(value => !value || value.length > 128)
    )
      return null;
    if (values.length) filters[key] = [...new Set(values)];
  }
  return filters;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;
  const filters = parseFilters(new URL(request.url).searchParams);
  if (!filters)
    return NextResponse.json(
      { error: "Invalid chat leakage filters" },
      { status: 400 }
    );
  try {
    await connectDB();
    const policy = await getAnalyticsPolicy(workspaceId);
    const report = await getChatLeakageReport({
      workspaceId,
      supabase: access.supabase,
      qualifiedStageKeys: policy.qualifiedStageKeys,
      policyRevision: policy.revision,
      filters,
    });
    return NextResponse.json(report, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Chat leakage analytics unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
