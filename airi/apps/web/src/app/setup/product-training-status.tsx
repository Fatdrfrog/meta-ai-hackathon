"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { IndexedUrlPublicSource } from "@/lib/kb/indexed-url-public-contract";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ProductContextState } from "./product-context-state";
import { isWhatsAppHistorySyncActive } from "@/lib/whatsapp/history-sync/status";

const STATUS_CARD_CLASSNAME =
  "space-y-3 rounded-2xl border-[3px] border-foreground bg-background p-4 shadow-[4px_4px_0px_#000000] dark:shadow-[4px_4px_0px_rgba(255,255,255,0.15)]";
const STATUS_BADGE_CLASSNAME =
  "max-w-full shrink whitespace-normal rounded-full border-2 border-foreground px-2.5 py-0.5 text-left text-xs font-bold leading-tight shadow-[2px_2px_0px_#000000]";

const failureKey = {
  no_content: "statusFailedNoContent",
  timeout: "statusFailedTimeout",
  generic: "statusFailedGeneric",
} as const;

type ProductTrainingStatusProps = {
  state: ProductContextState;
  onCheckAgain(): void;
  onRetrySource(): void;
};

function sourceName(source: IndexedUrlPublicSource): string {
  return source.title || source.url;
}

function focusStartFailureAlert(element: HTMLDivElement | null): void {
  element?.focus();
}

export function ProductTrainingStatus({
  state,
  onCheckAgain,
  onRetrySource,
}: ProductTrainingStatusProps) {
  const t = useTranslations("OnboardingProductStep");
  const isActive = state.phase === "starting" || state.phase === "polling";
  const isStartFailure =
    state.errorCode !== null &&
    state.errorCode !== "training_progress_unavailable";
  const showProgress =
    state.sources.length > 0 ||
    state.acceptedRun ||
    isActive ||
    state.phase === "background" ||
    state.phase === "ready";
  const errorCopy =
    state.errorCode === "training_progress_unavailable"
      ? t("trainingLoadError")
      : state.errorCode === "whatsapp_history_failed"
        ? t("whatsappHistoryError")
        : state.errorCode === "indexed_url_limit_exceeded"
          ? t("trainingLimitError")
          : state.errorCode === "invalid_training_source"
            ? t("trainingNeedsSource")
            : state.errorCode === "training_start_failed"
              ? t("trainingError")
              : null;
  const isImportingWhatsAppHistory =
    state.connected.whatsapp &&
    state.whatsappHistoryEligible &&
    isWhatsAppHistorySyncActive(state.whatsappHistorySync);
  const activeProgressCopy = isImportingWhatsAppHistory
    ? t("trainingProgressWhatsapp")
    : t("trainingProgressPending");
  const statusAnnouncement =
    state.phase === "loading"
      ? t("trainingLoading")
      : state.phase === "background"
        ? t("trainingBackgroundTitle")
        : state.phase === "ready"
          ? t("learningReadyTitle")
          : isActive
            ? activeProgressCopy
            : state.sources.some(source => source.index_status === "failed")
              ? t("statusFailed")
              : t("trainingOptional");

  return (
    <>
      <output aria-live="polite" className="sr-only">
        {statusAnnouncement}
      </output>
      <div className="min-w-0">
        {state.phase === "loading" ? (
          <p className="flex min-w-0 items-center gap-2 break-words text-sm font-semibold text-muted-foreground">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            {t("trainingLoading")}
          </p>
        ) : null}

        {showProgress ? (
          <div className={STATUS_CARD_CLASSNAME}>
            <p className="break-words text-xs font-black uppercase tracking-wider text-muted-foreground">
              {t("trainingProgressTitle")}
            </p>

            {state.phase === "background" ? (
              <div className="space-y-2">
                <p className="font-black text-foreground">
                  {t("trainingBackgroundTitle")}
                </p>
                <p className="break-words text-sm text-muted-foreground">
                  {t("trainingBackgroundDescription")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onCheckAgain}
                  className="gap-2 border-2 border-foreground font-bold"
                >
                  <RefreshCw className="h-4 w-4" />
                  {t("checkAgain")}
                </Button>
              </div>
            ) : null}

            {state.sources.length === 0 && isActive ? (
              <p className="flex min-w-0 items-start gap-2 break-words text-sm font-semibold text-muted-foreground">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                {activeProgressCopy}
              </p>
            ) : null}

            {state.sources.length > 0 ? (
              <ul className="space-y-2">
                {state.sources.map(source => (
                  <li
                    key={source.id}
                    className="flex flex-col gap-2 border-b-2 border-dashed border-muted pb-2 text-sm last:border-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="break-words font-bold text-foreground sm:truncate">
                        {sourceName(source)}
                      </p>
                      {source.index_status === "failed" ? (
                        <p className="break-words text-xs font-semibold text-destructive">
                          {t(failureKey[source.failure_code ?? "generic"])}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
                      <SourceStatusBadge
                        status={source.index_status}
                        animatePending={isActive}
                      />
                      {source.index_status === "failed" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={onRetrySource}
                          aria-label={t("retrySource", {
                            source: sourceName(source),
                          })}
                          className="border-2 border-foreground font-bold"
                        >
                          <RefreshCw className="h-3 w-3" />
                          {t("tryAgain")}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}

            {state.phase === "ready" ? (
              <div className="rounded-xl border-2 border-foreground bg-[#cfffe1] p-3 text-black dark:bg-emerald-950/40 dark:text-foreground">
                <p className="font-black">{t("learningReadyTitle")}</p>
                <p className="break-words text-sm font-semibold opacity-80">
                  {t("learningReadyDescription")}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {errorCopy ? (
        <Alert
          key={state.errorCode}
          ref={isStartFailure ? focusStartFailureAlert : undefined}
          tabIndex={-1}
          className="rounded-2xl border-[3px] border-foreground bg-destructive/10 font-semibold text-destructive shadow-[3px_3px_0px_#000000] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="min-w-0 break-words">
            <span>{errorCopy}</span>
            {state.errorCode === "training_progress_unavailable" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onCheckAgain}
                className="mt-2 border-2 border-foreground font-bold text-foreground"
              >
                {t("tryAgain")}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

function SourceStatusBadge({
  status,
  animatePending,
}: {
  status: IndexedUrlPublicSource["index_status"];
  animatePending: boolean;
}) {
  const t = useTranslations("OnboardingProductStep");
  if (status === "indexed") {
    return (
      <Badge
        className={`${STATUS_BADGE_CLASSNAME} bg-[#cfffe1] text-emerald-800 hover:bg-[#cfffe1] dark:bg-emerald-950/60 dark:text-emerald-300`}
      >
        <CheckCircle2 className="h-3 w-3 stroke-[3px]" />
        {t("statusIndexed")}
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge
        className={`${STATUS_BADGE_CLASSNAME} bg-[#fec8e7] text-rose-950 dark:text-rose-100 hover:bg-[#fec8e7] dark:bg-[#43142d]`}
      >
        <XCircle className="h-3 w-3 stroke-[3px]" />
        {t("statusFailed")}
      </Badge>
    );
  }
  return (
    <Badge
      className={`${STATUS_BADGE_CLASSNAME} bg-[#fdf0a6] text-amber-800 hover:bg-[#fdf0a6] dark:bg-yellow-950/60 dark:text-amber-300`}
    >
      <Loader2 className={`h-3 w-3 ${animatePending ? "animate-spin" : ""}`} />
      {t("statusPending")}
    </Badge>
  );
}
