import "server-only";

import { Scenario } from "@/models/scenario";

import type { WhatsAppQrAssignmentSummary } from "./dto";

type AssignmentProjection = {
  entryPointId: string;
  scenarioId?: string;
  nodeId?: string;
};

type ScenarioProjection = {
  _id: unknown;
  workspaceId: string;
  name: string;
  status: "draft" | "active";
  updatedAt: Date;
};

function isoDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("Persisted Scenario date is invalid");
  }
  return date.toISOString();
}

/** Loads assignment labels and revisions once for list and detail DTO owners. */
export async function loadWhatsAppQrAssignmentSummaries(params: {
  workspaceId: string;
  assignments: readonly AssignmentProjection[];
}): Promise<Map<string, WhatsAppQrAssignmentSummary>> {
  const scenarioIds = Array.from(
    new Set(
      params.assignments.flatMap(assignment =>
        assignment.scenarioId && assignment.nodeId
          ? [assignment.scenarioId]
          : []
      )
    )
  );
  if (scenarioIds.length === 0) return new Map();

  const scenarios = await Scenario.find({
    workspaceId: params.workspaceId,
    _id: { $in: scenarioIds },
    deletedAt: null,
  })
    .select({
      _id: 1,
      workspaceId: 1,
      name: 1,
      status: 1,
      updatedAt: 1,
    })
    .lean<ScenarioProjection[]>();
  const scenarioById = new Map(
    scenarios
      .filter(scenario => scenario.workspaceId === params.workspaceId)
      .map(scenario => [String(scenario._id), scenario])
  );
  const summaries = new Map<string, WhatsAppQrAssignmentSummary>();

  for (const assignment of params.assignments) {
    if (!assignment.scenarioId || !assignment.nodeId) continue;
    const scenario = scenarioById.get(assignment.scenarioId);
    if (!scenario) continue;
    summaries.set(assignment.entryPointId, {
      scenarioId: assignment.scenarioId,
      nodeId: assignment.nodeId,
      scenarioName: scenario.name,
      scenarioStatus: scenario.status,
      scenarioUpdatedAt: isoDate(scenario.updatedAt),
    });
  }

  return summaries;
}
