"use client";
import {
  useCampaignTimeFormatter,
  useRetryLocked,
} from "@/components/campaigns/campaign-retry-time";
import { SCENARIO_NODE_CHANNEL_PREVIEW_BLEED_CLASS } from "@/components/scenarios/nodes/node-card";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { FormProvider } from "react-hook-form";
import { ScenarioHiddenSourceHandles } from "../../scenario-hidden-source-handles";
import type { ScenarioNodeData } from "../../types";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import type { FlowBranchOptionHandleRenderParams } from "../../builders/whatsapp/field-editor";
import { WhatsAppActionRenderer } from "../../builders/whatsapp/action-renderer";
import { WhatsAppTemplateButtonEditorTray } from "../../builders/whatsapp/template-button-editor-tray";
import {
  getWhatsAppTemplateHeaderMediaFormat,
  isWhatsAppTemplateCarousel,
} from "../../builders/whatsapp/template-editor-utils";
import { FlowBranchPreview } from "./action-node-flow-branch-preview";
import { ActionNodeWhatsAppTemplateCarousel } from "./action-node-whatsapp-template-carousel";
import {
  resolveActionNodeFormSubmittedRoute,
  type ActionNodeBranchState,
  type ActionNodeModeState,
} from "./action-node-state";
import { ActionNodeWhatsAppFlowBuilder } from "./action-node-whatsapp-flow-section";
import {
  buildWhatsAppTemplateButtonTypeOptions,
  findTemplateFormSubmittedButtonIndex,
  listTemplateButtonRoutesRemovedOnSave,
  listUnshownTemplateButtonRouteHandles,
  resolveWhatsAppTemplateCatalogView,
  resolveWhatsAppTemplateSaveView,
  resolveWhatsAppTemplateSelectionView,
  translateWhatsAppTemplateEditorErrors,
} from "./action-node-whatsapp-template-section-state";
import {
  WhatsAppTemplateButtonDriftNotice,
  WhatsAppTemplateFlowDrawer,
  WhatsAppTemplateGeneratedDraftStatus,
  WhatsAppTemplatePickerField,
  WhatsAppTemplateRejectedNotice,
  WhatsAppTemplateSaveBar,
  WhatsAppTemplateSaveConfirmDialog,
} from "./action-node-whatsapp-template-section-ui";
import { ActionNodeWhatsAppTemplateVariables } from "./action-node-whatsapp-template-variables";
import { useWhatsAppTemplateControls } from "./use-whatsapp-template-controls";
import { useWhatsAppTemplateEditor } from "./use-whatsapp-template-editor";
import { useWhatsAppTemplateCreation } from "./use-whatsapp-template-creation";
import { useWhatsAppTemplateFlowScreens } from "./use-whatsapp-template-flow-screens";
import { useWhatsAppTemplatePreviewButtons } from "./use-whatsapp-template-preview-buttons";
import { ActionNodeWhatsAppTemplateFlowHealth } from "./action-node-whatsapp-template-flow-health";
import { useScenarioGraphResources } from "../../view/graph/resources-context";
import { ScenarioInlineNotice } from "../../scenario-inline-notice";
import { ActionNodeWhatsAppTemplateFormFields } from "./action-node-whatsapp-template-form-fields";

const LazyTemplateFormDrawer = lazy(() =>
  import("@/components/whatsapp-templates/template-form-drawer").then(m => ({
    default: m.TemplateFormDrawer,
  }))
);

