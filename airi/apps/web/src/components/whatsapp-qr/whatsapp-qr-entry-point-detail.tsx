"use client";

import {
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  QrCodeIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  ShieldAlertIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import type {
  WhatsAppQrCodeDetail,
  WhatsAppQrEntryPointDetail,
} from "@/lib/whatsapp/qr-entry-points/client";

import type {
  WhatsAppQrPendingOperationKey,
  WhatsAppQrSourceOption,
} from "./types";
import {
  WhatsAppQrEntryPointForm,
  type WhatsAppQrEntryPointFormValue,
} from "./whatsapp-qr-entry-point-form";

function BusyIndicator() {
  return (
    <span data-icon="inline-start">
      <Spinner />
    </span>
  );
}

type OverviewRowProps = {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  description: ReactNode;
  action?: ReactNode;
};

function OverviewRow({
  icon,
  label,
  value,
  description,
  action,
}: OverviewRowProps) {
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3 py-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-start">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <div className="min-w-0 text-sm font-medium">{value}</div>
        <div className="min-w-0 text-sm leading-5 text-muted-foreground">
          {description}
        </div>
      </div>
      {action ? (
        <div className="col-start-2 sm:col-auto sm:pt-1">{action}</div>
      ) : null}
    </div>
  );
}

function sourceLabel(
  sourceOptions: readonly WhatsAppQrSourceOption[],
  sourceId: string | undefined,
  disconnectedLabel: string
): string {
  if (!sourceId) return disconnectedLabel;
  return (
    sourceOptions.find(source => source.id === sourceId)?.label || sourceId
  );
}

function localizedEnumLabel(
  value: string | undefined,
  labels: Readonly<Record<string, string>>
): string {
  if (!value) return "";
  return labels[value] ?? value;
}

function useWhatsAppQrCodeStateLabels(code: WhatsAppQrCodeDetail | undefined) {
  const t = useTranslations("WhatsAppQr");
  return {
    provider: localizedEnumLabel(code?.providerState, {
      PENDING: t("providerState.PENDING"),
      ACTIVE: t("providerState.ACTIVE"),
      DELETED: t("providerState.DELETED"),
      RECONCILING: t("providerState.RECONCILING"),
    }),
    routing: localizedEnumLabel(code?.routingState, {
      ENABLED: t("routingState.ENABLED"),
      DISABLED: t("routingState.DISABLED"),
      RECONCILING: t("routingState.RECONCILING"),
    }),
    placement: localizedEnumLabel(code?.placementBindingState, {
      CURRENT: t("placementState.CURRENT"),
      HISTORICAL: t("placementState.HISTORICAL"),
      DETACHED: t("placementState.DETACHED"),
    }),
  };
}

export type WhatsAppQrEntryPointDetailProps = {
  detail: WhatsAppQrEntryPointDetail;
  assignedScenarioHref: string | null;
  sourceOptions: readonly WhatsAppQrSourceOption[];
  formValue: WhatsAppQrEntryPointFormValue;
  onFormChange(value: WhatsAppQrEntryPointFormValue): void;
  showFormErrors?: boolean;
  commandBusy: boolean;
  pendingOperationKey: WhatsAppQrPendingOperationKey | null;
  artworkSlot?: ReactNode;
  onSaveSettings(): void | Promise<void>;
  onCreateCode(): void | Promise<void>;
  onApplyMessage(): void | Promise<void>;
  onCreateReplacement(): void | Promise<void>;
  onSetRouting(
    codeId: string,
    state: "ENABLED" | "DISABLED"
  ): void | Promise<void>;
  onRequestDelete(code: WhatsAppQrCodeDetail): void;
  onRecoverDetached(): void | Promise<void>;
  onCheckProvider(): void | Promise<void>;
  onReconcile(operationId: string): void | Promise<void>;
  onDownload(format: "png" | "svg"): void | Promise<void>;
  onCopyLink(): void | Promise<void>;
  onTestLink(): void;
  providerMutationUnavailableReason?: string;
};

