"use client";

import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import {
  updateScenarioWhatsAppTemplate,
  type UpdateScenarioWhatsAppTemplateResult,
} from "@/lib/scenarios/client";
import { buildWhatsAppTemplateFormAlignmentPatch } from "@/lib/scenarios/whatsapp-template-flow";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useForm, type FieldErrors, type UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import type { ScenarioNodeData } from "../../types";
import { useScenarioEditorDraftStore } from "../../view/editor-drafts";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import { useLatestRef } from "../../view/use-latest-ref";
import {
  buildWhatsAppTemplateEditorSave,
  buildWhatsAppTemplateEditorSavePatch,
  editableWhatsAppTemplateEditorFormSchema,
  ensureWhatsAppTemplateBodyComponent,
  getEditableWhatsAppTemplateEditorFormValues,
  isWhatsAppTemplateEditorErrorKey,
  type EditableWhatsAppTemplateButton,
  type EditableWhatsAppTemplateEditorFormValues,
  type WhatsAppTemplateEditorSave,
} from "../../builders/whatsapp/template-editor-utils";
import {
  applyEditableTemplateButtonPatch,
  createEditableTemplateButton,
  EMPTY_EDITABLE_TEMPLATE_BUTTONS,
  formatTemplateEditorIssuePath,
  getFirstTemplateEditorErrorMessage,
  reindexEditableTemplateButtons,
  resolveMissingTemplateFlowNavigateScreens,
  TEMPLATE_EDITOR_FIELD_UPDATE_OPTIONS,
  type EditableTemplateButtonPatch,
} from "./action-node-template-editor";
import { showScenarioErrorToast } from "./action-node-utils";

type WhatsAppTemplateEditorNodeData = Pick<
  ScenarioActionEditorNodeData,
  | "actionFlowConfig"
  | "actionReplyText"
  | "actionWhatsAppTemplateButtonIds"
  | "actionWhatsAppTemplateComponents"
  | "actionWhatsAppTemplateForm"
  | "actionWhatsAppTemplateLanguage"
  | "actionWhatsAppTemplateName"
  | "uiActiveScenarioId"
>;

function templateLogContext(nodeData: WhatsAppTemplateEditorNodeData) {
  return {
    templateName: nodeData.actionWhatsAppTemplateName || null,
    templateLanguage: nodeData.actionWhatsAppTemplateLanguage || null,
  };
}

function warnTemplateUpdateSkipped(params: {
  nodeId: string;
  workspaceId: string;
  templateId: string;
  templateName: string | null;
  templateLanguage: string | null;
}) {
  // eslint-disable-next-line no-console
  console.warn("[Scenarios] WhatsApp template Meta update skipped", {
    nodeId: params.nodeId,
    workspaceId: params.workspaceId || null,
    templateId: params.templateId || null,
    templateName: params.templateName,
    templateLanguage: params.templateLanguage,
  });
}

function reportTemplateUpdateFailure(params: {
  nodeId: string;
  templateId: string;
  result: Extract<UpdateScenarioWhatsAppTemplateResult, { ok: false }>;
  message: string;
}) {
  // eslint-disable-next-line no-console
  console.warn("[Scenarios] WhatsApp template Meta update failed", {
    nodeId: params.nodeId,
    templateId: params.templateId,
    status: params.result.status,
    error: params.result.error,
  });
  showScenarioErrorToast(
    params.message,
    params.result.error ? new Error(params.result.error) : undefined,
    { showReason: true }
  );
}

/** Puts the template WhatsApp accepted on the step and in the editor. */
function applySavedTemplate(params: {
  saved: WhatsAppTemplateEditorSave;
  templateCategory: string | undefined;
  nodeData: WhatsAppTemplateEditorNodeData;
  patchNode: (patch: Partial<ScenarioNodeData>) => void;
  form: UseFormReturn<EditableWhatsAppTemplateEditorFormValues>;
  submittedDraft: string;
  saveDraft: (
    draft: EditableWhatsAppTemplateEditorFormValues | undefined
  ) => void;
  successMessage: string;
  refreshTemplates?: () => void | Promise<void>;
}) {
  const currentDraft = params.form.getValues();
  const editedDuringSave =
    JSON.stringify(currentDraft) !== params.submittedDraft;
  // First, so a toast naming the routes the save removed shows above it.
  toast.success(params.successMessage);
  params.patchNode({
    ...buildWhatsAppTemplateEditorSavePatch(
      params.saved,
      params.templateCategory
    ),
    // A form button that now opens another Flow drops the old Flow's linked
    // config, and no form button drops its saved fields too.
    ...buildWhatsAppTemplateFormAlignmentPatch(
      params.nodeData,
      params.saved.components
    ),
  });
  params.form.reset(params.saved.values);
  if (editedDuringSave) {
    params.form.reset(currentDraft, { keepDefaultValues: true });
  }
  params.saveDraft(editedDuringSave ? currentDraft : undefined);
  // The loaded catalog still has the template as it was before this save.
  void params.refreshTemplates?.();
}

