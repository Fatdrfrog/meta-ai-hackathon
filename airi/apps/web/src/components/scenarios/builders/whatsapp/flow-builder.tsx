"use client";

import type { ScenarioEditorValidationMode } from "../../view/node-enrichment/types";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { mapWhatsAppTemplateLanguageToFlowUiLocale } from "@/lib/scenarios/whatsapp-flow-ui-locale";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Info,
  Loader2,
  Save,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import type { WhatsAppFlowConfig } from "../../types";
import {
  FieldEditor,
  FlowFormEditorContent,
  type FlowBranchOptionHandleRenderParams,
} from "./field-editor";
import { getFlowStatusBadgeKey } from "./existing-flow-options";
import { getFlowBuilderHeaderMeta } from "./flow-builder-header-meta";
import type { ManagedWhatsAppFlowProvisioningHost } from "./managed-provisioning-host";
import { useFlowBuilderLifecycle } from "./use-flow-builder-lifecycle";
import { TemplatePicker, type ExistingFlow } from "./template-picker";
import { FlowInteractivePreview } from "./flow-interactive-preview";
import { getFlowTemplate, type FlowTemplateId } from "./templates";

type FlowBuilderProps = {
  flowConfig: WhatsAppFlowConfig | null | undefined;
  onFlowConfigChange: (config: WhatsAppFlowConfig) => void;
  existingFlows?: ExistingFlow[];
  existingFlowsLoading?: boolean;
  existingFlowsRefreshing?: boolean;
  onSelectExistingFlow?: (flow: ExistingFlow) => void | Promise<void>;
  onExistingFlowPickerOpen?: () => void;
  onOpenProviderPreview?: (flowId: string) => void | Promise<void>;
  onFlowArtifactsChanged?: () => void;
  managedProvisioningHost?: ManagedWhatsAppFlowProvisioningHost;
  onInlineClose?: () => void;
  onBranchHandleViewportChange?: () => void;
  renderFlowBranchHandle?: (
    params: FlowBranchOptionHandleRenderParams
  ) => ReactNode;
  connectedBranchIds?: readonly string[];
  workspaceId?: string;
  /** When set (template + embedded flow), Flow UI locale matches this template language. */
  templateFlowLanguageCode?: string | null;
  /** The approved template button owns this immutable provider Flow ID. */
  templateEmbeddedFlowId?: string | null;
  renderMode?: "full" | "inline";
  validationMode?: ScenarioEditorValidationMode;
};

