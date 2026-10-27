"use client";

import { useBulkAnalyticsFormatters } from "@/components/analytics/bulk-analytics-formatters";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEffect, useRef } from "react";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { isActiveBulkCampaignDispatchStatus } from "@/lib/campaign/campaign-operations-contracts";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  BulkCampaignHealthResponse,
  BulkRecipientEvidenceResponse,
} from "@/lib/analytics/bulk-analytics-campaign-health-contract";
import { useTranslations } from "next-intl";
import useSWR from "swr";

async function fetchEvidence<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Campaign evidence unavailable");
  return response.json();
}

export function BulkCampaignHealth({
  workspaceId,
  campaignIds,
  onOpenCampaignHistory,
  onFilterError,
  refreshKey = 0,
}: {
  workspaceId: string;
  campaignIds: string[];
  onOpenCampaignHistory?: (campaignId?: string) => void;
  onFilterError: (code: string | null) => void;
  refreshKey?: number;
}) {
  const t = useTranslations("BulkAnalytics.operations");
  const campaignT = useTranslations("CampaignHistory");
  const { formatInteger, formatDateTime } = useBulkAnalyticsFormatters();
  const campaignId = campaignIds.length === 1 ? campaignIds[0] : null;
  const url = campaignId
    ? `/api/workspaces/${workspaceId}/analytics/bulk/campaign-health?campaignId=${encodeURIComponent(campaignId)}`
    : null;
  const { data, error, isLoading, isValidating, mutate } =
    useSWR<BulkCampaignHealthResponse>(url, fetchEvidence, {
      keepPreviousData: false,
      revalidateOnFocus: false,
      dedupingInterval: 30_000,
      refreshInterval: response =>
        response?.family.campaigns.some(campaign =>
          isActiveBulkCampaignDispatchStatus(campaign.operation?.status)
        )
          ? 30_000
          : 0,
    });
  const previousRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (previousRefreshKey.current !== refreshKey) {
      previousRefreshKey.current = refreshKey;
      if (url) void mutate();
    }
  }, [refreshKey, url, mutate]);
  if (!campaignId) return null;
  const selected = data?.family.campaigns.find(
    campaign => campaign.id === campaignId
  );
  const statusLabel = (campaign: NonNullable<typeof selected>) => {
    const status = campaign.operation?.paused
      ? "paused"
      : campaign.operation?.status || campaign.status;
    return campaignT.has(`operations.status.${status}`)
      ? campaignT(`operations.status.${status}`)
      : t("unavailable");
  };
  const recipientCount = (
    key: keyof BulkCampaignHealthResponse["recipients"]
  ) =>
    !data
      ? t("unavailable")
      : data.recipients[key] == null
        ? t("atLeast", { count: formatInteger(data.observed.recipients[key]) })
        : formatInteger(data.recipients[key]);
  const stopLabel = (reason: string) =>
    t.has(`dispatchStopReasons.${reason}`)
      ? t(`dispatchStopReasons.${reason}`)
      : t("dispatchStopped");
  return (
    <section
      className="min-w-0 space-y-2 rounded-lg border px-4 py-3"
      aria-busy={isValidating}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">
              {selected?.name || t("healthTitle")}
            </h2>
            {selected ? (
              <Badge variant="outline">{statusLabel(selected)}</Badge>
            ) : null}
            {data ? (
              <span className="text-xs text-muted-foreground">
                {t("batchCount", { count: data.family.campaignIds.length })}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("familyScope")}
          </p>
        </div>
        {onOpenCampaignHistory ? (
          <Button
            variant="outline"
            size="sm"
            className="h-auto whitespace-normal py-1.5"
            onClick={() => onOpenCampaignHistory(campaignId)}
          >
            {t("openHistory")}
          </Button>
        ) : null}
      </div>
      {isLoading ? <Skeleton className="h-16 w-full" /> : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {t("healthFailed")}
            <Button
              size="sm"
              variant="outline"
              disabled={isValidating}
              onClick={() => void mutate()}
            >
              {t("refreshHealth")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {data ? (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {t("observedAt", { value: formatDateTime(data.observedAt) })}
            </span>
            {isValidating ? <span role="status">{t("updating")}</span> : null}
            {selected?.operation ? (
              <span>
                {t("dispatchProgress", {
                  count: formatInteger(selected.operation.progress.processed),
                  total: formatInteger(selected.operation.totalRecipients),
                })}
              </span>
            ) : null}
            {selected?.operation?.scheduledAt ? (
              <span>
                {t("scheduledFor", {
                  value: formatDateTime(selected.operation.scheduledAt),
                })}
              </span>
            ) : null}
          </div>
          {selected?.operation?.stopReason ? (
            <p className="text-xs text-destructive">
              {stopLabel(selected.operation.stopReason)}
            </p>
          ) : null}
          {!data.coverage.complete ? (
            <Alert>
              <AlertTitle>{t("incomplete")}</AlertTitle>
              <AlertDescription>{t("observedLowerBound")}</AlertDescription>
            </Alert>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-y py-2 sm:grid-cols-4">
            {(["planned", "attempted", "untouched", "uncertain"] as const).map(
              key => (
                <div
                  key={key}
                  className="flex min-w-0 flex-wrap items-baseline justify-between gap-1"
                >
                  <dt className="break-words text-xs text-muted-foreground">
                    {t(`recipientMetrics.${key}`)}
                  </dt>
                  <dd className="text-sm font-semibold tabular-nums">
                    {recipientCount(key)}
                  </dd>
                </div>
              )
            )}
          </dl>
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto max-w-full whitespace-normal px-0 py-1 text-left"
              >
                {t("batchDetails")}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-2">
              <p className="text-xs text-muted-foreground">
                {t("nestedEvidence")}
              </p>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("healthMetric")}</TableHead>
                      <TableHead className="text-right">
                        {t("distinctRecipients")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("providerAttempts")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(
                      [
                        "planned",
                        "attempted",
                        "accepted",
                        "delivered",
                        "read",
                        "failed",
                        "awaitingReceipts",
                        "uncertain",
                        "untouched",
                      ] as const
                    ).map(key => (
                      <TableRow key={key}>
                        <TableCell className="whitespace-normal text-xs">
                          {t(`recipientMetrics.${key}`)}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {recipientCount(key)}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {key in data.attempts
                            ? data.attempts[
                                key as keyof typeof data.attempts
                              ] == null
                              ? t("atLeast", {
                                  count: formatInteger(
                                    data.observed.attempts[
                                      key as keyof typeof data.observed.attempts
                                    ]
                                  ),
                                })
                              : formatInteger(
                                  data.attempts[
                                    key as keyof typeof data.attempts
                                  ]
                                )
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <h3 className="text-xs font-semibold">{t("batchLifecycle")}</h3>
              <ul className="divide-y rounded-md border px-3">
                {data.family.campaigns.map(campaign => (
                  <li key={campaign.id} className="space-y-1 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="break-words text-xs font-medium">
                        {campaign.name}
                      </span>
                      <Badge variant="outline">{statusLabel(campaign)}</Badge>
                    </div>
                    {campaign.operation ? (
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {t("dispatchProgress", {
                            count: formatInteger(
                              campaign.operation.progress.processed
                            ),
                            total: formatInteger(
                              campaign.operation.totalRecipients
                            ),
                          })}
                        </span>
                        {campaign.operation.scheduledAt ? (
                          <span>
                            {t("scheduledFor", {
                              value: formatDateTime(
                                campaign.operation.scheduledAt
                              ),
                            })}
                          </span>
                        ) : null}
                        {campaign.operation.dispatchExpiresAt ? (
                          <span>
                            {t("dispatchExpires", {
                              value: formatDateTime(
                                campaign.operation.dispatchExpiresAt
                              ),
                            })}
                          </span>
                        ) : null}
                        {campaign.operation.stopReason ? (
                          <span className="text-destructive">
                            {stopLabel(campaign.operation.stopReason)}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {onOpenCampaignHistory ? (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto px-0 py-0 text-xs"
                        onClick={() => onOpenCampaignHistory(campaign.id)}
                      >
                        {t("openHistory")}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {data.errors.length ? (
                <section className="space-y-1">
                  <h3 className="text-xs font-semibold">
                    {t("failureGroups")}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {t("failureScope")}
                  </p>
                  <div className="divide-y rounded-md border px-3">
                    {data.errors.map((failure, index) => (
                      <div
                        key={`${failure.code}-${index}`}
                        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2"
                      >
                        <span className="text-xs font-medium tabular-nums">
                          {failure.code || t("unknownError")} ·{" "}
                          {formatInteger(failure.count)}
                        </span>
                        <span className="min-w-0 flex-1 basis-[12rem] break-words text-xs text-muted-foreground">
                          {failure.message || t("noErrorDetail")}
                        </span>
                        <Button
                          size="sm"
                          variant="link"
                          className="h-auto max-w-full whitespace-normal px-0 py-1 text-xs"
                          onClick={() => onFilterError(failure.code)}
                        >
                          {t("filterFailures")}
                        </Button>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={isValidating}
                onClick={() => void mutate()}
              >
                {isValidating ? t("updating") : t("refreshHealth")}
              </Button>
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : null}
    </section>
  );
}

export function BulkRecipientHistory({
  workspaceId,
  recipient,
  campaignId,
  onClose,
}: {
  workspaceId: string;
  recipient: string | null;
  campaignId?: string;
  onClose: () => void;
}) {
  const t = useTranslations("BulkAnalytics.operations");
  const { formatDateTime } = useBulkAnalyticsFormatters();
  const params = new URLSearchParams({ recipient: recipient || "" });
  if (campaignId) params.set("campaignId", campaignId);
  const url = recipient
    ? `/api/workspaces/${workspaceId}/analytics/bulk/recipient-evidence?${params}`
    : null;
  const { data, error, isLoading, mutate } =
    useSWR<BulkRecipientEvidenceResponse>(url, fetchEvidence, {
      keepPreviousData: false,
      revalidateOnFocus: false,
    });
  return (
    <Dialog
      open={Boolean(recipient)}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-h-[85vh] overflow-y-auto"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{t("historyTitle")}</DialogTitle>
          <DialogDescription className="text-xs">
            {t("historyDescription")}
          </DialogDescription>
        </DialogHeader>
        <p className="break-all text-sm font-medium">{recipient}</p>
        {isLoading ? <Skeleton className="h-32 w-full" /> : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>
              {t("historyFailed")}
              <Button variant="link" onClick={() => void mutate()}>
                {t("refreshHealth")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {data ? (
          <>
            <p className="text-xs text-muted-foreground">
              {t("observedAt", { value: formatDateTime(data.observedAt) })}
            </p>
            <p className="text-sm font-medium">
              {t("latestOutcome")}:{" "}
              {data.latestOutcome
                ? t(`historyStatuses.${data.latestOutcome}`)
                : t("unavailable")}
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  "delivered",
                  "read",
                  "acceptedWithoutDeliveryProof",
                  "priorFailure",
                  "disputedIdentity",
                ] as const
              )
                .filter(key => data.evidence[key])
                .map(key => (
                  <Badge
                    key={key}
                    variant="outline"
                    className="whitespace-normal"
                  >
                    {t(`evidence.${key}`)}
                  </Badge>
                ))}
            </div>
            {!data.coverage.complete ? (
              <Alert>
                <AlertDescription>
                  {t("incompleteDescription")}{" "}
                </AlertDescription>
              </Alert>
            ) : null}
            {!data.attempts.length ? (
              <p className="py-5 text-sm text-muted-foreground">
                {t("noHistory")}
              </p>
            ) : (
              <ol className="space-y-2">
                {data.attempts.map((attempt, index) => (
                  <li
                    key={`${attempt.messageId}-${index}`}
                    className="space-y-1 rounded-md border p-3"
                  >
                    <p className="text-sm font-medium">
                      {t(`historyStatuses.${attempt.status}`)}
                    </p>
                    <p className="break-words text-xs text-muted-foreground">
                      {attempt.attemptedAt
                        ? formatDateTime(attempt.attemptedAt)
                        : t("unavailable")}
                    </p>
                    {attempt.deliveredAt ? (
                      <p className="text-xs">
                        {t("deliveredAt")}:{" "}
                        {formatDateTime(attempt.deliveredAt)}
                      </p>
                    ) : null}
                    {attempt.readAt ? (
                      <p className="text-xs">
                        {t("readAt")}: {formatDateTime(attempt.readAt)}
                      </p>
                    ) : null}
                    {attempt.errorCode || attempt.errorMessage ? (
                      <p className="break-words text-xs text-destructive">
                        {attempt.errorCode} {attempt.errorMessage}
                      </p>
                    ) : null}
                    {attempt.disputedIdentity ? (
                      <p className="text-xs text-destructive">
                        {t("identityConflict")}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          {t("close")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