export function WhatsAppQrEntryPointDetail({
  detail,
  assignedScenarioHref,
  sourceOptions,
  formValue,
  onFormChange,
  showFormErrors = false,
  commandBusy,
  pendingOperationKey,
  artworkSlot,
  onSaveSettings,
  onCreateCode,
  onApplyMessage,
  onCreateReplacement,
  onSetRouting,
  onRequestDelete,
  onRecoverDetached,
  onCheckProvider,
  onReconcile,
  onDownload,
  onCopyLink,
  onTestLink,
  providerMutationUnavailableReason,
}: WhatsAppQrEntryPointDetailProps) {
  const t = useTranslations("WhatsAppQr");
  const entryPoint = detail.entryPoint;
  const currentCode = detail.currentCode;
  const currentCodeStateLabels = useWhatsAppQrCodeStateLabels(currentCode);
  const activeAssignment =
    detail.assignment?.scenarioStatus === "active" ? detail.assignment : null;
  const effectiveSourceId = entryPoint.sourceId || formValue.sourceId;
  const effectiveSourceConnected = Boolean(
    effectiveSourceId &&
      sourceOptions.some(source => source.id === effectiveSourceId)
  );
  const providerAccessDisabled =
    commandBusy || !effectiveSourceId || !effectiveSourceConnected;
  const providerOperationPending = detail.operationPending;
  const providerMutationDisabled =
    providerAccessDisabled || providerOperationPending;
  const settingsMutationDisabled = commandBusy || providerOperationPending;
  const currentProviderCodeIsMutable = Boolean(
    entryPoint.status === "ACTIVE" &&
      currentCode?.providerState === "ACTIVE" &&
      !providerOperationPending
  );
  const canCreateProviderCode =
    entryPoint.status === "DRAFT" && !currentCode && !providerOperationPending;
  const artworkAvailable = Boolean(
    currentCode?.providerState === "ACTIVE" && currentCode.deepLink
  );
  const messageChanged =
    (entryPoint.desiredMessage || "") !== formValue.desiredMessage.trim();
  const saveRequiresProvider = entryPoint.status !== "DRAFT" && messageChanged;
  const resolvedProviderMutationUnavailableReason =
    providerMutationUnavailableReason ||
    (entryPoint.sourceId && !effectiveSourceConnected
      ? t("detail.source.linkedUnavailable")
      : !effectiveSourceId
        ? t("detail.source.chooseRequired")
        : null);
  const currentDeleteBlockedByHistory = Boolean(
    detail.historicalCodes.length || detail.historicalCodesHasMore
  );
  const reconcileKindLabel = localizedEnumLabel(
    detail.reconcileOperation?.kind,
    {
      CREATE: t("operationKind.CREATE"),
      CONNECT: t("operationKind.CONNECT"),
      APPLY_MESSAGE: t("operationKind.APPLY_MESSAGE"),
      REPLACE: t("operationKind.REPLACE"),
      MOVE: t("operationKind.MOVE"),
      SET_ROUTING: t("operationKind.SET_ROUTING"),
      DELETE: t("operationKind.DELETE"),
      SYNC_PROVIDER: t("operationKind.SYNC_PROVIDER"),
      RECONCILE: t("operationKind.RECONCILE"),
    }
  );
  const providerStateAvailable = Boolean(
    effectiveSourceConnected && currentCode?.providerState === "ACTIVE"
  );
  const providerStatusSummary = !effectiveSourceConnected
    ? t("detail.health.source", {
        source: sourceLabel(
          sourceOptions,
          effectiveSourceId,
          t("detail.source.notConnected")
        ),
      })
    : currentCode
      ? t("detail.health.provider", {
          state: currentCodeStateLabels.provider,
        })
      : t("detail.health.missingCode");
  const hasRecoveryAction =
    entryPoint.status === "DETACHED" || Boolean(detail.reconcileOperation);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {hasRecoveryAction ? (
        <Alert>
          <RotateCcwIcon />
          <AlertTitle>{t("detail.recovery.title")}</AlertTitle>
          <AlertDescription>
            <p>{t("detail.recovery.description")}</p>
            <div className="mt-2 flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap">
              {entryPoint.status === "DETACHED" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={settingsMutationDisabled}
                  onClick={() => void onRecoverDetached()}
                  className="w-full sm:w-auto"
                >
                  {pendingOperationKey === "recover-detached" ? (
                    <BusyIndicator />
                  ) : (
                    <RotateCcwIcon data-icon="inline-start" />
                  )}
                  {t("detail.recovery.recover")}
                </Button>
              ) : null}
              {detail.reconcileOperation ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={providerAccessDisabled}
                  onClick={() =>
                    void onReconcile(detail.reconcileOperation!.operationId)
                  }
                  className="w-full sm:w-auto"
                >
                  {pendingOperationKey ===
                  `reconcile:${detail.reconcileOperation.operationId}` ? (
                    <BusyIndicator />
                  ) : (
                    <RefreshCwIcon data-icon="inline-start" />
                  )}
                  {t("detail.recovery.reconcile", {
                    kind: reconcileKindLabel,
                  })}
                </Button>
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(15rem,4fr)_minmax(0,8fr)] lg:items-start">
        <section className="flex min-w-0 flex-col gap-4 rounded-2xl bg-muted/25 p-4 sm:p-5 lg:sticky lg:top-6 lg:self-start">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold">
              {t("detail.artwork.title")}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">
              {t("detail.artwork.description")}
            </p>
          </div>

          <div className="mx-auto w-full max-w-60 lg:max-w-72">
            {artworkSlot || (
              <div className="flex aspect-square items-center justify-center rounded-xl border bg-background text-center text-sm text-muted-foreground">
                <span className="flex flex-col items-center gap-2 px-4">
                  <QrCodeIcon className="size-8" aria-hidden="true" />
                  {currentCode
                    ? t("detail.artwork.previewOnManager")
                    : t("detail.artwork.previewUnavailable")}
                </span>
              </div>
            )}
          </div>

          {currentCode ? (
            <div className="flex min-w-0 flex-col gap-1 text-sm">
              <span className="font-medium">{currentCode.referenceCode}</span>
              <span className="truncate text-muted-foreground">
                {currentCode.deepLink ||
                  t("detail.artwork.deepLinkUnavailable")}
              </span>
            </div>
          ) : null}

          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <Button
              type="button"
              disabled={!artworkAvailable}
              onClick={() => void onDownload("png")}
              fullWidth
            >
              {pendingOperationKey === "download:png" ? (
                <BusyIndicator />
              ) : (
                <DownloadIcon data-icon="inline-start" />
              )}
              PNG
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  disabled={!currentCode}
                  aria-label={t("detail.artwork.description")}
                  title={t("detail.artwork.description")}
                >
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    disabled={!artworkAvailable}
                    onSelect={() => void onDownload("svg")}
                  >
                    {pendingOperationKey === "download:svg" ? (
                      <Spinner />
                    ) : (
                      <DownloadIcon />
                    )}
                    SVG
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!currentCode?.deepLink}
                    onSelect={() => void onCopyLink()}
                  >
                    <CopyIcon />
                    {t("card.copyLink")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!currentCode?.deepLink}
                    onSelect={onTestLink}
                  >
                    <ExternalLinkIcon />
                    {t("card.testLink")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </section>

        <div className="flex min-w-0 flex-col gap-4">
          {resolvedProviderMutationUnavailableReason ? (
            <Alert>
              <ShieldAlertIcon />
              <AlertTitle>{t("card.sourceUnavailable")}</AlertTitle>
              <AlertDescription>
                {t("detail.source.unavailableDescription", {
                  reason: resolvedProviderMutationUnavailableReason,
                })}
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="min-w-0 rounded-2xl border bg-background">
            <section className="flex min-w-0 flex-col gap-5 p-4 sm:p-6">
              <div className="flex flex-col gap-1">
                <h2 className="text-base font-semibold">
                  {t("detail.settings.title")}
                </h2>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("detail.settings.description")}
                </p>
              </div>

              <WhatsAppQrEntryPointForm
                value={formValue}
                onChange={onFormChange}
                sourceOptions={sourceOptions}
                sourceDisabled={Boolean(entryPoint.sourceId)}
                disabled={settingsMutationDisabled}
                requireMessage={entryPoint.status !== "DRAFT"}
                showErrors={showFormErrors}
                idPrefix="whatsapp-qr-detail"
              />

              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <Button
                  type="button"
                  disabled={
                    settingsMutationDisabled ||
                    (saveRequiresProvider &&
                      (providerMutationDisabled ||
                        !currentProviderCodeIsMutable))
                  }
                  onClick={() => void onSaveSettings()}
                  className="w-full sm:w-auto"
                >
                  {pendingOperationKey === "save-settings" ||
                  pendingOperationKey === "save-draft" ? (
                    <BusyIndicator />
                  ) : (
                    <SaveIcon data-icon="inline-start" />
                  )}
                  {t("detail.settings.save")}
                </Button>
                {currentCode ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      providerMutationDisabled || !currentProviderCodeIsMutable
                    }
                    onClick={() => void onApplyMessage()}
                    className="w-full sm:w-auto"
                  >
                    {pendingOperationKey === "apply-message" ? (
                      <BusyIndicator />
                    ) : (
                      <RefreshCwIcon data-icon="inline-start" />
                    )}
                    {t("detail.settings.applyMessage")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={
                      providerMutationDisabled || !canCreateProviderCode
                    }
                    onClick={() => void onCreateCode()}
                    className="w-full sm:w-auto"
                  >
                    {pendingOperationKey === "create-code" ? (
                      <BusyIndicator />
                    ) : null}
                    {t("detail.settings.createProviderCode")}
                  </Button>
                )}
              </div>
            </section>

            <Separator />

            <section className="px-4 sm:px-6">
              <OverviewRow
                icon={<WorkflowIcon className="size-4" />}
                label={t("detail.assignment.title")}
                value={
                  detail.assignment ? (
                    <span className="block truncate">
                      {detail.assignment.scenarioName}
                    </span>
                  ) : (
                    t("assignment.unassigned")
                  )
                }
                description={
                  detail.assignment
                    ? t(`assignment.status.${detail.assignment.scenarioStatus}`)
                    : t("detail.assignment.unassignedDescription")
                }
                action={
                  assignedScenarioHref && detail.assignment ? (
                    <Button
                      asChild
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Link
                        href={assignedScenarioHref}
                        aria-label={detail.assignment.scenarioName}
                        title={detail.assignment.scenarioName}
                      >
                        <ExternalLinkIcon />
                      </Link>
                    </Button>
                  ) : undefined
                }
              />

              <Separator />

              <OverviewRow
                icon={
                  providerStateAvailable ? (
                    <CircleCheckIcon className="size-4" />
                  ) : (
                    <CircleAlertIcon className="size-4" />
                  )
                }
                label={t("detail.health.title")}
                value={
                  <Badge
                    variant={
                      providerStateAvailable
                        ? "secondary"
                        : currentCode?.providerState === "DELETED"
                          ? "destructive"
                          : "outline"
                    }
                    className="max-w-full truncate"
                    title={providerStatusSummary}
                  >
                    {providerStatusSummary}
                  </Badge>
                }
                description={
                  <span className="flex flex-col gap-1">
                    <span>
                      {t("detail.health.resource", {
                        state: t(`status.${entryPoint.status}`),
                      })}
                      {" · "}
                      {t("detail.health.source", {
                        source: sourceLabel(
                          sourceOptions,
                          effectiveSourceId,
                          t("detail.source.notConnected")
                        ),
                      })}
                    </span>
                    {currentCode ? (
                      <span>
                        {t("detail.health.provider", {
                          state: currentCodeStateLabels.provider,
                        })}
                        {" · "}
                        {t("detail.health.routing", {
                          state: currentCodeStateLabels.routing,
                        })}
                        {" · "}
                        {t("detail.health.placement", {
                          state: currentCodeStateLabels.placement,
                        })}
                      </span>
                    ) : null}
                    <span>{t("detail.health.lastKnownDescription")}</span>
                  </span>
                }
                action={
                  currentCode ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={
                        providerMutationDisabled ||
                        !currentProviderCodeIsMutable
                      }
                      onClick={() => void onCheckProvider()}
                      className="w-full sm:w-auto"
                    >
                      {pendingOperationKey === "check-provider" ? (
                        <BusyIndicator />
                      ) : (
                        <RefreshCwIcon data-icon="inline-start" />
                      )}
                      {t("detail.health.checkProvider")}
                    </Button>
                  ) : undefined
                }
              />
            </section>

            <Separator />

            <section className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <span
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                    aria-hidden="true"
                  >
                    <HistoryIcon className="size-4" />
                  </span>
                  <div className="flex min-w-0 flex-col gap-1">
                    <h2 className="text-sm font-semibold">
                      {t("detail.history.title")}
                    </h2>
                    <p className="text-sm leading-5 text-muted-foreground">
                      {t("detail.history.description")}
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    providerMutationDisabled ||
                    !currentProviderCodeIsMutable ||
                    detail.canCreateReplacement === false
                  }
                  onClick={() => void onCreateReplacement()}
                  className="w-full sm:w-auto"
                >
                  {pendingOperationKey === "create-replacement" ? (
                    <BusyIndicator />
                  ) : (
                    <RotateCcwIcon data-icon="inline-start" />
                  )}
                  {t("detail.history.createReplacement")}
                </Button>
              </div>

              {currentCode ? (
                <CodeHistoryRow
                  code={currentCode}
                  label={t("detail.history.current")}
                  routingDisabled={providerMutationDisabled}
                  deleteDisabled={
                    providerMutationDisabled ||
                    Boolean(activeAssignment) ||
                    currentDeleteBlockedByHistory
                  }
                  showDelete={false}
                  pendingOperationKey={pendingOperationKey}
                  onSetRouting={onSetRouting}
                  onRequestDelete={onRequestDelete}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("detail.history.empty")}
                </p>
              )}

              {detail.historicalCodes.length ||
              detail.historicalCodesHasMore ? (
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="group w-full justify-between"
                    >
                      <span>
                        {t("detail.history.historical")} (
                        {detail.historicalCodes.length})
                      </span>
                      <ChevronDownIcon className="transition-transform group-data-[state=open]:rotate-180" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="flex flex-col gap-4 pt-2">
                      {detail.historicalCodes.map(code => (
                        <div key={code.codeId} className="flex flex-col gap-4">
                          <Separator />
                          <CodeHistoryRow
                            code={code}
                            label={t("detail.history.historical")}
                            routingDisabled={providerMutationDisabled}
                            deleteDisabled={
                              providerMutationDisabled ||
                              Boolean(activeAssignment)
                            }
                            showDelete
                            pendingOperationKey={pendingOperationKey}
                            onSetRouting={onSetRouting}
                            onRequestDelete={onRequestDelete}
                          />
                        </div>
                      ))}
                      {detail.historicalCodesHasMore ? (
                        <Alert>
                          <AlertTitle>
                            {t("detail.history.moreTitle")}
                          </AlertTitle>
                          <AlertDescription>
                            {t("detail.history.moreDescription")}
                          </AlertDescription>
                        </Alert>
                      ) : null}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </section>

            <Separator />

            <section className="flex min-w-0 flex-col gap-3 p-4 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 className="text-sm font-medium">
                    {t("detail.danger.title")}
                  </h2>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {t("detail.danger.description")}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    providerMutationDisabled ||
                    !currentCode ||
                    Boolean(activeAssignment) ||
                    currentDeleteBlockedByHistory
                  }
                  onClick={() => {
                    if (currentCode) onRequestDelete(currentCode);
                  }}
                  className="w-full sm:w-auto"
                >
                  <Trash2Icon data-icon="inline-start" />
                  {t("detail.danger.deleteCurrent")}
                </Button>
              </div>

              {activeAssignment ? (
                <Alert variant="destructive">
                  <AlertTitle>{t("detail.danger.activeTitle")}</AlertTitle>
                  <AlertDescription>
                    {assignedScenarioHref ? (
                      <Link
                        href={assignedScenarioHref}
                        className="font-medium underline underline-offset-4"
                      >
                        {t("detail.danger.activeDescription", {
                          scenarioName: activeAssignment.scenarioName,
                        })}
                      </Link>
                    ) : (
                      t("detail.danger.activeDescription", {
                        scenarioName: activeAssignment.scenarioName,
                      })
                    )}
                  </AlertDescription>
                </Alert>
              ) : null}
              {currentDeleteBlockedByHistory ? (
                <Alert>
                  <AlertTitle>{t("detail.danger.historyTitle")}</AlertTitle>
                  <AlertDescription>
                    {t("detail.danger.historyDescription")}
                  </AlertDescription>
                </Alert>
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

type CodeHistoryRowProps = {
  code: WhatsAppQrCodeDetail;
  label: string;
  routingDisabled: boolean;
  deleteDisabled: boolean;
  showDelete: boolean;
  pendingOperationKey: WhatsAppQrPendingOperationKey | null;
  onSetRouting(
    codeId: string,
    state: "ENABLED" | "DISABLED"
  ): void | Promise<void>;
  onRequestDelete(code: WhatsAppQrCodeDetail): void;
};

function CodeHistoryRow({
  code,
  label,
  routingDisabled,
  deleteDisabled,
  showDelete,
  pendingOperationKey,
  onSetRouting,
  onRequestDelete,
}: CodeHistoryRowProps) {
  const t = useTranslations("WhatsAppQr");
  const stateLabels = useWhatsAppQrCodeStateLabels(code);
  const routingEnabled = code.routingState === "ENABLED";
  const providerRoutingDisabled =
    routingDisabled || code.providerState !== "ACTIVE";
  const providerDeleteDisabled =
    deleteDisabled || code.providerState !== "ACTIVE";
  const nextRoutingState = routingEnabled ? "DISABLED" : "ENABLED";
  const routingOperationKey: WhatsAppQrPendingOperationKey = `set-routing:${code.codeId}:${nextRoutingState}`;
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 rounded-xl bg-muted/25 px-3 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{code.referenceCode}</span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <span className="truncate text-sm text-muted-foreground">
          {t("detail.history.codeMeta", {
            codeId: code.codeId,
            providerState: stateLabels.provider,
            routingState: stateLabels.routing,
          })}
        </span>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`${t("detail.history.title")}: ${code.referenceCode}`}
            title={`${t("detail.history.title")}: ${code.referenceCode}`}
          >
            {pendingOperationKey === routingOperationKey ? (
              <Spinner />
            ) : (
              <MoreHorizontalIcon />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={providerRoutingDisabled}
              onSelect={() => void onSetRouting(code.codeId, nextRoutingState)}
            >
              {pendingOperationKey === routingOperationKey ? (
                <Spinner />
              ) : (
                <RefreshCwIcon />
              )}
              {routingEnabled
                ? t("detail.history.disableRouting")
                : t("detail.history.enableRouting")}
            </DropdownMenuItem>
            {showDelete ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={providerDeleteDisabled}
                  onSelect={() => onRequestDelete(code)}
                >
                  <Trash2Icon />
                  {t("detail.history.delete")}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
