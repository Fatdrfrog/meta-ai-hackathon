"use client";

import { useTemplateFlowFacts } from "@/hooks/use-template-flow-facts";
import { fetchTemplateFlowFacts } from "@/lib/whatsapp/flows/client";
import { collectTemplateFlowIds } from "@/lib/whatsapp/flows/template-flow-health";
import { useCallback, useMemo } from "react";
import type { UseFormReturn } from "react-hook-form";
import type {
  EditableWhatsAppTemplateButton,
  EditableWhatsAppTemplateEditorFormValues,
} from "../../builders/whatsapp/template-editor-utils";
import {
  getTemplateButtonUnsetScreenFlowId,
  getTemplateFlowScreenIds,
  listTemplateScreenFlowIds,
  resolveTemplateFlowScreens,
  type TemplateFlowScreenLookup,
} from "../../builders/whatsapp/template-flow-screens";
import {
  TEMPLATE_EDITOR_FIELD_UPDATE_OPTIONS,
  type EditableTemplateButtonPatch,
} from "./action-node-template-editor";

type TemplateEditorForm =
  UseFormReturn<EditableWhatsAppTemplateEditorFormValues>;
type UpdateTemplateButton = (
  buttonIndex: number,
  patch: EditableTemplateButtonPatch
) => void;

/** Choosing a form, or switching a form button to open a screen. */
function patchNeedsFirstScreen(patch: EditableTemplateButtonPatch): boolean {
  return patch.flowId !== undefined || patch.flowAction === "navigate";
}

/** The row of the button that opens this form and has no first screen. */
function findUnsetScreenButton(
  form: TemplateEditorForm,
  flowId: string
): number {
  return form
    .getValues("buttons")
    .findIndex(button => getTemplateButtonUnsetScreenFlowId(button) === flowId);
}

/**
 * Sets a form button's first screen to its form's first screen, as the
 * Templates page does. It reads the screens through the same cached lookup
 * as the tray. Once they arrive it finds the button by its form, because
 * rows renumber when one is removed and a template has one form button. It
 * sets nothing if the merchant set a screen or chose another form meanwhile.
 */
async function defaultTemplateFlowFirstScreen({
  workspaceId,
  form,
  buttonIndex,
}: {
  workspaceId: string;
  form: TemplateEditorForm;
  buttonIndex: number;
}): Promise<void> {
  const flowId = getTemplateButtonUnsetScreenFlowId(
    form.getValues("buttons").find(button => button.index === buttonIndex)
  );
  if (!flowId) return;

  const factsByFlowId = await fetchTemplateFlowFacts({
    workspaceId,
    flowIds: [flowId],
  });
  const firstScreen = getTemplateFlowScreenIds(factsByFlowId[flowId])?.[0];
  const position = findUnsetScreenButton(form, flowId);
  if (!firstScreen || position < 0) return;
  form.setValue(
    `buttons.${position}.navigateScreen`,
    firstScreen,
    TEMPLATE_EDITOR_FIELD_UPDATE_OPTIONS
  );
}

/**
 * Reads the forms a template step uses, once for the whole step: the forms
 * its draft buttons open, for the tray's first screen field, the forms of
 * the template the form health notice checks, and the form whose fields the
 * step saved for AI steps. All read the same facts, so a reload in one
 * updates the others.
 *
 * `updateButton` wraps the editor's: choosing a form, or switching to open
 * a screen, sets the form's first screen.
 */
export function useWhatsAppTemplateFlowScreens({
  workspaceId,
  form,
  buttons,
  updateButton,
  healthComponents,
  fieldsFlowId,
}: {
  workspaceId?: string;
  form: TemplateEditorForm;
  buttons: readonly EditableWhatsAppTemplateButton[];
  updateButton: UpdateTemplateButton;
  /** The template the form health notice checks, when it shows. */
  healthComponents?: unknown;
  /**
   * The form the saved template's FLOW button opens, when the form fields
   * notice shows; the approved template may open another.
   */
  fieldsFlowId?: string | null;
}): {
  updateButton: UpdateTemplateButton;
  lookup: TemplateFlowScreenLookup | undefined;
  /** The facts the form health and form fields notices show. */
  flowFacts: ReturnType<typeof useTemplateFlowFacts>;
} {
  const flowIds = useMemo(
    () => [
      ...collectTemplateFlowIds(healthComponents),
      ...listTemplateScreenFlowIds(buttons),
      ...(fieldsFlowId ? [fieldsFlowId] : []),
    ],
    [buttons, fieldsFlowId, healthComponents]
  );
  const flowFacts = useTemplateFlowFacts({
    workspaceId,
    flowIds,
    enabled: flowIds.length > 0,
  });
  const { factsByFlowId, loading, refresh, isRefreshing } = flowFacts;

  const updateButtonWithFirstScreen = useCallback<UpdateTemplateButton>(
    (buttonIndex, patch) => {
      updateButton(buttonIndex, patch);
      if (!workspaceId || !patchNeedsFirstScreen(patch)) return;
      void defaultTemplateFlowFirstScreen({ workspaceId, form, buttonIndex });
    },
    [form, updateButton, workspaceId]
  );

  const lookup = useMemo<TemplateFlowScreenLookup | undefined>(
    () =>
      workspaceId
        ? {
            screensFor: flowId =>
              resolveTemplateFlowScreens({
                flowId,
                facts: factsByFlowId[flowId],
                loading,
              }),
            isRefreshing: flowId => isRefreshing([flowId]),
            refresh: flowId => void refresh([flowId]),
          }
        : undefined,
    [factsByFlowId, isRefreshing, loading, refresh, workspaceId]
  );

  return { updateButton: updateButtonWithFirstScreen, lookup, flowFacts };
}
