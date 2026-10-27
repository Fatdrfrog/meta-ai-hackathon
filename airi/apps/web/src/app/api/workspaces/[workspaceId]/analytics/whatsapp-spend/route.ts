import { parseWhatsAppSpendQuery } from "@/lib/analytics/whatsapp-analytics-contract";
import { queryWhatsAppSpend } from "@/lib/analytics/whatsapp-spend";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import {
  checkRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";
import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SPEND_REQUESTS_PER_MINUTE = 20;
// Each distinct period can miss the cache and reach Meta under the WABA lock,
// so one member cannot cycle periods into the shared provider cooldown.
const spendLimiter = createRateLimiter({
  requests: SPEND_REQUESTS_PER_MINUTE,
  window: "1 m",
  prefix: "analytics:whatsapp-spend",
});

/** Account-level WhatsApp spend reported by Meta, for any workspace member. */
export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;
  // Bounded periods keep each member from forcing uncached Meta reads.
  const window = parseWhatsAppSpendQuery(new URL(request.url).searchParams);
  if (!window)
    return NextResponse.json(
      {
        error:
          "Use days of 7, 30 or 90, or from/to UTC dates at most 90 days apart within the last 365 days",
      },
      { status: 400 }
    );
  const rateLimit = await checkRateLimit(
    spendLimiter,
    `${workspaceId}:${access.userId}`,
    SPEND_REQUESTS_PER_MINUTE
  );
  if (!rateLimit.success)
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Cache-Control": "no-store" } }
    );
  try {
    return NextResponse.json(
      await queryWhatsAppSpend({ workspaceId, ...window }),
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      { error: "WhatsApp spend unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
