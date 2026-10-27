"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowUp,
  AtSign,
  Check,
  Loader2,
  Mic,
  Square,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import {
  attachmentChipClassName,
  getAttachmentIcon,
  isPreviewableAttachment,
  SourceMentionText,
  SourceMentionIcon,
} from "../shared";
import type { AiriCreateDialogStepProps } from "../use-scenario-generator-wizard";

type ComposerFooterWizardKey =
  | "higgsfieldMentionSelected"
  | "higgsfieldAssetRefs"
  | "isGeneratorBusy"
  | "workspaceId"
  | "setIsHiggsfieldAssetDialogOpen"
  | "assetRefs"
  | "standaloneAssetWarnings"
  | "assetErrors"
  | "voiceError"
  | "assetWarningByKey"
  | "handleRemoveAsset"
  | "sourceMentionSearch"
  | "sourceMentionPanelOptions"
  | "selectedSourceMentions"
  | "highlightedSourceMentionIndex"
  | "handleSelectSourceMention"
  | "prompt"
  | "promptPlaceholder"
  | "promptHighlightRef"
  | "promptTextareaRef"
  | "handlePromptChange"
  | "handlePromptKeyDown"
  | "handlePromptSelectionUpdate"
  | "handlePromptScroll"
  | "uploadingAssets"
  | "assetInputRef"
  | "handleOpenSourceMentionPicker"
  | "handleAssetFiles"
  | "isVoiceActive"
  | "scribeStatus"
  | "handleStopVoiceDictation"
  | "handleStartVoiceDictation"
  | "hasTemplateSelectionActions"
  | "generatorStatus"
  | "generatorStatusLabel"
  | "isInitialDraftHandoff"
  | "handleCreateGeneratedScenario"
  | "fetchCanvaTemplates"
  | "canvaTemplateResult"
  | "generatorActionDisabled"
  | "createScenarioButtonDisabled"
  | "selectedCanvaTemplates"
  | "hasPlanReviewActions"
  | "canUseGenerator"
  | "handleGenerate";

