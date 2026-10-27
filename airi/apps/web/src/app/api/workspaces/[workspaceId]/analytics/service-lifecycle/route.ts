import { getServiceLifecycleReport } from "@/lib/analytics/service-lifecycle-report";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { NextResponse } from "next/server";
import { z } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const sourceIdSchema = z.string().uuid();
export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;
  const search = new URL(request.url).searchParams;
  const sourceValue = search.get("sourceId");
  if (
    search.getAll("sourceId").length > 1 ||
    (sourceValue !== null && !sourceIdSchema.safeParse(sourceValue).success)
  )
    return NextResponse.json(
      { error: "Invalid sourceId" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  const sourceId = sourceValue?.toLowerCase();
  const endValue = search.get("end"),
    startValue = search.get("start");
  const end = endValue === null ? new Date() : new Date(endValue);
  const start =
    startValue !== null
      ? new Date(startValue)
      : new Date(end.getTime() - 30 * 86400000);
  const duration = end.getTime() - start.getTime();
  if (!Number.isFinite(duration) || duration <= 0 || duration > 90 * 86400000)
    return NextResponse.json(
      { error: "Provide a positive window of at most 90 days" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  try {
    return NextResponse.json(
      await getServiceLifecycleReport(workspaceId, start, end, sourceId),
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      { error: "Service lifecycle analytics unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
