import { logger } from "@/lib/logger";
import {
  requireWorkspaceApiAccess,
  requireWorkspaceApiAccessWithRead,
} from "@/lib/supabase/workspace-api-access";
import {
  buildScenarioGraphPayloadValidationError,
  buildScenarioNameValidationError,
  mapScenarioOperationError,
} from "@/lib/scenarios/scenario-http";
import {
  findScenarioDetailDocument,
  readScenarioDetailMediaSigning,
  serializeOpenedScenarioDetail,
} from "@/lib/scenarios/scenario-detail";
import { saveScenario } from "@/lib/scenarios/scenario-save";
import { captureFunnelEvent } from "@/lib/funnel-analytics";
import { readScenarioActivationBlockedCode } from "@/lib/scenarios/scenario-funnel";
import {
  deleteScenario,
  prepareScenarioDeleteConfirmation,
} from "@/lib/scenarios/scenario-delete";
import { Types } from "mongoose";
import { NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";

export const runtime = "nodejs";
type Params = Promise<{ scenarioId: string }>;
function buildScenarioNotFoundResponse() {
  return NextResponse.json({ error: "Scenario not found" }, { status: 404 });
}
export async function GET(
  request: Request,
  { params }: { params: Params }
): Promise<Response> {
  try {
    const { scenarioId } = await params;
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");

    if (!workspaceId) return requiredFieldResponse("workspaceId");
    if (!Types.ObjectId.isValid(scenarioId)) {
      return buildScenarioNotFoundResponse();
    }

    // The read starts once the caller is signed in and overlaps the
    // membership check; nothing about the document is used unless it passes.
    const access = await requireWorkspaceApiAccessWithRead(workspaceId, () =>
      findScenarioDetailDocument({ workspaceId, scenarioId })
    );
    if (!access.ok) {
      return access.response;
    }

    const scenario = await access.read;
    return scenario
      ? NextResponse.json(
          await serializeOpenedScenarioDetail({
            workspaceId,
            scenario,
            mediaSigning: readScenarioDetailMediaSigning(
              searchParams.get("mediaSigning")
            ),
          })
        )
      : buildScenarioNotFoundResponse();
  } catch (error) {
    logger.error("scenario.load_failed", error);
    return NextResponse.json(
      { error: "Failed to load scenario" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Params }
): Promise<Response> {
  let body: Record<string, unknown> | null = null;
  let actor: { userId: string; workspaceId: string } | null = null;
  try {
    const { scenarioId } = await params;
    body = await request.json().catch(() => null);
    const workspaceId = body?.workspaceId as string | undefined;

    if (!workspaceId) return requiredFieldResponse("workspaceId");
    const nameValidationError = buildScenarioNameValidationError(body?.name);
    if (nameValidationError) return nameValidationError;
    const graphPayloadError = buildScenarioGraphPayloadValidationError(body);
    if (graphPayloadError) return graphPayloadError;
    if (!Types.ObjectId.isValid(scenarioId)) {
      return buildScenarioNotFoundResponse();
    }

    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) {
      return access.response;
    }
    const { userId } = access;
    actor = { userId, workspaceId };

    return NextResponse.json(
      await saveScenario({ workspaceId, scenarioId, userId }, body ?? {})
    );
  } catch (error) {
    const blockedCode = actor
      ? readScenarioActivationBlockedCode(error, body)
      : null;
    if (actor && blockedCode) {
      await captureFunnelEvent({
        event: "scenario_activation_blocked",
        userId: actor.userId,
        workspaceId: actor.workspaceId,
        properties: { code: blockedCode },
      });
    }
    const response = mapScenarioOperationError(error);
    if (response) return response;
    logger.error("scenario.update_failed", error);
    return NextResponse.json(
      { error: "Failed to update scenario" },
      { status: 500 }
    );
  }
}
export async function DELETE(
  request: Request,
  { params }: { params: Params }
): Promise<Response> {
  try {
    const { scenarioId } = await params;
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");

    if (!workspaceId) return requiredFieldResponse("workspaceId");
    if (!Types.ObjectId.isValid(scenarioId)) {
      return buildScenarioNotFoundResponse();
    }

    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) {
      return access.response;
    }
    const { supabase, userId } = access;

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const confirmation = prepareScenarioDeleteConfirmation(body);
    const result = await deleteScenario(
      { workspaceId, scenarioId, userId, supabase },
      confirmation
    );
    if (result.status === "cleanup_pending") {
      return NextResponse.json(
        {
          success: true,
          deleted: true,
          cleanupPending: true,
          retryable: true,
          code: "scenario_delete_cleanup_pending",
          pendingCleanup: result.pendingCleanup,
        },
        { status: 202 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    const response = mapScenarioOperationError(error);
    if (response) return response;
    logger.error("scenario.delete_failed", error);
    return NextResponse.json(
      { error: "Failed to delete scenario" },
      { status: 500 }
    );
  }
}