export function FlowBuilder({
  flowConfig,
  onFlowConfigChange,
  existingFlows,
  existingFlowsLoading,
  existingFlowsRefreshing,
  onSelectExistingFlow,
  onExistingFlowPickerOpen,
  onOpenProviderPreview,
  onFlowArtifactsChanged,
  managedProvisioningHost,
  onInlineClose,
  onBranchHandleViewportChange,
  renderFlowBranchHandle,
  connectedBranchIds,
  workspaceId,
  templateFlowLanguageCode,
  templateEmbeddedFlowId,
  renderMode = "full",
  validationMode = "runnable",
}: FlowBuilderProps) {
  const t = useTranslations("Scenarios");
  const isInlineMode = renderMode === "inline";
  const lockedFlowUiLocaleFromTemplate = useMemo(() => {
    const raw = templateFlowLanguageCode?.trim();
    if (!raw) return null;
    return mapWhatsAppTemplateLanguageToFlowUiLocale(raw);
  }, [templateFlowLanguageCode]);
  const commitFlowConfig = onFlowConfigChange;

  const providerReference = flowConfig?.providerReference;
  const hasProviderReference = Boolean(providerReference);
  const normalizedTemplateEmbeddedFlowId =
    templateEmbeddedFlowId?.trim() || null;
  const isTemplateOwnedFlow = normalizedTemplateEmbeddedFlowId !== null;
  const hasTemplate = hasProviderReference || Boolean(flowConfig?.templateId);
  const lifecycle = useFlowBuilderLifecycle({
    flowConfig,
    commitFlowConfig,
    workspaceId,
    templateEmbeddedFlowId,
    host: managedProvisioningHost,
    onSelectExistingFlow,
    onFlowArtifactsChanged,
    t,
  });
  const {
    confirmingReset,
    saveState,
    saveError,
    saveIssueLines,
    selectingExistingFlowKey,
    existingFlowSelectionError,
    publishing,
    sources: managedProvisioningSources,
    boundSourceId: managedBoundSourceId,
    selectedSourceId: selectedManagedSourceId,
    publishDisabledReason: managedPublishDisabledReason,
    patchState: setUiState,
    resetUiState,
    selectExistingFlow: handleSelectExistingFlow,
    publish: handleSaveFlow,
  } = lifecycle;
  const managedSourceLabelById = useMemo(
    () =>
      new Map(
        managedProvisioningSources.map(source => [source.id, source.label])
      ),
    [managedProvisioningSources]
  );
  const { displayFlowName, displayFlowStatus, hasUnpublishedChanges } =
    getFlowBuilderHeaderMeta(flowConfig, existingFlows, t);
  const flowStatusBadgeKey = getFlowStatusBadgeKey(displayFlowStatus);
  const flowStatusBadges = (
    <>
      {flowStatusBadgeKey ? (
        <Badge
          variant="secondary"
          className="h-4 shrink-0 px-1.5 text-[9px] font-normal"
        >
          {t(flowStatusBadgeKey)}
        </Badge>
      ) : null}
      {hasUnpublishedChanges ? (
        <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[9px]">
          {t("flowUnpublishedChanges")}
        </Badge>
      ) : null}
    </>
  );

  useEffect(() => {
    if (lockedFlowUiLocaleFromTemplate == null || !flowConfig) return;
    if (flowConfig.providerReference) return;
    if (publishing) return;
    if (flowConfig.flowUiLocale === lockedFlowUiLocaleFromTemplate) return;
    commitFlowConfig({
      ...flowConfig,
      flowUiLocale: lockedFlowUiLocaleFromTemplate,
    });
  }, [
    commitFlowConfig,
    flowConfig,
    lockedFlowUiLocaleFromTemplate,
    publishing,
  ]);

  const handleSelectTemplate = useCallback(
    (templateId: FlowTemplateId) => {
      const template = getFlowTemplate(templateId);
      if (!template) return;

      const config: WhatsAppFlowConfig = {
        templateId,
        screens: structuredClone(template.screens),
        ctaText: template.defaultCtaText,
        bodyText: template.defaultBodyText,
        flowUiLocale:
          lockedFlowUiLocaleFromTemplate ?? flowConfig?.flowUiLocale ?? "en",
        ...(flowConfig?.flowSubmitLabel
          ? { flowSubmitLabel: flowConfig.flowSubmitLabel }
          : {}),
      };

      commitFlowConfig(config);
      resetUiState();
    },
    [flowConfig, lockedFlowUiLocaleFromTemplate, commitFlowConfig, resetUiState]
  );

  const handleChangeTemplate = useCallback(() => {
    if (publishing || isTemplateOwnedFlow) return;
    if (confirmingReset) {
      commitFlowConfig({
        templateId: "",
        screens: [],
        ctaText: "",
      });
      resetUiState();
    } else {
      setUiState({ confirmingReset: true });
    }
  }, [
    confirmingReset,
    commitFlowConfig,
    isTemplateOwnedFlow,
    resetUiState,
    setUiState,
    publishing,
  ]);

  useEffect(() => {
    if (!hasTemplate) return;
    setUiState({
      selectingExistingFlowKey: null,
      existingFlowSelectionError: null,
    });
  }, [hasTemplate, setUiState]);

  if (!hasTemplate) {
    const picker = (
      <TemplatePicker
        onSelect={handleSelectTemplate}
        existingFlows={existingFlows}
        existingFlowsLoading={existingFlowsLoading}
        existingFlowsRefreshing={existingFlowsRefreshing}
        selectingExistingFlowKey={selectingExistingFlowKey}
        existingFlowSelectionError={existingFlowSelectionError}
        onSelectExistingFlow={handleSelectExistingFlow}
        onOpenExistingFlows={onExistingFlowPickerOpen}
        sourceLabelById={managedSourceLabelById}
        constrainedFlowId={normalizedTemplateEmbeddedFlowId}
      />
    );

    if (!isInlineMode || !onInlineClose) {
      return picker;
    }

    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-1 border-b bg-green-500/5 py-1.5 pl-2 pr-0">
          <span className="min-w-0 flex-1 truncate px-1 text-[11px] font-medium text-muted-foreground">
            {t("flowBuilderLabel")}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded-none"
            onClick={onInlineClose}
            aria-label={t("close")}
            title={t("close")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{picker}</div>
      </div>
    );
  }

  const activeFlowConfig = flowConfig;
  if (!activeFlowConfig) {
    return null;
  }

  const handleEditorConfigChange = (config: WhatsAppFlowConfig) => {
    if (publishing) return;
    commitFlowConfig(config);
  };

  const changeFlowLabel = hasProviderReference
    ? t("flowProviderReferenceChange")
    : t("flowChangeTemplate");
  const changeFlowConfirmLabel = hasProviderReference
    ? t("flowProviderReferenceChangeConfirm")
    : t("flowChangeTemplateConfirm");
  const changeFlowYesLabel = hasProviderReference
    ? t("flowProviderReferenceChangeYes")
    : t("flowChangeTemplateYes");
  const editorContent = providerReference ? (
    <div className="flex h-full min-h-0 items-start overflow-y-auto p-3">
      <div className="w-full rounded-lg border border-green-500/20 bg-green-500/5 p-3">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 rounded-full bg-green-500/10 p-1.5 text-green-700 dark:text-green-300">
            <Info className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">
              {t("flowProviderReferenceTitle")}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("flowProviderReferenceDescription")}
            </p>
            {isTemplateOwnedFlow ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("flowTemplateOwnedDescription")}
              </p>
            ) : null}
            {providerReference.jsonVersion ||
            providerReference.dataApiVersion ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="nodrag nopan nokey h-6 px-0 text-xs"
                  >
                    {t("flowDetails")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="nodrag nopan nokey flex w-auto max-w-64 flex-wrap gap-1.5 p-2"
                >
                  {providerReference.jsonVersion ? (
                    <Badge variant="outline" className="text-[10px]">
                      Flow JSON {providerReference.jsonVersion}
                    </Badge>
                  ) : null}
                  {providerReference.dataApiVersion ? (
                    <Badge variant="outline" className="text-[10px]">
                      Data API {providerReference.dataApiVersion}
                    </Badge>
                  ) : null}
                </PopoverContent>
              </Popover>
            ) : null}
          </div>
        </div>
        {onOpenProviderPreview ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 h-8 w-full gap-1.5 text-xs sm:w-auto"
            onClick={() => void onOpenProviderPreview(providerReference.flowId)}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            {t("flowProviderReferencePreview")}
          </Button>
        ) : null}
      </div>
    </div>
  ) : isInlineMode ? (
    <FlowFormEditorContent
      validationMode={saveState === "error" ? "runnable" : validationMode}
      className="h-full min-h-0 w-full overflow-y-auto"
      flowConfig={activeFlowConfig}
      onChange={handleEditorConfigChange}
      onViewportChange={onBranchHandleViewportChange}
      renderFlowBranchHandle={renderFlowBranchHandle}
      connectedBranchIds={connectedBranchIds}
      renderPreview={screenId => (
        <FlowInteractivePreview
          config={activeFlowConfig}
          initialScreenId={screenId}
          disabled={publishing}
        />
      )}
    />
  ) : (
    <FieldEditor
      validationMode={saveState === "error" ? "runnable" : validationMode}
      flowConfig={activeFlowConfig}
      onChange={handleEditorConfigChange}
      hideFlowUiLocaleSelect={lockedFlowUiLocaleFromTemplate != null}
      onViewportChange={onBranchHandleViewportChange}
      renderFlowBranchHandle={renderFlowBranchHandle}
      connectedBranchIds={connectedBranchIds}
      renderPreview={screenId => (
        <FlowInteractivePreview
          config={activeFlowConfig}
          initialScreenId={screenId}
          disabled={publishing}
        />
      )}
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div
        className={cn(
          "border-b bg-green-500/5 py-1.5",
          isInlineMode
            ? "flex items-center gap-1 pl-2 pr-0"
            : "flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3"
        )}
      >
        {isInlineMode ? (
          confirmingReset && !isTemplateOwnedFlow ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => setUiState({ confirmingReset: false })}
                aria-label={t("flowChangeTemplateNo")}
                title={t("flowChangeTemplateNo")}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="min-w-0 flex-1 truncate text-[11px] text-destructive">
                {changeFlowConfirmLabel}
              </span>
              <Button
                variant="destructive"
                size="sm"
                className="h-7 shrink-0 px-2 text-[11px]"
                onClick={handleChangeTemplate}
              >
                {changeFlowYesLabel}
              </Button>
              {onInlineClose ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 rounded-none"
                  onClick={onInlineClose}
                  disabled={publishing}
                  aria-label={t("close")}
                  title={t("close")}
                >
                  <X className="h-4 w-4" />
                </Button>
              ) : null}
            </>
          ) : (
            <>
              {!isTemplateOwnedFlow ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={handleChangeTemplate}
                  disabled={publishing}
                  aria-label={changeFlowLabel}
                  title={changeFlowLabel}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                </Button>
              ) : null}
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span
                  className="min-w-0 truncate text-[11px] font-medium text-green-800 dark:text-green-300"
                  title={displayFlowName}
                >
                  {displayFlowName}
                </span>
                {flowStatusBadges}
              </div>
              {workspaceId && !hasProviderReference && (
                <Button
                  variant="default"
                  size="xs"
                  className="h-7 shrink-0 whitespace-nowrap bg-green-600 px-2 text-[11px] shadow-sm hover:bg-green-700"
                  onClick={handleSaveFlow}
                  disabled={publishing || Boolean(managedPublishDisabledReason)}
                  title={managedPublishDisabledReason ?? undefined}
                >
                  {publishing ? (
                    <>
                      <Loader2 className="mr-0.5 h-3 w-3 animate-spin" />
                      {t("flowSaving")}
                    </>
                  ) : saveState === "saved" ? (
                    <>
                      <Check className="mr-0.5 h-3 w-3" />
                      {t("flowSaved")}
                    </>
                  ) : (
                    <>
                      <Save className="mr-0.5 h-3 w-3" />
                      {t("flowSaveButton")}
                    </>
                  )}
                </Button>
              )}
              {onInlineClose ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 rounded-none"
                  onClick={onInlineClose}
                  disabled={publishing}
                  aria-label={t("close")}
                  title={t("close")}
                >
                  <X className="h-4 w-4" />
                </Button>
              ) : null}
            </>
          )
        ) : (
          <div className="flex min-w-0 flex-1 basis-[min(100%,12rem)] flex-wrap items-center gap-1.5">
            <Image
              src="/whatsapp.svg"
              alt="WhatsApp"
              width={14}
              height={14}
              className="h-3.5 w-3.5 shrink-0 object-contain"
            />
            <span className="min-w-0 truncate text-[11px] font-medium text-green-700 dark:text-green-400">
              {displayFlowName}
            </span>
            {flowStatusBadges}
          </div>
        )}
        {!isInlineMode ? (
          confirmingReset && !isTemplateOwnedFlow ? (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-destructive">
                {changeFlowConfirmLabel}
              </span>
              <Button
                variant="destructive"
                size="sm"
                className="h-5 px-1.5 text-[10px]"
                onClick={handleChangeTemplate}
              >
                {changeFlowYesLabel}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px]"
                onClick={() => setUiState({ confirmingReset: false })}
              >
                {t("flowChangeTemplateNo")}
              </Button>
            </div>
          ) : (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
              {!isTemplateOwnedFlow ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 text-[11px]"
                  onClick={handleChangeTemplate}
                  disabled={publishing}
                >
                  <ArrowLeft className="mr-0.5 h-3 w-3" />
                  {changeFlowLabel}
                </Button>
              ) : null}
              {workspaceId && !hasProviderReference && (
                <Button
                  variant="default"
                  size="xs"
                  className="h-6 shrink-0 whitespace-nowrap bg-green-600 px-2 text-[11px] hover:bg-green-700"
                  onClick={handleSaveFlow}
                  disabled={publishing || Boolean(managedPublishDisabledReason)}
                  title={managedPublishDisabledReason ?? undefined}
                >
                  {publishing ? (
                    <>
                      <Loader2 className="mr-0.5 h-3 w-3 animate-spin" />
                      {t("flowSaving")}
                    </>
                  ) : saveState === "saved" ? (
                    <>
                      <Check className="mr-0.5 h-3 w-3" />
                      {t("flowSaved")}
                    </>
                  ) : (
                    <>
                      <Save className="mr-0.5 h-3 w-3" />
                      {t("flowSaveButton")}
                    </>
                  )}
                </Button>
              )}
            </div>
          )
        ) : null}
      </div>
      {!hasProviderReference &&
      managedProvisioningHost &&
      managedProvisioningSources.length > 1 ? (
        <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
          <label
            htmlFor="managed-whatsapp-flow-source"
            className="shrink-0 text-[11px] text-muted-foreground"
          >
            {t("flowManagedSourceLabel")}
          </label>
          <select
            id="managed-whatsapp-flow-source"
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
            value={selectedManagedSourceId ?? ""}
            disabled={publishing || Boolean(managedBoundSourceId)}
            onChange={event =>
              setUiState({ selectedProvisioningSourceId: event.target.value })
            }
          >
            <option value="">{t("flowManagedSourceSelect")}</option>
            {managedProvisioningSources.map(source => (
              <option key={source.id} value={source.id}>
                {source.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {!hasProviderReference && managedPublishDisabledReason ? (
        <p className="border-b bg-amber-50/80 px-3 py-1.5 text-[11px] text-amber-700 dark:bg-amber-950/20 dark:text-amber-400">
          {managedPublishDisabledReason}
        </p>
      ) : null}
      {saveState === "error" && (saveError || saveIssueLines.length > 0) && (
        <div className="border-b bg-destructive/10 px-3 py-1.5">
          {saveError ? (
            <p className="text-[11px] font-medium text-destructive">
              {saveError}
            </p>
          ) : null}
          {saveIssueLines.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-[11px] text-destructive">
              {saveIssueLines.slice(0, 8).map(line => (
                <li key={`error-${line}`}>- {line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      <div
        className={cn(
          "min-h-0 w-full flex-1 overflow-hidden",
          publishing && "pointer-events-none opacity-70"
        )}
        aria-disabled={publishing}
      >
        {editorContent}
      </div>
    </div>
  );
}
