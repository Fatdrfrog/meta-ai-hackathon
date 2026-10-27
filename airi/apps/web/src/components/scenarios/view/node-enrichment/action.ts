import { readLoadableWhatsAppTemplateFormFlowId } from "@/lib/scenarios/whatsapp-template-form-snapshot";
import { findMatchingScenarioWhatsAppTemplate } from "@/lib/scenarios/whatsapp-template-selection";
import { whatsappTemplateOffersFormSubmittedRoute } from "@/lib/scenarios/transition-registry";
import {
  getScenarioWhatsAppTemplateDefaultContextKey,
  listScenarioWhatsAppTemplateParameters,
  readSingleWhatsAppTemplateFlowButtonFlowId,
  renderScenarioWhatsAppTemplateBindingPreview,
  resolveScenarioWhatsAppTemplateBindings,
  type ScenarioLegacyActionRoutingPresentation,
  type WhatsAppComponent,
} from "@icecore/scenario-contracts";
import { TEMPLATE_BINDING_CONTEXT_LABELS } from "../../nodes/action-node/action-node-whatsapp-template-binding-labels";
import { resolveAvailableSourceHandleIds } from "../../graph/source-handles";
import type {
  ScenarioActionSelectorType,
  ScenarioFlowNode,
  ScenarioNodeData,
  ScenarioReplyMode,
  ScenarioWhatsAppTemplatePreview,
} from "../../types";
import type { ManagedWhatsAppFlowProvisioningHost } from "../../builders/whatsapp/managed-provisioning-host";
import { resolveScenarioWhatsAppInteractiveFlowConfig } from "@/lib/scenarios/whatsapp-service-message";
import { listScenarioFormAnswersKeyStampsReadBy } from "@/lib/scenarios/scenario-form-answer-checks";
import {
  buildActionPatchForSelector,
  buildActionSourceOptions,
  buildActionWhatsAppTemplateSelectionPatch,
  patchAffectsActionBranchOptions,
  resolveActionSelectorTypeForNode,
  resolveActionSourceIdForSelector,
  resolveActionTemplateOptions,
  resolveActionTemplateValue,
} from "../action/selector-utils";
import {
  ACTION_BRANCH_DESCRIPTORS,
  INSTAGRAM_BRANCH_DESCRIPTOR,
  TELEGRAM_BRANCH_DESCRIPTOR,
} from "../graph/branch-sync";
import {
  buildDraftActionPreviewText,
  buildScenarioPreviewContext,
  buildWhatsAppTemplatePreview,
} from "../preview/utils";
import type {
  BranchSyncOptions,
  HandleBranchSyncForNode,
} from "../scenario-node-enrichment-context";
import {
  resolveReplyModeFromNodeData,
  resolveScenarioActionTypeFromNodeData,
} from "@icecore/airi-runtime/scenario-action-semantics";
import { resolveAiReplyPreviewText } from "../../scenario-node-labels";
import { resolveScenarioNodeDataWithLiveWhatsAppTemplate } from "../scenario-template-utils";
import type { ScenarioActionEnrichmentView } from "./action-view";
import { buildCommonNodeEnrichment } from "./common";
import type {
  ScenarioActionConnections,
  ScenarioActionEditorNodeData,
  ScenarioActionWhatsAppFlows,
  ScenarioActionWhatsAppTemplates,
  ScenarioPersistedNodeDataOfKind,
} from "./types";

export {
  selectActionEnrichmentView,
  type ScenarioActionEnrichmentView,
} from "./action-view";

type ActionNodeData = ScenarioPersistedNodeDataOfKind<"action">;

type ActionRoutingPatch = {
  actionOutcomes?: ScenarioNodeData["actionOutcomes"];
  actionRunConditions?: ScenarioNodeData["actionRunConditions"];
};

type LegacyRoutingConverter = (patch: ActionRoutingPatch) => Promise<boolean>;

type SyncBranchesForNode = (
  descriptors: Parameters<HandleBranchSyncForNode>[1],
  patch: Partial<ScenarioNodeData>,
  options?: BranchSyncOptions
) => void;

