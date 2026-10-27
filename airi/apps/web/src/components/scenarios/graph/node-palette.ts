import {
  createClientMessageTriggerData,
  createDefaultScenarioWhatsAppServiceMessage,
  createEmptyRecipientColumnSplitConfig,
  type GenerativeAIActionConfig,
} from "@icecore/scenario-contracts";
import { SCENARIO_HANDLE_RULES } from "./config";
import { createScenarioGraphId } from "./id";
import { resolveScenarioFlowNodeType } from "./node-type";
import type { ScenarioFlowNode, ScenarioNodeData } from "../types";

export function createDefaultGenerativeAIActionConfig(): GenerativeAIActionConfig {
  return {
    version: 1,
    mode: "text_to_video",
    prompt: "",
  };
}

export type ScenarioNodePaletteItem = {
  id: string;
  kind: ScenarioNodeData["kind"];
  title?: string;
  titleKey?: string;
  contextOptionId?: ScenarioNodeData["contextOptionId"];
  defaults?: Partial<ScenarioNodeData>;
  disabled?: boolean;
  disabledHint?: string;
  hiddenFromMenu?: boolean;
};

/** Palette ids used by empty-canvas root CTAs (must stay in SCENARIO_NODE_PALETTE). */
export const SCENARIO_EMPTY_CANVAS_ROOT_PALETTE_IDS = {
  trigger: "trigger-incoming-message",
  bulk: "bulk-campaign",
} as const;

export type ScenarioEmptyCanvasRootKind =
  keyof typeof SCENARIO_EMPTY_CANVAS_ROOT_PALETTE_IDS;

const SCENARIO_EMPTY_CANVAS_ROOT_PALETTE_ID_SET = new Set<string>(
  Object.values(SCENARIO_EMPTY_CANVAS_ROOT_PALETTE_IDS)
);

export function canCreateScenarioPaletteItemFromHandle(
  item: ScenarioNodePaletteItem
): boolean {
  return (
    Boolean(SCENARIO_HANDLE_RULES[item.kind]?.inputHandleId) &&
    !SCENARIO_EMPTY_CANVAS_ROOT_PALETTE_ID_SET.has(item.id)
  );
}

export const SCENARIO_NODE_PALETTE: ScenarioNodePaletteItem[] = [
  {
    id: "bulk-campaign",
    kind: "bulk",
    titleKey: "presetBulkCampaign",
    defaults: {
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "Bulk campaign",
        recipientSourceSummary: "No generated recipients yet",
        generationStatus: "idle",
        cohorts: [],
      },
    },
  },
  {
    id: "trigger-incoming-message",
    kind: "trigger",
    titleKey: "badgeTrigger",
    defaults: {
      triggerConfig: {
        enabled: true,
        messageMatchMode: "any",
      },
    },
  },
  {
    // Graph-only WhatsApp QR trigger. Palette create/copy never ensure Meta
    // codes or call QR provisioning — drawer owns draft ensure + Meta later.
    id: "trigger-whatsapp-qr",
    kind: "trigger",
    titleKey: "presetTriggerWhatsAppQr",
    defaults: {
      triggerConfig: {
        enabled: true,
        entryPointType: "whatsapp_qr",
        messageMatchMode: "any",
      },
    },
  },
  {
    id: "logic-if-else",
    kind: "logic",
    titleKey: "scenarioGate",
    defaults: {
      logicType: "audience_filter",
    },
  },
  {
    id: "logic-wait",
    kind: "logic",
    titleKey: "presetLogicWait",
    hiddenFromMenu: true,
    defaults: {
      logicType: "audience_filter",
    },
  },
  {
    id: "logic-customer-pool",
    kind: "logic",
    titleKey: "presetLogicCustomerPool",
    hiddenFromMenu: true,
    defaults: {
      logicType: "audience_filter",
      audienceMode: "all",
    },
  },
  {
    id: "logic-recipient-column-split",
    kind: "logic",
    titleKey: "presetLogicRecipientColumnSplit",
    defaults: {
      logicType: "recipient_column_split",
      recipientColumnSplit: createEmptyRecipientColumnSplitConfig(),
    },
  },
  {
    id: "context-knowledge",
    kind: "context",
    titleKey: "presetContextKnowledge",
    defaults: {
      contextSources: [
        {
          optionId: "conversation_timeline",
          selectionMode: "all",
          itemIds: [],
        },
        { optionId: "answer_snippets", selectionMode: "all", itemIds: [] },
      ],
    },
  },
  {
    id: "action-reply",
    kind: "action",
    titleKey: "presetActionReply",
    defaults: {
      actionType: "reply",
      actionWhatsAppServiceMessage:
        createDefaultScenarioWhatsAppServiceMessage("text"),
    },
  },
  {
    id: "action-generative-ai",
    kind: "action",
    titleKey: "presetActionGenerativeAI",
    defaults: {
      actionType: "generative_ai",
      actionGenerativeAIConfig: createDefaultGenerativeAIActionConfig(),
    },
  },
  {
    id: "scenario-link",
    kind: "scenario_link",
    titleKey: "presetScenarioLink",
    hiddenFromMenu: true,
  },
];

export function createNodeFromPaletteItem(
  item: ScenarioNodePaletteItem,
  position: { x: number; y: number }
): ScenarioFlowNode {
  // WhatsApp QR palette item creates graph-only trigger data
  // (entryPointType whatsapp_qr). Never ensure/create Meta codes from
  // palette, create, copy, or autosave paths.
  const baseData: ScenarioNodeData =
    item.kind === "trigger"
      ? createClientMessageTriggerData({
          contextOptionId: item.contextOptionId,
          ...(item.defaults ?? {}),
        })
      : {
          kind: item.kind,
          contextOptionId: item.contextOptionId,
          ...(item.defaults ?? {}),
        };

  return {
    id: createScenarioGraphId("node"),
    type: resolveScenarioFlowNodeType(item.kind),
    position,
    data: baseData,
  };
}
