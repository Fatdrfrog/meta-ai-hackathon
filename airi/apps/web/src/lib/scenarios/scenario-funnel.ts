import { captureFunnelEvent } from "@/lib/funnel-analytics";
import { ScenarioOperationError } from "@/lib/scenarios/scenario-operation-error";

export function describeScenarioGraphForFunnel(nodes: unknown): {
  has_bulk_root: boolean;
  node_count: number;
} {
  const list = Array.isArray(nodes) ? nodes : [];
  return {
    has_bulk_root: list.some(
      node =>
        Boolean(node) &&
        typeof node === "object" &&
        (node as { type?: unknown }).type === "bulkNode"
    ),
    node_count: list.length,
  };
}

/**
 * Activation refusals that a person can act on. Revision conflicts and
 * missing scenarios are editor races, not funnel blockers.
 */
export function readScenarioActivationBlockedCode(
  error: unknown,
  body: unknown
): string | null {
  if (!(error instanceof ScenarioOperationError)) return null;
  const status =
    body && typeof body === "object"
      ? (body as { status?: unknown }).status
      : undefined;
  if (status !== "active") return null;

  const failure = error.failure;
  switch (failure.kind) {
    case "graph_invalid":
      return failure.code;
    case "subscenario_links_invalid":
    case "linked_conditions_invalid":
    case "qr_activation_conflict":
    case "birthday_conflict":
    case "conversation_capacity":
    case "scenario_capacity":
      return failure.kind;
    default:
      return null;
  }
}

export async function captureScenarioActivated(params: {
  userId: string;
  workspaceId: string;
  scenarioId: string;
  nodes: unknown;
}): Promise<void> {
  await captureFunnelEvent({
    event: "scenario_activated",
    userId: params.userId,
    workspaceId: params.workspaceId,
    properties: {
      scenario_id: params.scenarioId,
      ...describeScenarioGraphForFunnel(params.nodes),
    },
  });
}
