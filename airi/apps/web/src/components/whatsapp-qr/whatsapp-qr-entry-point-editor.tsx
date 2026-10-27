"use client";

import { ArrowLeftIcon, AlertCircleIcon, SaveIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

import type {
  WhatsAppQrEntryPointController,
  WhatsAppQrSourceOption,
} from "./types";
import type { WhatsAppQrDeleteCodeTarget } from "./whatsapp-qr-delete-code-dialog";
import { WhatsAppQrDeleteCodeDialog } from "./whatsapp-qr-delete-code-dialog";
import { useWhatsAppQrEntryPoint } from "./use-whatsapp-qr-entry-point";
import { WhatsAppQrArtwork } from "./whatsapp-qr-artwork";
import { WhatsAppQrEntryPointDetail } from "./whatsapp-qr-entry-point-detail";
import {
  useWhatsAppQrEntryPointValidationMessages,
  validateWhatsAppQrEntryPointForm,
  WhatsAppQrEntryPointForm,
  type WhatsAppQrEntryPointFormValue,
} from "./whatsapp-qr-entry-point-form";

export type WhatsAppQrEntryPointEditorProps = {
  workspaceId: string;
  controller: WhatsAppQrEntryPointController;
  sourceOptions: readonly WhatsAppQrSourceOption[];
  artworkSlot?: ReactNode;
  providerMutationUnavailableReason?: string;
};

export type WhatsAppQrEntryPointWorkspaceProps = {
  workspaceId: string;
  entryPointId: string;
  sourceOptions: readonly WhatsAppQrSourceOption[];
  providerMutationUnavailableReason?: string;
};

export function WhatsAppQrEntryPointWorkspace({
  workspaceId,
  entryPointId,
  sourceOptions,
  providerMutationUnavailableReason,
}: WhatsAppQrEntryPointWorkspaceProps) {
  const router = useRouter();
  const t = useTranslations("WhatsAppQr");
  const refreshRoute = useCallback(() => router.refresh(), [router]);
  const controller = useWhatsAppQrEntryPoint({
    workspaceId,
    entryPointId,
    onMutationSettled: refreshRoute,
  });
  const managerHref = `/panel/w/${workspaceId}/messengers/whatsapp-qr`;
  const placementName =
    controller.detail?.entryPoint.placementName || t("page.title");
  const currentCode = controller.detail?.currentCode;
  const artworkCodeId =
    currentCode?.providerState === "ACTIVE" && currentCode.deepLink
      ? currentCode.codeId
      : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={placementName}
        description={t("page.description")}
        secondaryAction={
          <Button asChild variant="outline">
            <Link href={managerHref}>
              <ArrowLeftIcon data-icon="inline-start" />
              {t("page.title")}
            </Link>
          </Button>
        }
      />
      <WhatsAppQrEntryPointEditor
        workspaceId={workspaceId}
        controller={controller}
        sourceOptions={sourceOptions}
        providerMutationUnavailableReason={providerMutationUnavailableReason}
        artworkSlot={
          <WhatsAppQrArtwork
            workspaceId={workspaceId}
            codeId={artworkCodeId}
            placementName={placementName}
          />
        }
      />
    </div>
  );
}

