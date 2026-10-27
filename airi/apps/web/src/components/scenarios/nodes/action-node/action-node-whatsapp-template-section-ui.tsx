"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  WhatsAppTemplateButtonBranchOption,
  WhatsAppTemplateButtonDrift,
} from "@/lib/scenarios/whatsapp-template-button-branches";
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildWhatsAppTemplateButtonSourceHandleId,
  type ScenarioGeneratedTemplateDraft,
} from "@icecore/scenario-contracts";
import { Loader2, RefreshCw, Save, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ComponentProps, ReactNode, SyntheticEvent } from "react";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import {
  getTemplateQuickReplySourceHandleCopy,
  getWhatsAppTemplateFormSubmittedSourceHandleCopy,
} from "../../view/scenario-source-handle-copy";
import {
  describeWhatsAppTemplateButtonDrift,
  formatQuotedLabelList,
} from "../../view/scenario-template-utils";
import { ScenarioInfoHint } from "../../scenario-info-hint";
import { ScenarioInlineNotice } from "../../scenario-inline-notice";
import {
  ScenarioRouteHandle,
  bindSourceHandleCreate,
} from "../../scenario-route";
import type { ActionNodeBranchState } from "./action-node-state";
import { stopScenarioWheelPropagation } from "./action-node-utils";
import { ActionNodeWhatsAppTemplatePicker } from "./action-node-whatsapp-template-picker";

const CARD_CONTROL_CLASS = "nodrag nopan nokey";

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

/** Keeps presses on card controls from selecting or dragging the node. */
const CARD_CONTROL_EVENTS = {
  onPointerDown: stopPropagation,
  onClick: stopPropagation,
};

const GENERATED_DRAFT_STATUS_KEYS: Record<
  ScenarioGeneratedTemplateDraft["status"],
  string
> = {
  draft: "whatsappTemplateDraftStatusDraft",
  submitting: "whatsappTemplateDraftStatusSubmitting",
  submitted: "whatsappTemplateDraftStatusInReview",
  pending: "whatsappTemplateDraftStatusInReview",
  approved: "whatsappTemplateDraftStatusApproved",
  rejected: "whatsappTemplateDraftStatusRejected",
};

/** The template picker, with its shared badge and unverified notice. */
export function WhatsAppTemplatePickerField({
  shared,
  unverified,
  onRefresh,
  refreshDisabled,
  ...pickerProps
}: Omit<
  ComponentProps<typeof ActionNodeWhatsAppTemplatePicker>,
  "labelAccessory"
> & {
  shared: boolean;
  unverified: boolean;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
}) {
  const t = useTranslations("Scenarios");
  return (
    <>
      <ActionNodeWhatsAppTemplatePicker
        {...pickerProps}
        labelAccessory={
          <>
            {shared ? <WhatsAppTemplateSharedBadge /> : null}
            {onRefresh ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="nodrag nopan nokey ml-auto h-6 gap-1 px-1 text-[11px]"
                onClick={event => {
                  event.stopPropagation();
                  onRefresh();
                }}
                disabled={refreshDisabled}
                aria-label={t("refresh")}
              >
                <RefreshCw className="size-3" />
                {t("refresh")}
              </Button>
            ) : null}
          </>
        }
      />
      {unverified ? (
        <ScenarioInlineNotice
          className="w-full"
          data-testid="whatsapp-template-unverified"
        >
          {t("whatsappTemplateUnverified")}
        </ScenarioInlineNotice>
      ) : null}
    </>
  );
}

function WhatsAppTemplateSharedBadge() {
  const t = useTranslations("Scenarios");
  return (
    <span className="inline-flex items-center">
      <Badge
        variant="outline"
        data-testid="whatsapp-template-shared"
        className="h-4 px-1.5 text-[10px] font-normal"
      >
        {t("whatsappTemplateShared")}
      </Badge>
      <ScenarioInfoHint
        label={t("infoHintLabel", {
          topic: t("whatsappTemplateShared"),
        })}
      >
        {t("whatsappTemplateSharedInfo")}
      </ScenarioInfoHint>
    </span>
  );
}

/**
 * A saved quick reply gets its route handle; a new one explains that saving
 * the template connects it.
 */
