import { processTimerReplanIngressQueue } from "@/lib/airi/scenario/timer-recovery/ingress";
import { processAiriConversationIngressQueue } from "@/lib/temporal/airi-conversation-ingress";
import { verifyCronAuth } from "@/lib/cron-auth";
import { ensureIndexes } from "@/lib/mongo";
import { createLogger } from "@icecore/shared/lib/logger";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const ingressLog = createLogger("cron-airi-ingress");

export async function GET(request: Request) {
  const denied = verifyCronAuth(request);
  if (denied) return denied;

  try {
    await ensureIndexes();
    const [conversations, timerReplans] = await Promise.allSettled([
      processAiriConversationIngressQueue({ limit: 25 }),
      processTimerReplanIngressQueue({ limit: 25 }),
    ]);
    if (conversations.status === "rejected") throw conversations.reason;
    if (timerReplans.status === "rejected") throw timerReplans.reason;
    const summary = {
      conversations: conversations.value,
      timerReplans: timerReplans.value,
    };
    ingressLog.info("airi_ingress_recovery_completed", summary);
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    ingressLog.error("airi_ingress_retry_failed", error);
    return NextResponse.json(
      { error: "Failed to process Airi ingress" },
      { status: 500 }
    );
  }
}
