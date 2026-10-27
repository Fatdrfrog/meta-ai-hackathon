import { verifyCronAuth } from "@/lib/cron-auth";
import { processWhatsAppQrDetachPendingBatch } from "@/lib/whatsapp/qr-entry-points/cleanup-retry";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const denied = verifyCronAuth(request);
    if (denied) return denied;

    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get("limit") || "50");
    const result = await processWhatsAppQrDetachPendingBatch({ limit });
    const ok = result.failed === 0;

    return NextResponse.json({ ok, ...result }, { status: ok ? 200 : 500 });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
