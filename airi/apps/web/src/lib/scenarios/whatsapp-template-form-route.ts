import {
  isWhatsAppTemplateFormSubmittedSourceHandleId,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
import type {
  CompiledScenarioGraph,
  ScenarioRuntimeEdge,
} from "@icecore/airi-runtime/scenario-graph";
// The registry owns the rule: it imports nothing from here, so the builder
// can read it without an import cycle.
import { whatsappTemplateOffersFormSubmittedRoute } from "@/lib/scenarios/transition-registry";

export { whatsappTemplateOffersFormSubmittedRoute };

/** Whether the step offers a "Form submitted" route and it is connected. */
export function whatsappTemplateHasFormSubmittedRoute(params: {
  nodeId: string;
  data: ScenarioNodeData;
  edges: readonly ScenarioRuntimeEdge[];
}): boolean {
  return (
    whatsappTemplateOffersFormSubmittedRoute(params.data) &&
    params.edges.some(
      edge =>
        edge.source === params.nodeId &&
        Boolean(edge.target) &&
        isWhatsAppTemplateFormSubmittedSourceHandleId(edge.sourceHandle)
    )
  );
}

const formSubmittedRouteNodeIdsByGraph = new WeakMap<
  CompiledScenarioGraph,
  ReadonlySet<string>
>();

/** The graph's steps with a connected "Form submitted" route, read once. */
export function readFormSubmittedRouteNodeIds(
  graph: CompiledScenarioGraph
): ReadonlySet<string> {
  let nodeIds = formSubmittedRouteNodeIdsByGraph.get(graph);
  if (!nodeIds) {
    // A route whose step was deleted leads nowhere.
    const edges = graph.edges.filter(
      edge => edge.target && graph.nodesById.has(edge.target)
    );
    nodeIds = new Set(
      graph.nodes.flatMap(node =>
        whatsappTemplateHasFormSubmittedRoute({
          nodeId: node.id,
          data: node.data,
          edges,
        })
          ? [node.id]
          : []
      )
    );
    formSubmittedRouteNodeIdsByGraph.set(graph, nodeIds);
  }
  return nodeIds;
}
