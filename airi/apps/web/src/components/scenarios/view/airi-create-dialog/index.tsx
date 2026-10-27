"use client";

import { CreativeAssetPickerDialog } from "@/components/assets/creative-asset-picker-dialog";
import { AiriResizableSidebar } from "@/components/ai/airi-resizable-sidebar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ui/conversation";
import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type AiriCreateDialogProps,
  EMPTY_SOURCE_IDS,
  EMPTY_SOURCE_MENTIONS,
  EMPTY_SOURCE_OPTIONS,
} from "./shared";
import { AiriCreateDialogCampaignSetupStep } from "./steps/campaign-setup-step";
import { AiriCreateDialogCanvaTemplatesStep } from "./steps/canva-templates-step";
import { AiriCreateDialogComposerFooter } from "./steps/composer-footer";
import { AiriCreateDialogGenerationStatusStep } from "./steps/generation-status-step";
import { AiriCreateDialogPlanReviewStep } from "./steps/plan-review-step";
import { AiriCreateDialogTemplatesStep } from "./steps/templates-step";
import { useScenarioGeneratorWizard } from "./use-scenario-generator-wizard";

export type { AiriCreateDialogProps } from "./shared";

export function AiriCreateDialog(props: AiriCreateDialogProps) {
  const t = useTranslations("Scenarios.airiCreate");
  const wizard = useScenarioGeneratorWizard({
    ...props,
    sourceIds: props.sourceIds ?? EMPTY_SOURCE_IDS,
    connectedSourceMentions:
      props.connectedSourceMentions ?? EMPTY_SOURCE_MENTIONS,
    connectedSourceOptions:
      props.connectedSourceOptions ?? EMPTY_SOURCE_OPTIONS,
    higgsfieldUnavailableReason: props.higgsfieldUnavailableReason ?? "",
  });

  const {
    open,
    onOpenChange,
    workspaceId,
    isHiggsfieldAssetDialogOpen,
    setIsHiggsfieldAssetDialogOpen,
    assetRefs,
    connectedSourceMentionSet,
    handleSelectCreativeAsset,
    canUseGenerator,
    handleAssetFiles,
    isInitialDraftHandoff,
    generatorStatus,
  } = wizard;

  return (
    <>
      {workspaceId ? (
        <CreativeAssetPickerDialog
          workspaceId={workspaceId}
          open={isHiggsfieldAssetDialogOpen}
          onOpenChange={setIsHiggsfieldAssetDialogOpen}
          selectedUrls={assetRefs.map(asset => asset.url)}
          showGenerate
          higgsfieldConfigured={connectedSourceMentionSet.has("higgsfield")}
          onSelect={handleSelectCreativeAsset}
        />
      ) : null}
      <AiriResizableSidebar
        open={open}
        onOpenChange={onOpenChange}
        title="Airi Create"
        description={t("description")}
        storageKey="airi-create-sidebar-width"
        defaultWidth={460}
        minWidth={380}
        maxWidth={680}
        contentClassName="sm:rounded-l-xl"
        bodyClassName="flex flex-col"
        closeLabel={t("close")}
        headerSlot={
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" />
            {t("statusLine", { status: generatorStatus })}
          </span>
        }
      >
        <div
          className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
          onDragOver={event => {
            event.preventDefault();
          }}
          onDrop={event => {
            event.preventDefault();
            void handleAssetFiles(event.dataTransfer.files);
          }}
        >
          <Conversation className="min-h-0 flex-1">
            <ConversationContent className="space-y-3 p-3">
              {!canUseGenerator ? (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{t("unavailable")}</AlertDescription>
                </Alert>
              ) : null}

              {!isInitialDraftHandoff ? (
                <div className="px-1 py-1">
                  <h2 className="text-sm font-semibold">{t("buildTitle")}</h2>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t("buildDescription")}
                  </p>
                </div>
              ) : null}

              <AiriCreateDialogTemplatesStep wizard={wizard} />
              <AiriCreateDialogCampaignSetupStep wizard={wizard} />
              <AiriCreateDialogGenerationStatusStep wizard={wizard} />
              <AiriCreateDialogPlanReviewStep wizard={wizard} />
              <AiriCreateDialogCanvaTemplatesStep wizard={wizard} />
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <AiriCreateDialogComposerFooter wizard={wizard} />
        </div>
      </AiriResizableSidebar>
    </>
  );
}
