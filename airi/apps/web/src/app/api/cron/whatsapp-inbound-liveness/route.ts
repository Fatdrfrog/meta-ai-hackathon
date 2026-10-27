import { verifyCronAuth } from "@/lib/cron-auth";
import { createServerLogger } from "@/lib/observability/server-logs";
import { runWhatsAppInboundLivenessCheck } from "@/lib/whatsapp/inbound-liveness-monitor";
import { buildCacheKey, cache } from "@icecore/shared/lib/cache";
import { readEnvFlag } from "@icecore/shared/lib/env";
import { NextResponse } from "next/server";

const logger = createServerLogger("whatsapp.inbound-liveness");
const LOCK_TTL_SECONDS = 10 * 60;

/**
 * Hourly check that active WhatsApp numbers still receive messages.
 * Meta can stop delivering a number's webhooks while the token, the webhook
 * subscription and Meta's own health checks all stay green.
 */
export async function GET(request: Request) {
  const denied = verifyCronAuth(request);
  if (denied) return denied;

  if (!readEnvFlag("WHATSAPP_INBOUND_LIVENESS_ENABLED", false)) {
    return NextResponse.json({ status: "skipped", reason: "disabled" });
  }

  const lockKey = buildCacheKey("whatsapp:inbound-liveness:v1", ["global"]);
  const lockToken = crypto.randomUUID();
  const lock = await cache.acquireLock(lockKey, lockToken, LOCK_TTL_SECONDS);
  if (lock === "unavailable") {
    return NextResponse.json(
      { status: "error", reason: "coordination_unavailable" },
      { status: 503 }
    );
  }
  if (lock === "contended") {
    return NextResponse.json({ status: "skipped", reason: "already_running" });
  }

  try {
    const summary = await runWhatsAppInboundLivenessCheck();
    return NextResponse.json({ status: "ok", ...summary });
  } catch (error) {
    logger.error("whatsapp_inbound_liveness_failed", error);
    return NextResponse.json(
      { status: "error", reason: "check_failed" },
      { status: 500 }
    );
  } finally {
    await cache.compareAndDelete(lockKey, lockToken);
  }
}
