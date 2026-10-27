import {
  isScenarioBehaviorConfig,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";

export function validateBehaviorTriggers(
  nodes: { id: string; data: ScenarioNodeData }[],
  edges: { source?: string | null; target?: string | null }[]
): "behaviorConfigInvalid" | "behaviorTemplateRequired" | null {
  for (const trigger of nodes.filter(
    node =>
      node.data.kind === "trigger" &&
      node.data.triggerConfig?.entryPointType === "customer_behavior"
  )) {
    if (!isScenarioBehaviorConfig(trigger.data.triggerConfig?.behavior))
      return "behaviorConfigInvalid";
    const seen = new Set<string>();
    const queue = [trigger.id];
    let found = false;
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = nodes.find(item => item.id === id);
      if (node?.data.kind === "action") {
        if (
          node.data.actionType !== "whatsapp_template" ||
          !node.data.actionWhatsAppTemplateName?.trim() ||
          !node.data.actionWhatsAppTemplateLanguage?.trim()
        )
          return "behaviorTemplateRequired";
        found = true;
        continue;
      }
      if (node?.data.kind === "scenario_link" || node?.data.kind === "bulk")
        return "behaviorTemplateRequired";
      for (const edge of edges)
        if (edge.source === id && edge.target) queue.push(edge.target);
    }
    if (!found) return "behaviorTemplateRequired";
  }
  return null;
}
