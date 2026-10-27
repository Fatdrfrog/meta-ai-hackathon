import { normalizeScenarioMode } from "@icecore/scenario-contracts";
import { logger } from "@/lib/logger";
import { parsePositiveInt } from "@/lib/api/query-params";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import {
  buildScenarioGraphPayloadValidationError,
  buildScenarioNameValidationError,
  mapScenarioOperationError,
} from "@/lib/scenarios/scenario-http";
import {
  listWorkspaceScenarioSummaries,
  SCENARIO_LIST_DEFAULT_LIMIT,
  SCENARIO_LIST_MAX_LIMIT,
} from "@/lib/scenarios/list-workspace-scenario-summaries";
import {
  createScenario,
  prepareScenarioCreate,
} from "@/lib/scenarios/scenario-create";
import { DEMO_SCENARIO_PRESET_ID } from "@/lib/scenarios/scenario-presets";
import { captureFunnelEvent } from "@/lib/funnel-analytics";
import { describeScenarioGraphForFunnel } from "@/lib/scenarios/scenario-funnel";
import { NextResponse } from "next/server";
import { requiredFieldResponse } from "@/lib/api/json-body";

export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const modeParam = searchParams.get("mode");
    const limit = parsePositiveInt(
      searchParams.get("limit"),
      SCENARIO_LIST_DEFAULT_LIMIT,
      1,
      SCENARIO_LIST_MAX_LIMIT
    );
    const mode =
      modeParam === "all"
        ? "all"
        : normalizeScenarioMode(modeParam || undefined);

    if (!workspaceId) return requiredFieldResponse("workspaceId");
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) {
      return access.response;
    }

    const { items, nextCursor, hasMore } = await listWorkspaceScenarioSummaries(
      {
        workspaceId,
        mode,
        limit,
        cursor: searchParams.get("cursor"),
      }
    );

    return NextResponse.json({
      items,
      nextCursor,
      hasMore,
    });
  } catch (error) {
    logger.error("scenarios.list_failed", error);
    return NextResponse.json(
      { error: "Failed to load scenarios" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => null);
    const graphPayloadError = buildScenarioGraphPayloadValidationError(body);
    if (graphPayloadError) return graphPayloadError;
    const workspaceId = body?.workspaceId as string | undefined;
    const command = prepareScenarioCreate(body);
    if (!workspaceId) return requiredFieldResponse("workspaceId");
    const nameValidationError = buildScenarioNameValidationError(command.name);
    if (nameValidationError) return nameValidationError;

    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) {
      return access.response;
    }
    const { userId } = access;

    const created = await createScenario({ workspaceId, userId }, command);
    await captureFunnelEvent({
      event: "scenario_created",
      userId,
      workspaceId,
      properties: {
        origin:
          command.presetId === DEMO_SCENARIO_PRESET_ID
            ? "demo"
            : command.presetId
              ? "preset"
              : "builder",
        status: command.status,
        ...describeScenarioGraphForFunnel(command.nodes),
      },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    const response = mapScenarioOperationError(error);
    if (response) return response;
    logger.error("scenario.create_failed", error);
    return NextResponse.json(
      { error: "Failed to create scenario" },
      { status: 500 }
    );
  }
}
