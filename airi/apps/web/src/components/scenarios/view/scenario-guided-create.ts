"use client";

import type {
  ScenarioMatchingRole,
  ScenarioTriggerConfig,
} from "@/components/scenarios/types";
import type {
  ScenarioActionSourceId,
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
  TranslateFn,
} from "../types";
import { buildWhatsAppServiceMessagePatch } from "@/lib/scenarios/whatsapp-service-message";
import { createClientMessageTriggerData } from "@icecore/scenario-contracts";
import { buildStarterFlow } from "./graph/starter";

export type ScenarioGuidedCreateKind =
  | "entry"
  | "keyword"
  | "fallback"
  | "blank";

export type ScenarioGuidedCreateSeed = {
  name: string;
  matchingRole?: ScenarioMatchingRole;
  initialFlow: {
    nodes: ScenarioFlowNode[];
    edges: ScenarioFlowEdge[];
  };
};

function cloneFlow(params: {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
}): {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
} {
  return {
    nodes: params.nodes.map(node => ({
      ...node,
      data:
        node.data && typeof node.data === "object"
          ? ({ ...(node.data as ScenarioNodeData) } as ScenarioNodeData)
          : node.data,
    })),
    edges: params.edges.map(edge => ({ ...edge })),
  };
}

function patchTriggerConfig(
  triggerNode: ScenarioFlowNode,
  patch: Partial<ScenarioTriggerConfig>
) {
  const nodeData = triggerNode.data as ScenarioNodeData;
  triggerNode.data = createClientMessageTriggerData({
    ...nodeData,
    triggerConfig: {
      ...(nodeData.triggerConfig || {}),
      ...patch,
    },
  });
}

const STARTER_REPLY_KEY_BY_KIND: Record<ScenarioGuidedCreateKind, string> = {
  entry: "guidedStarterReplyEntry",
  keyword: "guidedStarterReplyKeyword",
  fallback: "guidedStarterReplyFallback",
  blank: "guidedStarterReplyBlank",
};

/**
 * A starter must activate as created: an empty reply is refused by the
 * server. WhatsApp keeps its text in the service message; other channels in
 * the fixed reply.
 */
function seedStarterReply(actionNode: ScenarioFlowNode, text: string) {
  const data = actionNode.data as ScenarioNodeData;
  const serviceMessage = data.actionWhatsAppServiceMessage;
  if (serviceMessage?.message.kind === "text") {
    actionNode.data = {
      ...data,
      ...buildWhatsAppServiceMessagePatch({
        ...serviceMessage,
        message: { ...serviceMessage.message, body: { mode: "fixed", text } },
      }),
    };
    return;
  }
  actionNode.data = {
    ...data,
    actionType: "reply",
    actionReplyMode: "fixed",
    actionReplyText: text,
  };
}

function patchStarterFlowForKind(params: {
  kind: ScenarioGuidedCreateKind;
  flow: { nodes: ScenarioFlowNode[]; edges: ScenarioFlowEdge[] };
  t: TranslateFn;
}) {
  const triggerNode = params.flow.nodes.find(
    node => (node.data as ScenarioNodeData)?.kind === "trigger"
  );
  const actionNode = params.flow.nodes.find(
    node => (node.data as ScenarioNodeData)?.kind === "action"
  );

  if (triggerNode) {
    patchTriggerConfig(triggerNode, {
      enabled: true,
      messageMatchMode: "any",
      onlyNewCustomers: false,
      keywordPattern: undefined,
      keywordMatchMode: undefined,
    });
  }

  switch (params.kind) {
    case "entry":
      if (triggerNode) {
        patchTriggerConfig(triggerNode, {
          messageMatchMode: "any",
          onlyNewCustomers: true,
        });
      }
      break;
    case "keyword":
      if (triggerNode) {
        // An example keyword the person edits; an empty one cannot activate.
        patchTriggerConfig(triggerNode, {
          messageMatchMode: "contains",
          keywordPattern: params.t("guidedStarterKeyword"),
          keywordMatchMode: "contains",
        });
      }
      break;
    case "fallback":
      if (triggerNode) {
        patchTriggerConfig(triggerNode, {
          messageMatchMode: "any",
          onlyNewCustomers: false,
        });
      }
      break;
    case "blank":
      break;
  }

  if (actionNode) {
    seedStarterReply(
      actionNode,
      params.t(STARTER_REPLY_KEY_BY_KIND[params.kind])
    );
  }
}

export function buildGuidedScenarioSeed(params: {
  kind: ScenarioGuidedCreateKind;
  t: TranslateFn;
  connectedActionSources?: readonly ScenarioActionSourceId[] | null;
}): ScenarioGuidedCreateSeed {
  const starterFlow = cloneFlow(
    buildStarterFlow(params.connectedActionSources)
  );
  patchStarterFlowForKind({
    kind: params.kind,
    flow: starterFlow,
    t: params.t,
  });

  switch (params.kind) {
    case "entry":
      return {
        name: params.t("createTypeEntryTitle"),
        initialFlow: starterFlow,
      };
    case "keyword":
      return {
        name: params.t("createTypeKeywordTitle"),
        initialFlow: starterFlow,
      };
    case "fallback":
      return {
        name: params.t("createTypeFallbackTitle"),
        matchingRole: "fallback",
        initialFlow: starterFlow,
      };
    case "blank":
    default:
      return {
        name: params.t("createTypeBlankTitle"),
        initialFlow: starterFlow,
      };
  }
}
