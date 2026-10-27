"use client";

import {
  AlertCircleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  PlusIcon,
  QrCodeIcon,
  RotateCwIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import type { WhatsAppQrSourceOption } from "./types";
import type { WhatsAppQrManagerController } from "./use-whatsapp-qr-manager";
import { WhatsAppQrEntryPointCard } from "./whatsapp-qr-entry-point-card";

export type WhatsAppQrListProps = {
  workspaceId: string;
  sourceOptions: readonly WhatsAppQrSourceOption[];
  controller: WhatsAppQrManagerController;
  onCreate(): void;
};

export function WhatsAppQrList({
  workspaceId,
  sourceOptions,
  controller,
  onCreate,
}: WhatsAppQrListProps) {
  const t = useTranslations("WhatsAppQr");
  const sourceLabels = new Map(
    sourceOptions.map(source => [source.id, source.label] as const)
  );
  const hasFilters =
    Boolean(controller.filters.query.trim()) ||
    controller.filters.facet.kind !== "all";

  if (controller.loading && !controller.hasCommittedPage) {
    return <WhatsAppQrListSkeleton label={t("manager.loading")} />;
  }

  if (controller.error && !controller.hasCommittedPage) {
    return (
      <Alert variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>{t("manager.loadErrorTitle")}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <span>{controller.error}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void controller.refresh()}
          >
            <RotateCwIcon data-icon="inline-start" />
            {t("actions.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" aria-busy={controller.loading}>
      <span className="sr-only" role="status" aria-live="polite">
        {controller.loading ? t("manager.refreshing") : null}
      </span>

      {controller.error ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>{t("manager.refreshErrorTitle")}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{controller.error}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void controller.refresh()}
            >
              <RotateCwIcon data-icon="inline-start" />
              {t("actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {controller.items.length === 0 ? (
        <div className="flex min-h-64 min-w-0 flex-col items-center justify-center border-y px-6 py-14 text-center md:rounded-lg md:border">
          <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <QrCodeIcon className="size-5" />
          </div>
          <h2 className="mt-4 text-base font-semibold">
            {hasFilters
              ? t("manager.filteredEmptyTitle")
              : t("manager.firstEmptyTitle")}
          </h2>
          <p className="mt-1 max-w-lg text-sm text-pretty text-muted-foreground">
            {hasFilters
              ? t("manager.filteredEmptyDescription")
              : t("manager.firstEmptyDescription")}
          </p>
          <div className="mt-5">
            {hasFilters ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  controller.setFilters({ query: "", facet: { kind: "all" } })
                }
              >
                {t("actions.clearFilters")}
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={onCreate}>
                <PlusIcon data-icon="inline-start" />
                {t("actions.create")}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="min-w-0 md:overflow-hidden md:rounded-lg md:border">
          <div className="hidden grid-cols-[minmax(14rem,2fr)_minmax(6rem,0.8fr)_minmax(8rem,1.2fr)_minmax(7rem,0.8fr)_7rem] items-center gap-4 border-b bg-muted/30 px-4 py-2.5 text-xs font-medium text-muted-foreground lg:grid">
            <span>{t("manager.columns.asset")}</span>
            <span>{t("manager.columns.readiness")}</span>
            <span>{t("manager.columns.scenario")}</span>
            <span>{t("manager.columns.updated")}</span>
            <span className="sr-only">{t("card.moreActions")}</span>
          </div>
          <ul
            className="divide-y border-y md:border-y-0"
            aria-label={t("page.title")}
          >
            {controller.items.map(item => (
              <WhatsAppQrEntryPointCard
                key={item.entryPointId}
                workspaceId={workspaceId}
                item={item}
                sourceLabel={
                  (item.sourceId && sourceLabels.get(item.sourceId)) ||
                  t("card.sourceUnavailable")
                }
              />
            ))}
          </ul>
        </div>
      )}

      {controller.canGoPrevious || controller.canGoNext ? (
        <nav
          className="flex flex-wrap items-center justify-end gap-2"
          aria-label={t("manager.paginationLabel")}
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!controller.canGoPrevious || controller.loading}
            onClick={controller.goPrevious}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            {t("actions.previous")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!controller.canGoNext || controller.loading}
            onClick={controller.goNext}
          >
            {t("actions.next")}
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

function WhatsAppQrListSkeleton({ label }: { label: string }) {
  return (
    <div
      className="min-w-0 overflow-hidden border-y md:rounded-lg md:border"
      role="status"
      aria-live="polite"
      aria-label={label}
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-3 border-b px-3 py-3 last:border-b-0 lg:grid-cols-[minmax(14rem,2fr)_minmax(6rem,0.8fr)_minmax(8rem,1.2fr)_minmax(7rem,0.8fr)_7rem] lg:gap-4 lg:px-4"
        >
          <div className="flex min-w-0 items-center gap-3">
            <Skeleton className="size-18 shrink-0 rounded-lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-5 w-20 lg:hidden" />
            </div>
          </div>
          <Skeleton className="hidden h-5 w-20 lg:block" />
          <Skeleton className="hidden h-4 w-28 lg:block" />
          <Skeleton className="hidden h-4 w-24 lg:block" />
          <Skeleton className="size-8 rounded-md" />
        </div>
      ))}
    </div>
  );
}