export function WhatsAppTemplateButtonBranchHandle({
  buttonLabel,
  savedBranch,
  connectedPayloads,
  createNodeFromSourceHandle,
  refreshNodeInternals,
}: {
  buttonLabel: string;
  savedBranch: WhatsAppTemplateButtonBranchOption | undefined;
  connectedPayloads: ActionNodeBranchState["connectedTemplateButtonPayloads"];
  createNodeFromSourceHandle?: ScenarioActionEditorNodeData["uiOnCreateNodeFromSourceHandle"];
  refreshNodeInternals?: () => void;
}) {
  const t = useTranslations("Scenarios");
  const branchSourceCopy = getTemplateQuickReplySourceHandleCopy(
    t,
    buttonLabel || t("buttonReply")
  );
  if (savedBranch && branchSourceCopy) {
    const branchHandleId = buildWhatsAppTemplateButtonSourceHandleId(
      savedBranch.buttonId
    );
    return (
      <ScenarioRouteHandle
        id={branchHandleId}
        local
        connected={connectedPayloads.has(savedBranch.payload)}
        title={branchSourceCopy.tooltip}
        ariaLabel={branchSourceCopy.label}
        testId="whatsapp-template-button-branch-handle"
        onCreateNode={bindSourceHandleCreate(
          createNodeFromSourceHandle,
          branchHandleId
        )}
        onInteractionStart={refreshNodeInternals}
      />
    );
  }
  return <WhatsAppTemplateUnsavedRouteHint buttonLabel={buttonLabel} />;
}

/**
 * The template's one FLOW row carries the step's "Form submitted" route. A
 * row that opens another form explains that saving the template connects
 * it.
 */
export function WhatsAppTemplateFormSubmittedHandle({
  buttonLabel,
  opensSavedForm,
  connected,
  createNodeFromSourceHandle,
  refreshNodeInternals,
}: {
  buttonLabel: string;
  /** The row opens the saved template's form, which the route belongs to. */
  opensSavedForm: boolean;
  connected: boolean;
  createNodeFromSourceHandle?: ScenarioActionEditorNodeData["uiOnCreateNodeFromSourceHandle"];
  refreshNodeInternals?: () => void;
}) {
  const t = useTranslations("Scenarios");
  if (!opensSavedForm) {
    return <WhatsAppTemplateUnsavedRouteHint buttonLabel={buttonLabel} />;
  }
  const handleId = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
  const copy = getWhatsAppTemplateFormSubmittedSourceHandleCopy(t);
  return (
    <ScenarioRouteHandle
      id={handleId}
      local
      connected={connected}
      title={copy.tooltip}
      ariaLabel={copy.label}
      testId="whatsapp-template-form-submitted-handle"
      onCreateNode={bindSourceHandleCreate(
        createNodeFromSourceHandle,
        handleId
      )}
      onInteractionStart={refreshNodeInternals}
    />
  );
}

function WhatsAppTemplateUnsavedRouteHint({
  buttonLabel,
}: {
  buttonLabel: string;
}) {
  const t = useTranslations("Scenarios");
  return (
    <span
      className="inline-flex items-center"
      data-testid="whatsapp-template-button-unsaved-route"
    >
      <span
        aria-hidden
        className="mx-1 size-2.5 rounded-full border border-muted-foreground/40 bg-muted"
      />
      <ScenarioInfoHint
        label={t("infoHintLabel", {
          topic: buttonLabel.trim() || t("untitledButton"),
        })}
      >
        {t("whatsappTemplateSaveToConnect")}
      </ScenarioInfoHint>
    </span>
  );
}

/**
 * WhatsApp sends the approved template, so its reply buttons decide which
 * routes run. Warns, one line each, where they move the step's routes, and
 * offers to take the approved template into the step.
 */
export function WhatsAppTemplateButtonDriftNotice({
  drift,
  templateValue,
  onSelectTemplate,
}: {
  drift: readonly WhatsAppTemplateButtonDrift[];
  /** The step's template in the picker. */
  templateValue: string;
  onSelectTemplate: (templateValue: string) => void;
}) {
  const t = useTranslations("Scenarios");
  if (drift.length === 0) return null;
  // Buttons that share a text would repeat the same sentence.
  const descriptions = Array.from(
    new Set(drift.map(item => describeWhatsAppTemplateButtonDrift(item, t)))
  );
  const approvedTemplateAction = templateValue ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(CARD_CONTROL_CLASS, "h-7 px-2 text-[11px]")}
      onPointerDown={stopPropagation}
      onClick={event => {
        event.stopPropagation();
        onSelectTemplate(templateValue);
      }}
    >
      {t("whatsappTemplateButtonDriftUseApproved")}
    </Button>
  ) : undefined;
  return (
    <div
      className="flex w-full flex-col gap-1"
      data-testid="whatsapp-template-button-drift"
    >
      {descriptions.map((description, position) => (
        <ScenarioInlineNotice
          key={description}
          data-testid="whatsapp-template-button-drift-item"
          action={
            position === descriptions.length - 1
              ? approvedTemplateAction
              : undefined
          }
        >
          {description}
        </ScenarioInlineNotice>
      ))}
    </div>
  );
}

