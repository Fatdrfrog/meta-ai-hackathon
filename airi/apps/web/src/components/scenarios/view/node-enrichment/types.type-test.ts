import type {
  ScenarioActionEditorNodeData,
  ScenarioEditorFlowNode,
  ScenarioFlowNode,
  ScenarioTriggerEditorFlowNode,
  ScenarioTriggerEditorNodeData,
  ScenarioTriggerEditorNodeProps,
} from "./types";
import type {
  ScenarioCanvasNode,
  ScenarioNodeData,
  ScenarioGraphEdge,
  ScenarioDocumentDTO,
  ScenarioRawGraphNode,
  ScenarioRawGraphEdge,
} from "@icecore/scenario-contracts";
import type { ScenarioDocument } from "../../types";

declare const transportDocument: ScenarioDocumentDTO<
  ScenarioCanvasNode,
  ScenarioGraphEdge
>;
const editableDocument: ScenarioDocument = transportDocument;
// @ts-expect-error Raw document envelopes need editor normalization before canvas use.
const canvasNodesFromDocument: ScenarioCanvasNode[] = editableDocument.nodes;
const transportDocumentFromEditor: ScenarioDocumentDTO<
  ScenarioRawGraphNode,
  ScenarioRawGraphEdge
> = editableDocument;
declare const rawTransportDocument: ScenarioDocumentDTO<
  ScenarioRawGraphNode,
  ScenarioRawGraphEdge
>;
const rawEditableDocument: ScenarioDocument = rawTransportDocument;
void rawEditableDocument;
void canvasNodesFromDocument;
void transportDocumentFromEditor;

const patchPersistedNode = (_patch: Partial<ScenarioNodeData>) => undefined;

const uploadWhatsAppServiceMedia: NonNullable<
  ScenarioActionEditorNodeData["uiMedia"]["upload"]
> = async () => ({
  url: "https://cdn.test/audio.ogg",
  mediaType: "audio",
});

const immutableConnectedBranchPayloads: readonly string[] = Object.freeze([
  "connected-branch",
]);
const immutableConnectedBranchSnapshots: ScenarioActionEditorNodeData["uiConnections"] =
  {
    telegramPayloads: immutableConnectedBranchPayloads,
    instagramPayloads: immutableConnectedBranchPayloads,
    whatsAppChoicePayloads: immutableConnectedBranchPayloads,
    flowBranchIds: immutableConnectedBranchPayloads,
    templateButtonPayloads: immutableConnectedBranchPayloads,
    sourceHandleIds: immutableConnectedBranchPayloads,
  };
// @ts-expect-error Connection snapshots cannot be mutated by an editor consumer.
immutableConnectedBranchSnapshots.sourceHandleIds.push("next");
// @ts-expect-error Connection snapshot fields cannot be replaced by an editor consumer.
immutableConnectedBranchSnapshots.flowBranchIds = [];

const triggerEditorData = {
  kind: "trigger",
  uiNodeLabel: "Client message",
  uiAudienceOptions: {
    channels: [],
    classificationCategories: [],
    customers: [],
    funnelStages: [],
    internalLabels: [],
    metaReferralAds: [],
    metaReferralCampaigns: [],
    metaReferralAdSets: [],
    metaCampaignLabels: [],
  },
  uiTriggerConfig: {
    enabled: true,
    messageMatchMode: "any",
    keywordMatchMode: "contains",
  },
  uiOnSelect: () => undefined,
  uiOnTriggerConfigChange: () => undefined,
  uiOnPatch: patchPersistedNode,
  uiOnRemove: () => undefined,
  uiIsEditorExpanded: true,
  uiHasMetaAdsConnection: false,
} satisfies ScenarioTriggerEditorNodeData;

const triggerEditorNode = {
  id: "trigger-1",
  type: "triggerNode",
  position: { x: 0, y: 0 },
  data: triggerEditorData,
} satisfies ScenarioTriggerEditorFlowNode;

const editorNode: ScenarioEditorFlowNode = triggerEditorNode;

const persistedNode: ScenarioFlowNode = {
  id: "trigger-1",
  position: { x: 0, y: 0 },
  data: {
    kind: "trigger",
    triggerConfig: { enabled: true, messageMatchMode: "any" },
  },
};

function assertSpecializedTriggerProps(
  props: ScenarioTriggerEditorNodeProps
): void {
  const kind: "trigger" = props.data.kind;
  props.data.uiOnTriggerConfigChange({ channelFilter: ["whatsapp"] });
  props.data.uiOnPatch({ triggerConfig: { enabled: false } });
  void kind;
}

void editorNode;
void persistedNode;
void uploadWhatsAppServiceMedia;
void immutableConnectedBranchSnapshots;
void assertSpecializedTriggerProps;