/** The step as the canvas shows it: its live template and preview. */
type ActionDisplayState = {
  displayData: ActionNodeData;
  selectorType: ScenarioActionSelectorType;
  promptInputs: NonNullable<
    ScenarioActionEditorNodeData["uiScenarioPromptInputs"]
  >;
  formAnswerSources: ScenarioActionEditorNodeData["uiScenarioFormAnswerSources"];
  whatsAppPreview: ScenarioWhatsAppTemplatePreview | null;
  previewText: string;
};

/**
 * Stores the key of each form the step's AI prompt now reads, once, so the
 * prompt keeps reading that form when an earlier form changes.
 */
function stampFormAnswersKeysReadBy(
  data: ScenarioNodeData,
  ctx: Pick<ScenarioActionEnrichmentView, "graphIndex" | "callbacksRef">
): void {
  const stamps = ctx.graphIndex.scenarioFormKeyStampsByFormKey;
  if (!stamps) return;
  for (const stamp of listScenarioFormAnswersKeyStampsReadBy(data, stamps)) {
    ctx.callbacksRef.current.updateNodeById(stamp.nodeId, stamp.patch);
  }
}

function hasOwnField(patch: object, key: keyof ActionRoutingPatch): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

/** The legacy nodes a routing patch converts, each with its part of the patch. */
function listLegacyRoutingConversions(
  legacyRouting: ScenarioLegacyActionRoutingPresentation,
  patch: ActionRoutingPatch
) {
  const hasOutcomes = hasOwnField(patch, "actionOutcomes");
  const hasRunConditions = hasOwnField(patch, "actionRunConditions");
  const outcomesSource = legacyRouting.actionOutcomesSource;
  const runConditionsSource = legacyRouting.actionRunConditionsSource;
  return [
    ...(hasOutcomes && outcomesSource
      ? [
          {
            source: outcomesSource,
            patch: { actionOutcomes: patch.actionOutcomes },
          },
        ]
      : []),
    ...(hasRunConditions && runConditionsSource
      ? [
          {
            source: runConditionsSource,
            patch: { actionRunConditions: patch.actionRunConditions },
          },
        ]
      : []),
    ...(!hasOutcomes && !hasRunConditions && outcomesSource
      ? [{ source: outcomesSource, patch: {} }]
      : []),
  ];
}

/**
 * Converts the step's legacy routing nodes. The canvas callback is read when
 * the conversion runs, so a step kept from an earlier pass uses the current
 * one.
 */
function createLegacyRoutingConverter(
  nodeId: string,
  legacyRouting: ScenarioLegacyActionRoutingPresentation | undefined,
  ctx: ScenarioActionEnrichmentView
): LegacyRoutingConverter | null {
  const available =
    ctx.legacyRoutingConversionAvailable ??
    Boolean(ctx.callbacksRef.current.convertLegacyActionRouting);
  if (!legacyRouting || !available) return null;
  return async patch => {
    const requests = listLegacyRoutingConversions(legacyRouting, patch);
    if (requests.length === 0) return false;

    for (const request of requests) {
      const converted =
        await ctx.callbacksRef.current.convertLegacyActionRouting?.({
          sourceActionNodeId: nodeId,
          sourceNodeId: request.source.sourceNodeId,
          sourceKind: request.source.sourceKind,
          patch: request.patch,
        });
      if (!converted) return false;
    }
    return true;
  };
}

function resolveActionReplySeed(
  displayData: ActionNodeData,
  selectorType: ScenarioActionSelectorType
) {
  const replyMode: ScenarioReplyMode =
    selectorType === "telegram_builder"
      ? "fixed"
      : resolveReplyModeFromNodeData(displayData);
  const actionType =
    resolveScenarioActionTypeFromNodeData(displayData) ?? "reply";
  const replySeed =
    actionType === "reply" && replyMode === "fixed"
      ? (displayData.actionReplyText || "").trim()
      : "";
  return { replyMode, actionType, replySeed };
}

function listActionPreviewImageUrls(displayData: ActionNodeData): string[] {
  const mediaUrls = (displayData.actionMediaAssets || [])
    .map(asset => asset.url)
    .filter(Boolean);
  return Array.from(
    new Set([
      ...(displayData.actionAttachments || []).map(
        attachment => attachment.url
      ),
      ...(displayData.actionImageUrls || []),
      ...mediaUrls,
    ])
  );
}

