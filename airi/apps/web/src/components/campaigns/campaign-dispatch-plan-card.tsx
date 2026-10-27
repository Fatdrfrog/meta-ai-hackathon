"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { CampaignDispatchPlanLiveStatus } from "@/components/campaigns/campaign-dispatch-live-status";
import { BulkCampaignUpgradeButton } from "@/components/campaigns/bulk-campaign-limit-hint";
import {
  useCampaignTimeFormatter,
  useRetryLocked,
} from "@/components/campaigns/campaign-retry-time";
import {
  bulkCampaignReadinessErrorKey,
  bulkCampaignReadinessFix,
  resolveBulkCampaignSendStatus,
  getBulkCampaignPlanBlockReason,
  type BulkCampaignSendStatus,
  type BulkCampaignPlanLimit,
  type BulkCampaignReadinessFix,
} from "@/lib/campaign/bulk-campaign-send-gate";
import type { CampaignOperationStatusResponse } from "@/lib/campaign/campaign-operations-contracts";
import type {
  BulkCampaignBatchPlanPreviewResponse,
  BulkCampaignDispatchStatus,
  BulkCampaignQueuedDispatchInfo,
} from "@/lib/campaign/bulk-campaign-contracts";
import {
  isBulkCampaignReadiness,
  type BulkCampaignReadiness,
} from "@icecore/scenario-contracts";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

export type CampaignBatchPlanPreviewResponse =
  BulkCampaignBatchPlanPreviewResponse;
export type QueuedCampaignDispatchInfo = BulkCampaignQueuedDispatchInfo;

export type CampaignReadinessNoticeProps = {
  sendStatus?: BulkCampaignSendStatus;
  companyLimits?: BulkCampaignPlanLimit | null;
  blockedMessage?: string | null;
  readiness?: BulkCampaignReadiness | null;
  checkingReadiness?: boolean;
  readinessError?: boolean;
  /** Why the check failed, e.g. `meta_rate_limited`. */
  readinessErrorCode?: string | null;
  /** Epoch ms before which Refresh stays disabled (server Retry-After). */
  retryAt?: number | null;
  awaitingAudience?: boolean;
  /** A message is chosen, so only recipients are missing while awaiting. */
  messageSelected?: boolean;
  /** Every recipient was skipped, so a passing check still can't send. */
  allExcluded?: boolean;
  /**
   * Send waits on something this check doesn't cover, such as the template
   * catalog, so a passing check doesn't read as ready.
   */
  sendBlockedElsewhere?: boolean;
  onRefreshReadiness?: () => void;
  /** Keeps Refresh disabled, e.g. while a send is in flight. */
  refreshDisabled?: boolean;
  /** Id for the sending status, so Send can point at its explanation. */
  reasonId?: string;
  /** Enables the Integrations link for a missing or disconnected number. */
  workspaceId?: string | null;
};

/**
 * One link per label for the shown reasons, in reason order: WhatsApp
 * Manager's billing and restriction pages share one button.
 */
function resolveReadinessFixes(
  codes: Array<string | null | undefined>,
  workspaceId: string | null | undefined
): BulkCampaignReadinessFix[] {
  const fixes = new Map<string, BulkCampaignReadinessFix>();
  for (const code of codes) {
    const fix = bulkCampaignReadinessFix(code, workspaceId);
    if (fix && !fixes.has(fix.kind)) fixes.set(fix.kind, fix);
  }
  return [...fixes.values()];
}

