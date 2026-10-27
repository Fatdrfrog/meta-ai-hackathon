import {
  SCENARIO_NODE_DATA_KEYS,
  SCENARIO_NODE_DATA_NESTED_CONFIG_KEYS,
  type ScenarioNodeData,
  type ScenarioNodeDataKey,
} from "./scenario-node-data";

const genericActionNode: ScenarioNodeData = {
  kind: "action",
  actionAttachments: [
    { url: "https://cdn.test/image.jpg", mediaType: "image" },
    { url: "https://cdn.test/video.mp4", mediaType: "video" },
    { url: "https://cdn.test/file.pdf", mediaType: "document" },
    // @ts-expect-error Generic action attachments do not support audio.
    { url: "https://cdn.test/audio.ogg", mediaType: "audio" },
    // @ts-expect-error Generic action attachments do not support stickers.
    { url: "https://cdn.test/sticker.webp", mediaType: "sticker" },
  ],
};

const generativeAIActionNode: ScenarioNodeData = {
  kind: "action",
  actionType: "generative_ai",
  actionGenerativeAIConfig: {
    version: 1,
    mode: "text_to_video",
    prompt: "Create a product video",
  },
};

const invalidGenerativeAIActionNode: ScenarioNodeData = {
  kind: "action",
  // @ts-expect-error Audio generation is not a supported scenario mode.
  actionGenerativeAIConfig: { version: 1, mode: "text_to_audio", prompt: "x" },
};

const canonicalTriggerNode: ScenarioNodeData = {
  kind: "trigger",
  // @ts-expect-error Canonical trigger nodes derive their one supported entry kind.
  triggerType: "incoming_customer_message",
};

const canonicalWhatsAppQrTriggerNode: ScenarioNodeData = {
  kind: "trigger",
  triggerConfig: {
    entryPointType: "whatsapp_qr",
    entryPointId: "entry-1",
  },
};

const canonicalWhatsAppQrTriggerRejectsProviderCode: ScenarioNodeData = {
  kind: "trigger",
  triggerConfig: {
    entryPointType: "whatsapp_qr",
    // @ts-expect-error Canonical QR triggers persist only the stable entry-point id.
    providerCode: "provider-code-1",
  },
};

const canonicalNodeRejectsPatchCallback: ScenarioNodeData = {
  kind: "action",
  // @ts-expect-error Canonical node data must not contain editor patch callbacks.
  uiOnPatch: (_patch: Partial<ScenarioNodeData>) => undefined,
};

const editorBoundary = {
  uiOnPatch: (_patch: Partial<ScenarioNodeData>) => undefined,
};
editorBoundary.uiOnPatch({
  // @ts-expect-error Editor patches accept persisted node data only.
  uiNodeLabel: "Derived editor label",
});

const canonicalNodeRejectsTriggerCallback: ScenarioNodeData = {
  kind: "action",
  // @ts-expect-error Canonical node data must not contain trigger callbacks.
  uiOnTriggerConfigChange: () => undefined,
};

const canonicalNodeRejectsActionCallback: ScenarioNodeData = {
  kind: "action",
  // @ts-expect-error Canonical node data must not contain action callbacks.
  uiOnActionTypeChange: () => undefined,
};

const canonicalNodeRejectsBrowserFile: ScenarioNodeData = {
  kind: "action",
  // @ts-expect-error Canonical node data must not expose browser File callbacks.
  uiOnUploadActionImage: async (_file: File) => undefined,
};

const canonicalNodeRejectsEditorSet: ScenarioNodeData = {
  kind: "action",
  // @ts-expect-error Canonical node data must not contain editor-only sets.
  uiConnectedColumnSplitHandleIds: new Set(["right-source-path_1"]),
};

const canonicalNodeRejectsFetchedResources: ScenarioNodeData = {
  kind: "action",
  // @ts-expect-error Canonical node data must not contain fetched UI resources.
  uiContextItems: [],
};

const canonicalNodeRejectsPreviewText: ScenarioNodeData = {
  kind: "action",
  // @ts-expect-error Canonical node data must not contain derived preview text.
  actionPreviewText: "Rendered preview",
};

const canonicalNodeRejectsPreviewImage: ScenarioNodeData = {
  kind: "action",
  // @ts-expect-error Canonical node data must not contain derived preview images.
  actionPreviewImageUrl: "https://cdn.test/preview.png",
};

const canonicalWhatsAppFlowActionNode: ScenarioNodeData = {
  kind: "action",
  actionFlowConfig: {
    templateId: "flow-action",
    screens: [],
    ctaText: "Open",
    flowMode: "published",
    flowActionPayload: {
      screen: "FIRST_ENTRY_SCREEN",
      data: { product_name: "name" },
    },
    categories: ["LEAD_GENERATION"],
    endpointUri: "https://example.com/flow-endpoint",
    applicationId: "meta-app-1",
    metaFlowName: "appointment_booking_v1",
  },
};

void genericActionNode;
void canonicalWhatsAppFlowActionNode;
void generativeAIActionNode;
void invalidGenerativeAIActionNode;
void canonicalTriggerNode;
void canonicalWhatsAppQrTriggerNode;
void canonicalWhatsAppQrTriggerRejectsProviderCode;
void canonicalNodeRejectsPatchCallback;
void editorBoundary;
void canonicalNodeRejectsTriggerCallback;
void canonicalNodeRejectsActionCallback;
void canonicalNodeRejectsBrowserFile;
void canonicalNodeRejectsEditorSet;
void canonicalNodeRejectsFetchedResources;
void canonicalNodeRejectsPreviewText;
void canonicalNodeRejectsPreviewImage;

type ExpectNever<T extends never> = T;

type _MissingNodeDataKeys = ExpectNever<
  Exclude<keyof ScenarioNodeData, ScenarioNodeDataKey>
>;
type _ExtraNodeDataKeys = ExpectNever<
  Exclude<ScenarioNodeDataKey, keyof ScenarioNodeData>
>;
type _NestedConfigKeysAreKnown = ExpectNever<
  Exclude<
    (typeof SCENARIO_NODE_DATA_NESTED_CONFIG_KEYS)[number],
    ScenarioNodeDataKey
  >
>;

const _catalogMatchesType: readonly ScenarioNodeDataKey[] = SCENARIO_NODE_DATA_KEYS;

const canonicalNodeRejectsNewTopLevelActionField: ScenarioNodeData = {
  kind: "action",
  // @ts-expect-error Canonical node data refuses new top-level action* fields.
  actionOtpCode: "123456",
};

void _catalogMatchesType;
void canonicalNodeRejectsNewTopLevelActionField;