/**
 * A step that sets no values fills each variable from customer data. Named
 * variables preview with sample data; positional ones ({{1}}) name the data
 * they get, as "[Customer name]", instead of previewing empty.
 */
function previewTemplateDefaultValues(
  components: WhatsAppComponent[] | undefined,
  t: ScenarioActionEnrichmentView["t"]
): WhatsAppComponent[] | undefined {
  const parameters = listScenarioWhatsAppTemplateParameters(components).filter(
    parameter => /^\d+$/.test(parameter.variable)
  );
  if (!components || parameters.length === 0) return components;
  const values = Object.fromEntries(
    parameters.map(parameter => [
      parameter.id,
      `[${t(
        TEMPLATE_BINDING_CONTEXT_LABELS[
          getScenarioWhatsAppTemplateDefaultContextKey(parameter.variable)
        ]
      )}]`,
    ])
  );
  return renderScenarioWhatsAppTemplateBindingPreview(components, values);
}

function buildActionWhatsAppPreview(
  displayData: ActionNodeData,
  context: ReturnType<typeof buildScenarioPreviewContext>,
  t: ScenarioActionEnrichmentView["t"]
): ScenarioWhatsAppTemplatePreview | null {
  const templateBindings = displayData.actionWhatsAppTemplateBindings;
  const boundTemplateComponents = templateBindings
    ? renderScenarioWhatsAppTemplateBindingPreview(
        displayData.actionWhatsAppTemplateComponents ?? [],
        resolveScenarioWhatsAppTemplateBindings({
          components: displayData.actionWhatsAppTemplateComponents,
          bindings: templateBindings,
        }).values
      )
    : previewTemplateDefaultValues(
        displayData.actionWhatsAppTemplateComponents,
        t
      );
  const basePreview = buildWhatsAppTemplatePreview({
    components: boundTemplateComponents,
    context,
    translate: t,
    preserveUnresolvedVariables: Boolean(templateBindings),
  });
  const generatedDraft = displayData.generatedTemplateDraft;
  if (!basePreview || !generatedDraft?.headerMediaUrl) return basePreview;
  return {
    ...basePreview,
    headerMediaUrl: generatedDraft.headerMediaUrl,
    headerMediaFormat:
      generatedDraft.headerMediaFormat || basePreview.headerMediaFormat,
  };
}

// Empty stays empty: the card decides how to show a step with no content.
function resolveActionPreviewText(params: {
  displayData: ActionNodeData;
  selectorType: ScenarioActionSelectorType;
  actionType: string;
  replyMode: ScenarioReplyMode;
  whatsAppPreview: ScenarioWhatsAppTemplatePreview | null;
  draftPreviewText: string;
  promptInputs: ActionDisplayState["promptInputs"];
  formAnswerSources: ActionDisplayState["formAnswerSources"];
  t: ScenarioActionEnrichmentView["t"];
}): string {
  const { displayData, actionType } = params;
  if (actionType === "whatsapp_template") {
    return (
      (params.whatsAppPreview?.bodyText || "").trim() || params.draftPreviewText
    );
  }
  if (actionType === "assign_human") {
    return (displayData.actionInstruction || "").trim();
  }
  if (
    actionType !== "reply" ||
    params.replyMode !== "ai" ||
    params.selectorType === "whatsapp_service_message"
  ) {
    return params.draftPreviewText;
  }
  return resolveAiReplyPreviewText({
    instruction: displayData.actionReplyInstruction,
    nodeData: {
      ...displayData,
      uiScenarioPromptInputs: params.promptInputs,
      uiScenarioFormAnswerSources: params.formAnswerSources,
    },
    t: params.t,
  });
}

