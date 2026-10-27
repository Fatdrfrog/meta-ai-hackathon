import {
  DEFAULT_SCENARIO_VIEWPORT,
  isScenarioViewport,
  readScenarioGraphEnvelope,
  type ScenarioDocumentDTO,
} from "@icecore/scenario-contracts";
import { normalizeBulkFollowUpSettings } from "@/lib/scenarios/bulk-follow-up-settings";
import { normalizeScenarioGraphForPersistence } from "@/lib/scenarios/scenario-graph-persistence";
import { serializeScenarioCoreFieldsForDocument } from "@/lib/scenarios/scenario-summary-serialization";

export function serializeScenario(
  doc: Record<string, unknown>
): ScenarioDocumentDTO {
  if (
    !readScenarioGraphEnvelope({
      nodes: doc.nodes === undefined ? [] : doc.nodes,
      edges: doc.edges === undefined ? [] : doc.edges,
    })
  ) {
    throw new Error("Invalid persisted scenario graph");
  }
  const graph = normalizeScenarioGraphForPersistence(doc);

  return {
    ...serializeScenarioCoreFieldsForDocument(doc, graph.nodes),
    graphSchemaVersion: graph.graphSchemaVersion,
    nodes: graph.nodes,
    edges: graph.edges,
    viewport: isScenarioViewport(doc.viewport)
      ? doc.viewport
      : DEFAULT_SCENARIO_VIEWPORT,
    bulkFollowUpSettings: normalizeBulkFollowUpSettings(
      doc.bulkFollowUpSettings
    ),
  };
}
