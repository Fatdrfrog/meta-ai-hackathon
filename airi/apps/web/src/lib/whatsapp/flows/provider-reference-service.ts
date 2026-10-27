import { createHash } from "node:crypto";

import type {
  ScenarioGraphNode,
  WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { normalizeWhatsAppFlowProviderReference } from "@icecore/scenario-contracts";

import { applyScenarioWhatsAppInteractiveFlowSelectionToNode } from "@/lib/scenarios/whatsapp-flow-projection";
import { mutateScenarioGraphWithCas } from "@/lib/scenarios/scenario-graph-mutation";
import {
  buildScenarioFormAnswersKeysByNodeId,
  stampScenarioFormAnswersKey,
} from "@/lib/scenarios/scenario-form-answer-checks";
import {
  FLOW_BRANCH_TRANSITION,
  hasScenarioFlowBranchBindingData,
} from "@/lib/scenarios/transition-registry";
import { DEFAULT_FLOW_CTA_TEXT } from "@/lib/scenarios/whatsapp-flow-config";
import { resolveScenarioWhatsAppInteractiveFlowConfig } from "@/lib/scenarios/whatsapp-service-message";
import type {
  AttachWhatsAppFlowProviderReferenceRequest,
  WhatsAppFlowProviderReferenceFailureCode,
  WhatsAppFlowProviderReferenceResult,
} from "@/lib/whatsapp/flows/provider-reference-contract";
import { getWhatsAppFlowEndpointSecurityStatus } from "@/lib/whatsapp/flows/endpoint-security-service";
import {
  getMetaWhatsAppFlow,
  isMetaWhatsAppFlowOwnedByWaba,
  type MetaWhatsAppFlow,
} from "@/lib/whatsapp/flows/service";
import {
  whatsAppFlowSourceBindingFenceStore,
  WhatsAppFlowSourceBindingFenceConflictError,
  type WhatsAppFlowSourceBindingFenceLease,
} from "@/lib/whatsapp/flows/source-binding-fence-store";
import {
  asNullableRecord,
  readNonEmptyStringOrUndefined as optionalText,
} from "@icecore/shared/lib/value-utils";

type AttachWhatsAppFlowProviderReferenceInput =
  AttachWhatsAppFlowProviderReferenceRequest & {
    accessToken: string;
    applicationId: string;
    phoneNumberId?: string;
    wabaId: string;
    updatedBy: string;
  };

type ProviderReferenceMutationValue =
  | { attached: true; flowConfig: WhatsAppFlowConfig }
  | {
      attached: false;
      reason:
        | "active_requires_published"
        | "branches_connected"
        | "target_invalid";
    };

class InvalidProviderFlowReferenceError extends Error {}

function endpointIdentity(value: unknown): string | null {
  const text = optionalText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return null;
  }
}

function isSameEndpoint(left: unknown, right: unknown): boolean {
  const leftIdentity = endpointIdentity(left);
  return Boolean(leftIdentity && leftIdentity === endpointIdentity(right));
}

function providerReferenceSemanticOperationId(
  input: AttachWhatsAppFlowProviderReferenceInput
): string {
  const digest = createHash("sha256")
    .update(input.scenarioId)
    .update("\0")
    .update(input.nodeId)
    .update("\0")
    .update(input.flowId)
    .digest("hex");
  return `provider-reference:${digest}`;
}

function failure(
  code: WhatsAppFlowProviderReferenceFailureCode,
  message: string,
  retryable = false,
  revision?: {
    previousScenarioUpdatedAt: string | null;
    scenarioUpdatedAt: string | null;
  }
): Extract<WhatsAppFlowProviderReferenceResult, { ok: false }> {
  return {
    ok: false,
    error: { code, message, retryable },
    ...(revision ?? {}),
  };
}