export function WhatsAppQrEntryPointEditor({
  workspaceId,
  controller,
  sourceOptions,
  artworkSlot,
  providerMutationUnavailableReason,
}: WhatsAppQrEntryPointEditorProps) {
  const t = useTranslations("WhatsAppQr");
  useEffect(() => {
    if (controller.statusMessage) toast.success(controller.statusMessage);
  }, [controller.statusMessage]);

  if (controller.detailLoading && !controller.detail) {
    return <WhatsAppQrEntryPointEditorSkeleton />;
  }

  if (controller.detailError && !controller.detail) {
    if (controller.detailErrorStatus === 404) {
      return (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>{t("detail.load.notFoundTitle")}</AlertTitle>
          <AlertDescription>
            {t("detail.load.notFoundDescription")}
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <Alert variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>{t("detail.load.errorTitle")}</AlertTitle>
        <AlertDescription>
          <p>{controller.detailError}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={controller.retryDetail}
          >
            {t("actions.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const detailOwner = controller.detail
    ? controller.detail.entryPoint.entryPointId
    : "new-draft";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {controller.detailError ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>{t("detail.load.refreshErrorTitle")}</AlertTitle>
          <AlertDescription>
            <p>{controller.detailError}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={controller.retryDetail}
            >
              {t("actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <OwnedWhatsAppQrEntryPointEditor
        key={detailOwner}
        workspaceId={workspaceId}
        controller={controller}
        sourceOptions={sourceOptions}
        artworkSlot={artworkSlot}
        providerMutationUnavailableReason={providerMutationUnavailableReason}
      />
    </div>
  );
}

function OwnedWhatsAppQrEntryPointEditor({
  workspaceId,
  controller,
  sourceOptions,
  artworkSlot,
  providerMutationUnavailableReason,
}: WhatsAppQrEntryPointEditorProps) {
  const t = useTranslations("WhatsAppQr");
  const validationMessages = useWhatsAppQrEntryPointValidationMessages();
  const detail = controller.detail;
  const [formValue, setFormValue] = useState<WhatsAppQrEntryPointFormValue>(
    () => ({
      sourceId: detail?.entryPoint.sourceId || sourceOptions[0]?.id || "",
      placementName: detail?.entryPoint.placementName || "",
      desiredMessage: detail?.entryPoint.desiredMessage || "",
    })
  );
  const [showFormErrors, setShowFormErrors] = useState(false);
  const [deleteTarget, setDeleteTarget] =
    useState<WhatsAppQrDeleteCodeTarget | null>(null);
  const currentSourceIsAvailable = sourceOptions.some(
    source => source.id === formValue.sourceId
  );
  const effectiveFormValue =
    detail?.entryPoint.sourceId || currentSourceIsAvailable
      ? formValue
      : { ...formValue, sourceId: sourceOptions[0]?.id || "" };
  const assignedScenarioHref = detail?.assignment
    ? `/panel/w/${workspaceId}/scenarios?scenarioId=${encodeURIComponent(
        detail.assignment.scenarioId
      )}`
    : null;

  const validate = (requireSource: boolean, requireMessage: boolean) => {
    const errors = validateWhatsAppQrEntryPointForm(effectiveFormValue, {
      requireSource,
      requireMessage,
      messages: validationMessages,
    });
    setShowFormErrors(true);
    return Object.keys(errors).length === 0;
  };

  const saveSettings = async () => {
    const active = Boolean(detail && detail.entryPoint.status !== "DRAFT");
    if (!validate(false, active)) return;

    if (!detail || detail.entryPoint.status === "DRAFT") {
      await controller.saveDraft({
        placementName: effectiveFormValue.placementName.trim(),
        desiredMessage: effectiveFormValue.desiredMessage.trim() || null,
      });
      return;
    }

    let succeeded = true;
    if (
      detail.entryPoint.placementName !==
      effectiveFormValue.placementName.trim()
    ) {
      succeeded = await controller.saveDraft(
        {
          placementName: effectiveFormValue.placementName.trim(),
        },
        { operationKey: "save-settings" }
      );
    }
    if (
      succeeded &&
      (detail.entryPoint.desiredMessage || "") !==
        effectiveFormValue.desiredMessage.trim()
    ) {
      succeeded = await controller.applyMessage(
        effectiveFormValue.desiredMessage.trim(),
        { operationKey: "save-settings" }
      );
    }
  };

  const createProviderCode = async () => {
    if (!validate(true, true)) return;
    await controller.createCode({
      sourceId: effectiveFormValue.sourceId,
      placementName: effectiveFormValue.placementName.trim(),
      desiredMessage: effectiveFormValue.desiredMessage.trim(),
    });
  };

  const applyMessage = async () => {
    if (!validate(false, true)) return;
    await controller.applyMessage(effectiveFormValue.desiredMessage.trim());
  };

  const createReplacement = async () => {
    if (!validate(false, true)) return;
    await controller.createReplacement(
      effectiveFormValue.desiredMessage.trim()
    );
  };

  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      aria-busy={controller.commandBusy}
    >
      {controller.commandError ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{t("detail.actionFailedTitle")}</AlertTitle>
          <AlertDescription>{controller.commandError}</AlertDescription>
        </Alert>
      ) : null}

      {detail ? (
        <WhatsAppQrEntryPointDetail
          detail={detail}
          assignedScenarioHref={assignedScenarioHref}
          sourceOptions={sourceOptions}
          formValue={effectiveFormValue}
          onFormChange={setFormValue}
          showFormErrors={showFormErrors}
          commandBusy={controller.commandBusy}
          pendingOperationKey={controller.pendingOperationKey}
          artworkSlot={artworkSlot}
          providerMutationUnavailableReason={providerMutationUnavailableReason}
          onSaveSettings={saveSettings}
          onCreateCode={createProviderCode}
          onApplyMessage={applyMessage}
          onCreateReplacement={createReplacement}
          onSetRouting={async (codeId, state) => {
            await controller.setRouting(codeId, state);
          }}
          onRequestDelete={code =>
            setDeleteTarget({
              codeId: code.codeId,
              referenceCode: code.referenceCode,
              isCurrent: code.codeId === detail.currentCode?.codeId,
            })
          }
          onRecoverDetached={async () => {
            await controller.recoverDetached();
          }}
          onCheckProvider={async () => {
            await controller.checkProvider();
          }}
          onReconcile={async operationId => {
            await controller.reconcileOperation(operationId);
          }}
          onDownload={async format => {
            await controller.downloadArtwork(format);
          }}
          onCopyLink={async () => {
            await controller.copyLink();
          }}
          onTestLink={controller.testLink}
        />
      ) : (
        <section className="max-w-3xl rounded-2xl border bg-background">
          <div className="flex flex-col gap-1 p-4 sm:p-6">
            <h2 className="text-base font-semibold">
              {t("detail.draft.title")}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("detail.draft.description")}
            </p>
          </div>
          <Separator />
          <div className="p-4 sm:p-6">
            <WhatsAppQrEntryPointForm
              value={effectiveFormValue}
              onChange={setFormValue}
              sourceOptions={sourceOptions}
              disabled={controller.commandBusy}
              requireSource={false}
              requireMessage={false}
              showErrors={showFormErrors}
              idPrefix="whatsapp-qr-new-draft"
            />
          </div>
          <Separator />
          <div className="flex p-4 sm:justify-end sm:p-6">
            <Button
              type="button"
              disabled={controller.commandBusy}
              onClick={() => void saveSettings()}
              className="w-full sm:w-auto"
            >
              {controller.pendingOperationKey === "save-draft" ? (
                <span data-icon="inline-start">
                  <Spinner />
                </span>
              ) : (
                <SaveIcon data-icon="inline-start" />
              )}
              {t("actions.saveDraft")}
            </Button>
          </div>
        </section>
      )}

      <WhatsAppQrDeleteCodeDialog
        open={Boolean(deleteTarget)}
        onOpenChange={open => {
          if (!open) setDeleteTarget(null);
        }}
        target={deleteTarget}
        busy={
          Boolean(deleteTarget) &&
          controller.pendingOperationKey === `delete:${deleteTarget?.codeId}`
        }
        disabled={controller.commandBusy}
        activeAssignment={
          detail?.assignment?.scenarioStatus === "active"
            ? {
                scenarioId: detail.assignment.scenarioId,
                scenarioName: detail.assignment.scenarioName,
                scenarioHref: assignedScenarioHref!,
              }
            : null
        }
        onConfirm={async codeId => {
          const succeeded = await controller.deleteFromMeta(codeId);
          if (succeeded) setDeleteTarget(null);
        }}
      />
    </div>
  );
}

function WhatsAppQrEntryPointEditorSkeleton() {
  const t = useTranslations("WhatsAppQr");
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t("detail.load.loadingLabel")}
      className="grid min-w-0 gap-5 lg:grid-cols-[minmax(15rem,4fr)_minmax(0,8fr)] lg:items-start"
    >
      <div className="flex min-w-0 flex-col gap-4 rounded-2xl bg-muted/25 p-4 sm:p-5">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-full max-w-52" />
        </div>
        <Skeleton className="mx-auto aspect-square w-full max-w-60 rounded-xl lg:max-w-72" />
        <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="size-9" />
        </div>
      </div>

      <div className="min-w-0 rounded-2xl border bg-background">
        <div className="flex flex-col gap-5 p-4 sm:p-6">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-4 w-full max-w-sm" />
          </div>
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-full" />
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 w-full" />
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
          <Skeleton className="h-9 w-full sm:w-32" />
        </div>
        <Separator />
        <div className="flex flex-col gap-4 px-4 py-5 sm:px-6">
          <Skeleton className="h-14 w-full" />
          <Separator />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
      <span className="sr-only">{t("detail.load.loadingDescription")}</span>
    </div>
  );
}
