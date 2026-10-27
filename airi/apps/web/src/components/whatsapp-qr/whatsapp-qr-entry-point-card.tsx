"use client";

import {
  AlertCircleIcon,
  ClipboardIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  QrCodeIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WhatsAppQrManagerListItem } from "@/lib/whatsapp/qr-entry-points/client";

import { WhatsAppQrArtwork } from "./whatsapp-qr-artwork";

export type WhatsAppQrEntryPointCardProps = {
  workspaceId: string;
  item: WhatsAppQrManagerListItem;
  sourceLabel: string;
};

export function WhatsAppQrEntryPointCard({
  workspaceId,
  item,
  sourceLabel,
}: WhatsAppQrEntryPointCardProps) {
  const t = useTranslations("WhatsAppQr");
  const format = useFormatter();
  const detailHref = `/panel/w/${workspaceId}/messengers/whatsapp-qr/${encodeURIComponent(item.entryPointId)}`;
  const currentCode = item.currentCode;
  const artworkAvailable = Boolean(
    currentCode?.providerState === "ACTIVE" && currentCode.deepLink
  );
  const artworkDownloadHref =
    currentCode && artworkAvailable
      ? `/api/whatsapp/qr-entry-points/${encodeURIComponent(currentCode.codeId)}/artwork?${new URLSearchParams(
          {
            workspaceId,
            format: "png",
            disposition: "attachment",
          }
        ).toString()}`
      : null;
  const updatedAt = new Date(item.updatedAt);
  const updatedLabel = Number.isNaN(updatedAt.getTime())
    ? item.updatedAt
    : format.dateTime(updatedAt, {
        dateStyle: "medium",
        timeStyle: "short",
      });
  const assignmentLabel = item.assignment
    ? item.assignment.scenarioName
    : t("assignment.unassigned");
  const readiness =
    item.reconcilePending && item.readiness === "ready"
      ? "reconciling"
      : item.readiness;
  const readinessVariant =
    readiness === "ready"
      ? "secondary"
      : readiness === "unhealthy"
        ? "destructive"
        : "outline";
  const providerStateLabel = currentCode
    ? ({
        PENDING: t("providerState.PENDING"),
        ACTIVE: t("providerState.ACTIVE"),
        DELETED: t("providerState.DELETED"),
        RECONCILING: t("providerState.RECONCILING"),
      }[currentCode.providerState] ?? currentCode.providerState)
    : null;
  const routingStateLabel = currentCode
    ? ({
        ENABLED: t("routingState.ENABLED"),
        DISABLED: t("routingState.DISABLED"),
        RECONCILING: t("routingState.RECONCILING"),
      }[currentCode.routingState] ?? currentCode.routingState)
    : null;
  const operationalContext = [
    t(`status.${item.status}`),
    providerStateLabel
      ? t("card.provider", { state: providerStateLabel })
      : null,
    routingStateLabel ? t("card.routing", { state: routingStateLabel }) : null,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
  const needsRecovery =
    item.reconcilePending ||
    readiness === "reconciling" ||
    readiness === "detached" ||
    readiness === "unhealthy";

  const copyLink = async () => {
    if (!currentCode?.deepLink) return;
    try {
      await navigator.clipboard.writeText(currentCode.deepLink);
      toast.success(t("card.linkCopied"));
    } catch {
      toast.error(t("card.copyFailed"));
    }
  };

  return (
    <li
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-1 lg:grid-cols-[minmax(0,1fr)_7rem] lg:gap-4"
      data-testid="whatsapp-qr-card"
    >
      <Link
        href={detailHref}
        className="group grid min-w-0 grid-cols-[minmax(0,1fr)] items-center gap-3 rounded-md px-3 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:grid-cols-[minmax(14rem,2fr)_minmax(6rem,0.8fr)_minmax(8rem,1.2fr)_minmax(7rem,0.8fr)] lg:gap-4 lg:px-4"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-18 shrink-0">
            {artworkAvailable ? (
              <WhatsAppQrArtwork
                workspaceId={workspaceId}
                codeId={currentCode?.codeId}
                placementName={item.placementName}
              />
            ) : (
              <div
                className="flex size-full items-center justify-center rounded-lg border bg-muted/30 text-muted-foreground"
                role="img"
                aria-label={t("card.artworkUnavailable")}
              >
                <QrCodeIcon className="size-5" />
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p
              className="truncate text-sm font-medium underline-offset-4 group-hover:underline"
              title={item.placementName}
            >
              {item.placementName}
            </p>
            <p
              className="mt-0.5 truncate text-xs text-muted-foreground"
              title={sourceLabel}
            >
              {sourceLabel}
            </p>
            <p
              className="mt-1.5 line-clamp-1 text-xs text-muted-foreground"
              title={item.desiredMessage || t("card.noMessage")}
            >
              {item.desiredMessage || t("card.noMessage")}
            </p>
            <p
              className="mt-1 truncate text-xs text-muted-foreground"
              title={operationalContext}
            >
              {operationalContext}
            </p>
            {needsRecovery ? (
              <span className="mt-1.5 flex min-w-0 items-center gap-1 text-xs font-medium text-destructive">
                <AlertCircleIcon className="size-3.5 shrink-0" />
                <span className="truncate">{t("card.recoveryTitle")}</span>
              </span>
            ) : null}

            <div className="mt-2 flex min-w-0 flex-col items-start gap-1.5 lg:hidden">
              <Badge variant={readinessVariant}>
                {t(`readiness.${readiness}`)}
              </Badge>
              <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="max-w-full truncate">
                  <span className="sr-only">
                    {t("manager.columns.scenario")}:{" "}
                  </span>
                  {assignmentLabel}
                </span>
                <span aria-hidden="true">{"\u00b7"}</span>
                <time dateTime={item.updatedAt}>
                  <span className="sr-only">
                    {t("manager.columns.updated")}:{" "}
                  </span>
                  {updatedLabel}
                </time>
              </div>
            </div>
          </div>
        </div>

        <div className="hidden lg:block">
          <Badge variant={readinessVariant}>
            {t(`readiness.${readiness}`)}
          </Badge>
        </div>

        <div className="hidden min-w-0 lg:block">
          <p className="truncate text-sm" title={assignmentLabel}>
            {assignmentLabel}
          </p>
          {item.assignment ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(`assignment.status.${item.assignment.scenarioStatus}`)}
            </p>
          ) : null}
        </div>

        <time
          dateTime={item.updatedAt}
          className="hidden text-sm text-muted-foreground lg:block"
        >
          {updatedLabel}
        </time>
      </Link>

      <TooltipProvider>
        <div className="flex items-center justify-end lg:pr-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="hidden lg:inline-flex"
                disabled={!currentCode?.deepLink}
                onClick={() => void copyLink()}
                aria-label={t("card.copyLink")}
              >
                <ClipboardIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("card.copyLink")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild={Boolean(artworkDownloadHref)}
                type="button"
                size="icon-sm"
                variant="ghost"
                className="hidden lg:inline-flex"
                disabled={!artworkDownloadHref}
                aria-label={t("card.downloadPng")}
              >
                {artworkDownloadHref ? (
                  <a href={artworkDownloadHref}>
                    <DownloadIcon />
                  </a>
                ) : (
                  <DownloadIcon />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("card.downloadPng")}</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("card.moreActions")}
                  >
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t("card.moreActions")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuItem asChild>
                  <Link href={detailHref}>
                    <ExternalLinkIcon />
                    {t("card.openDetails")}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!currentCode?.deepLink}
                  onSelect={() => void copyLink()}
                  className="lg:hidden"
                >
                  <ClipboardIcon />
                  {t("card.copyLink")}
                </DropdownMenuItem>
                {artworkDownloadHref ? (
                  <DropdownMenuItem asChild className="lg:hidden">
                    <a href={artworkDownloadHref}>
                      <DownloadIcon />
                      {t("card.downloadPng")}
                    </a>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem disabled className="lg:hidden">
                    <DownloadIcon />
                    {t("card.downloadPng")}
                  </DropdownMenuItem>
                )}
                {currentCode?.deepLink ? (
                  <DropdownMenuItem asChild>
                    <a
                      href={currentCode.deepLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLinkIcon />
                      {t("card.testLink")}
                    </a>
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TooltipProvider>
    </li>
  );
}
