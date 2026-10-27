import { getActiveWorkspaces } from "./workspaces";
import { verifyCronAuth } from "@/lib/cron-auth";
import {
  buildDailyKnowledgeCanonicalSyncExecutionId,
  tryStartKnowledgeCanonicalSyncWorkflow,
} from "@/lib/temporal/knowledge-canonical-sync-client";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE_SIZE = 200;

export async function GET(request: Request) {
  try {
    const denied = verifyCronAuth(request);
    if (denied) return denied;

    const { searchParams } = new URL(request.url);
    const singleWorkspaceId = (searchParams.get("workspaceId") || "").trim();
    const executionId = buildDailyKnowledgeCanonicalSyncExecutionId();

    if (!singleWorkspaceId) {
      let offset = 0;
      let started = 0;
      let failed = 0;
      const failures: Array<{ workspaceId: string; message: string }> = [];

      while (true) {
        const batch = await getActiveWorkspaces(PAGE_SIZE, offset);
        if (!batch.length) break;

        for (const row of batch) {
          const workspaceId = String(row.id || "").trim();
          if (!workspaceId) continue;

          const result = await tryStartKnowledgeCanonicalSyncWorkflow({
            workspaceId,
            executionId,
          });
          if (result.ok) {
            started += 1;
          } else if (result.reason === "temporal_not_configured") {
            return NextResponse.json({
              ok: true,
              skipped: true,
              reason: "temporal_not_configured",
              started: 0,
              failed: 0,
              workspacesProcessed: 0,
              executionId,
            });
          } else {
            failed += 1;
            if (failures.length < 25) {
              failures.push({
                workspaceId,
                message: result.message || "start_failed",
              });
            }
          }
        }

        offset += PAGE_SIZE;
        if (batch.length < PAGE_SIZE) break;
      }

      return NextResponse.json({
        ok: true,
        skipped: false,
        started,
        failed,
        failures,
        executionId,
      });
    }

    const result = await tryStartKnowledgeCanonicalSyncWorkflow({
      workspaceId: singleWorkspaceId,
      executionId,
    });

    if (result.ok) {
      return NextResponse.json({
        ok: true,
        skipped: false,
        started: 1,
        failed: 0,
        workflowId: result.workflowId,
        workspaceId: singleWorkspaceId,
        executionId,
      });
    }

    if (result.reason === "temporal_not_configured") {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: "temporal_not_configured",
        workspaceId: singleWorkspaceId,
        executionId,
      });
    }

    return NextResponse.json(
      {
        ok: false,
        workspaceId: singleWorkspaceId,
        error: result.message || "start_failed",
      },
      { status: 500 }
    );
  } catch (error) {
    console.error("[Cron] knowledge-canonical-sync failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
