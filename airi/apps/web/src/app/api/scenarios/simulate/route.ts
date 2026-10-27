import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { buildScenarioGraphPayloadValidationError } from "@/lib/scenarios/scenario-http";
import { normalizeScenarioGraphForPersistence } from "@/lib/scenarios/scenario-graph-persistence";
import { simulateScenarioStep } from "@/lib/scenarios/scenario-simulation-service";
import {
  scenarioSimulationEventSchema,
  scenarioSimulationStateSchema,
  type ScenarioSimulationGraph,
} from "@/lib/scenarios/scenario-simulation-types";

export const runtime = "nodejs";
const inputSchema = z.object({
  workspaceId: z.string().trim().min(1).max(100),
  draftScenario: z.object({
    nodes: z.array(z.unknown()).max(1000),
    edges: z.array(z.unknown()).max(4000),
  }),
  event: scenarioSimulationEventSchema,
  state: scenarioSimulationStateSchema.nullish(),
  context: z
    .object({
      classificationCategory: z.string().max(240).optional(),
      internalLabels: z.array(z.string().max(240)).max(100).optional(),
      funnelStage: z.string().max(240).optional(),
      hasPurchaseHistory: z.boolean().optional(),
    })
    .optional(),
});

export async function POST(request: Request) {
  const decoded = inputSchema.safeParse(await request.json().catch(() => null));
  if (!decoded.success)
    return NextResponse.json(
      { error: "Invalid scenario preview input" },
      { status: 400 }
    );
  const input = decoded.data;
  const access = await requireWorkspaceApiAccess(input.workspaceId);
  if (!access.ok) return access.response;
  const graphError = buildScenarioGraphPayloadValidationError(
    input.draftScenario
  );
  if (graphError) return graphError;
  if (input.event.kind !== "start" && !input.state)
    return NextResponse.json(
      { error: "Start the preview before sending a reply" },
      { status: 400 }
    );
  try {
    const graph = normalizeScenarioGraphForPersistence(
      input.draftScenario
    ) as ScenarioSimulationGraph;
    const result = await simulateScenarioStep({
      graph,
      state: input.state,
      event: input.event,
      context: input.context,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to try this scenario",
      },
      { status: 422 }
    );
  }
}
