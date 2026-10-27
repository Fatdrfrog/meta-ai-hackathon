"use client";

import { createDefaultAiriBuilderFlowConfig } from "@/components/ai/airi-builder-defaults";
import { AiriWhatsAppTemplateInlineEditor } from "@/components/ai/airi-whatsapp-template-inline-editor";
import { FlowBuilder } from "@/components/scenarios/builders/whatsapp/flow-builder";
import { parseFlowJsonToWhatsAppFlowConfig } from "@/components/scenarios/builders/whatsapp/flow-json-parser";
import {
  getEditableWhatsAppTemplateButtons,
  updateWhatsAppTemplateButton,
  type EditableWhatsAppTemplateButton,
} from "@/components/scenarios/builders/whatsapp/template-editor-utils";
import type { ExistingFlow } from "@/components/scenarios/builders/whatsapp/template-picker";
import { scenarioEditorChunks } from "@/components/scenarios/scenario-editor-chunks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Separator } from "@/components/ui/separator";
import type {
  ActiveAiriBuilderInput,
  AiriBuilderPatch,
} from "@/lib/airi-chats/builder-state";
import type { AiriWhatsAppTemplateDraft } from "@/lib/airi-chats/whatsapp-template-drafts";
import { cn } from "@/lib/utils";
import {
  fetchWhatsAppFlowDetails,
  fetchWhatsAppFlowsList,
} from "@/lib/whatsapp/flows/client";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import {
  ArrowLeft,
  Loader2,
  PanelRightClose,
  RefreshCw,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useReducer } from "react";

export type AiriBuilderMode = ActiveAiriBuilderInput["kind"];

/**
 * What applying a pending Airi patch changes: the open artifact, another
 * artifact Airi named, or none yet (a campaign's draft opens as a new one).
 */
export type AiriBuilderPendingPatchTarget = "open" | "other" | "new";

export type AiriBuilderSidePanelProps = {
  workspaceId: string;
  mode: AiriBuilderMode;
  templateArtifactId?: string | null;
  templateDraft: AiriWhatsAppTemplateDraft;
  flowConfig: WhatsAppFlowConfig;
  pendingPatch: AiriBuilderPatch | null;
  pendingPatchTarget?: AiriBuilderPendingPatchTarget;
  /** The open artifact is being saved before the patch switches away. */
  pendingPatchBusy?: boolean;
  /** The open artifact is in conflict: the switch waits for the choice. */
  pendingPatchBlocked?: boolean;
  hasActiveThread?: boolean;
  className?: string;
  onModeChange: (mode: AiriBuilderMode) => void;
  onTemplateDraftChange: (draft: AiriWhatsAppTemplateDraft) => void;
  onFlowConfigChange: (config: WhatsAppFlowConfig) => void;
  onApplyPendingPatch: () => void;
  onDismissPendingPatch: () => void;
  onSaved: () => void;
  onClose: () => void;
  showCloseButton?: boolean;
  /** A newer revision saved elsewhere; autosave is paused until resolved. */
  conflict?: AiriBuilderConflictView | null;
  onKeepLocalChanges?: () => void;
  onTakeLatestVersion?: () => void;
};

export type AiriBuilderConflictView = {
  revision: number;
  canTakeLatest: boolean;
};

type AiriBuilderSidePanelState = {
  existingFlows: ExistingFlow[];
  flowsLoading: boolean;
  flowsRefreshing: boolean;
  flowError: string | null;
  drawerContainer: HTMLElement | null;
  activeFlowButtonIndex: number | null;
  openingFlowButtonIndex: number | null;
};

type AiriBuilderSidePanelAction =
  | Partial<AiriBuilderSidePanelState>
  | ((state: AiriBuilderSidePanelState) => Partial<AiriBuilderSidePanelState>);

const initialAiriBuilderSidePanelState: AiriBuilderSidePanelState = {
  existingFlows: [],
  flowsLoading: false,
  flowsRefreshing: false,
  flowError: null,
  drawerContainer: null,
  activeFlowButtonIndex: null,
  openingFlowButtonIndex: null,
};

function airiBuilderSidePanelReducer(
  state: AiriBuilderSidePanelState,
  action: AiriBuilderSidePanelAction
): AiriBuilderSidePanelState {
  const patch = typeof action === "function" ? action(state) : action;
  return { ...state, ...patch };
}

