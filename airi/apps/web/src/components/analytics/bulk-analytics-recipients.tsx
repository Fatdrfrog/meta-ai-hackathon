"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import type { MessageRecord } from "@/components/analytics/bulk-analytics";
import { normalizeBulkAnalyticsRecipientSearch } from "@/lib/analytics/bulk-analytics-contract";
import { useBulkAnalyticsFormatters } from "@/components/analytics/bulk-analytics-formatters";
import { formatBulkAnalyticsRecipientLabel } from "@/components/analytics/bulk-analytics-export";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type BulkAnalyticsRecipientsProps = {
  records: MessageRecord[];
  isLoading: boolean;
  error?: Error;
  page: number;
  pageInfo?: { limit: number; hasMore: boolean; nextCursor: string | null };
  onPreviousPage: () => void;
  onNextPage: () => void;
  onOpenConversation: (conversationId: string) => void;
  conversationScope: string;
  onOpenHistory: (recipient: string) => void;
  totalCount?: number;
  search?: string;
  onSearchChange?: (value: string) => void;
  emptyState?: React.ReactNode;
};

function ReplyStatus({ replied }: { replied: boolean }) {
  const t = useTranslations("BulkAnalytics.statusBadge");
  return (
    <Badge variant="outline">{replied ? t("replied") : t("noReply")}</Badge>
  );
}

function DeliveryStatus({
  row,
  isConversationPool,
}: {
  row: MessageRecord;
  isConversationPool: boolean;
}) {
  const t = useTranslations("BulkAnalytics");
  return (
    <div className="space-y-1">
      <Badge variant="outline" className="max-w-full whitespace-normal">
        {isConversationPool
          ? t("operations.unavailable")
          : t(`operations.statuses.${row.deliveryStatus || "unknown"}`)}
      </Badge>
      {!isConversationPool && row.deliveryErrorCode ? (
        <p className="break-words text-xs text-destructive">
          {row.deliveryErrorCode}
        </p>
      ) : null}
      {row.recipientConflict ? (
        <p className="break-words text-xs text-destructive">
          {t("operations.identityConflict")}
        </p>
      ) : null}
    </div>
  );
}

