import { verifyCronAuth } from "@/lib/cron-auth";
import { processCrossStoreOutboxBatch } from "@/lib/cross-store-outbox";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const denied = verifyCronAuth(request);
    if (denied) return denied;

    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get("limit") || "200");

    const result = await processCrossStoreOutboxBatch({
      deadlineAtMs: Date.now() + 50_000,
      limit,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