function providerScreens(flowJson: unknown): WhatsAppFlowConfig["screens"] {
  const root = asNullableRecord(flowJson);
  if (!root || !Array.isArray(root.screens) || root.screens.length === 0) {
    throw new InvalidProviderFlowReferenceError(
      "Flow JSON does not contain screens"
    );
  }

  const ids = new Set<string>();
  return root.screens.map(screenValue => {
    const screen = asNullableRecord(screenValue);
    const id = optionalText(screen?.id);
    if (!id || ids.has(id)) {
      throw new InvalidProviderFlowReferenceError(
        "Flow JSON contains an invalid screen id"
      );
    }
    ids.add(id);
    return {
      id,
      title: optionalText(screen?.title) ?? id,
      fields: [],
    };
  });
}

function hasConnectedFlowBranches(params: {
  actionNodeId: string;
  nodes: unknown[];
  edges: unknown[];
}): boolean {
  const nodesById = new Map(
    (params.nodes as ScenarioGraphNode[]).map(node => [node.id, node] as const)
  );

  return params.edges.some(edgeValue => {
    const edge = asNullableRecord(edgeValue);
    if (optionalText(edge?.source) !== params.actionNodeId) return false;
    if (
      FLOW_BRANCH_TRANSITION.matchesSourceHandle(
        optionalText(edge?.sourceHandle)
      )
    ) {
      return true;
    }

    const targetId = optionalText(edge?.target);
    const targetNode = targetId ? nodesById.get(targetId) : null;
    return hasScenarioFlowBranchBindingData(targetNode?.data);
  });
}

function isScenarioGraphNode(node: unknown): node is ScenarioGraphNode {
  return (
    node !== null &&
    typeof node === "object" &&
    typeof (node as { id?: unknown }).id === "string"
  );
}

function buildWhatsAppFlowProviderReferenceConfig(params: {
  flow: MetaWhatsAppFlow;
  flowJson: unknown;
  flowId: string;
  sourceId: string;
  wabaId: string;
  previousConfig?: WhatsAppFlowConfig | null;
}): WhatsAppFlowConfig {
  const root = asNullableRecord(params.flowJson);
  if (!root) {
    throw new InvalidProviderFlowReferenceError("Flow JSON is invalid");
  }
  const flowId = params.flowId.trim();
  const sourceId = params.sourceId.trim();
  const wabaId = params.wabaId.trim();
  const returnedFlowId = optionalText(params.flow.id);
  if (!flowId || !sourceId || !wabaId || returnedFlowId !== flowId) {
    throw new InvalidProviderFlowReferenceError(
      "Flow provider metadata is invalid"
    );
  }

  const flowName = optionalText(params.flow.name);
  const jsonVersion =
    optionalText(params.flow.json_version) ?? optionalText(root.version);
  const dataApiVersion =
    optionalText(params.flow.data_api_version) ??
    optionalText(root.data_api_version);
  const isEndpoint = Boolean(
    optionalText(params.flow.endpoint_uri) || dataApiVersion
  );
  const reference = normalizeWhatsAppFlowProviderReference({
    flowId,
    sourceId,
    wabaId,
    flowName,
    providerStatus: params.flow.status,
    jsonVersion,
    dataApiVersion,
  });
  if (!reference) {
    throw new InvalidProviderFlowReferenceError(
      "Flow provider metadata is invalid"
    );
  }
  const previous = params.previousConfig;
  const headerText = optionalText(previous?.headerText);
  const bodyText = optionalText(previous?.bodyText);
  const footerText = optionalText(previous?.footerText);

  return {
    templateId: "provider_reference",
    screens: providerScreens(params.flowJson),
    ctaText: optionalText(previous?.ctaText) ?? DEFAULT_FLOW_CTA_TEXT,
    ...(headerText ? { headerText } : {}),
    ...(bodyText ? { bodyText } : {}),
    ...(footerText ? { footerText } : {}),
    flowNavigationMode: isEndpoint ? "data_endpoint" : "linear",
    providerReference: reference,
  };
}