export function BulkAnalyticsRecipients({
  records,
  isLoading,
  error,
  page,
  pageInfo,
  onPreviousPage,
  onNextPage,
  onOpenConversation,
  conversationScope,
  onOpenHistory,
  totalCount,
  search = "",
  onSearchChange,
  emptyState,
}: BulkAnalyticsRecipientsProps) {
  const t = useTranslations("BulkAnalytics");
  const r = useTranslations("BulkAnalytics.recipients");
  const pagination = useTranslations("Pagination");
  const { formatDateTime, formatInteger, formatScore, formatMinutes } =
    useBulkAnalyticsFormatters();
  const [draft, setDraft] = useState(search);
  const [searchError, setSearchError] = useState(false);
  const [selected, setSelected] = useState<MessageRecord | null>(null);
  const [previousSearch, setPreviousSearch] = useState(search);
  const [previousRecords, setPreviousRecords] = useState(records);
  const [previousScope, setPreviousScope] = useState(conversationScope);
  const searchId = useId();
  const isConversationPool = conversationScope !== "campaign_sends";
  if (previousSearch !== search) {
    setPreviousSearch(search);
    setDraft(search);
    setSearchError(false);
    setSelected(null);
  }
  // Close a stale attempt when its observation is replaced or its query changes.
  if (previousRecords !== records || previousScope !== conversationScope) {
    setPreviousRecords(records);
    setPreviousScope(conversationScope);
    setSelected(null);
  }
  const first = records.length ? page * (pageInfo?.limit || 100) + 1 : 0;
  const last = records.length ? first + records.length - 1 : 0;
  const range =
    totalCount == null
      ? r("rangeUnknown", {
          from: formatInteger(first),
          to: formatInteger(last),
        })
      : r("range", {
          from: formatInteger(first),
          to: formatInteger(last),
          total: formatInteger(totalCount),
        });
  const pageControls = () => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {r("page", { number: page + 1 })}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={pagination("previousAria")}
        disabled={page === 0 || isLoading}
        onClick={onPreviousPage}
      >
        {pagination("previous")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={pagination("nextAria")}
        disabled={!pageInfo?.hasMore || isLoading}
        onClick={onNextPage}
      >
        {pagination("next")}
      </Button>
    </div>
  );
  const actions = (row: MessageRecord) => (
    <div className="flex flex-wrap gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isLoading}
        onClick={() => setSelected(row)}
      >
        {r("details")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={isLoading || !row.conversationId}
        onClick={() => onOpenConversation(row.conversationId)}
      >
        {r("conversation")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={isLoading || !row.recipient}
        onClick={() => onOpenHistory(row.recipient)}
      >
        {t("operations.historyAction")}
      </Button>
    </div>
  );
  const detail = (label: string, value: string | number | null | undefined) => (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-baseline gap-x-3 border-b border-border/60 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm [overflow-wrap:anywhere]">
        {value == null || value === "" ? t("operations.unavailable") : value}
      </dd>
    </div>
  );
  return (
    <section
      className="min-w-0 space-y-4 rounded-lg border bg-background p-3 sm:p-4"
      aria-busy={isLoading}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">
            {isConversationPool
              ? t("recentTable.titles.conversationPool")
              : t("recentTable.titles.acceptedSends")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
            {range}
          </p>
        </div>
        {pageControls()}
      </div>
      {onSearchChange ? (
        <form
          className="space-y-2"
          onSubmit={event => {
            event.preventDefault();
            try {
              const normalized = normalizeBulkAnalyticsRecipientSearch(draft);
              setSearchError(false);
              onSearchChange(normalized || "");
            } catch {
              setSearchError(true);
            }
          }}
        >
          <Label htmlFor={searchId}>{r("searchLabel")}</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={searchId}
              type="search"
              inputMode="tel"
              autoComplete="off"
              value={draft}
              onChange={event => {
                setDraft(event.target.value);
                setSearchError(false);
              }}
              placeholder={r("searchPlaceholder")}
              aria-invalid={searchError}
              aria-describedby={`${searchId}-help${searchError ? ` ${searchId}-error` : ""}`}
              className="min-w-0 flex-1 basis-48"
            />
            <Button
              type="submit"
              size="sm"
              className="h-9"
              disabled={isLoading}
            >
              <Search className="size-4" aria-hidden="true" />
              {r("searchApply")}
            </Button>
            {draft || search ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9"
                disabled={isLoading}
                onClick={() => {
                  setDraft("");
                  setSearchError(false);
                  onSearchChange("");
                }}
              >
                {r("searchClear")}
              </Button>
            ) : null}
          </div>
          <p id={`${searchId}-help`} className="text-xs text-muted-foreground">
            {r("searchHelp")}
          </p>
          {searchError ? (
            <p
              id={`${searchId}-error`}
              role="alert"
              className="text-xs text-destructive"
            >
              {r("searchInvalid")}
            </p>
          ) : null}
        </form>
      ) : null}
      {isLoading && records.length > 0 && !error ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("operations.updating")}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{t("errors.loadFailed")}</AlertDescription>
        </Alert>
      ) : null}
      <div className="hidden overflow-hidden rounded-md border md:block">
        <Table
          aria-label={
            isConversationPool
              ? t("recentTable.aria.conversationPool")
              : t("recentTable.aria.acceptedSends")
          }
        >
          <TableHeader>
            <TableRow>
              <TableHead>{t("recentTable.columns.recipient")}</TableHead>
              <TableHead>{t("recentTable.columns.template")}</TableHead>
              <TableHead>{t("operations.deliveryFilter")}</TableHead>
              <TableHead>{t("operations.replyStatus")}</TableHead>
              <TableHead>{t("recentTable.columns.engagement")}</TableHead>
              <TableHead>{r("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && !records.length
              ? Array.from({ length: 5 }, (_, index) => (
                  <TableRow key={index}>
                    {Array.from({ length: 6 }, (_, cell) => (
                      <TableCell key={cell}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : records.map(row => (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-48 break-words font-medium [overflow-wrap:anywhere]">
                      {formatBulkAnalyticsRecipientLabel(
                        row.recipient || row.conversationId
                      )}
                    </TableCell>
                    <TableCell className="max-w-48">
                      <p className="break-words [overflow-wrap:anywhere]">
                        {row.templateName || t("operations.unavailable")}
                      </p>
                      <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(row.sentAt)}
                      </p>
                    </TableCell>
                    <TableCell>
                      <DeliveryStatus
                        row={row}
                        isConversationPool={isConversationPool}
                      />
                    </TableCell>
                    <TableCell>
                      <ReplyStatus replied={row.replied} />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {r("replyCount", {
                          count: formatInteger(row.replyCount),
                        })}
                      </p>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatScore(row.engagementScore)}
                    </TableCell>
                    <TableCell className="max-w-64">{actions(row)}</TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
      <div className="space-y-2 md:hidden">
        {isLoading && !records.length ? (
          <Skeleton className="h-36 w-full" />
        ) : (
          records.map(row => (
            <article
              key={row.id}
              className="min-w-0 space-y-3 rounded-md border p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 break-all text-sm font-medium">
                  {formatBulkAnalyticsRecipientLabel(
                    row.recipient || row.conversationId
                  )}
                </p>
                <ReplyStatus replied={row.replied} />
              </div>
              <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {row.templateName || t("operations.unavailable")} ·{" "}
                {formatDateTime(row.sentAt)}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <DeliveryStatus
                  row={row}
                  isConversationPool={isConversationPool}
                />
                <p className="text-xs text-muted-foreground">
                  {r("replyCount", { count: formatInteger(row.replyCount) })} ·{" "}
                  {t("recentTable.columns.engagement")}:{" "}
                  {formatScore(row.engagementScore)}
                </p>
              </div>
              {actions(row)}
            </article>
          ))
        )}
      </div>
      {!isLoading && !error && !records.length
        ? emptyState || (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t("operations.noResults")}
            </p>
          )
        : null}
      {records.length > 10 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">{range}</p>
          {pageControls()}
        </div>
      ) : null}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={open => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{r("detailsTitle")}</DialogTitle>
            <DialogDescription>{r("detailsDescription")}</DialogDescription>
          </DialogHeader>
          {selected ? (
            <>
              <p className="break-all text-sm font-semibold">
                {formatBulkAnalyticsRecipientLabel(
                  selected.recipient || selected.conversationId
                )}
              </p>
              {selected.recipientConflict ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    {r("conflictDescription")}
                  </AlertDescription>
                </Alert>
              ) : null}
              <dl className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                {detail(r("providerMessageId"), selected.messageId)}
                {detail(
                  t("operations.providerRecipient"),
                  selected.providerRecipient
                )}
                {detail(
                  t("recentTable.columns.template"),
                  selected.templateName
                )}
                {detail(
                  t("recentTable.columns.sent"),
                  formatDateTime(selected.sentAt)
                )}
                {detail(
                  t("operations.deliveryFilter"),
                  isConversationPool
                    ? t("operations.unavailable")
                    : t(
                        `operations.statuses.${selected.deliveryStatus || "unknown"}`
                      )
                )}
                {detail(t("operations.errorCode"), selected.deliveryErrorCode)}
                {detail(
                  t("operations.deliveredAt"),
                  formatDateTime(selected.deliveredAt)
                )}
                {detail(
                  t("operations.readAt"),
                  formatDateTime(selected.readAt)
                )}
                {detail(
                  r("firstReplyAt"),
                  selected.replied
                    ? formatDateTime(selected.firstReplyAt)
                    : t("operations.noFirstReply")
                )}
                {detail(
                  r("replyDelay"),
                  selected.replied
                    ? formatMinutes(selected.replyDelayMinutes)
                    : t("operations.noFirstReply")
                )}
                {detail(
                  t("recentTable.columns.replies"),
                  formatInteger(selected.replyCount)
                )}
                {detail(
                  t("recentTable.columns.engagement"),
                  formatScore(selected.engagementScore)
                )}
                {detail(
                  r("matchedCount"),
                  selected.matchedMessageCount == null
                    ? null
                    : formatInteger(selected.matchedMessageCount)
                )}
                {detail(
                  r("matchedAt"),
                  formatDateTime(selected.firstMatchedMessageAt)
                )}
                {detail(
                  r("matchedDirection"),
                  selected.firstMatchedMessageDirection
                )}
                {detail(r("conversationStatus"), selected.conversationStatus)}
                {detail(
                  r("managerRead"),
                  selected.isReadByManager == null
                    ? null
                    : selected.isReadByManager
                      ? r("yes")
                      : r("no")
                )}
                {detail(r("conversationSource"), selected.conversationSource)}
              </dl>
              {selected.deliveryErrorMessage ? (
                <Alert variant="destructive">
                  <AlertDescription className="break-words">
                    {selected.deliveryErrorMessage}
                  </AlertDescription>
                </Alert>
              ) : null}
              <dl className="space-y-2">
                {detail(
                  t("recentTable.columns.firstReply"),
                  selected.replied
                    ? selected.firstReplyText ||
                        (t.has(`categories.${selected.replyCategory}`)
                          ? t(`categories.${selected.replyCategory}`)
                          : selected.replyCategory)
                    : t("operations.noFirstReply")
                )}
                {detail(
                  t("recentTable.columns.matchedMessage"),
                  selected.firstMatchedMessageText || t("recentTable.noMatch")
                )}
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!selected.conversationId}
                  onClick={() => {
                    onOpenConversation(selected.conversationId);
                    setSelected(null);
                  }}
                >
                  {r("conversation")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!selected.recipient}
                  onClick={() => {
                    onOpenHistory(selected.recipient);
                    setSelected(null);
                  }}
                >
                  {t("operations.historyAction")}
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
