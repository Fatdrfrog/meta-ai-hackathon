import { NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import connectDB from "@/lib/mongoose";
import { getAcquisitionReport } from "@/lib/analytics/acquisition-report";
import {
  canonicalAnalyticsTimeZone,
  normalizeDashboardCustomCalendarRange,
  resolveDashboardCalendarDays,
} from "@/lib/dashboard-comparison";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;
  const query = new URL(request.url).searchParams;
  const days = Number(query.get("days") || 30),
    observationDays = Number(query.get("observationDays") || 30);
  const sourceId = query.get("sourceId") || null;
  // One canonical IANA name per zone for the calendar and the pipeline.
  const timeZone = canonicalAnalyticsTimeZone(query.get("timeZone") || "UTC");
  if (!timeZone)
    return NextResponse.json(
      { error: "Invalid analytics time zone" },
      { status: 400 }
    );
  if (
    ![7, 30, 90].includes(days) ||
    ![7, 30].includes(observationDays) ||
    (sourceId && !/^[a-f0-9-]{36}$/i.test(sourceId))
  )
    return NextResponse.json(
      { error: "Invalid analytics interval or source" },
      { status: 400 }
    );
  let range: ReturnType<typeof normalizeDashboardCustomCalendarRange>;
  try {
    const hasCalendarDates = query.has("from") || query.has("to");
    const calendar = hasCalendarDates
      ? {
          from: query.get("from")?.trim() || "",
          to: query.get("to")?.trim() || "",
        }
      : resolveDashboardCalendarDays(days, timeZone);
    range = normalizeDashboardCustomCalendarRange(
      calendar.from,
      calendar.to,
      timeZone
    );
    const calendarDays =
      (Date.parse(`${calendar.to}T00:00:00Z`) -
        Date.parse(`${calendar.from}T00:00:00Z`)) /
        86400_000 +
      1;
    if (calendarDays > 90) throw new Error("analytics_interval_too_long");
  } catch {
    return NextResponse.json(
      { error: "Invalid analytics calendar range" },
      { status: 400 }
    );
  }
  try {
    await connectDB();
    const report = await getAcquisitionReport({
      workspaceId,
      start: range.start,
      end: range.endExclusive,
      observationDays: observationDays as 7 | 30,
      sourceId,
      timeZone,
    });
    return NextResponse.json(report, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Acquisition analytics unavailable" },
      { status: 503, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