function resolveActionDisplayState(
  nodeId: string,
  rawData: ActionNodeData,
  ctx: ScenarioActionEnrichmentView
): ActionDisplayState {
  const displayData = resolveScenarioNodeDataWithLiveWhatsAppTemplate({
    nodeData: rawData,
    whatsAppTemplates: ctx.whatsAppTemplates,
  }) as ActionNodeData;
  const selectorType = resolveActionSelectorTypeForNode(displayData);
  const { replyMode, actionType, replySeed } = resolveActionReplySeed(
    displayData,
    selectorType
  );
  const index = ctx.graphIndex;
  const promptInputs =
    index.scenarioPromptInputsByNodeId.get(nodeId) ??
    index.scenarioPromptInputs ??
    [];
  const formAnswerSources =
    index.scenarioFormAnswerSourcesByNodeId?.get(nodeId);
  const previewContext = buildScenarioPreviewContext({
    reply: replySeed,
    links: displayData.actionLinkUrls || [],
    images: listActionPreviewImageUrls(displayData),
    profile: index.previewProfileByActionId.get(nodeId),
    translate: ctx.t,
    promptInputs,
    formAnswers: formAnswerSources,
  });
  const draftPreviewText = buildDraftActionPreviewText({
    template: undefined,
    reply: replySeed,
    context: previewContext,
  }).trim();
  const whatsAppPreview = buildActionWhatsAppPreview(
    displayData,
    previewContext,
    ctx.t
  );
  return {
    displayData,
    selectorType,
    promptInputs,
    formAnswerSources,
    whatsAppPreview,
    previewText: resolveActionPreviewText({
      displayData,
      selectorType,
      actionType,
      replyMode,
      whatsAppPreview,
      draftPreviewText,
      promptInputs,
      formAnswerSources,
      t: ctx.t,
    }),
  };
}

function ownedSourceHandleKey(nodeId: string, data: ScenarioNodeData) {
  return resolveAvailableSourceHandleIds({
    id: nodeId,
    position: { x: 0, y: 0 },
    data,
  } as ScenarioFlowNode)
    .sort()
    .join("\u0000");
}

// Branch sync drops edges from handles an action stops owning, which would
// detach a legacy wait; convert it first, as opening an outcome does.
function createBranchSync(params: {
  nodeId: string;
  rawData: ActionNodeData;
  legacyRouting: ScenarioLegacyActionRoutingPresentation | undefined;
  convertLegacyRouting: LegacyRoutingConverter | null;
  ctx: ScenarioActionEnrichmentView;
}): SyncBranchesForNode {
  const { nodeId, rawData, legacyRouting, convertLegacyRouting, ctx } = params;
  return (descriptors, patch, options) => {
    const sync = () =>
      ctx.handleBranchSyncForNodeRef.current(
        nodeId,
        descriptors,
        patch,
        options
      );
    if (
      !legacyRouting?.actionOutcomesSource ||
      !convertLegacyRouting ||
      ownedSourceHandleKey(nodeId, rawData) ===
        ownedSourceHandleKey(nodeId, { ...rawData, ...patch })
    ) {
      sync();
      return;
    }
    void convertLegacyRouting({}).then(converted => {
      if (converted) sync();
    });
  };
}

function isRoutingOnlyPatch(patchKeys: string[]): boolean {
  return (
    patchKeys.length > 0 &&
    patchKeys.every(
      key => key === "actionOutcomes" || key === "actionRunConditions"
    )
  );
}

function canConvertRoutingField(
  key: string,
  legacyRouting: ScenarioLegacyActionRoutingPresentation | undefined
): boolean {
  if (key === "actionOutcomes") {
    return Boolean(legacyRouting?.actionOutcomesSource);
  }
  return key === "actionRunConditions"
    ? Boolean(legacyRouting?.actionRunConditionsSource)
    : false;
}

function pickRoutingPatch(patch: Partial<ScenarioNodeData>) {
  return {
    ...(hasOwnField(patch, "actionOutcomes")
      ? { actionOutcomes: patch.actionOutcomes }
      : {}),
    ...(hasOwnField(patch, "actionRunConditions")
      ? { actionRunConditions: patch.actionRunConditions }
      : {}),
  };
}

function createActionPatchHandler(params: {
  nodeId: string;
  rawData: ActionNodeData;
  legacyRouting: ScenarioLegacyActionRoutingPresentation | undefined;
  convertLegacyRouting: LegacyRoutingConverter | null;
  syncBranchesForNode: SyncBranchesForNode;
  ctx: ScenarioActionEnrichmentView;
}): ScenarioActionEditorNodeData["uiOnPatch"] {
  const { nodeId, rawData, legacyRouting, convertLegacyRouting, ctx } = params;
  return patch => {
    stampFormAnswersKeysReadBy({ ...rawData, ...patch }, ctx);
    const patchKeys = Object.keys(patch);
    if (
      convertLegacyRouting &&
      isRoutingOnlyPatch(patchKeys) &&
      patchKeys.every(key => canConvertRoutingField(key, legacyRouting))
    ) {
      void convertLegacyRouting(pickRoutingPatch(patch));
      return;
    }
    if (patchAffectsActionBranchOptions(patch)) {
      params.syncBranchesForNode(ACTION_BRANCH_DESCRIPTORS, patch);
      return;
    }
    ctx.callbacksRef.current.updateNodeById(nodeId, patch);
  };
}

