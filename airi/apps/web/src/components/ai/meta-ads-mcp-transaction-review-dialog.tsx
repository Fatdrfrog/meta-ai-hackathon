"use client";

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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { MetaAdsMcpTransactionV2 } from "@/lib/meta-ads/mcp/confirmation-contract";
import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";
import { AlertTriangle, ChevronDown, Loader2, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslations } from "next-intl";

export type MetaAdsMcpTransactionReviewDialogProps = {
  open: boolean;
  transaction: MetaAdsMcpTransactionV2;
  state: "ready" | "stale" | "mismatched" | "submitting";
  error?: string;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
};

function ReviewRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 border-b py-2 last:border-b-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

function ReviewSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-background px-3">
      <h3 className="border-b py-2 text-sm font-semibold">{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

function ExactValue({ value }: { value: unknown }) {
  const serialized = JSON.stringify(value);
  return (
    <code className="break-all font-mono text-xs">
      {serialized === undefined ? String(value) : serialized}
    </code>
  );
}

export function MetaAdsMcpTransactionReviewDialog({
  open,
  transaction,
  state,
  error,
  onOpenChange,
  onConfirm,
}: MetaAdsMcpTransactionReviewDialogProps) {
  const t = useTranslations("AiriMetaAds");
  const submissionLockRef = useRef(false);
  const [locallyLocked, setLocallyLocked] = useState(false);
  const unavailable =
    state === "stale" || state === "mismatched" || state === "submitting";
  const requestedStatuses = Array.from(
    new Set(
      transaction.disclosure.entities.flatMap(entity =>
        entity.requestedStatus ? [entity.requestedStatus] : []
      )
    )
  );
  const exactLogicalJson = JSON.stringify(
    JSON.parse(serializeCanonicalJson(transaction.logicalArguments)),
    null,
    2
  );
  const shortDigest = `${transaction.transactionDigest.slice(0, 12)}…${transaction.transactionDigest.slice(-8)}`;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && state === "submitting") return;
    if (!nextOpen) {
      submissionLockRef.current = false;
      setLocallyLocked(false);
    }
    onOpenChange(nextOpen);
  };

  const handleConfirm = () => {
    if (unavailable || submissionLockRef.current) return;
    submissionLockRef.current = true;
    setLocallyLocked(true);
    onConfirm();
    queueMicrotask(() => {
      submissionLockRef.current = false;
      setLocallyLocked(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[90dvh] max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>{t("review.title")}</DialogTitle>
            <Badge variant={state === "ready" ? "secondary" : "destructive"}>
              {t(`review.states.${state}`)}
            </Badge>
          </div>
          <DialogDescription>{t("review.description")}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:absolute [&>[data-slot=scroll-area-viewport]]:inset-0">
          <div className="space-y-4 px-5 py-4">
            {state === "stale" || state === "mismatched" ? (
              <div
                role="alert"
                className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  {t(
                    state === "stale"
                      ? "review.staleError"
                      : "review.mismatchError"
                  )}
                </span>
              </div>
            ) : error ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {t("review.error")}
              </div>
            ) : null}

            <ReviewSection title={t("review.summary")}>
              <ReviewRow label={t("review.target")}>
                <span className="break-all">
                  {transaction.target.adAccountName
                    ? `${transaction.target.adAccountName} (${transaction.target.adAccountId})`
                    : transaction.target.adAccountId}
                </span>
              </ReviewRow>
              <ReviewRow label={t("review.business")}>
                {transaction.target.businessId ? (
                  <span className="break-all">
                    {transaction.target.businessName
                      ? `${transaction.target.businessName} (${transaction.target.businessId})`
                      : transaction.target.businessId}
                  </span>
                ) : (
                  t("common.notProvided")
                )}
              </ReviewRow>
              <ReviewRow label={t("review.currencyTimezone")}>
                {transaction.target.currency} /{" "}
                {transaction.target.timezone || t("common.notProvided")}
              </ReviewRow>
            </ReviewSection>

            <ReviewSection title={t("review.operation")}>
              <ReviewRow label={t("review.operation")}>
                <span className="break-all">{transaction.summary}</span>
              </ReviewRow>
              <ReviewRow label={t("review.entities")}>
                {transaction.disclosure.entities.length > 0 ? (
                  <ul className="space-y-1">
                    {transaction.disclosure.entities.map((entity, index) => (
                      <li
                        key={`${entity.type}:${entity.id || index}`}
                        className="break-all"
                      >
                        {entity.type}
                        {entity.id ? ` · ${entity.id}` : ""}
                        {entity.action
                          ? ` · ${t("review.entityAction", { action: entity.action })}`
                          : ""}
                        {entity.requestedStatus
                          ? ` · ${t("review.entityStatus", { status: entity.requestedStatus })}`
                          : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  t("common.notProvided")
                )}
              </ReviewRow>
              <ReviewRow label={t("review.requestedStatus")}>
                {requestedStatuses.length > 0
                  ? requestedStatuses.join(", ")
                  : t("common.notChanged")}
              </ReviewRow>
            </ReviewSection>

            <ReviewSection title={t("review.money")}>
              <ReviewRow label={t("review.moneyRaw")}>
                {transaction.disclosure.money.length > 0 ? (
                  <ul className="space-y-1">
                    {transaction.disclosure.money.map(item => (
                      <li key={item.path} className="break-all">
                        <code>{item.path}</code>:{" "}
                        <ExactValue value={item.rawValue} />
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("review.moneyCurrency")}: {item.currency}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("review.moneyUnits", { currency: item.currency })}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  t("common.notChanged")
                )}
              </ReviewRow>
            </ReviewSection>

            <ReviewSection title={t("review.schedule")}>
              <ReviewRow label={t("review.values")}>
                {transaction.disclosure.schedule.length > 0 ? (
                  <ul className="space-y-1">
                    {transaction.disclosure.schedule.map(item => (
                      <li key={item.path} className="break-all">
                        <code>{item.path}</code>:{" "}
                        <ExactValue value={item.value} />
                        {` · ${item.timezone || transaction.target.timezone || t("common.notProvided")}`}
                      </li>
                    ))}
                  </ul>
                ) : (
                  t("common.notChanged")
                )}
              </ReviewRow>
            </ReviewSection>

            <ReviewSection title={t("review.targeting")}>
              <ReviewRow label={t("review.values")}>
                {transaction.disclosure.targeting.length > 0 ? (
                  <ul className="space-y-1">
                    {transaction.disclosure.targeting.map(item => (
                      <li key={item.path} className="break-all">
                        <code>{item.path}</code>:{" "}
                        <ExactValue value={item.value} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  t("common.notChanged")
                )}
              </ReviewRow>
            </ReviewSection>

            <ReviewSection title={t("review.creativeAssets")}>
              <ReviewRow label={t("review.logicalAssets")}>
                {transaction.disclosure.creativeAssets.length > 0 ? (
                  <ul className="space-y-1">
                    {transaction.disclosure.creativeAssets.map(asset => (
                      <li key={asset.id} className="break-all">
                        {asset.name} · {asset.kind} · {asset.id}
                      </li>
                    ))}
                  </ul>
                ) : (
                  t("common.notChanged")
                )}
              </ReviewRow>
              {transaction.disclosure.creativeAssets.length > 0 ? (
                <ReviewRow label={t("review.uploadUrls")}>
                  {t("review.uploadHelp")}
                </ReviewRow>
              ) : null}
            </ReviewSection>

            <ReviewSection title={t("review.warnings")}>
              <ReviewRow label={t("review.warnings")}>
                {transaction.disclosure.warnings.length > 0
                  ? transaction.disclosure.warnings.join(" · ")
                  : t("common.none")}
              </ReviewRow>
              <ReviewRow label={t("review.unmapped")}>
                {transaction.disclosure.unmappedArgumentPaths.length > 0
                  ? transaction.disclosure.unmappedArgumentPaths.join(", ")
                  : t("common.none")}
              </ReviewRow>
            </ReviewSection>

            <Collapsible className="rounded-lg border bg-background">
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="group h-auto w-full justify-between gap-3 whitespace-normal rounded-lg px-3 py-3 text-left"
                >
                  {t("common.technical")}
                  <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 border-t p-3">
                <dl>
                  <ReviewRow label={t("review.user")}>
                    <span className="break-all">
                      {transaction.target.mcpUserName
                        ? `${transaction.target.mcpUserName} (${transaction.target.mcpUserId})`
                        : transaction.target.mcpUserId}
                    </span>
                  </ReviewRow>
                  <ReviewRow label={t("review.sourceConnection")}>
                    <span className="break-all">
                      {transaction.target.sourceId} /{" "}
                      {transaction.target.connectionId}
                    </span>
                  </ReviewRow>
                  <ReviewRow label={t("review.tool")}>
                    <span className="break-all">{transaction.tool.name}</span>
                  </ReviewRow>
                  <ReviewRow label={t("review.accounts")}>
                    {transaction.disclosure.accountIds.length > 0
                      ? transaction.disclosure.accountIds.join(", ")
                      : t("common.notProvided")}
                  </ReviewRow>
                  <ReviewRow label={t("review.businesses")}>
                    {transaction.disclosure.businessIds.length > 0
                      ? transaction.disclosure.businessIds.join(", ")
                      : t("common.notProvided")}
                  </ReviewRow>
                  <ReviewRow label={t("review.operation")}>
                    {transaction.disclosure.operation}
                  </ReviewRow>
                  {error ? (
                    <ReviewRow label={t("review.errorDetails")}>
                      {error}
                    </ReviewRow>
                  ) : null}
                </dl>
                <ReviewSection title={t("review.fullDigest")}>
                  <ReviewRow label={t("review.shortDigest")}>
                    <code className="font-mono text-xs">{shortDigest}</code>
                  </ReviewRow>
                  <ReviewRow label={t("review.fullDigest")}>
                    <code className="break-all font-mono text-xs">
                      {transaction.transactionDigest}
                    </code>
                  </ReviewRow>
                </ReviewSection>
                <h3 className="text-sm font-semibold">{t("review.json")}</h3>
                <div className="overflow-x-auto p-3">
                  <pre className="w-max min-w-full whitespace-pre font-mono text-xs leading-5">
                    {exactLogicalJson}
                  </pre>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </ScrollArea>

        <DialogFooter className="shrink-0 border-t px-5 py-4">
          <Button
            type="button"
            variant="outline"
            disabled={state === "submitting"}
            onClick={() => handleOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            className="h-auto min-h-10 whitespace-normal"
            disabled={unavailable || locallyLocked}
            onClick={handleConfirm}
          >
            {state === "submitting" || locallyLocked ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ShieldCheck className="size-4" />
            )}
            {state === "submitting" || locallyLocked
              ? t("review.submitting")
              : t("review.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
