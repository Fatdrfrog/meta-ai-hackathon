import { nextRevisionDate } from "@/lib/scenarios/scenario-revision";
import {
  normalizeScenarioStatus,
  type ScenarioStatus,
} from "@icecore/scenario-contracts";

import { normalizeScenarioGraphForPersistence } from "@/lib/scenarios/scenario-graph-persistence";
import { assertNoNewLegacyActionRoutingAssignments } from "@/lib/scenarios/legacy-action-routing";
import { Scenario } from "@/models/scenario";

const MAX_SCENARIO_GRAPH_MUTATION_ATTEMPTS = 2;

type ScenarioGraphSnapshotRecord = {
  _id?: unknown;
  graphSchemaVersion?: unknown;
  nodes?: unknown;
  edges?: unknown;
  status?: unknown;
  updatedAt?: unknown;
};

export type ScenarioGraphMutationSnapshot = {
  nodes: unknown[];
  edges: unknown[];
  status: ScenarioStatus;
};

export type ScenarioGraphMutationProjection<T> =
  | {
      changed: false;
      value: T;
    }
  | {
      changed: true;
      nodes: unknown[];
      edges?: unknown[];
      value: T;
    };

export type ScenarioGraphMutationResult<T> =
  | {
      status: "updated" | "unchanged";
      value: T;
      previousScenarioUpdatedAt: string;
      scenarioUpdatedAt: string;
    }
  | {
      status: "not_found";
      previousScenarioUpdatedAt: null;
      scenarioUpdatedAt: null;
    }
  | {
      status: "conflict";
      previousScenarioUpdatedAt: string | null;
      scenarioUpdatedAt: string | null;
    };

function asRevisionDate(value: unknown): Date | null {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === "string"
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

export async function mutateScenarioGraphWithCas<T>(params: {
  workspaceId: string;
  scenarioId: string;
  expectedUpdatedAt?: string | Date | null;
  updatedBy?: string | null;
  project: (
    snapshot: ScenarioGraphMutationSnapshot
  ) => ScenarioGraphMutationProjection<T>;
}): Promise<ScenarioGraphMutationResult<T>> {
  let previousScenarioUpdatedAt: string | null = null;

  for (
    let attempt = 0;
    attempt < MAX_SCENARIO_GRAPH_MUTATION_ATTEMPTS;
    attempt += 1
  ) {
    const scenario = await Scenario.findOne({
      _id: params.scenarioId,
      workspaceId: params.workspaceId,
      deletedAt: null,
    })
      .select("graphSchemaVersion nodes edges status updatedAt")
      .lean<ScenarioGraphSnapshotRecord | null>();
    if (!scenario) {
      return {
        status: "not_found",
        previousScenarioUpdatedAt: null,
        scenarioUpdatedAt: null,
      };
    }

    const revision = asRevisionDate(scenario.updatedAt);
    if (!revision) {
      return {
        status: "conflict",
        previousScenarioUpdatedAt: null,
        scenarioUpdatedAt: null,
      };
    }
    const revisionIso = revision.toISOString();
    previousScenarioUpdatedAt = revisionIso;
    if (params.expectedUpdatedAt !== undefined) {
      const expectedRevision = asRevisionDate(params.expectedUpdatedAt);
      if (
        !expectedRevision ||
        expectedRevision.getTime() !== revision.getTime()
      ) {
        return {
          status: "conflict",
          previousScenarioUpdatedAt: revisionIso,
          scenarioUpdatedAt: revisionIso,
        };
      }
    }
    const snapshot: ScenarioGraphMutationSnapshot = {
      nodes: Array.isArray(scenario.nodes) ? scenario.nodes : [],
      edges: Array.isArray(scenario.edges) ? scenario.edges : [],
      status: normalizeScenarioStatus(scenario.status),
    };
    const projection = params.project(snapshot);
    if (!projection.changed) {
      return {
        status: "unchanged",
        value: projection.value,
        previousScenarioUpdatedAt: revisionIso,
        scenarioUpdatedAt: revisionIso,
      };
    }

    const graph = normalizeScenarioGraphForPersistence({
      graphSchemaVersion: scenario.graphSchemaVersion,
      nodes: projection.nodes,
      edges: projection.edges ?? snapshot.edges,
    });
    assertNoNewLegacyActionRoutingAssignments({
      previousNodes: snapshot.nodes,
      previousEdges: snapshot.edges,
      nextNodes: graph.nodes,
      nextEdges: graph.edges,
    });
    const nextUpdatedAt = nextRevisionDate(revision);
    const updateResult = await Scenario.updateOne(
      {
        _id: params.scenarioId,
        workspaceId: params.workspaceId,
        deletedAt: null,
        status: snapshot.status,
        updatedAt: revision,
      },
      {
        $set: {
          graphSchemaVersion: graph.graphSchemaVersion,
          nodes: graph.nodes,
          edges: graph.edges,
          ...(params.updatedBy !== undefined
            ? { updatedBy: params.updatedBy }
            : {}),
          updatedAt: nextUpdatedAt,
        },
      },
      // This timestamp is the CAS revision returned to the caller.
      { timestamps: false }
    );
    if (updateResult.matchedCount === 1) {
      return {
        status: "updated",
        value: projection.value,
        previousScenarioUpdatedAt: revisionIso,
        scenarioUpdatedAt: nextUpdatedAt.toISOString(),
      };
    }
  }

  return {
    status: "conflict",
    previousScenarioUpdatedAt,
    scenarioUpdatedAt: previousScenarioUpdatedAt,
  };
}