export function CampaignReadinessNotice(props: CampaignReadinessNoticeProps) {
  const t = useTranslations("CampaignDispatchPlanCard");
  const retryLocked = useRetryLocked(props.retryAt);
  const formatReadinessTime = useCampaignTimeFormatter();
  const readiness = isBulkCampaignReadiness(props.readiness)
    ? props.readiness
    : null;
  const status =
    props.sendStatus ??
    resolveBulkCampaignSendStatus({
      ...props,
      limit: props.companyLimits,
      readiness,
      readinessError:
        props.readinessError || (!readiness && !props.awaitingAudience),
    });
  const readinessState = status.state;
  const planBlocked = readinessState === "plan_blocked";
  const showResult = !props.checkingReadiness && !props.readinessError;
  const reasonKey =
    props.readinessError &&
    (!props.blockedMessage ||
      bulkCampaignReadinessErrorKey(props.readinessErrorCode))
      ? (bulkCampaignReadinessErrorKey(props.readinessErrorCode) ??
        "readiness.unavailableDescription")
      : null;
  // Retrying won't bring back a missing number, so don't title it "try again".
  // A rate limit says when to try again below, so its title doesn't.
  const titleKey =
    readinessState === "awaitingAudience" && props.messageSelected
      ? "awaitingRecipients"
      : readinessState === "unavailable" &&
          props.readinessErrorCode === "plan_unavailable"
        ? "blocked"
        : readinessState === "unavailable" &&
            props.readinessErrorCode === "meta_rate_limited"
          ? "rateLimited"
          : readinessState;
  const fixes = resolveReadinessFixes(
    reasonKey
      ? [props.readinessErrorCode]
      : showResult
        ? (readiness?.reasons.map(reason => reason.code) ?? [])
        : [],
    props.workspaceId
  );

  // Delivery progress already has its own status; a previous check is stale here.
  if (readinessState === "sending" || readinessState === "active_dispatch")
    return null;

  return (
    <div
      id={props.reasonId}
      role="status"
      aria-live="polite"
      aria-busy={readinessState === "checking"}
      data-testid="campaign-readiness"
      data-readiness-state={readinessState}
      className={`min-w-0 rounded-lg border px-3 py-3 ${
        readinessState === "ready"
          ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30"
          : planBlocked ||
              readinessState === "blocked" ||
              readinessState === "unavailable" ||
              readinessState === "noRecipients"
            ? "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30"
            : "border-transparent bg-muted/30"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {readinessState === "checking" ? (
            <Loader2
              aria-hidden="true"
              className="h-4 w-4 shrink-0 animate-spin"
            />
          ) : readinessState === "ready" ? (
            <CheckCircle2
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-emerald-700"
            />
          ) : (
            <AlertCircle
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-amber-700"
            />
          )}
          <h3 className="min-w-0 break-words text-sm font-medium">
            {t(planBlocked ? "planRestriction.title" : `readiness.${titleKey}`)}
          </h3>
        </div>
        {planBlocked && props.workspaceId ? (
          <BulkCampaignUpgradeButton
            workspaceId={props.workspaceId}
            limit={props.companyLimits}
            t={t}
            label={t("planRestriction.upgrade")}
            className="max-w-full"
          />
        ) : null}
        {!planBlocked && props.onRefreshReadiness ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 px-2"
            disabled={
              readinessState === "checking" ||
              retryLocked ||
              props.refreshDisabled
            }
            onClick={props.onRefreshReadiness}
          >
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            {t(
              readinessState === "ready"
                ? "readiness.recheck"
                : "readiness.refresh"
            )}
          </Button>
        ) : null}
      </div>
      {planBlocked && status.planReason ? (
        <div className="mt-2 space-y-2 text-sm">
          <p>{t(`planRestriction.${status.planReason}`)}</p>
          {props.companyLimits && (
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-0 text-xs text-muted-foreground"
                >
                  {t("planRestriction.details")}
                  <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-1 text-xs text-muted-foreground">
                {typeof props.companyLimits.bulkRecipientLimit === "number" &&
                  typeof props.companyLimits.bulkRecipientCount ===
                    "number" && (
                    <p>
                      {t("planRestriction.recipientUsage", {
                        used: props.companyLimits.bulkRecipientCount,
                        limit: props.companyLimits.bulkRecipientLimit,
                      })}
                    </p>
                  )}
                {typeof props.companyLimits.conversationLimit === "number" &&
                  typeof props.companyLimits.conversationCount === "number" && (
                    <p>
                      {t("planRestriction.conversationUsage", {
                        used: props.companyLimits.conversationCount,
                        limit: props.companyLimits.conversationLimit,
                      })}
                    </p>
                  )}
              </CollapsibleContent>
            </Collapsible>
          )}
          {(props.readinessError ||
            props.checkingReadiness ||
            (readiness && readiness.state !== "ready")) && (
            <p className="text-xs text-muted-foreground">
              {t("planRestriction.checksPending")}
            </p>
          )}
        </div>
      ) : null}
      {props.blockedMessage &&
      (readinessState === "blocked" ||
        readinessState === "unavailable" ||
        planBlocked) ? (
        <p className="mt-2 break-words text-sm">{props.blockedMessage}</p>
      ) : null}
      {reasonKey && (readinessState === "unavailable" || planBlocked) ? (
        <div
          className={
            planBlocked
              ? "mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3"
              : "mt-2"
          }
        >
          <p className="min-w-0 break-words text-sm">
            {t(reasonKey)}
            {retryLocked && typeof props.retryAt === "number" ? (
              <>
                {" "}
                <span>
                  {t("readiness.cooldownUntil", {
                    time: formatReadinessTime(props.retryAt),
                  })}
                </span>
              </>
            ) : null}
          </p>
          {planBlocked && props.onRefreshReadiness ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={
                props.checkingReadiness || retryLocked || props.refreshDisabled
              }
              onClick={props.onRefreshReadiness}
            >
              <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
              {t("readiness.refresh")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {showResult && readiness?.reasons.length ? (
        <ul className="mt-2 space-y-2 text-sm">
          {readiness.reasons.map((reason, index) => (
            <li
              key={`${reason.code}:${index}`}
              className="min-w-0 space-y-1 break-words"
            >
              <p>
                {t(`readiness.reasons.${reason.code}`, {
                  count: reason.affectedRecipientCount ?? 0,
                })}
              </p>
              {reason.code === "contact_frequency_limit" ? (
                <p className="text-xs text-muted-foreground">
                  {reason.nextEligibleAt
                    ? t("readiness.cooldownUntil", {
                        time: formatReadinessTime(reason.nextEligibleAt),
                      })
                    : t("readiness.cooldownUnknown")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {fixes.length > 0 ? (
        <div
          data-testid="campaign-readiness-fixes"
          className="mt-2 flex flex-wrap gap-2"
        >
          {fixes.map(fix => (
            <Button
              key={fix.kind}
              asChild
              size="sm"
              variant="outline"
              className="h-8 max-w-full"
            >
              {fix.external ? (
                <a href={fix.href} target="_blank" rel="noopener noreferrer">
                  <span className="min-w-0 truncate">
                    {t(`readiness.fix.${fix.kind}`)}
                  </span>
                  <ExternalLink data-icon="inline-end" aria-hidden="true" />
                </a>
              ) : (
                <Link href={fix.href}>
                  <span className="min-w-0 truncate">
                    {t(`readiness.fix.${fix.kind}`)}
                  </span>
                </Link>
              )}
            </Button>
          ))}
        </div>
      ) : null}
      {showResult && readiness && !planBlocked ? (
        <Collapsible className="mt-1">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="group h-8 px-0 text-xs text-muted-foreground hover:bg-transparent"
            >
              {t("readiness.details")}
              <ChevronDown
                aria-hidden="true"
                className="h-3.5 w-3.5 group-data-[state=open]:rotate-180"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-1 pb-1 text-xs text-muted-foreground">
            <p>
              {t("readiness.checkedAt", {
                time: formatReadinessTime(readiness.checkedAt),
              })}
            </p>
            {readiness.reasons.map((reason, index) =>
              reason.providerCode ? (
                <p key={`${reason.code}:${index}`}>
                  {t("readiness.providerCode", { code: reason.providerCode })}
                </p>
              ) : null
            )}
            <p>{t("readiness.remainingUnknown")}</p>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

export function CampaignDispatchPlanCard(
  props: CampaignReadinessNoticeProps & {
    workspaceId?: string | null;
    loading?: boolean;
    preview?: CampaignBatchPlanPreviewResponse | null;
    previewError?: boolean;
    onRefreshPreview?: () => void;
    queuedDispatch?: QueuedCampaignDispatchInfo | null;
    embedded?: boolean;
    showReadiness?: boolean;
    onDispatchLifecycleChange?: (
      status: BulkCampaignDispatchStatus,
      operation: CampaignOperationStatusResponse | null
    ) => void;
  }
) {
  const t = useTranslations("CampaignDispatchPlanCard");
  const channel = props.preview?.channel;
  const unconfigured = Boolean(
    props.preview && !props.preview.configured && !props.previewError
  );
  const planBlocked =
    props.sendStatus?.state === "plan_blocked" ||
    (!props.sendStatus &&
      Boolean(getBulkCampaignPlanBlockReason(props.companyLimits)));

  if (props.loading && !props.onRefreshReadiness && !planBlocked) {
    return <Skeleton className="h-12 w-full rounded-lg" />;
  }

  if (
    !props.preview &&
    !props.previewError &&
    !props.queuedDispatch &&
    !props.onRefreshReadiness &&
    !planBlocked
  ) {
    return null;
  }

  const showReadinessNotice =
    ((props.showReadiness ?? !props.queuedDispatch) &&
      (channel === "whatsapp" || props.onRefreshReadiness)) ||
    props.previewError ||
    planBlocked;

  return (
    <section className="min-w-0 space-y-3">
      {showReadinessNotice ? (
        <CampaignReadinessNotice
          sendStatus={props.sendStatus}
          companyLimits={props.companyLimits}
          sendBlockedElsewhere={props.sendBlockedElsewhere}
          blockedMessage={
            props.blockedMessage ??
            (unconfigured && props.readinessErrorCode !== "plan_unavailable"
              ? t("credentialsUnavailable")
              : undefined)
          }
          readiness={props.readiness ?? props.preview?.readiness}
          checkingReadiness={props.checkingReadiness}
          readinessError={props.readinessError || props.previewError}
          readinessErrorCode={props.readinessErrorCode}
          retryAt={props.retryAt}
          awaitingAudience={props.awaitingAudience}
          messageSelected={props.messageSelected}
          allExcluded={props.allExcluded}
          onRefreshReadiness={
            props.onRefreshReadiness ?? props.onRefreshPreview
          }
          refreshDisabled={props.refreshDisabled}
          reasonId={props.reasonId}
          workspaceId={props.workspaceId}
        />
      ) : null}
      {/* The notice's reason line already says the number is unavailable. */}
      {unconfigured && !showReadinessNotice ? (
        <Alert>
          <AlertDescription>{t("credentialsUnavailable")}</AlertDescription>
        </Alert>
      ) : null}
      {props.queuedDispatch ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {t("queuedSummary", { count: props.queuedDispatch.total })}
          </p>
          <CampaignDispatchPlanLiveStatus
            workspaceId={props.workspaceId}
            campaignId={props.queuedDispatch.campaignId}
            initialStatus={props.queuedDispatch.status ?? "queued"}
            onLifecycleChange={props.onDispatchLifecycleChange}
          />
        </div>
      ) : null}
    </section>
  );
}