function buildActionWhatsAppTemplates(params: {
  nodeId: string;
  rawData: ActionNodeData;
  display: ActionDisplayState;
  syncBranchesForNode: SyncBranchesForNode;
  ctx: ScenarioActionEnrichmentView;
}): ScenarioActionWhatsAppTemplates {
  const { nodeId, rawData, display, ctx } = params;
  const options = resolveActionTemplateOptions({
    nodeData: display.displayData,
    whatsAppTemplates: ctx.whatsAppTemplates,
  });
  return {
    catalogMatch: Boolean(
      findMatchingScenarioWhatsAppTemplate({
        nodeData: display.displayData,
        whatsAppTemplates: ctx.whatsAppTemplates,
      })
    ),
    options,
    selectedValue: resolveActionTemplateValue({
      nodeData: display.displayData,
      actionTemplates: options,
    }),
    onOpenChange: open => {
      if (!open) return;
      void ctx.callbacksRef.current.loadWhatsAppTemplates();
    },
    // Routes stay on matching buttons; the toast can undo the rest.
    select: templateValue => {
      const patch = buildActionWhatsAppTemplateSelectionPatch({
        nodeData: rawData,
        templateValue,
        whatsAppTemplates: ctx.whatsAppTemplates,
      });
      if (!patch) return;
      params.syncBranchesForNode(ACTION_BRANCH_DESCRIPTORS, patch, {
        templatePick: true,
      });
      // AI steps read the answers of the form the template's button opens.
      // The load skips a bulk send's template, which has no Form submitted
      // route.
      if (
        readSingleWhatsAppTemplateFlowButtonFlowId(
          patch.actionWhatsAppTemplateComponents
        )
      ) {
        void ctx.loadWhatsAppTemplateForm(nodeId, { reason: "pick" });
      }
    },
    refresh: () => ctx.callbacksRef.current.loadWhatsAppTemplates(true),
    preview: display.whatsAppPreview,
    submittingGenerated: ctx.submittingGeneratedTemplateNodeId === nodeId,
    submitGenerated: () => ctx.submitGeneratedTemplateForNode(nodeId),
    formFields: {
      // The saved step, as the loader reads it, not the display copy.
      flowId: readLoadableWhatsAppTemplateFormFlowId(rawData),
      loading: ctx.loadingTemplateFormNodeIds?.has(nodeId) ?? false,
      load: (reason, options) =>
        ctx.loadWhatsAppTemplateForm(nodeId, { ...options, reason }),
    },
  };
}

function buildActionWhatsAppFlows(
  nodeId: string,
  displayData: ActionNodeData,
  ctx: ScenarioActionEnrichmentView
): ScenarioActionWhatsAppFlows {
  const managedProvisioningHost = {
    sources: ctx.managedWhatsAppFlowProvisioningSources,
    ownerKey: JSON.stringify([ctx.scenarioSessionOwnerKey, nodeId]),
    publishing: ctx.publishingManagedFlowNodeId === nodeId,
    publish: params => ctx.publishManagedWhatsAppFlow({ ...params, nodeId }),
  } satisfies ManagedWhatsAppFlowProvisioningHost;
  return {
    openingPreviewId:
      ctx.openingLinkedWhatsAppFlowNodeId === nodeId
        ? ctx.openingLinkedWhatsAppFlowId
        : null,
    openPreview: (flowId, flowAction) =>
      ctx.callbacksRef.current.openLinkedWhatsAppFlowPreview(
        nodeId,
        flowId,
        flowAction,
        resolveScenarioWhatsAppInteractiveFlowConfig(displayData)
      ),
    options: ctx.whatsAppFlows,
    onCtaOptionsOpenChange: open => {
      if (!open) return;
      void ctx.callbacksRef.current.loadWhatsAppFlows();
    },
    openPicker: () => {
      void ctx.callbacksRef.current.loadWhatsAppFlows();
    },
    select: flow => ctx.selectExistingFlowForNodeRef.current(nodeId, flow),
    refresh: () => {
      void ctx.callbacksRef.current.loadWhatsAppFlows(true);
    },
    managedProvisioningHost,
  };
}