export function useWhatsAppTemplateEditor({
  id,
  workspaceId,
  templateId,
  templateCategory,
  nodeData,
  patchNode,
  refreshTemplates,
}: {
  id: string;
  workspaceId: string;
  templateId: string;
  templateCategory?: string;
  nodeData: WhatsAppTemplateEditorNodeData;
  patchNode: (patch: Partial<ScenarioNodeData>) => void;
  /** Reloads the template catalog after a save. */
  refreshTemplates?: () => void | Promise<void>;
}) {
  const t = useTranslations("Scenarios");
  const components = useMemo(
    () =>
      ensureWhatsAppTemplateBodyComponent(
        nodeData.actionWhatsAppTemplateComponents
      ),
    [nodeData.actionWhatsAppTemplateComponents]
  );
  const defaults = useMemo(
    () =>
      getEditableWhatsAppTemplateEditorFormValues({
        replyText: nodeData.actionReplyText,
        components,
        buttonIds: nodeData.actionWhatsAppTemplateButtonIds,
      }),
    [
      components,
      nodeData.actionReplyText,
      nodeData.actionWhatsAppTemplateButtonIds,
    ]
  );
  const draftStore = useScenarioEditorDraftStore();
  const draftKey =
    "template:" +
    JSON.stringify([
      workspaceId,
      nodeData.uiActiveScenarioId,
      id,
      templateId,
      nodeData.actionWhatsAppTemplateName,
      nodeData.actionWhatsAppTemplateLanguage,
    ]);
  const saveKey = JSON.stringify([workspaceId, templateId]);
  const isUpdatePending = useSyncExternalStore(
    draftStore.subscribe,
    () => draftStore.isPending(saveKey),
    () => false
  );
  const ownerKey = useTransitionOwnerKey(draftKey);
  const ownerRef = useLatestRef(ownerKey);

  useEffect(
    () => () => {
      ownerRef.current = "";
    },
    [ownerRef]
  );

  const form = useForm<EditableWhatsAppTemplateEditorFormValues>({
    resolver: zodResolver(editableWhatsAppTemplateEditorFormSchema, undefined, {
      mode: "sync",
    }),
    defaultValues:
      draftStore.get<EditableWhatsAppTemplateEditorFormValues>(draftKey) ??
      defaults,
    mode: "onChange",
  });
  const {
    formState: { isDirty, isSubmitting },
    handleSubmit,
    reset,
    setValue,
    watch,
  } = form;

  useEffect(() => {
    reset(defaults);
    const draft =
      draftStore.get<EditableWhatsAppTemplateEditorFormValues>(draftKey);
    if (draft) reset(draft, { keepDefaultValues: true });
    const subscription = watch(() => {
      const values = form.getValues();
      draftStore.set(
        draftKey,
        JSON.stringify(values) === JSON.stringify(defaults) ? undefined : values
      );
    });
    return () => subscription.unsubscribe();
  }, [defaults, draftKey, draftStore, form, reset, setValue, watch]);

  const headerText = watch("headerText") ?? "";
  const bodyText = watch("bodyText") ?? "";
  const footerText = watch("footerText") ?? "";
  const watchedButtons = watch("buttons");
  const buttons = watchedButtons ?? EMPTY_EDITABLE_TEMPLATE_BUTTONS;

  const setButtons = useCallback(
    (nextButtons: EditableWhatsAppTemplateButton[]) => {
      setValue(
        "buttons",
        reindexEditableTemplateButtons(nextButtons),
        TEMPLATE_EDITOR_FIELD_UPDATE_OPTIONS
      );
    },
    [setValue]
  );
  const setHeaderText = useCallback(
    (value: string) => {
      setValue("headerText", value, TEMPLATE_EDITOR_FIELD_UPDATE_OPTIONS);
    },
    [setValue]
  );
  const setBodyText = useCallback(
    (value: string) => {
      setValue("bodyText", value, TEMPLATE_EDITOR_FIELD_UPDATE_OPTIONS);
    },
    [setValue]
  );
  const setFooterText = useCallback(
    (value: string) => {
      setValue("footerText", value, TEMPLATE_EDITOR_FIELD_UPDATE_OPTIONS);
    },
    [setValue]
  );
  const updateButton = useCallback(
    (buttonIndex: number, patch: EditableTemplateButtonPatch) => {
      setButtons(
        buttons.map(button =>
          button.index === buttonIndex
            ? applyEditableTemplateButtonPatch(button, patch)
            : button
        )
      );
    },
    [buttons, setButtons]
  );
  const removeButton = useCallback(
    (buttonIndex: number) => {
      setButtons(buttons.filter(button => button.index !== buttonIndex));
    },
    [buttons, setButtons]
  );
  const addButton = useCallback(() => {
    setButtons([...buttons, createEditableTemplateButton(buttons.length)]);
  }, [buttons, setButtons]);

  const handleInvalid = useCallback(
    (errors: FieldErrors<EditableWhatsAppTemplateEditorFormValues>) => {
      const attemptedValues = { headerText, bodyText, footerText, buttons };
      const parsed =
        editableWhatsAppTemplateEditorFormSchema.safeParse(attemptedValues);
      const firstSchemaIssue = parsed.success ? null : parsed.error.issues[0];
      const message =
        firstSchemaIssue?.message ||
        getFirstTemplateEditorErrorMessage(errors) ||
        "";

      // eslint-disable-next-line no-console
      console.warn("[Scenarios] WhatsApp template save blocked", {
        nodeId: id,
        templateName: nodeData.actionWhatsAppTemplateName || null,
        templateLanguage: nodeData.actionWhatsAppTemplateLanguage || null,
        message,
        issues: parsed.success
          ? errors
          : parsed.error.issues.map(issue => ({
              path: formatTemplateEditorIssuePath(issue.path),
              message: issue.message,
              code: issue.code,
            })),
      });
      // The tray marks the fields; the toast names the first problem.
      toast.error(
        t("whatsappTemplateSaveInvalid"),
        isWhatsAppTemplateEditorErrorKey(message)
          ? { description: t(message) }
          : undefined
      );
    },
    [
      bodyText,
      buttons,
      footerText,
      headerText,
      id,
      nodeData.actionWhatsAppTemplateLanguage,
      nodeData.actionWhatsAppTemplateName,
      t,
    ]
  );

  const save = handleSubmit(async values => {
    const submittedSaveKey = saveKey;
    if (!draftStore.begin(submittedSaveKey)) return;
    const submittedOwner = ownerKey;
    const submittedPatch = patchNode;
    const logContext = templateLogContext(nodeData);
    try {
      const submittedDraft = JSON.stringify(form.getValues());
      // This no longer fills anything: validation already rejected any form
      // button without a first screen, which the tray's first screen field
      // sets. Removing the lookup is a follow-up.
      const valuesForMeta = await resolveMissingTemplateFlowNavigateScreens({
        values,
        workspaceId,
        flowConfig: nodeData.actionFlowConfig,
        nodeId: id,
      });
      if (ownerRef.current !== submittedOwner) return;
      const saved = buildWhatsAppTemplateEditorSave({
        components,
        buttonIds: nodeData.actionWhatsAppTemplateButtonIds,
        values: valuesForMeta,
      });
      const nextComponents = saved.components;

      if (!workspaceId || !templateId) {
        warnTemplateUpdateSkipped({
          nodeId: id,
          workspaceId,
          templateId,
          ...logContext,
        });
        toast.error(t("whatsappTemplateMetaUpdateMissing"));
        return;
      }

      // eslint-disable-next-line no-console
      console.info("[Scenarios] Updating WhatsApp template in Meta", {
        nodeId: id,
        workspaceId,
        templateId,
        ...logContext,
        componentTypes: nextComponents.map(component => component.type),
      });
      const updateResult = await updateScenarioWhatsAppTemplate({
        workspaceId,
        templateId,
        category: templateCategory,
        components: nextComponents,
      });
      if (ownerRef.current !== submittedOwner) return;
      if (!updateResult.ok) {
        reportTemplateUpdateFailure({
          nodeId: id,
          templateId,
          result: updateResult,
          message: t("whatsappTemplateMetaUpdateFailed"),
        });
        return;
      }

      // eslint-disable-next-line no-console
      console.info("[Scenarios] WhatsApp template updated in Meta", {
        nodeId: id,
        templateId,
      });
      applySavedTemplate({
        saved,
        templateCategory,
        nodeData,
        patchNode: submittedPatch,
        form,
        submittedDraft,
        saveDraft: draft => draftStore.set(draftKey, draft),
        successMessage: t("whatsappTemplateMetaUpdateSuccess"),
        refreshTemplates,
      });
    } catch (error) {
      if (ownerRef.current === submittedOwner) {
        showScenarioErrorToast(t("whatsappTemplateMetaUpdateFailed"), error, {
          showReason: true,
        });
      }
    } finally {
      draftStore.finish(submittedSaveKey);
    }
  }, handleInvalid);

  const discard = useCallback(() => {
    reset(defaults);
    draftStore.set(draftKey, undefined);
  }, [defaults, draftKey, draftStore, reset]);

  return {
    form,
    save,
    discard,
    isDirty,
    isSubmitting,
    isUpdatePending,
    components,
    headerText,
    bodyText,
    footerText,
    buttons,
    setHeaderText,
    setBodyText,
    setFooterText,
    updateButton,
    removeButton,
    addButton,
  };
}
