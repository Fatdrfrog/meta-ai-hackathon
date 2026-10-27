import { sha256Hex } from "@icecore/shared/lib/sha256";

import {
  normalizeWhatsAppFlowProviderReference,
  resolveWhatsAppFlowProviderSource,
  type ManagedWhatsAppFlowProvisioningProjection,
  type ScenarioGraphNode,
  type ScenarioNodeData,
  type WhatsAppFlowConfig,
  type WhatsAppFlowProviderReference,
} from "@icecore/scenario-contracts";

import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import {
  hasWhatsAppFlowProviderMetadata,
  serializeWhatsAppFlowEditableContent,
  toEditableWhatsAppFlowConfig,
} from "@/lib/scenarios/whatsapp-flow-config";
import {
  buildScenarioWhatsAppServiceFlowSelectionPatch,
  buildScenarioWhatsAppInteractiveFlowConfigPatch,
  resolveScenarioWhatsAppInteractiveFlowTarget,
} from "@/lib/scenarios/whatsapp-service-message";
import { getSingleFlowIdFromWhatsAppTemplateComponents } from "@/lib/scenarios/whatsapp-template-flow";
import { WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUSES } from "@/lib/whatsapp/flows/provisioning-contract";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export function collectScenarioWhatsAppFlowProviderSourceIds(
  nodes: readonly { data?: unknown }[],
  additionalSourceIds: readonly (string | null | undefined)[] = []
): string[] {
  const sourceIds = new Set<string>();
  for (const candidate of additionalSourceIds) {
    const sourceId = typeof candidate === "string" ? candidate.trim() : "";
    if (sourceId) sourceIds.add(sourceId);
  }
  for (const node of nodes) {
    if (
      !node.data ||
      typeof node.data !== "object" ||
      Array.isArray(node.data)
    ) {
      continue;
    }
    const target = resolveScenarioWhatsAppInteractiveFlowTarget(
      node.data as ScenarioNodeData
    );
    const sourceId = resolveWhatsAppFlowProviderSource({
      flowConfig: target?.config,
    })?.sourceId;
    if (sourceId) sourceIds.add(sourceId);
  }
  return Array.from(sourceIds);
}

export function createWhatsAppFlowEditableContentDigest(
  config: WhatsAppFlowConfig
): string {
  return sha256Hex(serializeWhatsAppFlowEditableContent(config));
}

export function normalizeManagedWhatsAppFlowProvisioningProjection(
  value: unknown
): ManagedWhatsAppFlowProvisioningProjection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const operationId =
    typeof candidate.operationId === "string"
      ? candidate.operationId.trim()
      : "";
  const sourceId =
    typeof candidate.sourceId === "string" ? candidate.sourceId.trim() : "";
  const wabaId =
    typeof candidate.wabaId === "string" ? candidate.wabaId.trim() : "";
  const contentDigest =
    typeof candidate.contentDigest === "string"
      ? candidate.contentDigest.trim()
      : "";
  const flowId =
    typeof candidate.flowId === "string" ? candidate.flowId.trim() : "";
  const flowName =
    typeof candidate.flowName === "string" ? candidate.flowName.trim() : "";
  const providerStatus = WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUSES.includes(
    String(
      candidate.providerStatus
    ) as ManagedWhatsAppFlowProvisioningProjection["providerStatus"]
  )
    ? (candidate.providerStatus as ManagedWhatsAppFlowProvisioningProjection["providerStatus"])
    : null;

  if (
    !operationId ||
    !sourceId ||
    !wabaId ||
    !Number.isSafeInteger(candidate.contentRevision) ||
    Number(candidate.contentRevision) < 0 ||
    !SHA256_HEX_PATTERN.test(contentDigest) ||
    !providerStatus ||
    (candidate.flowId !== undefined && !flowId) ||
    (candidate.flowName !== undefined && !flowName)
  ) {
    return null;
  }

  return {
    operationId,
    sourceId,
    wabaId,
    contentRevision: candidate.contentRevision as number,
    contentDigest,
    ...(flowId ? { flowId } : {}),
    ...(flowName ? { flowName } : {}),
    providerStatus,
  };
}

function applyNodeDataPatch(
  data: ScenarioNodeData,
  patch: Partial<ScenarioNodeData>
): ScenarioNodeData {
  const next = { ...data } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next as ScenarioNodeData;
}