type ActionNodeWhatsAppTemplateSectionProps = {
  id: string;
  branchState: ActionNodeBranchState;
  createNodeFromSourceHandle?: ScenarioActionEditorNodeData["uiOnCreateNodeFromSourceHandle"];
  /**
   * The canvas overlays the Flow drawer on the node; node settings place it
   * in their scrolling column, where an overlay could cover fields above.
   */
  flowDrawerPlacement?: "overlay" | "inline";
  loadingLabel: string;
  mode: ActionNodeModeState;
  nodeData: ScenarioActionEditorNodeData;
  onTemplateHasFlowButtonChange?: (hasFlowButton: boolean) => void;
  patchNode: (patch: Partial<ScenarioNodeData>) => void;
  refreshNodeInternals?: () => void;
  renderInlineFlowBranchHandle?: (
    params: FlowBranchOptionHandleRenderParams
  ) => ReactNode;
  scheduleNodeInternalsUpdate?: () => void;
  /** Render quick-reply route handles (canvas only). */
  showPorts?: boolean;
  whatsAppFlowsLoading: boolean;
  whatsAppFlowsRefreshing: boolean;
  whatsAppTemplatesLoading: boolean;
  whatsAppTemplatesRefreshing: boolean;
};

export function ActionNodeWhatsAppTemplateSection({
  id,
  branchState,
  createNodeFromSourceHandle,
  flowDrawerPlacement = "overlay",
  loadingLabel,
  mode,
  nodeData,
  onTemplateHasFlowButtonChange,
  patchNode,
  refreshNodeInternals,
  renderInlineFlowBranchHandle,
  scheduleNodeInternalsUpdate,
  showPorts = true,
  whatsAppFlowsLoading,
  whatsAppFlowsRefreshing,
  whatsAppTemplatesLoading,
  whatsAppTemplatesRefreshing,
}: ActionNodeWhatsAppTemplateSectionProps) {
  const t = useTranslations("Scenarios");
  const tTemplates = useTranslations("templates");
  const tPlan = useTranslations("CampaignDispatchPlanCard");
  const { whatsAppTemplatesError } = useScenarioGraphResources();
  const formatRetryTime = useCampaignTimeFormatter();
  const retryAt = Date.parse(whatsAppTemplatesError?.retryAt || "");
  const coolingDown = useRetryLocked(Number.isFinite(retryAt) ? retryAt : null);
  // Only Meta's own limit reads as a limit, as on the bulk node; a network or
  // server failure also waits before the next try.
  const retryAfterText = coolingDown
    ? whatsAppTemplatesError?.code === "WHATSAPP_TEMPLATES_RATE_LIMITED"
      ? tTemplates("alerts.refreshCooldown", { time: formatRetryTime(retryAt) })
      : tPlan("readiness.cooldownUntil", { time: formatRetryTime(retryAt) })
    : null;
  const templateEditorWorkspaceId = mode.templateEditorWorkspaceId;
  const canEditTemplateFlow = mode.canEditTemplateFlow;
  const controls = useWhatsAppTemplateControls({
    id,
    nodeData,
    mode,
    patchNode,
    flowExistingLoadFailedMessage: t("flowExistingLoadFailed"),
  });
  const templateFlowDrawerOpen = controls.flowDrawerOpen;

  useEffect(() => {
    scheduleNodeInternalsUpdate?.();
  }, [
    branchState.flowBranchHandleSignature,
    branchState.whatsAppTemplateButtonBranchHandleSignature,
    branchState.hasTemplateFlowBranchControls,
    scheduleNodeInternalsUpdate,
    templateFlowDrawerOpen,
  ]);

  const editor = useWhatsAppTemplateEditor({
    id,
    workspaceId: templateEditorWorkspaceId,
    templateId: controls.selectedTemplateId,
    templateCategory: controls.selectedTemplateCategory,
    nodeData,
    patchNode,
    refreshTemplates: nodeData.uiWhatsAppTemplates.refresh,
  });
  const selection = resolveWhatsAppTemplateSelectionView({
    nodeData,
    selectOpen: controls.selectOpen,
    pendingTemplateValue: controls.pendingTemplateValue,
    templatesLoading: whatsAppTemplatesLoading,
    templatesRefreshing: whatsAppTemplatesRefreshing,
  });
  const saveView = resolveWhatsAppTemplateSaveView({
    generatedTemplateDraft: nodeData.generatedTemplateDraft,
    isDirty: editor.isDirty,
    isSubmitting: editor.isSubmitting,
    isUpdatePending: editor.isUpdatePending,
  });
  const catalog = resolveWhatsAppTemplateCatalogView({
    catalogMatch: nodeData.uiWhatsAppTemplates.catalogMatch,
    hasSelectedOption: Boolean(controls.selectedTemplateOption),
    selectedTemplateId: controls.selectedTemplateId,
    templatesListLoading: selection.templatesListLoading,
    canSubmitGeneratedTemplate: saveView.canSubmitGeneratedTemplate,
    catalogComponents: controls.selectedTemplateOption?.components,
    savedComponents: nodeData.actionWhatsAppTemplateComponents,
    savedButtonIds: nodeData.actionWhatsAppTemplateButtonIds,
    savedForm: nodeData.actionWhatsAppTemplateForm,
    routedSourceHandleIds: nodeData.uiConnections.sourceHandleIds,
  });
  // The form whose fields AI steps read; a bulk send shows no notice for it.
  const fieldsFlowId =
    controls.selectedTemplateId && !nodeData.uiBulkPrimaryWhatsAppTemplate
      ? nodeData.uiWhatsAppTemplates.formFields.flowId
      : null;
  // One read of the step's forms serves both notices and the tray.
  const flowScreens = useWhatsAppTemplateFlowScreens({
    workspaceId: nodeData.uiWorkspaceId,
    form: editor.form,
    buttons: editor.buttons,
    updateButton: editor.updateButton,
    healthComponents: controls.selectedTemplateId
      ? catalog.flowHealthComponents
      : undefined,
    fieldsFlowId,
  });
  const formSubmittedRoute = useMemo(
    () => resolveActionNodeFormSubmittedRoute(nodeData),
    [nodeData]
  );
  const formSubmittedDraft = {
    formSubmittedRoute,
    savedComponents: nodeData.actionWhatsAppTemplateComponents,
    buttons: editor.buttons,
  };
  const routeAnchorHandleIds = showPorts
    ? listUnshownTemplateButtonRouteHandles({
        savedBranchesById: branchState.savedTemplateButtonBranchesById,
        ...formSubmittedDraft,
      })
    : [];
  const routeAnchorSignature = routeAnchorHandleIds.join("|");

  useEffect(() => {
    scheduleNodeInternalsUpdate?.();
  }, [routeAnchorSignature, scheduleNodeInternalsUpdate]);
  const templateHasFlowButton = editor.buttons.some(
    button => button.type === "flow"
  );

  useEffect(() => {
    onTemplateHasFlowButtonChange?.(templateHasFlowButton);
  }, [onTemplateHasFlowButtonChange, templateHasFlowButton]);

  const templatePreviewButtons = useWhatsAppTemplatePreviewButtons({
    buttons: editor.buttons,
    id,
    t,
    showPorts,
    savedBranchesById: branchState.savedTemplateButtonBranchesById,
    connectedPayloads: branchState.connectedTemplateButtonPayloads,
    formSubmittedRoute,
    formSubmittedButtonIndex:
      findTemplateFormSubmittedButtonIndex(formSubmittedDraft),
    createNodeFromSourceHandle,
    refreshNodeInternals,
    canEditTemplateFlow,
    inlineTemplateFlowId: controls.inlineFlowId,
    openingInlineTemplateFlowId: controls.openingFlowId,
    openingLinkedFlowId: nodeData.uiWhatsAppFlows.openingPreviewId,
    onButtonChange: flowScreens.updateButton,
    onButtonRemove: editor.removeButton,
    onOpenInlineTemplateFlow: controls.openInlineFlow,
    onOpenLinkedFlowPreview: nodeData.uiWhatsAppFlows.openPreview,
  });

  const creation = useWhatsAppTemplateCreation({
    workspaceId: templateEditorWorkspaceId,
    scenarioId: nodeData.uiActiveScenarioId,
    nodeId: id,
    templateName: nodeData.actionWhatsAppTemplateName,
    templateLanguage: nodeData.actionWhatsAppTemplateLanguage,
    submitGenerated: nodeData.uiWhatsAppTemplates.submitGenerated,
    refreshTemplates: nodeData.uiWhatsAppTemplates.refresh,
  });

  const templateButtonTypeOptions = useMemo(
    () => buildWhatsAppTemplateButtonTypeOptions(t),
    [t]
  );
  const pendingRouteRemovals = listTemplateButtonRoutesRemovedOnSave({
    savedBranchesById: branchState.savedTemplateButtonBranchesById,
    ...formSubmittedDraft,
    destinationsBySourceHandle:
      nodeData.uiConnections.destinationsBySourceHandle,
    t,
  });
  const templateEditorTray = (
    <WhatsAppTemplateButtonEditorTray
      buttonTypeOptions={templateButtonTypeOptions}
      existingFlows={nodeData.uiWhatsAppFlows.options}
      existingFlowsLoading={whatsAppFlowsLoading || whatsAppFlowsRefreshing}
      flowScreens={flowScreens.lookup}
      pendingRouteRemovals={pendingRouteRemovals}
      onButtonChange={flowScreens.updateButton}
      onButtonRemove={editor.removeButton}
      onAddButton={editor.addButton}
      onExistingFlowPickerOpen={nodeData.uiWhatsAppFlows.openPicker}
    />
  );
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);

  // Saving changes a shared WhatsApp template, so it always asks first.
  const requestTemplateSave = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!saveView.canSaveTemplate) return;
    if (await editor.form.trigger()) setSaveConfirmOpen(true);
    else void editor.save();
  };

  return (
    <>
      <FormProvider {...editor.form}>
        <form
          className="nodrag flex flex-col items-start gap-2"
          onSubmit={event => void requestTemplateSave(event)}
          noValidate
        >
          <WhatsAppTemplatePickerField
            id={`${id}-whatsapp-template`}
            options={nodeData.uiWhatsAppTemplates.options}
            value={selection.templateSelectValue}
            savedName={selection.selectedTemplateName}
            savedLanguage={selection.selectedTemplateLanguage}
            open={controls.selectOpen}
            onOpenChange={controls.setTemplatePickerOpen}
            onSelect={controls.selectTemplate}
            loading={selection.showTemplateSelectLoading}
            listLoading={selection.templatesListLoading}
            loadingLabel={loadingLabel}
            onCreateNew={
              templateEditorWorkspaceId
                ? () => creation.setCreateDrawerOpen(true)
                : undefined
            }
            shared={catalog.isSharedTemplate}
            unverified={catalog.showUnverifiedTemplate}
            onRefresh={() => void nodeData.uiWhatsAppTemplates.refresh()}
            refreshDisabled={selection.templatesListLoading || coolingDown}
          />
          {whatsAppTemplatesError ? (
            <ScenarioInlineNotice
              className="w-full"
              data-testid="whatsapp-template-catalog-unavailable"
            >
              {tTemplates(nodeData.uiWhatsAppTemplates.options.length > 0 ? "alerts.savedTemplates" : "alerts.refreshUnavailable")}
              {retryAfterText ? ` ${retryAfterText}` : null}
            </ScenarioInlineNotice>
          ) : null}
          {controls.selectedTemplateId ? (
            <>
              <ActionNodeWhatsAppTemplateFlowHealth
                components={catalog.flowHealthComponents}
                flowFacts={flowScreens.flowFacts}
              />
              <ActionNodeWhatsAppTemplateFormFields
                id={id}
                nodeData={nodeData}
                flowFacts={flowScreens.flowFacts}
              />
            </>
          ) : null}
          <WhatsAppTemplateButtonDriftNotice
            drift={catalog.buttonDrift}
            templateValue={nodeData.uiWhatsAppTemplates.selectedValue}
            onSelectTemplate={nodeData.uiWhatsAppTemplates.select}
          />
          <ActionNodeWhatsAppTemplateMessage
            editor={editor}
            editorKey={selection.templateEditorKey}
            preview={nodeData.uiWhatsAppTemplates.preview}
            buttons={templatePreviewButtons}
            buttonEditor={templateEditorTray}
            routeAnchorHandleIds={routeAnchorHandleIds}
            carousel={
              isWhatsAppTemplateCarousel(editor.components) ? (
                <ActionNodeWhatsAppTemplateCarousel
                  components={editor.components}
                  showPorts={showPorts}
                  savedBranchesById={
                    branchState.savedTemplateButtonBranchesById
                  }
                  connectedPayloads={
                    branchState.connectedTemplateButtonPayloads
                  }
                  createNodeFromSourceHandle={createNodeFromSourceHandle}
                  refreshNodeInternals={refreshNodeInternals}
                  onViewportChange={scheduleNodeInternalsUpdate}
                />
              ) : null
            }
          />
          <WhatsAppTemplateGeneratedDraftStatus
            draft={nodeData.generatedTemplateDraft}
            canSubmit={saveView.canSubmitGeneratedTemplate}
            submitting={nodeData.uiWhatsAppTemplates.submittingGenerated}
            onSubmit={creation.submitGenerated}
          />
          <WhatsAppTemplateRejectedNotice
            draft={nodeData.generatedTemplateDraft}
          />
          <WhatsAppTemplateSaveBar
            dirty={editor.isDirty}
            submitting={editor.isSubmitting}
            saving={saveView.isSavingTemplate}
            canSubmitGenerated={saveView.canSubmitGeneratedTemplate}
            onDiscard={editor.discard}
          />
        </form>
      </FormProvider>

      <WhatsAppTemplateSaveConfirmDialog
        open={saveConfirmOpen}
        onOpenChange={setSaveConfirmOpen}
        onConfirm={editor.save}
        removedRouteLabels={pendingRouteRemovals.map(removal => removal.label)}
      />

      {branchState.hasTemplateFlowBranchControls && !templateFlowDrawerOpen ? (
        <FlowBranchPreview
          connectedBranchIds={nodeData.uiConnections.flowBranchIds}
          options={branchState.flowBranchOptions}
          renderFlowBranchHandle={renderInlineFlowBranchHandle}
        />
      ) : null}

      <ActionNodeWhatsAppTemplateInlineFlow
        id={id}
        canEdit={canEditTemplateFlow}
        controls={controls}
        nodeData={nodeData}
        placement={flowDrawerPlacement}
        templateName={selection.selectedTemplateName}
        templateLanguage={selection.selectedTemplateLanguage}
        flowsLoading={whatsAppFlowsLoading}
        flowsRefreshing={whatsAppFlowsRefreshing}
        onBranchHandleViewportChange={scheduleNodeInternalsUpdate}
        renderFlowBranchHandle={renderInlineFlowBranchHandle}
      />

      <ActionNodeWhatsAppTemplateVariables
        id={id}
        nodeData={nodeData}
        showPorts={showPorts}
        patchNode={patchNode}
      />

      {templateEditorWorkspaceId ? (
        <Suspense fallback={null}>
          <LazyTemplateFormDrawer
            open={creation.createDrawerOpen}
            onOpenChange={creation.setCreateDrawerOpen}
            workspaceId={templateEditorWorkspaceId}
            onSuccess={creation.onCreateSuccess}
          />
        </Suspense>
      ) : null}
    </>
  );
}

