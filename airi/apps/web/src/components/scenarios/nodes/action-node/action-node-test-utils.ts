import {
  buildWhatsAppSessionChoiceSourceHandleId,
  type ScenarioWhatsAppCarouselCard,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { readLoadableWhatsAppTemplateFormFlowId } from "@/lib/scenarios/whatsapp-template-form-snapshot";
import { resolveAvailableSourceHandleIds } from "../../graph/source-handles";
import type { ScenarioFlowNode } from "../../types";
import type {
  ScenarioActionEditorNodeData,
  ScenarioActionNodeEnrichment,
  ScenarioEditorNodeBase,
  ScenarioPersistedNodeDataOfKind,
} from "../../view/node-enrichment/types";

type ActionCapabilities = Pick<
  ScenarioActionNodeEnrichment,
  | "uiActionCommands"
  | "uiMedia"
  | "uiWhatsAppTemplates"
  | "uiWhatsAppFlows"
  | "uiConnections"
>;

export type ActionNodeTestData = ScenarioPersistedNodeDataOfKind<"action"> &
  Partial<
    Omit<
      ScenarioEditorNodeBase & ScenarioActionNodeEnrichment,
      keyof ActionCapabilities
    >
  > & {
    [K in keyof ActionCapabilities]?: Partial<ActionCapabilities[K]>;
  };

export function createActionEditorTestData(
  data: ActionNodeTestData
): ScenarioActionEditorNodeData {
  return {
    ...data,
    uiOnSelect: data.uiOnSelect ?? jest.fn(),
    uiOnPatch: data.uiOnPatch ?? jest.fn(),
    uiOnRemove: data.uiOnRemove ?? jest.fn(),
    uiActionNodeCount: data.uiActionNodeCount ?? 1,
    uiIsEditorExpanded: data.uiIsEditorExpanded ?? true,
    uiSourceCapabilities: data.uiSourceCapabilities ?? {
      hasMetaAds: false,
      hasWhatsApp: false,
      hasWhatsAppCoexistence: false,
    },
    uiActionCommands: {
      changeType: jest.fn(),
      changeReplyMode: jest.fn(),
      changeTelegramQuickReplies: jest.fn(),
      changeInstagramConfig: jest.fn(),
      ...data.uiActionCommands,
    },
    uiMedia: {
      upload: jest.fn(async () => undefined),
      generateVoice: jest.fn(async () => undefined),
      remove: jest.fn(),
      ...data.uiMedia,
    },
    uiWhatsAppTemplates: {
      options: [],
      selectedValue: "",
      preview: null,
      onOpenChange: jest.fn(),
      select: jest.fn(),
      refresh: jest.fn(),
      submittingGenerated: false,
      submitGenerated: jest.fn(async () => true),
      formFields: {
        // As the enrichment reads it from the saved step.
        flowId: readLoadableWhatsAppTemplateFormFlowId(data),
        loading: false,
        load: jest.fn(async () => ({ status: "skipped" as const })),
      },
      ...data.uiWhatsAppTemplates,
    },
    uiWhatsAppFlows: {
      options: [],
      openPicker: jest.fn(),
      onCtaOptionsOpenChange: jest.fn(),
      select: jest.fn(),
      openingPreviewId: null,
      openPreview: jest.fn(),
      refresh: jest.fn(),
      managedProvisioningHost: {
        sources: [],
        ownerKey: "session-1:node-1",
        publishing: false,
        publish: jest.fn(async () => null),
      },
      ...data.uiWhatsAppFlows,
    },
    uiConnections: {
      sourceHandleIds: [],
      telegramPayloads: [],
      instagramPayloads: [],
      whatsAppChoicePayloads: [],
      flowBranchIds: [],
      templateButtonPayloads: [],
      ...data.uiConnections,
    },
  };
}

/** The source handles a connection from this action may use. */
export function availableSourceHandlesFor(
  data: ActionNodeTestData,
  id = "action-1"
): string[] {
  return resolveAvailableSourceHandleIds({
    id,
    position: { x: 0, y: 0 },
    data,
  } as ScenarioFlowNode);
}

export function testChoiceId(id: string, nodeId = "action-1"): string {
  return `wsc:${nodeId}:${id}`;
}

export function testChoiceHandle(id: string, nodeId = "action-1"): string {
  return buildWhatsAppSessionChoiceSourceHandleId(testChoiceId(id, nodeId));
}

/** Carousel cards with a Buy and an Info choice each. */
export function testCarouselCards(
  cardIds: readonly string[],
  nodeId = "action-1"
): ScenarioWhatsAppCarouselCard[] {
  return cardIds.map(cardId => ({
    id: cardId,
    media: { url: `https://cdn.test/${cardId}.jpg`, mediaType: "image" },
    interaction: {
      kind: "quick_replies",
      options: [
        { id: testChoiceId(`${cardId}-buy`, nodeId), label: "Buy" },
        { id: testChoiceId(`${cardId}-info`, nodeId), label: "Info" },
      ],
    },
  }));
}

/** A Flow whose one screen asks a single-choice question. */
export function testFlowConfig(
  options: Array<{ id: string; title: string }> = [
    { id: "opt_1", title: "Yes" },
    { id: "opt_2", title: "No" },
  ]
): WhatsAppFlowConfig {
  return {
    templateId: "customer_feedback",
    metaFlowId: "flow-1",
    ctaText: "Open flow",
    screens: [
      {
        id: "screen_1",
        title: "Feedback",
        fields: [
          {
            id: "field_1",
            label: "Pick one",
            fieldType: "RadioButtonsGroup",
            options,
          },
        ],
      },
    ],
  };
}
