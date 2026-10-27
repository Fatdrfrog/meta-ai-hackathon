import {
  normalizeWhatsAppQrEntryPointId,
  type ScenarioGraphNode,
  type ScenarioTriggerConfig,
} from "@icecore/scenario-contracts";

import { resolveScenarioTrigger } from "@/lib/scenarios/trigger-utils";

export type WhatsAppQrGraphBinding = {
  nodeId: string;
  entryPointId: string | null;
};

export type WhatsAppQrBindingWriteResult =
  | { ok: true; removedNodeIds: string[] }
  | {
      ok: false;
      code: "whatsapp_qr_binding_conflict";
      nodeId: string;
      change: "added" | "changed" | "cleared" | "duplicate";
    };

function isWhatsAppQrTrigger(node: ScenarioGraphNode): boolean {
  return (
    node.data.kind === "trigger" &&
    resolveScenarioTrigger(node.data).entryPointType === "whatsapp_qr"
  );
}

export function collectWhatsAppQrGraphBindings(
  nodes: readonly ScenarioGraphNode[]
): WhatsAppQrGraphBinding[] {
  return nodes.flatMap(node => {
    if (!isWhatsAppQrTrigger(node)) return [];
    return [
      {
        nodeId: node.id,
        entryPointId: resolveScenarioTrigger(node.data).entryPointId ?? null,
      },
    ];
  });
}

export function hasWhatsAppQrGraphBinding(
  nodes: readonly ScenarioGraphNode[]
): boolean {
  return collectWhatsAppQrGraphBindings(nodes).length > 0;
}

function requireWhatsAppQrNode<TNode extends ScenarioGraphNode>(
  nodes: readonly TNode[],
  nodeId: string
): TNode {
  const node = nodes.find(candidate => candidate.id === nodeId);
  if (!node) throw new Error("WhatsApp QR trigger node not found");
  if (!isWhatsAppQrTrigger(node)) {
    throw new Error("Node is not a WhatsApp QR trigger");
  }
  return node;
}

function replaceTriggerConfig<TNode extends ScenarioGraphNode>(
  nodes: readonly TNode[],
  target: TNode,
  triggerConfig: ScenarioTriggerConfig
): TNode[] {
  return nodes.map(node => {
    if (node !== target) return node;
    return {
      ...node,
      data: {
        ...node.data,
        triggerConfig,
      },
    } as TNode;
  });
}

export function setWhatsAppQrGraphBinding<TNode extends ScenarioGraphNode>(
  nodes: readonly TNode[],
  nodeId: string,
  entryPointId: string
): TNode[] {
  const target = requireWhatsAppQrNode(nodes, nodeId);
  const normalizedEntryPointId = normalizeWhatsAppQrEntryPointId(entryPointId);
  if (!normalizedEntryPointId) throw new Error("Entry point id is invalid");
  if (
    collectWhatsAppQrGraphBindings(nodes).some(
      binding =>
        binding.nodeId !== nodeId &&
        binding.entryPointId === normalizedEntryPointId
    )
  ) {
    throw new Error("Entry point is already bound in this Scenario");
  }
  return replaceTriggerConfig(nodes, target, {
    ...resolveScenarioTrigger(target.data),
    entryPointType: "whatsapp_qr",
    entryPointId: normalizedEntryPointId,
  });
}

export function clearWhatsAppQrGraphBinding<TNode extends ScenarioGraphNode>(
  nodes: readonly TNode[],
  nodeId: string
): TNode[] {
  const target = requireWhatsAppQrNode(nodes, nodeId);
  const normalized = resolveScenarioTrigger(target.data);
  const triggerConfig: ScenarioTriggerConfig = { ...normalized };
  delete triggerConfig.entryPointId;
  return replaceTriggerConfig(nodes, target, triggerConfig);
}

export function assertOrdinaryScenarioWritePreservesWhatsAppQrBindings(params: {
  previousNodes: readonly ScenarioGraphNode[];
  nextNodes: readonly ScenarioGraphNode[];
}): WhatsAppQrBindingWriteResult {
  const previous = collectWhatsAppQrGraphBindings(params.previousNodes);
  const next = collectWhatsAppQrGraphBindings(params.nextNodes);
  const seenEntryPointIds = new Set<string>();

  for (const binding of next) {
    if (!binding.entryPointId) continue;
    if (seenEntryPointIds.has(binding.entryPointId)) {
      return {
        ok: false,
        code: "whatsapp_qr_binding_conflict",
        nodeId: binding.nodeId,
        change: "duplicate",
      };
    }
    seenEntryPointIds.add(binding.entryPointId);
  }

  const nextByNodeId = new Map(next.map(binding => [binding.nodeId, binding]));
  const removedNodeIds: string[] = [];
  for (const previousBinding of previous) {
    const nextBinding = nextByNodeId.get(previousBinding.nodeId);
    if (!nextBinding) {
      removedNodeIds.push(previousBinding.nodeId);
      continue;
    }
    if (previousBinding.entryPointId === nextBinding.entryPointId) continue;
    return {
      ok: false,
      code: "whatsapp_qr_binding_conflict",
      nodeId: previousBinding.nodeId,
      change:
        previousBinding.entryPointId === null
          ? "added"
          : nextBinding.entryPointId === null
            ? "cleared"
            : "changed",
    };
  }

  const previousNodeIds = new Set(previous.map(binding => binding.nodeId));
  for (const nextBinding of next) {
    if (previousNodeIds.has(nextBinding.nodeId)) continue;
    if (nextBinding.entryPointId !== null) {
      return {
        ok: false,
        code: "whatsapp_qr_binding_conflict",
        nodeId: nextBinding.nodeId,
        change: "added",
      };
    }
  }

  return { ok: true, removedNodeIds };
}
