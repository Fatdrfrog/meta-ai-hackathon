"use client";

import { ScenarioInlineNotice } from "@/components/scenarios/scenario-inline-notice";
import { Button } from "@/components/ui/button";
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
import type { ScenarioWhatsAppServiceMessageKind } from "@icecore/scenario-contracts";
import type { TranslateFn } from "../../../types";
import type {
  ServiceMessageActionUnavailableReason,
  ServiceMessageEditorIntent,
  ServiceMessageEditorProjection,
} from "./service-message-editor-model";
import type {
  useWhatsAppServiceMessageResources,
  WhatsAppServiceResourceFailures,
} from "./service-message-resources";
import type { ServiceMessageValidationSummary } from "./service-message-validation-summary";

type ServiceMessageResources = ReturnType<
  typeof useWhatsAppServiceMessageResources
>;

/** Only the message types that use the failed data say it failed. */
function resourcesFailedFor(
  kind: ScenarioWhatsAppServiceMessageKind,
  failed: WhatsAppServiceResourceFailures
): boolean {
  return (
    (kind === "cta_url" && failed.signupLinks) ||
    (kind === "voice_call" && failed.calling) ||
    (kind === "commerce" && failed.catalog)
  );
}

function currentActionUnavailableMessageKey(
  reason: ServiceMessageActionUnavailableReason | null
): string | null {
  switch (reason) {
    case "calling_not_ready":
      return "whatsappServiceCallingUnavailable";
    case "coexistence_unsupported":
      return "whatsappServiceCurrentActionCoexistenceUnavailable";
    case "standalone_media":
      return "whatsappServiceMediaAudioNotAllowedHere";
    case null:
      return null;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function pendingIntentTitleKey(
  intent: ServiceMessageEditorIntent | null
): string {
  if (intent?.type === "add_choice")
    return "whatsappServiceListConversionTitle";
  if (intent?.type === "remove_action")
    return "whatsappServiceRemoveActionTitle";
  return "whatsappServiceChangeActionTitle";
}

export function ServiceMessageResourcesFailedNotice({
  kind,
  resources,
  t,
}: {
  kind: ScenarioWhatsAppServiceMessageKind;
  resources: ServiceMessageResources;
  t: TranslateFn;
}) {
  if (!resourcesFailedFor(kind, resources.failedResources)) return null;
  return (
    <ScenarioInlineNotice
      tone="error"
      className="mb-2"
      data-testid="whatsapp-service-resources-failed"
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="nodrag nopan h-6 bg-background px-2 text-[11px] text-foreground"
          onPointerDown={event => event.stopPropagation()}
          onClick={resources.retry}
        >
          {t("retry")}
        </Button>
      }
    >
      {t("whatsappServiceResourcesFailed")}
    </ScenarioInlineNotice>
  );
}

export function ServiceMessageCurrentActionNotice({
  projection,
  resources,
  t,
}: {
  projection: ServiceMessageEditorProjection;
  resources: ServiceMessageResources;
  t: TranslateFn;
}) {
  const reason = projection.currentActionUnavailableReason;
  const warningKey = currentActionUnavailableMessageKey(reason);
  if (projection.currentActionAvailable || warningKey === null) return null;
  // While calling loads, or after it failed to load, it is not known yet.
  if (
    (resources.loading || resources.failedResources.calling) &&
    reason === "calling_not_ready"
  )
    return null;
  return (
    <ScenarioInlineNotice
      className="mt-1.5"
      data-testid="whatsapp-service-current-action-unavailable"
    >
      {t(warningKey)}
    </ScenarioInlineNotice>
  );
}

export function ServiceMessageValidationNotice({
  validation,
  firstIssueShownInline,
  firstIssueReachable,
  t,
  onShowFirstIssue,
}: {
  validation: ServiceMessageValidationSummary;
  /** A field on the step, or the preview, already shows the first issue. */
  firstIssueShownInline: boolean;
  firstIssueReachable: boolean;
  t: TranslateFn;
  onShowFirstIssue: () => void;
}) {
  const { issueCount, firstIssueMessage } = validation;
  if (issueCount === 0) return null;
  return (
    <ScenarioInlineNotice
      tone="error"
      className="mt-1.5"
      data-testid="whatsapp-service-message-validation"
      action={
        validation.firstFieldKey && firstIssueReachable ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="nodrag nopan h-6 px-2 text-[11px] text-current hover:text-current"
            onPointerDown={event => event.stopPropagation()}
            onClick={onShowFirstIssue}
          >
            {t("whatsappServiceValidationShowFirst")}
          </Button>
        ) : undefined
      }
    >
      {firstIssueShownInline || !firstIssueMessage ? (
        t("whatsappServiceValidationIssueCount", { count: issueCount })
      ) : (
        <>
          {firstIssueMessage}
          {issueCount > 1
            ? " · " +
              t("whatsappServiceValidationIssueCount", { count: issueCount })
            : null}
        </>
      )}
    </ScenarioInlineNotice>
  );
}

/** Confirms an edit that drops buttons and their routes, or turns reply buttons into a list. */
export function ServiceMessagePendingIntentDialog({
  intent,
  t,
  onDismiss,
  onConfirm,
}: {
  intent: ServiceMessageEditorIntent | null;
  t: TranslateFn;
  onDismiss: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={intent !== null}
      onOpenChange={open => {
        if (!open) onDismiss();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(pendingIntentTitleKey(intent))}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              intent?.type === "add_choice"
                ? "whatsappServiceListConversionHint"
                : "whatsappServiceChangeActionHint"
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => onConfirm()}>
            {t(intent?.type === "remove_action" ? "delete" : "continue")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
