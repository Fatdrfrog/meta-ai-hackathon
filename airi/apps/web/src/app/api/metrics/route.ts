import {
  getPerformanceStats,
  getSlowOperations,
} from "@/lib/performance-monitor";
import { requireAppAdmin } from "@/lib/auth/app-admin";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const access = await requireAppAdmin();
  if (access.response) {
    return new Response(await access.response.text(), {
      status: access.response.status,
    });
  }

  try {
    const { searchParams } = new URL(request.url);
    const threshold = parseInt(searchParams.get("threshold") || "2000", 10);

    const stats = getPerformanceStats();
    const slowOperations = getSlowOperations(threshold);

    return NextResponse.json({
      performanceStats: stats,
      slowOperations: slowOperations.slice(-20),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "Failed to fetch metrics" + error }),
      { status: 500 }
    );
  }
}
