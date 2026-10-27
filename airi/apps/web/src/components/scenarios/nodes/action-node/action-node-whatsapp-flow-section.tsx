"use client";

import type { WhatsAppFlowConfig } from "@/components/scenarios/types";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { lazy, Suspense, type ReactNode } from "react";
import type {
  ScenarioActionWhatsAppFlows,
  ScenarioEditorValidationMode,
} from "@/components/scenarios/view/node-enrichment/types";
import type { FlowBranchOptionHandleRenderParams } from "@/components/scenarios/builders/whatsapp/field-editor";
import { FlowFieldAnswerTokensContext } from "@/components/scenarios/builders/whatsapp/flow-field-answer-tokens";
import { stopScenarioWheelPropagation } from "@/components/scenarios/nodes/action-node/action-node-utils";
import { useFormAnswersKeyStamp } from "@/components/scenarios/nodes/action-node/use-form-answers-key-stamp";

const LazyFlowBuilder = lazy(() =>
  import("@/components/scenarios/builders/whatsapp/flow-builder").then(m => ({
    default: m.FlowBuilder,
  }))
);

export function ActionNodeWhatsAppFlowBuilder({
  nodeId,
  formKeysByNodeId,
  flowConfig,
  onFlowConfigChange,
  flows,
  existingFlowsLoading,
  existingFlowsRefreshing,
  workspaceId,
  onBranchHandleViewportChange,
  onInlineClose,
  templateFlowLanguageCode,
  templateEmbeddedFlowId,
  renderFlowBranchHandle,
  connectedBranchIds,
  renderMode = "full",
  validationMode,
}: {
  /** The step sending the form, whose answers key it keeps unique. */
  nodeId?: string;
  /** Every form's key in the scenario, by sending step. */
  formKeysByNodeId?: ReadonlyMap<string, string>;
  flowConfig?: WhatsAppFlowConfig | null;
  onFlowConfigChange: (config: WhatsAppFlowConfig) => void;
  flows: ScenarioActionWhatsAppFlows;
  existingFlowsLoading: boolean;
  existingFlowsRefreshing: boolean;
  workspaceId?: string;
  /** Canvas only. */
  onBranchHandleViewportChange?: () => void;
  onInlineClose?: () => void;
  templateFlowLanguageCode?: string | null;
  templateEmbeddedFlowId?: string | null;
  renderFlowBranchHandle?: (
    params: FlowBranchOptionHandleRenderParams
  ) => ReactNode;
  connectedBranchIds?: readonly string[];
  renderMode?: "full" | "inline";
  validationMode?: ScenarioEditorValidationMode;
}) {
  const t = useTranslations("Scenarios");
  const form = useFormAnswersKeyStamp({
    nodeId,
    formKeysByNodeId,
    flowConfig,
    onFlowConfigChange,
  });
  const builder = (
    <FlowFieldAnswerTokensContext.Provider value={form.answerTokens}>
      <Suspense
        fallback={
          <div
            className="flex flex-1 items-center justify-center p-3"
            data-testid="whatsapp-flow-builder-loading"
          >
            <Loader2
              className="size-4 animate-spin text-muted-foreground"
              aria-hidden
            />
            <span className="sr-only">{t("flowLoading")}</span>
          </div>
        }
      >
        <LazyFlowBuilder
          validationMode={validationMode}
          flowConfig={form.flowConfig ?? null}
          onFlowConfigChange={form.commitFlowConfig}
          existingFlows={flows.options}
          existingFlowsLoading={existingFlowsLoading}
          existingFlowsRefreshing={existingFlowsRefreshing}
          onSelectExistingFlow={flows.select}
          onExistingFlowPickerOpen={flows.openPicker}
          onOpenProviderPreview={flows.openPreview}
          onFlowArtifactsChanged={flows.refresh}
          managedProvisioningHost={flows.managedProvisioningHost}
          workspaceId={workspaceId}
          onBranchHandleViewportChange={onBranchHandleViewportChange}
          onInlineClose={onInlineClose}
          templateFlowLanguageCode={templateFlowLanguageCode}
          templateEmbeddedFlowId={templateEmbeddedFlowId}
          renderFlowBranchHandle={renderFlowBranchHandle}
          connectedBranchIds={connectedBranchIds}
          renderMode={renderMode}
        />
      </Suspense>
    </FlowFieldAnswerTokensContext.Provider>
  );

  if (renderMode === "inline") {
    return builder;
  }

  return (
    <div
      className="nodrag nowheel relative flex h-full min-h-[240px] flex-col overflow-auto overscroll-contain rounded-md border bg-muted/10"
      onWheel={stopScenarioWheelPropagation}
    >
      {builder}
    </div>
  );
}
