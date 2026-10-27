"use client";

import { useMemo } from "react";
import type { TranslateFn } from "../../types";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import type { WhatsAppActionRendererButton } from "../../builders/whatsapp/action-renderer";
import {
  WhatsAppTemplateButtonRowActions,
  type WhatsAppTemplateButtonRowActionsProps,
} from "../../builders/whatsapp/template-button-editor-tray";
import type { EditableWhatsAppTemplateButton } from "../../builders/whatsapp/template-editor-utils";
import type {
  ActionNodeBranchState,
  ActionNodeFormSubmittedRoute,
} from "./action-node-state";
import {
  WhatsAppTemplateButtonBranchHandle,
  WhatsAppTemplateFormSubmittedHandle,
} from "./action-node-whatsapp-template-section-ui";

type TemplatePreviewButtonContext = Omit<
  WhatsAppTemplateButtonRowActionsProps,
  "formIndex" | "branchHandle"
> & {
  id: string;
  t: TranslateFn;
  /** Quick-reply and Form submitted route handles render on the canvas only. */
  showPorts: boolean;
  savedBranchesById: ActionNodeBranchState["savedTemplateButtonBranchesById"];
  connectedPayloads: ActionNodeBranchState["connectedTemplateButtonPayloads"];
  formSubmittedRoute: ActionNodeFormSubmittedRoute;
  /** The FLOW row that draws the Form submitted dot. */
  formSubmittedButtonIndex: number | null;
  createNodeFromSourceHandle?: ScenarioActionEditorNodeData["uiOnCreateNodeFromSourceHandle"];
  refreshNodeInternals?: () => void;
};

/** Preview rows for the template's buttons, with their row actions and route handles. */
export function useWhatsAppTemplatePreviewButtons({
  buttons,
  id,
  t,
  showPorts,
  savedBranchesById,
  connectedPayloads,
  formSubmittedRoute,
  formSubmittedButtonIndex,
  createNodeFromSourceHandle,
  refreshNodeInternals,
  canEditTemplateFlow,
  inlineTemplateFlowId,
  openingInlineTemplateFlowId,
  openingLinkedFlowId,
  onButtonChange,
  onButtonRemove,
  onOpenInlineTemplateFlow,
  onOpenLinkedFlowPreview,
}: TemplatePreviewButtonContext & {
  buttons: EditableWhatsAppTemplateButton[];
}): WhatsAppActionRendererButton[] {
  return useMemo(() => {
    const context: TemplatePreviewButtonContext = {
      id,
      t,
      showPorts,
      savedBranchesById,
      connectedPayloads,
      formSubmittedRoute,
      formSubmittedButtonIndex,
      createNodeFromSourceHandle,
      refreshNodeInternals,
      canEditTemplateFlow,
      inlineTemplateFlowId,
      openingInlineTemplateFlowId,
      openingLinkedFlowId,
      onButtonChange,
      onButtonRemove,
      onOpenInlineTemplateFlow,
      onOpenLinkedFlowPreview,
    };
    return buttons.map((button, formIndex) =>
      buildTemplatePreviewButton(button, formIndex, context)
    );
  }, [
    buttons,
    id,
    t,
    showPorts,
    savedBranchesById,
    connectedPayloads,
    formSubmittedRoute,
    formSubmittedButtonIndex,
    createNodeFromSourceHandle,
    refreshNodeInternals,
    canEditTemplateFlow,
    inlineTemplateFlowId,
    openingInlineTemplateFlowId,
    openingLinkedFlowId,
    onButtonChange,
    onButtonRemove,
    onOpenInlineTemplateFlow,
    onOpenLinkedFlowPreview,
  ]);
}

function buildTemplatePreviewButton(
  button: EditableWhatsAppTemplateButton,
  formIndex: number,
  context: TemplatePreviewButtonContext
): WhatsAppActionRendererButton {
  const row: WhatsAppActionRendererButton = {
    key: `template-button-${button.index}`,
    type: button.type,
    label: templatePreviewButtonLabel(button, context.t),
    value: button.value,
    flowId: button.flowId,
    flowAction: button.flowAction,
    rowActions: (
      <WhatsAppTemplateButtonRowActions
        formIndex={formIndex}
        canEditTemplateFlow={context.canEditTemplateFlow}
        inlineTemplateFlowId={context.inlineTemplateFlowId}
        openingInlineTemplateFlowId={context.openingInlineTemplateFlowId}
        openingLinkedFlowId={context.openingLinkedFlowId}
        onButtonChange={context.onButtonChange}
        onButtonRemove={context.onButtonRemove}
        onOpenInlineTemplateFlow={context.onOpenInlineTemplateFlow}
        onOpenLinkedFlowPreview={context.onOpenLinkedFlowPreview}
        branchHandle={
          context.showPorts
            ? templatePreviewButtonRouteHandle(button, context)
            : null
        }
      />
    ),
  };
  if (button.type === "flow" || button.type === "quick_reply") {
    row.onLabelChange = (value: string) => {
      context.onButtonChange(button.index, { label: value });
    };
  }
  return row;
}

/**
 * A quick reply's route dot, or the template's Form submitted dot on its
 * FLOW row while the step shows that route in a row.
 */
function templatePreviewButtonRouteHandle(
  button: EditableWhatsAppTemplateButton,
  context: TemplatePreviewButtonContext
) {
  if (button.type === "quick_reply") {
    return (
      <WhatsAppTemplateButtonBranchHandle
        buttonLabel={button.label}
        savedBranch={
          button.routeId === undefined
            ? undefined
            : context.savedBranchesById.get(button.routeId)
        }
        connectedPayloads={context.connectedPayloads}
        createNodeFromSourceHandle={context.createNodeFromSourceHandle}
        refreshNodeInternals={context.refreshNodeInternals}
      />
    );
  }
  if (
    button.type === "flow" &&
    context.formSubmittedRoute.placement === "row"
  ) {
    return (
      <WhatsAppTemplateFormSubmittedHandle
        buttonLabel={button.label}
        opensSavedForm={button.index === context.formSubmittedButtonIndex}
        connected={context.formSubmittedRoute.connected}
        createNodeFromSourceHandle={context.createNodeFromSourceHandle}
        refreshNodeInternals={context.refreshNodeInternals}
      />
    );
  }
  return null;
}

function templatePreviewButtonLabel(
  button: EditableWhatsAppTemplateButton,
  t: TranslateFn
) {
  if (button.type === "request_contact_info")
    return button.label || t("buttonContactInfo");
  if (button.type === "copy_code")
    return button.label || t("whatsappTemplateCopyCode");
  return button.label;
}
