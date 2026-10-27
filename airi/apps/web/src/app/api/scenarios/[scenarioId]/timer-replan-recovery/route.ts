import { retryTimerReplanIngressForScenario } from "@/lib/airi/scenario/timer-recovery/ingress";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { createLogger } from "@icecore/shared/lib/logger";
import { Types } from "mongoose";
import { NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";

export const runtime = "nodejs";

type Params = Promise<{ scenarioId: string }>;

const timerReplanRecoveryLog = createLogger("scenario-timer-replan-recovery");

export async function POST(request: Request, { params }: { params: Params }) {
  const { scenarioId } = await params;
  const body = await request.json().catch(() => null);
  const workspaceId =
    typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  if (!workspaceId) return requiredFieldResponse("workspaceId");
  if (!Types.ObjectId.isValid(scenarioId)) {
    return NextResponse.json({ error: "Scenario not found" }, { status: 404 });
  }

  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  try {
    const result = await retryTimerReplanIngressForScenario({
      workspaceId,
      scenarioId,
      limit: 25,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    timerReplanRecoveryLog.error("timer_replan_recovery_retry_failed", error);
    return NextResponse.json(
      { error: "Failed to retry timer recovery" },
      { status: 500 }
    );
  }
}