function buildActionConnections(
  nodeId: string,
  index: ScenarioActionEnrichmentView["graphIndex"]
): ScenarioActionConnections {
  return {
    destinationsBySourceHandle:
      index.destinationsBySourceHandleByNodeId?.get(nodeId),
    telegramPayloads:
      index.connectedTelegramBranchPayloadsByActionId.get(nodeId) ?? [],
    sourceHandleIds: index.connectedSourceHandleIdsByNodeId.get(nodeId) ?? [],
    instagramPayloads:
      index.connectedInstagramBranchPayloadsByActionId.get(nodeId) ?? [],
    whatsAppChoicePayloads:
      index.connectedWhatsAppSessionChoicePayloadsByActionId.get(nodeId) ?? [],
    flowBranchIds: index.connectedFlowBranchIdsByActionId.get(nodeId) ?? [],
    templateButtonPayloads:
      index.connectedWhatsAppTemplateButtonPayloadsByActionId.get(nodeId) ?? [],
  };
}

function isBulkPrimaryAction(
  nodeId: string,
  index: ScenarioActionEnrichmentView["graphIndex"]
): boolean {
  return index.bulkPrimaryActionIds?.has(nodeId) ?? false;
}

function readFormAnswerTokensRead(
  nodeId: string,
  index: ScenarioActionEnrichmentView["graphIndex"]
): readonly string[] {
  const formKey = index.scenarioFormKeysByNodeId?.get(nodeId);
  return (
    (formKey && index.scenarioFormAnswerTokensByFormKey?.get(formKey)) || []
  );
}

/** What the step shows about its place in the graph. */
function buildActionGraphEnrichment(
  nodeId: string,
  display: ActionDisplayState,
  ctx: ScenarioActionEnrichmentView
) {
  const index = ctx.graphIndex;
  const bulkPrimaryAction = isBulkPrimaryAction(nodeId, index);
  return {
    uiBulkPrimaryAction: bulkPrimaryAction,
    uiBulkPrimaryWhatsAppTemplate:
      index.bulkPrimaryWhatsAppTemplateIds?.has(nodeId) ?? false,
    uiBulkRouteRecipients: bulkPrimaryAction
      ? [...(index.bulkRouteRecipientsByActionId.get(nodeId) ?? [])]
      : undefined,
    uiInstagramReplyDisabledReason:
      index.instagramReplyActionIdsBlockedByBulkRoot.has(nodeId)
        ? ctx.t("instagramReplyBulkDisabled")
        : null,
    uiActionNodeCount: index.actionNodeCount,
    uiScenarioPromptInputs: display.promptInputs,
    uiScenarioPickedOptionSources:
      index.scenarioPickedOptionSourcesByNodeId?.get(nodeId) ?? [],
    uiScenarioFormAnswerSources: display.formAnswerSources,
    uiScenarioFormKeys: index.scenarioFormKeysByNodeId,
    uiScenarioFormAnswerTokensRead: readFormAnswerTokensRead(nodeId, index),
    uiIncomingRouteCount: index.incomingRouteCountByNodeId?.get(nodeId) ?? 0,
    uiReachedAfterLongNoReply:
      index.reachedAfterLongNoReplyNodeIds?.has(nodeId) ?? false,
    uiConnections: buildActionConnections(nodeId, index),
  };
}