function replaceNodeData<TNode extends ScenarioGraphNode>(
  node: TNode,
  data: ScenarioNodeData
): TNode {
  return { ...node, data } as TNode;
}

export function applyScenarioWhatsAppInteractiveFlowConfigToNode<
  TNode extends ScenarioGraphNode,
>(node: TNode, config: WhatsAppFlowConfig): TNode {
  const patch = buildScenarioWhatsAppInteractiveFlowConfigPatch(
    node.data,
    config
  );
  if (!patch) return node;
  return replaceNodeData(node, applyNodeDataPatch(node.data, patch));
}

/** Applies a server-authorized existing-Flow selection to its canonical owner. */
export function applyScenarioWhatsAppInteractiveFlowSelectionToNode<
  TNode extends ScenarioGraphNode,
>(node: TNode, config: WhatsAppFlowConfig): TNode | null {
  const servicePatch = buildScenarioWhatsAppServiceFlowSelectionPatch(
    node.data,
    config
  );
  if (servicePatch) {
    return replaceNodeData(node, applyNodeDataPatch(node.data, servicePatch));
  }

  if (
    node.data.actionWhatsAppServiceMessage !== undefined ||
    resolveScenarioActionTypeFromNodeData(node.data) !== "whatsapp_template"
  ) {
    return null;
  }

  const providerFlowId = config.providerReference?.flowId.trim();
  if (
    providerFlowId &&
    getSingleFlowIdFromWhatsAppTemplateComponents(
      node.data.actionWhatsAppTemplateComponents
    ) !== providerFlowId
  ) {
    return null;
  }

  return replaceNodeData(
    node,
    applyNodeDataPatch(node.data, { actionFlowConfig: config })
  );
}

export function applyManagedWhatsAppFlowProvisioningProjectionToNode<
  TNode extends ScenarioGraphNode,
>(
  node: TNode,
  projection: ManagedWhatsAppFlowProvisioningProjection
): TNode | null {
  const target = resolveScenarioWhatsAppInteractiveFlowTarget(node.data);
  const normalized =
    normalizeManagedWhatsAppFlowProvisioningProjection(projection);
  if (!target || !normalized) return null;
  return applyScenarioWhatsAppInteractiveFlowConfigToNode(node, {
    ...toEditableWhatsAppFlowConfig(target.config),
    managedProvisioning: normalized,
  });
}

function stripProviderFields<TNode extends ScenarioGraphNode>(
  node: TNode
): TNode {
  const target = resolveScenarioWhatsAppInteractiveFlowTarget(node.data);
  if (!target) {
    return stripUnresolvedProviderFields(node);
  }
  return applyScenarioWhatsAppInteractiveFlowConfigToNode(
    node,
    toEditableWhatsAppFlowConfig(target.config)
  );
}

function stripUnresolvedProviderFields<TNode extends ScenarioGraphNode>(
  node: TNode
): TNode {
  const data = node.data as ScenarioNodeData & Record<string, unknown>;
  let changed = false;
  const nextData = { ...data } as Record<string, unknown>;
  const templateConfig = data.actionFlowConfig;
  if (
    templateConfig &&
    typeof templateConfig === "object" &&
    hasWhatsAppFlowProviderMetadata(templateConfig)
  ) {
    nextData.actionFlowConfig = toEditableWhatsAppFlowConfig(templateConfig);
    changed = true;
  }

  const serviceMessage = data.actionWhatsAppServiceMessage;
  if (
    serviceMessage &&
    typeof serviceMessage === "object" &&
    !Array.isArray(serviceMessage)
  ) {
    const serviceRecord = serviceMessage as unknown as Record<string, unknown>;
    const message = serviceRecord.message;
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const messageRecord = message as Record<string, unknown>;
      const flowConfig = messageRecord.flowConfig;
      if (
        flowConfig &&
        typeof flowConfig === "object" &&
        !Array.isArray(flowConfig) &&
        hasWhatsAppFlowProviderMetadata(flowConfig)
      ) {
        nextData.actionWhatsAppServiceMessage = {
          ...serviceRecord,
          message: {
            ...messageRecord,
            flowConfig: toEditableWhatsAppFlowConfig(
              flowConfig as WhatsAppFlowConfig
            ),
          },
        };
        changed = true;
      }
    }
  }

  return changed ? replaceNodeData(node, nextData as ScenarioNodeData) : node;
}