/**
 * The template as the customer sees it, editable in place. A carousel
 * template shows its cards and edits only its message text: it has no
 * header, footer, or message buttons.
 */
function ActionNodeWhatsAppTemplateMessage({
  editor,
  editorKey,
  preview,
  buttons,
  buttonEditor,
  routeAnchorHandleIds,
  carousel,
}: {
  editor: ReturnType<typeof useWhatsAppTemplateEditor>;
  /** Remounts the editor when the step points at another template. */
  editorKey: string;
  preview: ScenarioActionEditorNodeData["uiWhatsAppTemplates"]["preview"];
  buttons: ReturnType<typeof useWhatsAppTemplatePreviewButtons>;
  buttonEditor: ReactNode;
  routeAnchorHandleIds: readonly string[];
  /** The carousel cards, for a carousel template. */
  carousel: ReactNode;
}) {
  const t = useTranslations("Scenarios");
  const headerMediaFormat = useMemo(
    () =>
      getWhatsAppTemplateHeaderMediaFormat(editor.components) ??
      preview?.headerMediaFormat,
    [preview?.headerMediaFormat, editor.components]
  );
  const errors = translateWhatsAppTemplateEditorErrors(
    editor.form.formState.errors,
    t
  );

  return (
    <div
      className={cn(
        "relative min-h-[280px]",
        SCENARIO_NODE_CHANNEL_PREVIEW_BLEED_CLASS
      )}
    >
      <WhatsAppActionRenderer
        key={editorKey}
        headerText={editor.headerText}
        onHeaderTextChange={
          headerMediaFormat || carousel ? undefined : editor.setHeaderText
        }
        headerPlaceholder={t("whatsappTemplateHeaderPlaceholder")}
        headerError={errors.header}
        headerMediaFormat={headerMediaFormat}
        headerMediaUrl={preview?.headerMediaUrl}
        bodyText={editor.bodyText}
        onBodyTextChange={editor.setBodyText}
        bodyPlaceholder={t("actionReplyTextPlaceholder")}
        bodyError={errors.body}
        footerText={editor.footerText}
        onFooterTextChange={carousel ? undefined : editor.setFooterText}
        footerPlaceholder={t("whatsappTemplateFooterPlaceholder")}
        footerError={errors.footer}
        buttons={buttons}
        buttonEditor={carousel ? undefined : buttonEditor}
        bubbleTrailingContent={carousel || undefined}
        fitContent
        embedded
        align="center"
        previewClassName="w-full"
      />
      {/* Saved routes whose button left the draft keep their edges. */}
      <ScenarioHiddenSourceHandles handleIds={routeAnchorHandleIds} />
    </div>
  );
}