function buildActionCommands(
  display: ActionDisplayState,
  convertLegacyRouting: LegacyRoutingConverter | null,
  syncBranchesForNode: SyncBranchesForNode,
  ctx: ScenarioActionEnrichmentView,
  nodeId: string
): ScenarioActionEditorNodeData["uiActionCommands"] {
  return {
    convertLegacyRouting: convertLegacyRouting
      ? async patch => {
          await convertLegacyRouting(patch);
        }
      : undefined,
    changeType: nextActionType => {
      syncBranchesForNode(
        ACTION_BRANCH_DESCRIPTORS,
        buildActionPatchForSelector({
          nodeData: display.displayData,
          selectorType: nextActionType,
        })
      );
    },
    changeReplyMode: mode =>
      ctx.callbacksRef.current.updateNodeById(nodeId, {
        kind: "action",
        actionType: "reply",
        actionReplyMode: mode,
      }),
    changeTelegramQuickReplies: quickReplies =>
      syncBranchesForNode(TELEGRAM_BRANCH_DESCRIPTOR, {
        actionTelegramQuickReplies: quickReplies,
      }),
    changeInstagramConfig: config =>
      syncBranchesForNode(INSTAGRAM_BRANCH_DESCRIPTOR, {
        actionInstagramConfig: config,
      }),
  };
}

function buildActionMedia(
  nodeId: string,
  ctx: ScenarioActionEnrichmentView
): ScenarioActionEditorNodeData["uiMedia"] {
  return {
    upload: (file, options) =>
      ctx.callbacksRef.current.uploadActionImageForNodeId(
        nodeId,
        file,
        options
      ),
    generateVoice: params =>
      ctx.callbacksRef.current.generateActionVoiceForNodeId(nodeId, params),
    remove: imageUrl =>
      ctx.callbacksRef.current.removeActionImageUrlByNodeId(nodeId, imageUrl),
  };
}

export function enrichActionNodeData(
  nodeId: string,
  rawData: ActionNodeData,
  ctx: ScenarioActionEnrichmentView
): ScenarioActionEditorNodeData {
  const display = resolveActionDisplayState(nodeId, rawData, ctx);
  const legacyRouting = ctx.legacyRoutingByActionId.get(nodeId);
  const convertLegacyRouting = createLegacyRoutingConverter(
    nodeId,
    legacyRouting,
    ctx
  );
  const syncBranchesForNode = createBranchSync({
    nodeId,
    rawData,
    legacyRouting,
    convertLegacyRouting,
    ctx,
  });
  const {
    uiOnRemove,
    uiOnSelect,
    uiValidationMode,
    uiUsesSettingsPanel,
    uiOnOpenSettings,
  } = buildCommonNodeEnrichment(nodeId, ctx);

  return {
    ...display.displayData,
    uiValidationMode,
    uiUsesSettingsPanel,
    uiOnSelect,
    uiOnOpenSettings,
    uiOnPatch: createActionPatchHandler({
      nodeId,
      rawData,
      legacyRouting,
      convertLegacyRouting,
      syncBranchesForNode,
      ctx,
    }),
    uiOnRemove,
    uiOnCreateNodeFromSourceHandle: async (
      sourceHandleId,
      clientX,
      clientY
    ) => {
      if (
        legacyRouting?.actionOutcomesSource &&
        convertLegacyRouting &&
        !(await convertLegacyRouting({}))
      ) {
        return;
      }
      ctx.openNodePickerFromHandle(nodeId, sourceHandleId, clientX, clientY);
    },
    uiAudienceOptions: ctx.audienceOptions,
    uiActionSourceOptions: buildActionSourceOptions({
      connectedActionSources: ctx.connectedActionSources,
      selectedSourceId: resolveActionSourceIdForSelector(display.selectorType),
      t: ctx.t,
    }),
    actionPreviewText: display.previewText || undefined,
    ...buildActionGraphEnrichment(nodeId, display, ctx),
    // The saved step, not the display copy, as validation and runtime read it.
    uiSavedStepOffersFormSubmittedRoute:
      whatsappTemplateOffersFormSubmittedRoute(rawData),
    uiWorkspaceId: ctx.workspaceId,
    uiActiveScenarioId: ctx.activeScenarioId,
    uiIsEditorExpanded: ctx.selectedNodeId === nodeId,
    uiSourceCapabilities: ctx.sourceCapabilities,
    uiActionCommands: buildActionCommands(
      display,
      convertLegacyRouting,
      syncBranchesForNode,
      ctx,
      nodeId
    ),
    uiWhatsAppTemplates: buildActionWhatsAppTemplates({
      nodeId,
      rawData,
      display,
      syncBranchesForNode,
      ctx,
    }),
    uiWhatsAppFlows: buildActionWhatsAppFlows(nodeId, display.displayData, ctx),
    uiMedia: buildActionMedia(nodeId, ctx),
  };
}
