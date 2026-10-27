"use client";

import dynamic from "next/dynamic";
import { memo, type ComponentProps, type ReactNode } from "react";
import { scenarioEditorChunks } from "../scenario-editor-chunks";
import {
  lazyScenarioChunkComponent,
  useOpenedOnce,
  useScenarioClientRendered,
  type ScenarioLazyChunk,
} from "../scenario-lazy-chunk";
import { ScenarioLazyChunkBoundary } from "../scenario-lazy-chunk-boundary";
import type { AiriCreateDialogProps } from "./airi-create-dialog";
import type { ScenarioPreviewDrawer } from "./preview/drawer";
import type { ScenarioActivationImpactDialog } from "./scenario-activation-impact-dialog";
import type { ScenarioCreateTypeDialog } from "./scenario-create-type-dialog";
import type { RevenuePlaybookDialog } from "./revenue-playbook-dialog";
import { ScenarioPendingConfirmationDialog } from "./scenarios-view-shell";
import type { WhatsAppLinkedFlowPreviewDialog } from "./whatsapp-linked-flow-preview-dialog";

type ScenariosViewDialogsProps = {
  createTypeDialog: ComponentProps<typeof ScenarioCreateTypeDialog>;
  airiCreateDialog: AiriCreateDialogProps;
  revenuePlaybookDialog: ComponentProps<typeof RevenuePlaybookDialog>;
  linkedFlowPreviewDialog: ComponentProps<
    typeof WhatsAppLinkedFlowPreviewDialog
  >;
  previewDrawer: ComponentProps<typeof ScenarioPreviewDrawer>;
  activationImpactDialog: ComponentProps<typeof ScenarioActivationImpactDialog>;
  pendingConfirmationDialog: ComponentProps<
    typeof ScenarioPendingConfirmationDialog
  >;
};

const AiriCreateDialog = dynamic<AiriCreateDialogProps>(
  () => import("./airi-create-dialog").then(module => module.AiriCreateDialog),
  {
    loading: () => null,
    ssr: false,
  }
);
const LazyRevenuePlaybookDialog = dynamic<
  ComponentProps<typeof RevenuePlaybookDialog>
>(
  () =>
    import("./revenue-playbook-dialog").then(
      module => module.RevenuePlaybookDialog
    ),
  { ssr: false }
);
// These load through the shared chunk list, so the idle warm-up downloads
// the chunk this render uses, and a failed download is tried again.
const LazyScenarioCreateTypeDialog = lazyScenarioChunkComponent(
  scenarioEditorChunks.createTypeDialog,
  module => module.ScenarioCreateTypeDialog
);
const LazyWhatsAppLinkedFlowPreviewDialog = lazyScenarioChunkComponent(
  scenarioEditorChunks.linkedFlowPreviewDialog,
  module => module.WhatsAppLinkedFlowPreviewDialog
);
const LazyScenarioPreviewDrawer = lazyScenarioChunkComponent(
  scenarioEditorChunks.previewDrawer,
  module => module.ScenarioPreviewDrawer
);
const LazyScenarioActivationImpactDialog = lazyScenarioChunkComponent(
  scenarioEditorChunks.activationImpactDialog,
  module => module.ScenarioActivationImpactDialog
);

/**
 * Mounts a dialog on its first open and keeps it mounted after, so closing
 * still animates and returns focus. Like next/dynamic with `ssr: false`, it
 * renders only in the browser, after hydration.
 */
function LazyScenarioDialog({
  open,
  chunk,
  children,
}: {
  open: boolean;
  chunk: ScenarioLazyChunk<unknown>;
  children: ReactNode;
}) {
  const opened = useOpenedOnce(open);
  const clientRendered = useScenarioClientRendered();
  if (!opened || !clientRendered) return null;
  return (
    <ScenarioLazyChunkBoundary chunk={chunk} fallback={null}>
      {children}
    </ScenarioLazyChunkBoundary>
  );
}

export const ScenariosViewDialogs = memo(function ScenariosViewDialogs({
  createTypeDialog,
  airiCreateDialog,
  revenuePlaybookDialog,
  linkedFlowPreviewDialog,
  previewDrawer,
  activationImpactDialog,
  pendingConfirmationDialog,
}: ScenariosViewDialogsProps) {
  return (
    <>
      <LazyScenarioDialog
        open={createTypeDialog.open}
        chunk={scenarioEditorChunks.createTypeDialog}
      >
        <LazyScenarioCreateTypeDialog {...createTypeDialog} />
      </LazyScenarioDialog>
      {revenuePlaybookDialog.open && (
        <LazyRevenuePlaybookDialog
          key={revenuePlaybookDialog.workspaceId}
          {...revenuePlaybookDialog}
        />
      )}
      {airiCreateDialog.open ? (
        <AiriCreateDialog key="open" {...airiCreateDialog} />
      ) : null}
      <LazyScenarioDialog
        open={linkedFlowPreviewDialog.open}
        chunk={scenarioEditorChunks.linkedFlowPreviewDialog}
      >
        <LazyWhatsAppLinkedFlowPreviewDialog {...linkedFlowPreviewDialog} />
      </LazyScenarioDialog>
      <LazyScenarioDialog
        open={previewDrawer.open}
        chunk={scenarioEditorChunks.previewDrawer}
      >
        <LazyScenarioPreviewDrawer {...previewDrawer} />
      </LazyScenarioDialog>
      <LazyScenarioDialog
        open={activationImpactDialog.open}
        chunk={scenarioEditorChunks.activationImpactDialog}
      >
        <LazyScenarioActivationImpactDialog {...activationImpactDialog} />
      </LazyScenarioDialog>
      <ScenarioPendingConfirmationDialog {...pendingConfirmationDialog} />
    </>
  );
});