export function AiriCreateDialogComposerFooter({
  wizard,
}: AiriCreateDialogStepProps<ComposerFooterWizardKey>) {
  const t = useTranslations("Scenarios.airiCreate");
  const {
    higgsfieldMentionSelected,
    higgsfieldAssetRefs,
    isGeneratorBusy,
    workspaceId,
    setIsHiggsfieldAssetDialogOpen,
    assetRefs,
    standaloneAssetWarnings,
    assetErrors,
    voiceError,
    assetWarningByKey,
    handleRemoveAsset,
    sourceMentionSearch,
    sourceMentionPanelOptions,
    selectedSourceMentions,
    highlightedSourceMentionIndex,
    handleSelectSourceMention,
    prompt,
    promptPlaceholder,
    promptHighlightRef,
    promptTextareaRef,
    handlePromptChange,
    handlePromptKeyDown,
    handlePromptSelectionUpdate,
    handlePromptScroll,
    uploadingAssets,
    assetInputRef,
    handleOpenSourceMentionPicker,
    handleAssetFiles,
    isVoiceActive,
    scribeStatus,
    handleStopVoiceDictation,
    handleStartVoiceDictation,
    hasTemplateSelectionActions,
    generatorStatus,
    generatorStatusLabel,
    isInitialDraftHandoff,
    handleCreateGeneratedScenario,
    fetchCanvaTemplates,
    canvaTemplateResult,
    generatorActionDisabled,
    createScenarioButtonDisabled,
    selectedCanvaTemplates,
    hasPlanReviewActions,
    canUseGenerator,
    handleGenerate,
  } = wizard;

  const actionControls = hasTemplateSelectionActions ? (
    <div className="flex shrink-0 flex-wrap justify-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void handleCreateGeneratedScenario([])}
        disabled={generatorStatus === "creating"}
      >
        {t("composer.skip")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          void fetchCanvaTemplates({
            continuation: canvaTemplateResult?.continuation,
            append: true,
          })
        }
        disabled={generatorActionDisabled || !canvaTemplateResult?.continuation}
      >
        {generatorStatus === "fetching_templates" ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : null}
        {t("composer.next")}
      </Button>
      <Button
        type="button"
        size="sm"
        onClick={() =>
          void handleCreateGeneratedScenario(selectedCanvaTemplates)
        }
        disabled={createScenarioButtonDisabled}
      >
        {t("composer.continue")}
      </Button>
    </div>
  ) : hasPlanReviewActions ? (
    <Button
      type="button"
      size="sm"
      className="shrink-0"
      onClick={() => void handleCreateGeneratedScenario([])}
      disabled={createScenarioButtonDisabled}
    >
      {generatorStatus === "creating" ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : null}
      {t("composer.create")}
    </Button>
  ) : (
    <Button
      type="button"
      variant="ghost"
      onClick={() => void handleGenerate()}
      disabled={!canUseGenerator || generatorActionDisabled}
      className="h-9 w-9 shrink-0 rounded-full bg-primary p-0 text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
      aria-label={t("composer.generate")}
    >
      {generatorActionDisabled ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <ArrowUp className="h-4 w-4" />
      )}
    </Button>
  );

  if (isInitialDraftHandoff) {
    const handoffTitle =
      generatorStatus === "planning"
        ? t("composer.handoffBuilding")
        : generatorStatus === "creating"
          ? t("composer.handoffCreating")
          : t("composer.handoffReview");

    return (
      <div className="shrink-0 border-t bg-background px-3 py-3">
        <div className="rounded-lg bg-muted/35 px-3 py-2.5 ring-1 ring-border/60">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{handoffTitle}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {t("composer.handoffHint")}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="rounded-md bg-background px-2 py-0.5 ring-1 ring-border/70">
                  {generatorStatusLabel}
                </span>
                {selectedSourceMentions.length > 0 ? (
                  <span className="rounded-md bg-background px-2 py-0.5 ring-1 ring-border/70">
                    {t("composer.sourcesCount", {
                      count: selectedSourceMentions.length,
                    })}
                  </span>
                ) : null}
                {assetRefs.length > 0 ? (
                  <span className="rounded-md bg-background px-2 py-0.5 ring-1 ring-border/70">
                    {t("composer.assetsCount", { count: assetRefs.length })}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="shrink-0">{actionControls}</div>
          </div>
          {assetErrors.length > 0 || voiceError ? (
            <div className="mt-2 space-y-1 text-xs text-destructive">
              {assetErrors.map(error => (
                <div key={error} className="truncate">
                  {t("composer.attachmentFailedWith", { error })}
                </div>
              ))}
              {voiceError ? <div className="truncate">{voiceError}</div> : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="shrink-0 bg-background px-3 pb-3 pt-2">
        <div className="rounded-2xl bg-muted/30 p-2 shadow-sm ring-1 ring-border/70 focus-within:ring-2 focus-within:ring-primary/25">
          {higgsfieldMentionSelected && higgsfieldAssetRefs.length === 0 ? (
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
              <div className="flex min-w-0 items-center gap-2">
                <WandSparkles className="h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  {t("composer.higgsfieldNeeded")}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 bg-background px-2 text-xs"
                disabled={isGeneratorBusy || !workspaceId}
                onClick={() => setIsHiggsfieldAssetDialogOpen(true)}
                aria-label={t("composer.chooseHiggsfieldAsset")}
              >
                {t("composer.chooseAsset")}
              </Button>
            </div>
          ) : null}

          {assetRefs.length > 0 ||
          standaloneAssetWarnings.length > 0 ||
          assetErrors.length > 0 ||
          voiceError ? (
            <div className="mb-2 flex max-h-24 flex-wrap gap-1 overflow-y-auto px-1">
              <TooltipProvider delayDuration={150}>
                {assetRefs.map(asset => {
                  const warning = assetWarningByKey.get(asset.url);
                  const AttachmentIcon = getAttachmentIcon(asset);
                  const assetSourceLabel =
                    asset.source === "higgsfield"
                      ? "Higgsfield"
                      : asset.id
                        ? t("composer.library")
                        : "";
                  const previewLabel = t("composer.previewAsset", {
                    name: asset.fileName || asset.url,
                  });
                  const chip = (
                    <div
                      data-attachment-chip="true"
                      data-asset-kind={asset.kind}
                      data-asset-source={asset.source}
                      data-warning-state={warning ? "warning" : undefined}
                      tabIndex={warning ? 0 : undefined}
                      className={attachmentChipClassName(Boolean(warning))}
                    >
                      {isPreviewableAttachment(asset) ? (
                        asset.kind === "video" ||
                        (asset.mimeType || "").startsWith("video/") ? (
                          <video
                            src={asset.url}
                            aria-label={previewLabel}
                            className="h-6 w-6 shrink-0 rounded object-cover"
                            muted
                            playsInline
                          />
                        ) : (
                          <Image
                            src={asset.url}
                            alt={previewLabel}
                            width={24}
                            height={24}
                            className="h-6 w-6 shrink-0 rounded object-cover"
                            unoptimized
                          />
                        )
                      ) : (
                        <AttachmentIcon
                          className={`h-3.5 w-3.5 shrink-0 ${
                            warning
                              ? "text-amber-700 dark:text-amber-200"
                              : "text-muted-foreground"
                          }`}
                        />
                      )}
                      <span className="min-w-0 max-w-44 truncate">
                        {asset.fileName || asset.url}
                      </span>
                      {assetSourceLabel ? (
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {assetSourceLabel}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                        onClick={() => handleRemoveAsset(asset)}
                        aria-label={t("composer.removeAsset")}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  );

                  if (!warning) {
                    return (
                      <div key={`${asset.url}-${asset.fileName || ""}`}>
                        {chip}
                      </div>
                    );
                  }

                  return (
                    <Tooltip key={`${asset.url}-${asset.fileName || ""}`}>
                      <TooltipTrigger asChild>{chip}</TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs text-left">
                        {warning.message}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </TooltipProvider>
              {standaloneAssetWarnings.map(warning => (
                <div
                  key={warning.message}
                  className="flex min-h-8 max-w-full items-center rounded-full bg-amber-50 px-2 text-xs text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-200 dark:ring-amber-900/50"
                >
                  <span className="min-w-0 truncate">{warning.message}</span>
                </div>
              ))}
              {assetErrors.map(error => (
                <div
                  key={error}
                  className="flex min-h-8 max-w-full items-center gap-1.5 rounded-full bg-destructive/10 px-2 text-xs text-destructive ring-1 ring-destructive/20"
                >
                  <span className="font-medium">
                    {t("composer.attachmentFailed")}
                  </span>
                  <span className="min-w-0 truncate">{error}</span>
                </div>
              ))}
              {voiceError ? (
                <div className="flex min-h-8 max-w-full items-center rounded-full bg-destructive/10 px-2 text-xs text-destructive ring-1 ring-destructive/20">
                  <span className="min-w-0 truncate">{voiceError}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="relative" data-scenario-generator-composer="true">
            {sourceMentionSearch && !isGeneratorBusy ? (
              <div
                role="listbox"
                aria-label={t("composer.mentionList")}
                className="absolute bottom-full left-0 z-50 mb-2 w-full overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
              >
                {sourceMentionPanelOptions.length > 0 ? (
                  sourceMentionPanelOptions.map((option, index) => {
                    const selected = selectedSourceMentions.includes(option.id);
                    const highlighted = index === highlightedSourceMentionIndex;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="option"
                        aria-selected={highlighted}
                        className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors ${
                          highlighted ? "bg-muted" : "hover:bg-muted"
                        }`}
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => handleSelectSourceMention(option)}
                      >
                        <SourceMentionIcon
                          option={option}
                          className="h-4 w-4 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {option.label}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          @{option.id}
                        </span>
                        {selected ? (
                          <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                        ) : null}
                      </button>
                    );
                  })
                ) : (
                  <div className="px-2 py-2 text-sm text-muted-foreground">
                    {t("composer.noMentionMatches")}
                  </div>
                )}
              </div>
            ) : null}

            <div className="relative min-h-[76px]">
              <div
                ref={promptHighlightRef}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2 py-2 text-sm leading-5 text-foreground"
              >
                {prompt ? (
                  <SourceMentionText text={prompt} context="composer" />
                ) : (
                  <span className="text-muted-foreground">
                    {promptPlaceholder}
                  </span>
                )}
              </div>
              <Textarea
                ref={promptTextareaRef}
                id="scenario-generator-prompt"
                value={prompt}
                onChange={handlePromptChange}
                onKeyDown={handlePromptKeyDown}
                onClick={handlePromptSelectionUpdate}
                onKeyUp={handlePromptSelectionUpdate}
                onSelect={handlePromptSelectionUpdate}
                onFocus={handlePromptSelectionUpdate}
                onScroll={handlePromptScroll}
                rows={3}
                placeholder=""
                disabled={isGeneratorBusy}
                spellCheck
                className="relative z-10 min-h-[76px] resize-none border-0 bg-transparent px-2 py-2 text-sm text-transparent shadow-none caret-foreground selection:bg-primary/20 focus-visible:ring-0"
                aria-label={t("composer.promptLabel")}
              />
            </div>
          </div>

          <div className="mt-1 flex min-w-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              disabled={
                uploadingAssets || assetRefs.length >= 10 || !workspaceId
              }
              onClick={() => assetInputRef.current?.click()}
              aria-label={t("composer.attach")}
            >
              {uploadingAssets ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              disabled={isGeneratorBusy}
              onClick={handleOpenSourceMentionPicker}
              aria-label={t("composer.mention")}
            >
              <AtSign className="h-4 w-4" />
            </Button>
            {higgsfieldMentionSelected ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="rounded-full"
                disabled={isGeneratorBusy || !workspaceId}
                onClick={() => setIsHiggsfieldAssetDialogOpen(true)}
                aria-label={t("composer.chooseHiggsfieldAssets")}
              >
                <WandSparkles className="h-4 w-4" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              disabled={isGeneratorBusy && !isVoiceActive}
              onClick={() =>
                isVoiceActive
                  ? handleStopVoiceDictation()
                  : void handleStartVoiceDictation()
              }
              aria-label={
                isVoiceActive
                  ? t("composer.stopVoice")
                  : t("composer.startVoice")
              }
            >
              {scribeStatus === "connecting" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isVoiceActive ? (
                <Square className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </Button>

            {isVoiceActive ? (
              <span className="hidden truncate px-2 text-xs text-muted-foreground sm:inline">
                {t("composer.listening")}
              </span>
            ) : null}

            <div className="min-w-0 flex-1" />

            {actionControls}
          </div>
        </div>
        <Input
          ref={assetInputRef}
          type="file"
          multiple
          className="hidden"
          accept="image/*,video/mp4,video/webm,video/quicktime,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,text/plain"
          onChange={event => {
            const files = Array.from(event.target.files || []);
            event.target.value = "";
            if (files.length > 0) void handleAssetFiles(files);
          }}
        />
      </div>
    </>
  );
}
