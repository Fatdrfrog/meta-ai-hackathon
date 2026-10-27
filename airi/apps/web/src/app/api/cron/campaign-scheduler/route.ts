import { verifyCronAuth } from "@/lib/cron-auth";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const denied = verifyCronAuth(request);
    if (denied) return denied;

    return NextResponse.json({
      ok: true,
      retired: true,
      message:
        "Legacy campaign-scheduler is retired. Scheduled campaigns are driven by Temporal schedules.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