/** The template's own form (WhatsApp Flow), edited in a drawer. */
function ActionNodeWhatsAppTemplateInlineFlow({
  id,
  canEdit,
  controls,
  nodeData,
  placement,
  templateName,
  templateLanguage,
  flowsLoading,
  flowsRefreshing,
  onBranchHandleViewportChange,
  renderFlowBranchHandle,
}: {
  id: string;
  canEdit: boolean;
  controls: ReturnType<typeof useWhatsAppTemplateControls>;
  nodeData: ScenarioActionEditorNodeData;
  placement: "overlay" | "inline";
  templateName: string;
  templateLanguage: string;
  flowsLoading: boolean;
  flowsRefreshing: boolean;
  onBranchHandleViewportChange?: () => void;
  renderFlowBranchHandle?: (
    params: FlowBranchOptionHandleRenderParams
  ) => ReactNode;
}) {
  return (
    <WhatsAppTemplateFlowDrawer
      id={id}
      canEdit={canEdit}
      open={controls.flowDrawerOpen}
      placement={placement}
      templateName={templateName}
      templateLanguage={templateLanguage}
    >
      <ActionNodeWhatsAppFlowBuilder
        nodeId={id}
        formKeysByNodeId={nodeData.uiScenarioFormKeys}
        validationMode={nodeData.uiValidationMode}
        flowConfig={controls.inlineFlowConfig}
        onFlowConfigChange={controls.changeInlineFlowConfig}
        flows={nodeData.uiWhatsAppFlows}
        existingFlowsLoading={flowsLoading}
        existingFlowsRefreshing={flowsRefreshing}
        workspaceId={nodeData.uiWorkspaceId}
        onBranchHandleViewportChange={onBranchHandleViewportChange}
        onInlineClose={controls.closeInlineFlow}
        templateFlowLanguageCode={controls.selectedTemplateLanguage}
        templateEmbeddedFlowId={controls.inlineFlowId}
        renderFlowBranchHandle={renderFlowBranchHandle}
        renderMode="inline"
        connectedBranchIds={nodeData.uiConnections.flowBranchIds}
      />
    </WhatsAppTemplateFlowDrawer>
  );
}
