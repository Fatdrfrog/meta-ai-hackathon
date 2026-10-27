import { queryWhatsAppAnalytics } from "@/lib/analytics/whatsapp-analytics-service";
import { canonicalAnalyticsTimeZone } from "@/lib/dashboard-comparison";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;
  const search = new URL(request.url).searchParams;
  const raw = search.get("days");
  const days = raw === null ? 30 : Number(raw);
  // Only the intervals the Outcomes picker offers, so cache keys stay bounded.
  if (![7, 30, 90].includes(days))
    return NextResponse.json(
      { error: "days must be 7, 30 or 90" },
      { status: 400 }
    );
  // One canonical IANA name per zone for the calendar, cache key and pipeline.
  const timeZone = canonicalAnalyticsTimeZone(search.get("timeZone") || "UTC");
  if (!timeZone)
    return NextResponse.json(
      { error: "Invalid analytics time zone" },
      { status: 400 }
    );
  const sourceId = search.get("sourceId")?.trim() || undefined;
  if (sourceId && sourceId.length > 128)
    return NextResponse.json({ error: "Invalid sourceId" }, { status: 400 });
  try {
    return NextResponse.json(
      await queryWhatsAppAnalytics({
        workspaceId,
        days,
        sourceId,
        refresh: search.get("refresh") === "1",
        timeZone,
        signal: request.signal,
      }),
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      { error: "WhatsApp analytics unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