function restoreStoredLegacyProviderMetadata(
  editableConfig: WhatsAppFlowConfig,
  storedConfig: WhatsAppFlowConfig
): WhatsAppFlowConfig {
  return {
    ...editableConfig,
    ...(storedConfig.metaFlowId !== undefined
      ? { metaFlowId: storedConfig.metaFlowId }
      : {}),
    ...(storedConfig.metaFlowName !== undefined
      ? { metaFlowName: storedConfig.metaFlowName }
      : {}),
    ...(storedConfig.metaFlowStatus !== undefined
      ? { metaFlowStatus: storedConfig.metaFlowStatus }
      : {}),
  };
}

function restoreStoredProviderMetadata(
  editableConfig: WhatsAppFlowConfig,
  storedConfig: WhatsAppFlowConfig,
  providerReference: WhatsAppFlowProviderReference | null
): WhatsAppFlowConfig {
  return providerReference
    ? { ...editableConfig, providerReference }
    : restoreStoredLegacyProviderMetadata(editableConfig, storedConfig);
}

export function stripServerOwnedWhatsAppFlowProviderFields<
  TNode extends ScenarioGraphNode,
>(nodes: readonly TNode[]): TNode[] {
  return nodes.map(stripProviderFields);
}

export function mergeServerOwnedWhatsAppFlowProjection<
  TIncoming extends ScenarioGraphNode,
>(params: {
  incomingNodes: readonly TIncoming[];
  storedNodes: readonly ScenarioGraphNode[];
  digestEditableConfig: (config: WhatsAppFlowConfig) => string;
  preserveTemplateProviderBindingOnContentChange?: boolean;
}): TIncoming[] {
  const storedById = new Map(
    params.storedNodes.map(node => [String(node.id), node])
  );

  return params.incomingNodes.map(incomingNode => {
    const strippedIncoming = stripProviderFields(incomingNode);
    const storedNode = storedById.get(String(incomingNode.id));
    const storedTarget = storedNode
      ? resolveScenarioWhatsAppInteractiveFlowTarget(storedNode.data)
      : null;
    const incomingTarget = resolveScenarioWhatsAppInteractiveFlowTarget(
      strippedIncoming.data
    );
    if (
      !incomingTarget ||
      !storedTarget ||
      incomingTarget.owner !== storedTarget.owner
    ) {
      return strippedIncoming;
    }

    const projection = normalizeManagedWhatsAppFlowProvisioningProjection(
      storedTarget.config.managedProvisioning
    );
    const providerReference = normalizeWhatsAppFlowProviderReference(
      storedTarget.config.providerReference
    );
    if (
      !projection &&
      Object.prototype.hasOwnProperty.call(
        storedTarget.config,
        "providerReference"
      ) &&
      !providerReference
    ) {
      return strippedIncoming;
    }

    try {
      const incomingDigest = params.digestEditableConfig(incomingTarget.config);
      const storedDigest = params.digestEditableConfig(storedTarget.config);
      if (
        projection
          ? incomingDigest !== projection.contentDigest ||
            storedDigest !== projection.contentDigest
          : incomingDigest !== storedDigest
      ) {
        // A provider-authored Flow is an opaque immutable reference. Any local
        // content edit invalidates it rather than rebinding changed content to
        // the original provider Flow ID.
        if (providerReference) return strippedIncoming;

        // Template buttons are provider-bound to a concrete Flow ID. Preserve
        // the immutable provider evidence so edited content is quarantined and
        // provisioning can require an explicit template rebind. Runnable
        // validation rejects a projection whose digest no longer matches.
        if (
          storedTarget.owner === "template" &&
          params.preserveTemplateProviderBindingOnContentChange !== false
        ) {
          return applyScenarioWhatsAppInteractiveFlowConfigToNode(
            strippedIncoming,
            projection
              ? {
                  ...incomingTarget.config,
                  managedProvisioning: projection,
                }
              : restoreStoredLegacyProviderMetadata(
                  incomingTarget.config,
                  storedTarget.config
                )
          );
        }
        return strippedIncoming;
      }
    } catch {
      return strippedIncoming;
    }

    return applyScenarioWhatsAppInteractiveFlowConfigToNode(
      strippedIncoming,
      projection
        ? {
            ...incomingTarget.config,
            managedProvisioning: projection,
          }
        : restoreStoredProviderMetadata(
            incomingTarget.config,
            storedTarget.config,
            providerReference
          )
    );
  });
}
