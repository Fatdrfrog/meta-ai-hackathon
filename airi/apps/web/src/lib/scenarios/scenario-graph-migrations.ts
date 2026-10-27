import { migrateLegacyTriggerNodeData } from "@/lib/scenarios/legacy-trigger-adapter";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";

export const CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION = 1;

export type MigratedScenarioGraph = {
  graphSchemaVersion: typeof CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION;
  nodes: unknown[];
  edges: unknown[];
};

export function migratePersistedScenarioGraph(
  raw: unknown,
): MigratedScenarioGraph {
  const graph = asNullableRecord(raw);
  const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph?.edges) ? graph.edges : [];

  return {
    graphSchemaVersion: CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION,
    nodes: rawNodes.map(node => {
      const nodeRecord = asNullableRecord(node);
      if (!nodeRecord) return node;

      const data = asNullableRecord(nodeRecord.data);
      if (!data) return { ...nodeRecord };

      return {
        ...nodeRecord,
        data:
          data.kind === "trigger"
            ? migrateLegacyTriggerNodeData(data)
            : { ...data },
      };
    }),
    edges: [...rawEdges],
  };
}