/** Review status of an AI-written template, with Send for review while allowed. */
export function WhatsAppTemplateGeneratedDraftStatus({
  draft,
  canSubmit,
  submitting,
  onSubmit,
}: {
  draft: ScenarioGeneratedTemplateDraft | undefined;
  canSubmit: boolean;
  submitting: boolean;
  onSubmit: () => Promise<unknown>;
}) {
  const t = useTranslations("Scenarios");
  if (!draft) return null;
  return (
    <div
      className="flex w-full flex-wrap items-center gap-2"
      {...CARD_CONTROL_EVENTS}
    >
      <Badge
        variant={draft.status === "rejected" ? "destructive" : "outline"}
        data-testid="whatsapp-template-draft-status"
        className="h-5"
      >
        {t(GENERATED_DRAFT_STATUS_KEYS[draft.status])}
      </Badge>
      {canSubmit ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(CARD_CONTROL_CLASS, "ml-auto h-8 gap-1.5")}
          disabled={submitting}
          onClick={() => void onSubmit()}
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Send className="h-4 w-4" aria-hidden />
          )}
          {t("whatsappTemplateSendForReview")}
        </Button>
      ) : null}
    </div>
  );
}

export function WhatsAppTemplateRejectedNotice({
  draft,
}: {
  draft: ScenarioGeneratedTemplateDraft | undefined;
}) {
  const t = useTranslations("Scenarios");
  const reason = draft?.status === "rejected" ? draft.error?.trim() || "" : "";
  if (!reason) return null;
  return (
    <ScenarioInlineNotice
      tone="error"
      className="w-full"
      data-testid="whatsapp-template-rejected"
    >
      {t("whatsappTemplateRejectedReason", { reason })}
    </ScenarioInlineNotice>
  );
}

/** Unsaved template edits: discard them, or submit the form to update the shared template. */
export function WhatsAppTemplateSaveBar({
  dirty,
  submitting,
  saving,
  canSubmitGenerated,
  onDiscard,
}: {
  dirty: boolean;
  submitting: boolean;
  saving: boolean;
  /** An AI draft is sent for review instead, so it has no Save button. */
  canSubmitGenerated: boolean;
  onDiscard: () => void;
}) {
  const t = useTranslations("Scenarios");
  if (!dirty) return null;
  return (
    <div
      className="w-full space-y-1.5 rounded-md border border-dashed px-2 py-1.5"
      data-testid="whatsapp-template-save-bar"
      {...CARD_CONTROL_EVENTS}
    >
      <p className="text-[11px] leading-snug text-muted-foreground">
        {t("whatsappTemplateDraftUnsaved")}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(CARD_CONTROL_CLASS, "h-8")}
          disabled={submitting}
          onClick={onDiscard}
        >
          {t("whatsappTemplateDiscardDraft")}
        </Button>
        {!canSubmitGenerated ? (
          <Button
            type="submit"
            size="sm"
            className={cn(CARD_CONTROL_CLASS, "h-8 gap-1.5")}
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Save className="h-4 w-4" aria-hidden />
            )}
            {t("whatsappTemplateUpdateShared")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function WhatsAppTemplateSaveConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  removedRouteLabels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
  /** Buttons whose routes Save removes. */
  removedRouteLabels: readonly string[];
}) {
  const t = useTranslations("Scenarios");
  const removedRoutes = formatQuotedLabelList(removedRouteLabels, t);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("whatsappTemplateSaveConfirmTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("whatsappTemplateSharedInfo")}
            {removedRoutes.count > 0 ? (
              <span
                className="mt-2 block"
                data-testid="whatsapp-template-save-confirm-removes-routes"
              >
                {t("whatsappTemplateSaveConfirmRemovesRoutes", removedRoutes)}
              </span>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()}>
            {t("whatsappTemplateUpdateShared")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Frame for the template's inline Flow builder, shown while it is open. */
export function WhatsAppTemplateFlowDrawer({
  id,
  canEdit,
  open,
  placement,
  templateName,
  templateLanguage,
  children,
}: {
  id: string;
  canEdit: boolean;
  open: boolean;
  placement: "overlay" | "inline";
  templateName: string;
  templateLanguage: string;
  children: ReactNode;
}) {
  const t = useTranslations("Scenarios");
  if (!canEdit || !open) return null;
  const titleId = `${id}-template-flow-drawer-title`;
  const descriptionId = `${id}-template-flow-drawer-description`;
  const summaryLabel = templateName
    ? templateLanguage
      ? `${templateName} [${templateLanguage}]`
      : templateName
    : t("whatsappTemplateSelectPlaceholder");
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={cn(
        "nowheel flex h-[min(32rem,75vh)] max-h-[min(32rem,75vh)] flex-col overflow-hidden overscroll-contain bg-background p-0",
        placement === "inline"
          ? "w-full rounded-md border"
          : "absolute inset-x-0 bottom-0 z-[1] border-t-0"
      )}
      onWheel={stopScenarioWheelPropagation}
    >
      <div id={titleId} className="sr-only">
        {t("flowBuilderLabel")}
      </div>
      <div id={descriptionId} className="sr-only">
        {summaryLabel}
      </div>
      <div className="nowheel min-h-0 flex flex-1 overflow-hidden overscroll-contain p-0">
        {children}
      </div>
    </div>
  );
}