async function attachWithSourceFence(
  input: AttachWhatsAppFlowProviderReferenceInput,
  sourceFence: WhatsAppFlowSourceBindingFenceLease
): Promise<WhatsAppFlowProviderReferenceResult> {
  const details = await getMetaWhatsAppFlow({
    accessToken: input.accessToken,
    flowId: input.flowId,
    phoneNumberId: input.phoneNumberId,
    includeJson: true,
    expectedWabaId: input.wabaId,
  });
  if (!details.ok || !details.flow) {
    return failure(
      details.status === 404 ? "FLOW_NOT_OWNED" : "PROVIDER_UNAVAILABLE",
      details.status === 404
        ? "Flow does not belong to this WhatsApp Business Account"
        : "Could not verify the Flow with Meta",
      details.status >= 500
    );
  }
  if (!isMetaWhatsAppFlowOwnedByWaba(details.flow, input.wabaId)) {
    return failure(
      "FLOW_NOT_OWNED",
      "Flow does not belong to this WhatsApp Business Account"
    );
  }
  if (!details.flowJson) {
    return failure(
      "FLOW_JSON_UNAVAILABLE",
      "Flow JSON is unavailable from Meta",
      true
    );
  }

  const providerEndpointUri = optionalText(details.flow.endpoint_uri);
  if (providerEndpointUri) {
    const endpointStatus = await getWhatsAppFlowEndpointSecurityStatus({
      context: {
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        wabaId: input.wabaId,
        applicationId: input.applicationId,
        accessToken: input.accessToken,
      },
    });
    if (
      endpointStatus.endpointUri &&
      isSameEndpoint(providerEndpointUri, endpointStatus.endpointUri)
    ) {
      return failure(
        "MANAGED_ENDPOINT_INCOMPATIBLE",
        "This Flow uses airi.chat's managed endpoint and cannot be attached as a provider-managed reference"
      );
    }
  }

  let buildConfig: (previous: WhatsAppFlowConfig) => WhatsAppFlowConfig;
  try {
    buildConfig = previous =>
      buildWhatsAppFlowProviderReferenceConfig({
        flow: details.flow!,
        flowJson: details.flowJson,
        flowId: input.flowId,
        sourceId: input.sourceId,
        wabaId: input.wabaId,
        previousConfig: previous,
      });
    // Validate provider metadata and screen structure before entering the CAS.
    buildConfig({ templateId: "", screens: [], ctaText: "" });
  } catch {
    return failure("FLOW_INVALID", "Meta returned an invalid Flow definition");
  }

  await whatsAppFlowSourceBindingFenceStore.assertCurrent(sourceFence);

  const mutation =
    await mutateScenarioGraphWithCas<ProviderReferenceMutationValue>({
      workspaceId: input.workspaceId,
      scenarioId: input.scenarioId,
      expectedUpdatedAt: input.expectedUpdatedAt,
      updatedBy: input.updatedBy,
      project: snapshot => {
        const nodeIndex = snapshot.nodes.findIndex(
          node =>
            node !== null &&
            typeof node === "object" &&
            String((node as { id?: unknown }).id) === input.nodeId
        );
        if (nodeIndex < 0) {
          return {
            changed: false,
            value: { attached: false, reason: "target_invalid" },
          };
        }
        const node = snapshot.nodes[nodeIndex] as ScenarioGraphNode;
        if (
          hasConnectedFlowBranches({
            actionNodeId: input.nodeId,
            nodes: snapshot.nodes,
            edges: snapshot.edges,
          })
        ) {
          return {
            changed: false,
            value: { attached: false, reason: "branches_connected" },
          };
        }
        const currentConfig = resolveScenarioWhatsAppInteractiveFlowConfig(
          node.data
        );
        // The linked form keeps the step's name in variables, or gets one.
        const flowConfig = stampScenarioFormAnswersKey(
          buildConfig(
            currentConfig ?? { templateId: "", screens: [], ctaText: "" }
          ),
          {
            nodeId: input.nodeId,
            formKeysByNodeId: buildScenarioFormAnswersKeysByNodeId(
              snapshot.nodes.filter(isScenarioGraphNode)
            ),
          }
        );
        if (
          snapshot.status === "active" &&
          flowConfig.providerReference?.providerStatus !== "PUBLISHED"
        ) {
          return {
            changed: false,
            value: {
              attached: false,
              reason: "active_requires_published",
            },
          };
        }
        const projected = applyScenarioWhatsAppInteractiveFlowSelectionToNode(
          node,
          flowConfig
        );
        if (!projected) {
          return {
            changed: false,
            value: { attached: false, reason: "target_invalid" },
          };
        }
        const nodes = [...snapshot.nodes];
        nodes[nodeIndex] = projected;
        return {
          changed: true,
          nodes,
          value: { attached: true, flowConfig },
        };
      },
    });

  if (mutation.status === "not_found") {
    return failure("SCENARIO_NOT_FOUND", "Scenario was not found");
  }
  if (mutation.status === "conflict") {
    return failure(
      "SCENARIO_REVISION_CONFLICT",
      "Scenario changed; refresh before attaching this Flow",
      false,
      {
        previousScenarioUpdatedAt: mutation.previousScenarioUpdatedAt,
        scenarioUpdatedAt: mutation.scenarioUpdatedAt,
      }
    );
  }
  if (!mutation.value.attached) {
    if (mutation.value.reason === "branches_connected") {
      return failure(
        "FLOW_BRANCHES_CONNECTED",
        "Disconnect existing WhatsApp Flow branches before attaching a provider Flow",
        false,
        {
          previousScenarioUpdatedAt: mutation.previousScenarioUpdatedAt,
          scenarioUpdatedAt: mutation.scenarioUpdatedAt,
        }
      );
    }
    if (mutation.value.reason === "active_requires_published") {
      return failure(
        "ACTIVE_SCENARIO_REQUIRES_PUBLISHED_FLOW",
        "Active scenarios can only attach a PUBLISHED WhatsApp Flow",
        false,
        {
          previousScenarioUpdatedAt: mutation.previousScenarioUpdatedAt,
          scenarioUpdatedAt: mutation.scenarioUpdatedAt,
        }
      );
    }
    return failure(
      "TARGET_INVALID",
      "The action node is not an editable WhatsApp Flow target",
      false,
      {
        previousScenarioUpdatedAt: mutation.previousScenarioUpdatedAt,
        scenarioUpdatedAt: mutation.scenarioUpdatedAt,
      }
    );
  }
  return {
    ok: true,
    flowConfig: mutation.value.flowConfig,
    previousScenarioUpdatedAt: mutation.previousScenarioUpdatedAt,
    scenarioUpdatedAt: mutation.scenarioUpdatedAt,
  };
}

export async function attachWhatsAppFlowProviderReference(
  input: AttachWhatsAppFlowProviderReferenceInput
): Promise<WhatsAppFlowProviderReferenceResult> {
  let sourceFence: WhatsAppFlowSourceBindingFenceLease | null = null;
  try {
    sourceFence = await whatsAppFlowSourceBindingFenceStore.acquire({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      expectedWabaId: input.wabaId,
      kind: "PROVISIONING",
      semanticOperationId: providerReferenceSemanticOperationId(input),
    });
    return await attachWithSourceFence(input, sourceFence);
  } catch (error) {
    if (error instanceof WhatsAppFlowSourceBindingFenceConflictError) {
      return failure(
        "SOURCE_BINDING_CHANGED",
        "WhatsApp source binding changed; refresh and retry"
      );
    }
    throw error;
  } finally {
    if (sourceFence) {
      await whatsAppFlowSourceBindingFenceStore
        .release(sourceFence)
        .catch(() => undefined);
    }
  }
}