export function AiriBuilderSidePanel({
  workspaceId,
  mode,
  templateArtifactId,
  templateDraft,
  flowConfig,
  pendingPatch,
  pendingPatchTarget = "open",
  pendingPatchBusy = false,
  pendingPatchBlocked = false,
  hasActiveThread = true,
  className,
  onModeChange,
  onTemplateDraftChange,
  onFlowConfigChange,
  onApplyPendingPatch,
  onDismissPendingPatch,
  onSaved,
  onClose,
  showCloseButton = true,
  conflict = null,
  onKeepLocalChanges,
  onTakeLatestVersion,
}: AiriBuilderSidePanelProps) {
  const t = useTranslations("AiriChat");
  const pendingPatchBlockedId = useId();
  const [
    {
      existingFlows,
      flowsLoading,
      flowsRefreshing,
      flowError,
      drawerContainer,
      activeFlowButtonIndex,
      openingFlowButtonIndex,
    },
    dispatchPanelState,
  ] = useReducer(airiBuilderSidePanelReducer, initialAiriBuilderSidePanelState);
  const flowDrawerOpen = mode === "whatsapp_flow";
  const selectedExistingFlow = flowConfig.metaFlowId
    ? existingFlows.find(flow => flow.id === flowConfig.metaFlowId)
    : null;
  const flowDisplayName =
    (flowConfig.metaFlowName || "").trim() ||
    (selectedExistingFlow?.name || "").trim() ||
    (flowConfig.templateId || "").replace(/_/g, " ").trim() ||
    "New Flow";
  const flowDisplayStatus = (
    (flowConfig.metaFlowStatus || "").trim() ||
    (selectedExistingFlow?.status || "").trim()
  ).toUpperCase();
  const flowStatusLabel = flowDisplayStatus || "Draft";
  const flowScreenCount = Array.isArray(flowConfig.screens)
    ? flowConfig.screens.length
    : 0;
  const flowFieldCount = Array.isArray(flowConfig.screens)
    ? flowConfig.screens.reduce(
        (count, screen) =>
          count + (Array.isArray(screen.fields) ? screen.fields.length : 0),
        0
      )
    : 0;

  const handleFlowDrawerOpenChange = useCallback(
    (open: boolean) => {
      onModeChange(open ? "whatsapp_flow" : "whatsapp_template");
    },
    [onModeChange]
  );

  const setSidePanelRef = useCallback((node: HTMLElement | null) => {
    dispatchPanelState({ drawerContainer: node });
  }, []);

  const attachFlowConfigToTemplateButton = useCallback(
    (buttonIndex: number, nextConfig: WhatsAppFlowConfig) => {
      const flowId = nextConfig.metaFlowId?.trim();
      if (!flowId) return;

      const firstScreenId = nextConfig.screens?.[0]?.id?.trim();
      const currentButton = getEditableWhatsAppTemplateButtons(
        templateDraft.components
      ).find(button => button.index === buttonIndex);
      const flowAction = currentButton?.flowAction || "navigate";
      onTemplateDraftChange({
        ...templateDraft,
        kind: "whatsapp_template",
        components: updateWhatsAppTemplateButton(
          templateDraft.components,
          buttonIndex,
          {
            type: "flow",
            flowId,
            flowAction,
            navigateScreen:
              flowAction === "navigate" ? firstScreenId || undefined : "",
          }
        ),
      });
    },
    [onTemplateDraftChange, templateDraft]
  );

  const handleFlowConfigChange = useCallback(
    (nextConfig: WhatsAppFlowConfig) => {
      onFlowConfigChange(nextConfig);

      if (activeFlowButtonIndex === null) return;
      attachFlowConfigToTemplateButton(activeFlowButtonIndex, nextConfig);
    },
    [
      activeFlowButtonIndex,
      attachFlowConfigToTemplateButton,
      onFlowConfigChange,
    ]
  );

  const loadExistingFlows = useCallback(
    async (force = false) => {
      if (force) {
        dispatchPanelState({ flowsRefreshing: true, flowError: null });
      } else {
        dispatchPanelState({ flowsLoading: true, flowError: null });
      }
      try {
        const result = await fetchWhatsAppFlowsList({
          workspaceId,
          limit: 200,
          force,
        });
        if (!result.ok) {
          throw new Error(result.data?.error || "Failed to load flows");
        }
        dispatchPanelState({
          existingFlows: (result.data?.flows || []).map(flow => ({
            id: flow.id,
            name: flow.name || flow.id,
            ...(result.data?.sourceId
              ? { sourceId: result.data.sourceId }
              : {}),
            status: flow.status,
          })),
        });
      } catch (error) {
        dispatchPanelState({
          flowError:
            error instanceof Error ? error.message : "Failed to load flows",
        });
      } finally {
        dispatchPanelState({ flowsLoading: false, flowsRefreshing: false });
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    if (mode !== "whatsapp_flow") return;
    void loadExistingFlows(false);
  }, [loadExistingFlows, mode]);

  // Template text and Flow fields use the message editor, which downloads on
  // demand: start it as the builder opens, so its fields are editable at once.
  useEffect(() => {
    if (hasActiveThread) scenarioEditorChunks.whatsAppInlineEditor.preload();
  }, [hasActiveThread]);

  const selectExistingFlow = useCallback(
    async (flow: ExistingFlow) => {
      const normalizedFlowId = flow.id.trim();
      const sourceId = flow.sourceId?.trim();
      if (!normalizedFlowId) return;
      dispatchPanelState({ flowError: null });
      try {
        const result = await fetchWhatsAppFlowDetails({
          workspaceId,
          ...(sourceId ? { sourceId } : {}),
          flowId: normalizedFlowId,
          includeJson: true,
        });
        if (!result.ok) {
          throw new Error(result.data?.error || "Failed to load selected Flow");
        }
        const flowName = result.data?.flow?.name?.trim() || normalizedFlowId;
        const flowStatus = result.data?.flow?.status?.trim() || null;
        const parsed = parseFlowJsonToWhatsAppFlowConfig({
          flowJson: result.data?.flowJson,
          flowId: normalizedFlowId,
          flowName,
          flowStatus,
          previousConfig: flowConfig,
        });
        if (!parsed) {
          throw new Error(
            result.data?.flowJsonError || "Selected Flow has no editable JSON"
          );
        }
        handleFlowConfigChange(parsed);
        return parsed;
      } catch (error) {
        dispatchPanelState({
          flowError:
            error instanceof Error ? error.message : "Failed to load Flow",
        });
        return null;
      }
    },
    [flowConfig, handleFlowConfigChange, workspaceId]
  );

  const handleOpenFlowButton = useCallback(
    async (button: EditableWhatsAppTemplateButton) => {
      dispatchPanelState({ activeFlowButtonIndex: button.index });
      const flowId = button.flowId?.trim();
      onModeChange("whatsapp_flow");

      if (!flowId) {
        handleFlowConfigChange(
          createDefaultAiriBuilderFlowConfig(button.label)
        );
        return;
      }

      dispatchPanelState({ openingFlowButtonIndex: button.index });
      try {
        const selectedFlow = existingFlows.find(flow => flow.id === flowId) ?? {
          id: flowId,
          name: flowId,
        };
        const selectedConfig = await selectExistingFlow(selectedFlow);
        if (selectedConfig) {
          attachFlowConfigToTemplateButton(button.index, selectedConfig);
        }
      } finally {
        dispatchPanelState(current => ({
          openingFlowButtonIndex:
            current.openingFlowButtonIndex === button.index
              ? null
              : current.openingFlowButtonIndex,
        }));
      }
    },
    [
      attachFlowConfigToTemplateButton,
      handleFlowConfigChange,
      existingFlows,
      onModeChange,
      selectExistingFlow,
    ]
  );

  if (!hasActiveThread) return null;

  return (
    <aside
      ref={setSidePanelRef}
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-background dark:bg-black",
        className
      )}
      aria-label="WhatsApp builder"
    >
      <div
        className={cn(
          "flex h-11 shrink-0 items-center gap-2 border-b py-0 pl-3",
          showCloseButton ? "pr-3" : "pr-14"
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">WhatsApp Builder</p>
        </div>
        {drawerContainer ? (
          <Drawer
            open={flowDrawerOpen}
            onOpenChange={handleFlowDrawerOpenChange}
            direction="bottom"
            modal={false}
            container={drawerContainer}
          >
            <DrawerContent
              aria-label="WhatsApp Flow builder"
              className="absolute inset-x-0 bottom-0 mt-0 flex h-[min(86%,46rem)] min-h-[24rem] max-h-[86%] overflow-hidden rounded-t-lg border-t bg-background p-0 shadow-2xl data-[state=closed]:duration-75 data-[state=closed]:translate-y-3 data-[state=open]:duration-100 data-[vaul-drawer-direction=bottom]:mt-0 data-[vaul-drawer-direction=bottom]:max-h-none"
              overlayClassName="absolute inset-0 bg-black/20 data-[state=closed]:duration-75 data-[state=open]:duration-100"
            >
              <DrawerHeader className="shrink-0 gap-1 px-4 py-3 text-left">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <DrawerTitle className="truncate text-sm">
                      WhatsApp Flow builder
                    </DrawerTitle>
                    <DrawerDescription
                      className={cn(
                        "truncate text-xs",
                        flowError ? "text-destructive" : undefined
                      )}
                    >
                      {flowError || flowDisplayName}
                    </DrawerDescription>
                  </div>
                  <DrawerClose asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-8 rounded-full"
                      aria-label="Close Flow builder"
                    >
                      <X data-icon="icon" />
                    </Button>
                  </DrawerClose>
                </div>
              </DrawerHeader>
              <div
                className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2"
                aria-label="Flow tools"
              >
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="max-w-[16rem] truncate text-xs font-medium">
                    {flowDisplayName}
                  </span>
                  <Badge
                    variant={
                      flowDisplayStatus === "PUBLISHED"
                        ? "default"
                        : "secondary"
                    }
                  >
                    {flowStatusLabel}
                  </Badge>
                  <Badge variant="outline">
                    {flowScreenCount}{" "}
                    {flowScreenCount === 1 ? "screen" : "screens"}
                  </Badge>
                  <Badge variant="outline">
                    {flowFieldCount} {flowFieldCount === 1 ? "field" : "fields"}
                  </Badge>
                </div>
                <Separator
                  orientation="vertical"
                  className="hidden h-5 sm:block"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8"
                  aria-label="Refresh flows"
                  onClick={() => void loadExistingFlows(true)}
                  disabled={flowsLoading || flowsRefreshing}
                >
                  {flowsRefreshing ? (
                    <Loader2
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : (
                    <RefreshCw data-icon="inline-start" />
                  )}
                  Refresh
                </Button>
                <DrawerClose asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-8"
                    aria-label="Return to template builder"
                  >
                    <ArrowLeft data-icon="inline-start" />
                    Template
                  </Button>
                </DrawerClose>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <FlowBuilder
                  flowConfig={flowConfig}
                  onFlowConfigChange={handleFlowConfigChange}
                  existingFlows={existingFlows}
                  existingFlowsLoading={flowsLoading}
                  existingFlowsRefreshing={flowsRefreshing}
                  onSelectExistingFlow={flow => {
                    void selectExistingFlow(flow);
                  }}
                  onExistingFlowPickerOpen={() => void loadExistingFlows(false)}
                />
              </div>
            </DrawerContent>
          </Drawer>
        ) : null}
        {showCloseButton ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            aria-label="Toggle side panel"
            onClick={onClose}
          >
            <PanelRightClose data-icon="icon" />
          </Button>
        ) : null}
      </div>

      {conflict ? (
        <div
          role="alert"
          className="border-b bg-destructive/10 px-3 py-2 text-xs"
        >
          <p className="font-medium text-destructive">
            This builder changed elsewhere (revision {conflict.revision}).
          </p>
          <p className="mt-0.5 text-destructive/80">
            Autosave is paused so neither version is lost. Choose which one to
            keep.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onKeepLocalChanges}
            >
              Keep my version
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={!conflict.canTakeLatest}
              onClick={onTakeLatestVersion}
            >
              Use latest version
            </Button>
          </div>
        </div>
      ) : null}

      {pendingPatch ? (
        <div className="border-b bg-amber-500/10 px-3 py-2 text-xs">
          <p className="font-medium text-amber-800 dark:text-amber-200">
            {pendingPatchTarget === "new"
              ? t(
                  pendingPatch.kind === "whatsapp_flow"
                    ? "pendingPatchNewFlowTitle"
                    : "pendingPatchNewTemplateTitle"
                )
              : pendingPatchTarget === "other"
                ? t("pendingPatchOtherTitle")
                : "Airi has an update for this builder."}
          </p>
          <p className="mt-0.5 text-amber-800/80 dark:text-amber-200/80">
            {pendingPatch.summary}
          </p>
          {pendingPatchBlocked ? (
            <p
              id={pendingPatchBlockedId}
              className="mt-1 text-amber-800 dark:text-amber-200"
            >
              {t("pendingPatchResolveConflict")}
            </p>
          ) : null}
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={pendingPatchBusy || pendingPatchBlocked}
              aria-busy={pendingPatchBusy || undefined}
              aria-describedby={
                pendingPatchBlocked ? pendingPatchBlockedId : undefined
              }
              onClick={onApplyPendingPatch}
            >
              {pendingPatchBusy ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : null}
              {pendingPatchTarget === "new"
                ? t("pendingPatchOpenNew")
                : pendingPatchTarget === "other"
                  ? t("pendingPatchOpenOther")
                  : "Apply update"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={onDismissPendingPatch}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        <AiriWhatsAppTemplateInlineEditor
          workspaceId={workspaceId}
          artifactId={templateArtifactId}
          templateDraft={templateDraft}
          flowConfig={flowConfig}
          activeFlowButtonIndex={activeFlowButtonIndex}
          onTemplateDraftChange={onTemplateDraftChange}
          onOpenFlowButton={handleOpenFlowButton}
          openingFlowButtonIndex={openingFlowButtonIndex}
          onSaved={onSaved}
        />
      </div>
    </aside>
  );
}
