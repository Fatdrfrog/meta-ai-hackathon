import { verifyCronAuth } from "@/lib/cron-auth";
import connectDB from "@/lib/mongoose";
import { runScenarioEvalFlywheel } from "@/lib/scenarios/eval-flywheel";
import {
  runScenarioPromptOptimizer,
  SCENARIO_PROMPT_OPTIMIZER_MAX_AI_MS,
} from "@/lib/scenarios/prompt-optimizer";
import { ScenarioTriggerLog } from "@/models/scenario-trigger-log";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Work budget below maxDuration, leaving room to respond. */
const CRON_BUDGET_MS = 280_000;
/** Non-AI optimizer work (Mongo reads/writes) on top of its AI worst case. */
const OPTIMIZER_BUDGET_MARGIN_MS = 10_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Starts at a different workspace each week, so the ones the budget skips
 * this week run first in a later week instead of being starved every run.
 */
function rotateWeekly<T>(items: T[], nowMs: number): T[] {
  if (items.length < 2) return items;
  const offset = Math.floor(nowMs / WEEK_MS) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function normalizePositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

export async function GET(request: Request) {
  try {
    const denied = verifyCronAuth(request);
    if (denied) return denied;

    const deadlineAtMs = Date.now() + CRON_BUDGET_MS;
    await connectDB();

    const { searchParams } = new URL(request.url);
    const workspaceIdFilter = searchParams.get("workspaceId");
    const sampleTarget = normalizePositiveInt(
      process.env.SCENARIO_EVAL_WEEKLY_SAMPLE_TARGET,
      50,
      10,
      500
    );
    const lookbackDays = normalizePositiveInt(
      process.env.SCENARIO_EVAL_LOOKBACK_DAYS,
      14,
      1,
      90
    );
    const autoOptimize = normalizeBoolean(
      process.env.SCENARIO_EVAL_AUTO_OPTIMIZE,
      true
    );
    const autoPromote = normalizeBoolean(
      process.env.SCENARIO_EVAL_AUTO_PROMOTE,
      true
    );

    const workspaceIds = workspaceIdFilter
      ? [workspaceIdFilter]
      : await ScenarioTriggerLog.distinct("workspaceId", {
          evaluatedAt: {
            $gte: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000),
          },
        });

    let completed = 0;
    let failed = 0;
    let optimizerCompleted = 0;
    let optimizerFailed = 0;
    const optimizerSkippedWorkspaceIds: string[] = [];
    const errors: Array<{ workspaceId: string; error: string }> = [];
    const optimizerQueue: Array<{
      workspaceId: string;
      evalRunId: string;
      scenarioId: string;
    }> = [];

    // Flywheels first: they are Mongo-only and short, so a slow optimizer run
    // can never starve another workspace's flywheel.
    for (const workspaceId of workspaceIds) {
      if (typeof workspaceId !== "string" || !workspaceId.trim()) continue;
      try {
        const evalResult = await runScenarioEvalFlywheel({
          workspaceId: workspaceId.trim(),
          sampleTarget,
          triggerLogDaysLookback: lookbackDays,
          runByUserId: null,
        });
        if (autoOptimize && evalResult.dominantScenarioId) {
          optimizerQueue.push({
            workspaceId: workspaceId.trim(),
            evalRunId: evalResult.runId,
            scenarioId: evalResult.dominantScenarioId,
          });
        }
        completed += 1;
      } catch (error) {
        failed += 1;
        errors.push({
          workspaceId: workspaceId.trim(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Each optimizer run can take two reasoning-tier calls; start one only
    // when its worst case still fits, so the function is never killed with a
    // run left in "running".
    for (const item of rotateWeekly(optimizerQueue, Date.now())) {
      const remainingMs = deadlineAtMs - Date.now();
      if (
        remainingMs <
        SCENARIO_PROMPT_OPTIMIZER_MAX_AI_MS + OPTIMIZER_BUDGET_MARGIN_MS
      ) {
        optimizerSkippedWorkspaceIds.push(item.workspaceId);
        continue;
      }
      try {
        await runScenarioPromptOptimizer({
          workspaceId: item.workspaceId,
          evalRunId: item.evalRunId,
          scenarioId: item.scenarioId,
          autoPromote,
          runByUserId: null,
          triggeredBy: "cron",
        });
        optimizerCompleted += 1;
      } catch (error) {
        optimizerFailed += 1;
        errors.push({
          workspaceId: item.workspaceId,
          error: `optimizer: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    if (optimizerSkippedWorkspaceIds.length > 0) {
      console.warn(
        "[Cron] Scenario eval extractor skipped prompt optimizer runs for lack of time budget:",
        optimizerSkippedWorkspaceIds
      );
    }

    return NextResponse.json({
      ok: true,
      workspaces: workspaceIds.length,
      completed,
      failed,
      optimizerCompleted,
      optimizerFailed,
      optimizerSkipped: optimizerSkippedWorkspaceIds.length,
      errors: errors.slice(0, 20),
    });
  } catch (error) {
    console.error("[Cron] Scenario eval extractor failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
