"use client";

import { WhatsAppSpendSummary } from "@/components/analytics/whatsapp-spend-summary";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getCampaignDeliveryFunnel,
  isActiveBulkCampaignDispatchStatus,
  isTerminalBulkCampaignDispatchStatus,
  type CampaignOperationStatusResponse,
  type CampaignRetryContactCooldownResponse,
} from "@/lib/campaign/campaign-operations-contracts";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Mail,
  MessageCircle,
  Pause,
  Play,
  RotateCcw,
  Send,
  XCircle,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import useSWR from "swr";
import {
  BULK_CAMPAIGN_STATUS_POLL_INTERVAL_MS,
  BULK_CAMPAIGN_DELIVERY_POLL_INTERVAL_MS,
  shouldRetryCampaignStatusError,
  retryCampaignStatusError,
  useBulkCampaignRealtime,
} from "./use-bulk-campaign-dispatch-status";

interface CampaignMessage {
  id?: string | null;
  message_id?: string | null;
  recipient?: string | null;
  phone?: string | null;
  provider?: string | null;
  status?: string | null;
  error_code?: number | null;
  error_message?: string | null;
  failure_reason?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  clicked_at?: string | null;
  bounced_at?: string | null;
}

interface Campaign {
  id: string;
  name: string;
  channel: string;
  template_name?: string;
  template_language?: string;
  message_text?: string;
  total_recipients: number;
  successful_sends: number;
  failed_sends: number;
  sent_at: string;
  estimated_cost: number | null;
  cost_status?: "reported" | "not_priced" | "not_tracked" | null;
  unpriced_message_count?: number | null;
  delivery_rate?: number;
  read_rate?: number;
  open_rate?: number;
  click_rate?: number;
  unsubscribe_rate?: number;
  bounce_rate?: number;
  reply_rate?: number | null;
  replied_count?: number | null;
  cost_per_reply?: number | null;
  users?: { full_name?: string; email?: string };
  messages?: CampaignMessage[];
  operation: CampaignOperationStatusResponse | null;
  failure_summary?: {
    failedCount: number;
    topReason?: string | null;
    topErrorCode?: number | null;
    reasons?: Array<{
      reason: string;
      count: number;
      errorCode?: number | null;
    }>;
  } | null;
}

interface CampaignHistoryProps {
  workspaceId: string;
  onViewAnalytics?: (campaignId: string) => void;
  focusCampaignId?: string | null;
  focusRequestKey?: number;
  onClearFocus?: () => void;
}

interface CampaignHistoryResponse {
  campaigns: Campaign[];
  hasEmailCampaigns?: boolean;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

type CampaignOperationAction = "cancel" | "retry" | "pause" | "resume";

type CampaignOperationFeedback = {
  campaignId: string;
  tone: "success" | "warning" | "error";
  message: string;
};

type CampaignMetricKey =
  | "recipients"
  | "accepted"
  | "failed"
  | "deliveryRate"
  | "readRate"
  | "replyRate"
  | "openRate"
  | "clickRate"
  | "bounceRate"
  | "unsubscribeRate"
  | "cost"
  | "costPerReply";

type CampaignMetricItem = {
  key: CampaignMetricKey;
  value: string;
  detail?: string;
  tone?: "default" | "success" | "danger";
};

type CampaignHistoryTranslate = (
  key: string,
  values?: Record<string, string | number>
) => string;

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok)
    throw Object.assign(new Error("Failed to fetch campaigns"), {
      status: res.status,
    });
  return (await res.json()) as CampaignHistoryResponse;
};

function shouldSurfaceCampaignOutcomeAlerts(
  operation: CampaignOperationStatusResponse | null
) {
  return !operation || isTerminalBulkCampaignDispatchStatus(operation.status);
}

function campaignOperationProgressPercent(params: {
  processed: number;
  total: number;
}): number {
  if (params.total <= 0) return 0;
  return Math.max(0, Math.min(100, (params.processed / params.total) * 100));
}

function HistoryIconButton(props: {
  label: string;
  disabled?: boolean;
  variant?: "outline" | "ghost";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={props.variant ?? "outline"}
      size="icon"
      className="size-7 shrink-0"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}

function operationStatusClassName(status: string) {
  if (status === "completed") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200";
  }
  if (status === "failed" || status === "expired") {
    return "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200";
  }
  if (status === "cancelled") {
    return "border-muted bg-muted/40 text-muted-foreground";
  }
  if (status === "paused") {
    return "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100";
  }
  return "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200";
}

function mutationErrorMessage(payload: unknown, fallback: string) {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string" &&
    payload.error.trim()
  ) {
    return payload.error;
  }
  return fallback;
}

function readRetryCooldown(
  payload: unknown
): CampaignRetryContactCooldownResponse["cooldown"] | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("code" in payload) ||
    payload.code !== "retry_contact_cooldown" ||
    !("cooldown" in payload)
  )
    return null;
  const cooldown = payload.cooldown;
  if (
    !cooldown ||
    typeof cooldown !== "object" ||
    !("blockedRecipientCount" in cooldown) ||
    typeof cooldown.blockedRecipientCount !== "number" ||
    !("eligibleRecipientCount" in cooldown) ||
    typeof cooldown.eligibleRecipientCount !== "number" ||
    !("nextEligibleAt" in cooldown) ||
    (cooldown.nextEligibleAt !== null &&
      (typeof cooldown.nextEligibleAt !== "string" ||
        !Number.isFinite(Date.parse(cooldown.nextEligibleAt))))
  )
    return null;
  return {
    blockedRecipientCount: cooldown.blockedRecipientCount,
    eligibleRecipientCount: cooldown.eligibleRecipientCount,
    nextEligibleAt: cooldown.nextEligibleAt,
  };
}

function isContactFrequencyLimit(reason?: string | null): boolean {
  if (reason === "contact_frequency_limit") return true;
  if (!reason) return false;
  try {
    const parsed: unknown = JSON.parse(reason);
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        "providerCode" in parsed &&
        parsed.providerCode === "contact_frequency_limit"
    );
  } catch {
    return false;
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function isLocallyCancelledPayload(payload: unknown) {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "status" in payload &&
      payload.status === "cancelled"
  );
}

function formatMessageStatus(status?: string | null) {
  const normalized = String(status || "").trim();
  return normalized || "unknown";
}

function messageStatusClassName(status?: string | null) {
  const normalized = formatMessageStatus(status).toLowerCase();
  if (normalized === "failed" || normalized === "bounced") {
    return "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200";
  }
  if (normalized === "read" || normalized === "delivered") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200";
  }
  if (normalized === "sent") {
    return "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200";
  }
  return "border-muted bg-muted/40 text-muted-foreground";
}

function formatMessageDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatMessagePreview(value?: string | null) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function resolveMessageUpdatedAt(message: CampaignMessage) {
  return (
    message.read_at ||
    message.delivered_at ||
    message.clicked_at ||
    message.bounced_at ||
    message.updated_at ||
    message.created_at ||
    null
  );
}

function formatRatePercent(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "-";
  }
  return `${value.toFixed(1)}%`;
}

function calculateRate(value: number, total: number) {
  if (!total || total <= 0) return 0;
  return (value / total) * 100;
}

function formatMetricCount(value: number, total: number) {
  return `${value} (${calculateRate(value, total).toFixed(1)}%)`;
}

function formatCurrency(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "-";
  }
  return `$${value.toFixed(2)}`;
}

function isCampaignCostUnpriced(campaign: Campaign) {
  return (
    campaign.cost_status === "not_priced" ||
    campaign.cost_status === "not_tracked"
  );
}

function buildCampaignMetricItems(
  campaign: Campaign,
  t: CampaignHistoryTranslate
): CampaignMetricItem[] {
  const totalRecipients =
    campaign.operation?.totalRecipients ?? campaign.total_recipients;
  const accepted =
    campaign.operation?.progress.accepted ?? campaign.successful_sends;
  const failed = campaign.operation?.progress.failed ?? campaign.failed_sends;
  const items: CampaignMetricItem[] = [
    {
      key: "recipients",
      value: String(totalRecipients),
    },
    {
      key: "accepted",
      value: formatMetricCount(accepted, totalRecipients),
      tone: accepted > 0 ? "success" : "default",
    },
    {
      key: "failed",
      value: formatMetricCount(failed, totalRecipients),
      tone: failed > 0 ? "danger" : "default",
    },
  ];

  if (campaign.channel === "email") {
    items.push(
      { key: "openRate", value: formatRatePercent(campaign.open_rate) },
      { key: "clickRate", value: formatRatePercent(campaign.click_rate) },
      { key: "bounceRate", value: formatRatePercent(campaign.bounce_rate) },
      {
        key: "unsubscribeRate",
        value: formatRatePercent(campaign.unsubscribe_rate),
      }
    );
    return items;
  }

  items.push(
    {
      key: "deliveryRate",
      value: formatRatePercent(campaign.delivery_rate),
    },
    { key: "readRate", value: formatRatePercent(campaign.read_rate) }
  );

  if (campaign.channel === "whatsapp") {
    const unpricedCount = campaign.unpriced_message_count ?? 0;
    items.push(
      { key: "replyRate", value: formatRatePercent(campaign.reply_rate) },
      isCampaignCostUnpriced(campaign)
        ? {
            key: "cost",
            value: t("costStatus.notPriced"),
            detail:
              campaign.cost_status === "not_tracked"
                ? t("costStatus.notTracked")
                : unpricedCount > 0
                  ? t("costStatus.unpricedMessages", { count: unpricedCount })
                  : t("costStatus.notPricedDetail"),
          }
        : { key: "cost", value: formatCurrency(campaign.estimated_cost) },
      {
        key: "costPerReply",
        value: isCampaignCostUnpriced(campaign)
          ? t("costStatus.notPriced")
          : formatCurrency(campaign.cost_per_reply),
      }
    );
  }

  return items;
}

function campaignSender(campaign: Campaign, fallback: string) {
  return (
    campaign.users?.full_name ||
    campaign.users?.email?.split("@")[0] ||
    fallback
  );
}

export function CampaignHistory({
  workspaceId,
  onViewAnalytics,
  focusCampaignId = null,
  focusRequestKey = 0,
  onClearFocus,
}: CampaignHistoryProps) {
  const t = useTranslations("CampaignHistory");
  const analyticsT = useTranslations("BulkAnalytics.operations");
  const appliedFocusRequest = useRef<string | null>(null);
  const format = useFormatter();
  const [expandedCampaignId, setExpandedCampaignId] = useState<string | null>(
    null
  );
  const handleReturnToAll = useCallback(() => {
    setExpandedCampaignId(null);
    onClearFocus?.();
  }, [onClearFocus]);
  const focusNavigation =
    focusCampaignId && onClearFocus ? (
      <Button
        variant="outline"
        size="sm"
        className="mb-3"
        onClick={handleReturnToAll}
      >
        {analyticsT("returnToAllCampaigns")}
      </Button>
    ) : null;
  const [pendingOperation, setPendingOperation] = useState<{
    campaignId: string;
    action: CampaignOperationAction;
  } | null>(null);
  const [providerCircuitAcknowledgement, setProviderCircuitAcknowledgement] =
    useState<{
      campaignId: string;
      acknowledged: boolean;
    } | null>(null);
  const [operationFeedback, setOperationFeedback] =
    useState<CampaignOperationFeedback | null>(null);
  const [retryCooldown, setRetryCooldown] = useState<{
    workspaceId: string;
    campaignId: string;
    cooldown: CampaignRetryContactCooldownResponse["cooldown"];
  } | null>(null);
  useEffect(() => {
    const nextEligibleAt = retryCooldown?.cooldown.nextEligibleAt;
    if (!nextEligibleAt || retryCooldown.workspaceId !== workspaceId) return;
    const remainingMs = Date.parse(nextEligibleAt) - Date.now();
    const timer = setTimeout(
      () =>
        setRetryCooldown(current => {
          const deadline = current?.cooldown.nextEligibleAt;
          return deadline && Date.parse(deadline) > Date.now()
            ? { ...current }
            : null;
        }),
      Math.max(0, Math.min(remainingMs, 2_147_483_647))
    );
    return () => clearTimeout(timer);
  }, [retryCooldown, workspaceId]);

  const {
    data,
    error,
    isLoading: loading,
    mutate: mutateHistory,
  } = useSWR<CampaignHistoryResponse>(
    workspaceId
      ? `/api/campaigns/history?${new URLSearchParams({ workspaceId, ...(focusCampaignId ? { campaignId: focusCampaignId } : {}) })}`
      : null,
    fetcher,
    {
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      shouldRetryOnError: shouldRetryCampaignStatusError,
      onErrorRetry: retryCampaignStatusError,
      refreshInterval: latest =>
        latest?.campaigns.some(campaign =>
          isActiveBulkCampaignDispatchStatus(campaign.operation?.status)
        )
          ? BULK_CAMPAIGN_STATUS_POLL_INTERVAL_MS
          : latest?.campaigns.length
            ? BULK_CAMPAIGN_DELIVERY_POLL_INTERVAL_MS
            : 0,
    }
  );
  const campaigns = data?.campaigns ?? [];
  useEffect(() => {
    const requestIdentity = `${workspaceId}:${focusCampaignId}:${focusRequestKey}`;
    if (
      !focusCampaignId ||
      !data?.campaigns.some(campaign => campaign.id === focusCampaignId) ||
      appliedFocusRequest.current === requestIdentity
    )
      return;
    appliedFocusRequest.current = requestIdentity;
    setExpandedCampaignId(focusCampaignId);
    const row = document.getElementById(`campaign-${focusCampaignId}-history`);
    row?.scrollIntoView({ block: "start" });
    row?.focus({ preventScroll: true });
  }, [workspaceId, focusCampaignId, focusRequestKey, data]);

  const refreshHistory = useCallback(() => {
    void mutateHistory().catch(() => undefined);
  }, [mutateHistory]);
  useBulkCampaignRealtime({ workspaceId, onChange: refreshHistory });

  const cancelCampaign = async (campaignId: string) => {
    if (pendingOperation) return;
    setPendingOperation({ campaignId, action: "cancel" });
    setOperationFeedback(null);

    try {
      const response = await fetch(
        `/api/campaigns/${encodeURIComponent(campaignId)}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        }
      );
      if (!response.ok) {
        const payload = await readJsonBody(response);
        if (!isLocallyCancelledPayload(payload)) {
          throw new Error(
            mutationErrorMessage(payload, t("operations.cancel.error"))
          );
        }
        setOperationFeedback({
          campaignId,
          tone: "warning",
          message: t("operations.cancel.localWarning"),
        });
        refreshHistory();
        return;
      }

      setOperationFeedback({
        campaignId,
        tone: "success",
        message: t("operations.cancel.success"),
      });
      refreshHistory();
    } catch (cancelError) {
      setOperationFeedback({
        campaignId,
        tone: "error",
        message:
          cancelError instanceof Error
            ? cancelError.message
            : t("operations.cancel.error"),
      });
    } finally {
      setPendingOperation(current =>
        current?.campaignId === campaignId && current.action === "cancel"
          ? null
          : current
      );
    }
  };

  const setCampaignPaused = async (campaignId: string, paused: boolean) => {
    if (pendingOperation) return;
    const action = paused ? "pause" : "resume";
    setPendingOperation({ campaignId, action });
    setOperationFeedback(null);

    try {
      const response = await fetch(
        `/api/campaigns/${encodeURIComponent(campaignId)}/pause`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, paused }),
        }
      );
      if (!response.ok) {
        throw new Error(
          mutationErrorMessage(
            await readJsonBody(response),
            paused
              ? t("operations.pause.error")
              : t("operations.pause.resumeError")
          )
        );
      }

      setOperationFeedback({
        campaignId,
        tone: "success",
        message: paused
          ? t("operations.pause.success")
          : t("operations.pause.resumeSuccess"),
      });
      refreshHistory();
    } catch (pauseError) {
      setOperationFeedback({
        campaignId,
        tone: "error",
        message:
          pauseError instanceof Error
            ? pauseError.message
            : paused
              ? t("operations.pause.error")
              : t("operations.pause.resumeError"),
      });
    } finally {
      setPendingOperation(current =>
        current?.campaignId === campaignId && current.action === action
          ? null
          : current
      );
    }
  };

  const retryCampaign = async (
    campaignId: string,
    operation: CampaignOperationStatusResponse
  ) => {
    if (
      pendingOperation ||
      !isTerminalBulkCampaignDispatchStatus(operation.status) ||
      !operation.retry.available
    ) {
      return;
    }
    const requiresAcknowledgement =
      operation.providerCircuit.requiresAcknowledgement;
    const providerCircuitAcknowledged = requiresAcknowledgement
      ? providerCircuitAcknowledgement?.campaignId === campaignId &&
        providerCircuitAcknowledgement.acknowledged
      : false;
    if (requiresAcknowledgement && !providerCircuitAcknowledged) return;

    setPendingOperation({ campaignId, action: "retry" });
    setOperationFeedback(null);

    try {
      const response = await fetch(
        `/api/campaigns/${encodeURIComponent(campaignId)}/retry`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            providerCircuitAcknowledged,
          }),
        }
      );
      if (!response.ok) {
        const payload = await readJsonBody(response);
        const cooldown = readRetryCooldown(payload);
        if (cooldown) {
          setRetryCooldown({ workspaceId, campaignId, cooldown });
          setOperationFeedback(null);
          return;
        }
        throw new Error(
          mutationErrorMessage(payload, t("operations.retry.error"))
        );
      }

      const payload = await readJsonBody(response);
      const skippedRecentContact =
        payload &&
        typeof payload === "object" &&
        "skippedRecentContact" in payload &&
        typeof payload.skippedRecentContact === "number"
          ? payload.skippedRecentContact
          : 0;
      setProviderCircuitAcknowledgement(null);
      setRetryCooldown(null);
      setOperationFeedback({
        campaignId,
        tone: "success",
        message:
          skippedRecentContact > 0
            ? t("operations.retry.successSkippedRecent", {
                count: skippedRecentContact,
              })
            : t("operations.retry.success"),
      });
      refreshHistory();
    } catch (retryError) {
      setOperationFeedback({
        campaignId,
        tone: "error",
        message:
          retryError instanceof Error
            ? retryError.message
            : t("operations.retry.error"),
      });
    } finally {
      setPendingOperation(current =>
        current?.campaignId === campaignId && current.action === "retry"
          ? null
          : current
      );
    }
  };

  if (loading) {
    return (
      <section>
        {focusNavigation}
        <div className="mb-4">
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section>
        {focusNavigation}
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </section>
    );
  }

  if (campaigns.length === 0) {
    return (
      <section className="py-10 text-center text-muted-foreground">
        {focusCampaignId ? (
          <>
            <p className="mb-3 text-sm">
              {analyticsT("historyTargetUnavailable")}
            </p>
            {onClearFocus ? (
              <Button
                variant="outline"
                size="sm"
                className="mb-4"
                onClick={handleReturnToAll}
              >
                {analyticsT("returnToAllCampaigns")}
              </Button>
            ) : null}
          </>
        ) : null}
        <p className="mb-1 text-base font-medium text-foreground">
          {t("empty.title")}
        </p>
        <p className="text-sm">{t("empty.description")}</p>
      </section>
    );
  }

  return (
    <section>
      {error ? (
        <Alert variant="destructive" className="mb-3">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{t("refreshError")}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold tracking-tight">
            {t("title")}
          </h2>
          {focusCampaignId && onClearFocus ? (
            <Button variant="outline" size="sm" onClick={handleReturnToAll}>
              {analyticsT("returnToAllCampaigns")}
            </Button>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">
          {t("campaignCount", { count: campaigns.length })}
        </span>
      </div>
      {campaigns.some(campaign => campaign.channel === "whatsapp") ? (
        <WhatsAppSpendSummary
          workspaceId={workspaceId}
          period={{ days: 30 }}
          className="mb-3"
        />
      ) : null}

      <div className="overflow-x-auto rounded-md border">
        <Table className="table-fixed min-w-[20rem]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[44%] md:w-[34%] lg:w-[30%]">
                {t("campaign")}
              </TableHead>
              <TableHead className="hidden w-[16%] md:table-cell lg:w-[14%]">
                {t("channel")}
              </TableHead>
              <TableHead className="w-[34%] md:w-[28%] lg:w-[25%]">
                {t("results")}
              </TableHead>
              <TableHead className="hidden lg:table-cell lg:w-[18%]">
                {t("sentAt")}
              </TableHead>
              <TableHead className="w-[22%] text-right md:w-[22%] lg:w-[13%]">
                {t("actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map(campaign => {
              const operation = campaign.operation;
              const deliveryFunnel = operation
                ? getCampaignDeliveryFunnel(operation.delivery)
                : null;
              const successRate = calculateRate(
                campaign.successful_sends,
                campaign.total_recipients
              );
              const failureSummary = campaign.failure_summary;
              const localFrequencyFailure = isContactFrequencyLimit(
                failureSummary?.topReason
              );
              const resultTotal =
                operation?.totalRecipients ?? campaign.total_recipients;
              const resultSuccessful =
                operation?.progress.successful ?? campaign.successful_sends;
              const resultFailed =
                operation?.progress.failed ?? campaign.failed_sends;
              const allFailed =
                resultTotal > 0 &&
                resultFailed >= resultTotal &&
                resultSuccessful === 0;
              const messages = campaign.messages ?? [];
              const detailsExpanded = expandedCampaignId === campaign.id;
              const messagePanelId = `campaign-${campaign.id}-messages`;
              const metricItems = buildCampaignMetricItems(campaign, t);
              const sender = campaignSender(campaign, t("unknown"));
              const canCancel = Boolean(
                operation?.canCancel &&
                  isActiveBulkCampaignDispatchStatus(operation.status)
              );
              const isPaused = Boolean(canCancel && operation?.paused);
              const canPause = Boolean(canCancel && !isPaused);
              const canResume = Boolean(canCancel && isPaused);
              const displayStatus = isPaused ? "paused" : operation?.status;
              const canRetry = Boolean(
                operation?.retry.available &&
                  isTerminalBulkCampaignDispatchStatus(operation.status)
              );
              const requiresProviderAcknowledgement = Boolean(
                canRetry && operation?.providerCircuit.requiresAcknowledgement
              );
              const providerCircuitAcknowledged = Boolean(
                providerCircuitAcknowledgement?.campaignId === campaign.id &&
                  providerCircuitAcknowledgement.acknowledged
              );
              const pendingAction =
                pendingOperation?.campaignId === campaign.id
                  ? pendingOperation.action
                  : null;
              const feedback =
                operationFeedback?.campaignId === campaign.id
                  ? operationFeedback
                  : null;
              const cooldown =
                retryCooldown?.workspaceId === workspaceId &&
                retryCooldown.campaignId === campaign.id
                  ? retryCooldown.cooldown
                  : null;
              const cooldownActive = Boolean(
                cooldown?.nextEligibleAt &&
                  Date.parse(cooldown.nextEligibleAt) > Date.now()
              );

              return (
                <Fragment key={campaign.id}>
                  <TableRow
                    id={`campaign-${campaign.id}-history`}
                    tabIndex={-1}
                    className={cn(
                      "align-top",
                      detailsExpanded && "bg-muted/20 hover:bg-muted/20"
                    )}
                  >
                    <TableCell className="whitespace-normal py-3 align-top">
                      <div className="min-w-0 space-y-1">
                        <div
                          className="truncate font-medium"
                          title={campaign.name}
                        >
                          {campaign.name}
                        </div>
                        {campaign.channel === "whatsapp" &&
                        campaign.template_name ? (
                          <div className="truncate text-xs text-muted-foreground">
                            {campaign.template_name}
                            {campaign.template_language
                              ? ` / ${campaign.template_language}`
                              : ""}
                          </div>
                        ) : campaign.channel === "email" &&
                          campaign.template_name ? (
                          <div className="truncate text-xs text-muted-foreground">
                            {campaign.template_name}
                          </div>
                        ) : campaign.message_text ? (
                          <div
                            className="line-clamp-2 text-xs text-muted-foreground"
                            title={campaign.message_text}
                          >
                            {formatMessagePreview(campaign.message_text)}
                          </div>
                        ) : null}

                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 text-xs text-muted-foreground">
                          <span className="lg:hidden">
                            {t("sentByValue", { name: sender })}
                          </span>
                          <span className="md:hidden">
                            {campaign.channel === "whatsapp"
                              ? t("whatsapp")
                              : campaign.channel === "telegram"
                                ? t("telegram")
                                : t("email")}
                          </span>
                          <span className="lg:hidden">
                            {formatMessageDate(campaign.sent_at)}
                          </span>
                        </div>
                      </div>
                    </TableCell>

                    <TableCell className="hidden py-3 align-top md:table-cell">
                      <Badge variant="outline" className="gap-1.5 font-normal">
                        {campaign.channel === "whatsapp" ? (
                          <MessageCircle
                            className="size-3.5"
                            aria-hidden="true"
                          />
                        ) : campaign.channel === "telegram" ? (
                          <Send className="size-3.5" aria-hidden="true" />
                        ) : (
                          <Mail className="size-3.5" aria-hidden="true" />
                        )}
                        {campaign.channel === "whatsapp"
                          ? t("whatsapp")
                          : campaign.channel === "telegram"
                            ? t("telegram")
                            : t("email")}
                      </Badge>
                    </TableCell>

                    <TableCell className="min-w-0 whitespace-normal py-3 align-top">
                      <div className="min-w-0 space-y-1.5">
                        {operation ? (
                          <>
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <Badge
                                variant="outline"
                                className={cn(
                                  "h-5 max-w-full truncate px-1.5 text-[10px] font-medium",
                                  operationStatusClassName(
                                    displayStatus || operation.status
                                  )
                                )}
                              >
                                {t(
                                  `operations.status.${displayStatus || operation.status}`
                                )}
                              </Badge>
                              <span className="text-[11px] tabular-nums text-muted-foreground">
                                {operation.progress.attempted} /{" "}
                                {operation.totalRecipients}
                              </span>
                            </div>

                            {/* Attempted, not processed: a stopped run also
                                processes the batch it skipped, and attempted
                                plus "not attempted" adds up to the total. */}
                            <Progress
                              value={campaignOperationProgressPercent({
                                processed: operation.progress.attempted,
                                total: operation.totalRecipients,
                              })}
                              className="h-1.5"
                              aria-label={t("operations.progress")}
                            />

                            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
                              <span>
                                {t("summary.accepted", {
                                  accepted: operation.progress.accepted,
                                  total: operation.totalRecipients,
                                })}
                              </span>
                              <dl className="flex gap-1">
                                <dt>{t("operations.delivery.delivered")}</dt>
                                <dd>{deliveryFunnel?.delivered ?? 0}</dd>
                              </dl>
                            </div>
                            {operation.delivery.failed > 0 &&
                            !failureSummary?.topReason &&
                            shouldSurfaceCampaignOutcomeAlerts(operation) ? (
                              <p className="text-xs text-red-700 dark:text-red-300">
                                {t("summary.failed", {
                                  count: operation.delivery.failed,
                                })}
                              </p>
                            ) : null}

                            {operation.progress.notAttempted > 0 &&
                            isActiveBulkCampaignDispatchStatus(
                              operation.status
                            ) ? (
                              <p className="truncate text-[10px] text-muted-foreground">
                                {t("operations.remaining", {
                                  count: operation.progress.notAttempted,
                                })}
                              </p>
                            ) : null}

                            {operation.progress.notAttempted > 0 &&
                            shouldSurfaceCampaignOutcomeAlerts(operation) ? (
                              <div className="flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                <AlertCircle
                                  className="size-3 shrink-0"
                                  aria-hidden="true"
                                />
                                <span className="truncate">
                                  {t("operations.notAttempted")}
                                </span>
                                <span className="tabular-nums">
                                  {operation.progress.notAttempted}
                                </span>
                              </div>
                            ) : null}

                            {requiresProviderAcknowledgement ? (
                              <div className="rounded-md border border-amber-200 bg-amber-50/80 px-2 py-1 text-[10px] leading-snug text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                                <div className="font-medium">
                                  {t("operations.retry.circuitWarning")}
                                </div>
                                <div className="mt-0.5 flex flex-wrap gap-x-2">
                                  <span>
                                    {t("operations.retry.provider")}{" "}
                                    <strong>
                                      {operation.providerCircuit.provider ||
                                        t("unknown")}
                                    </strong>
                                  </span>
                                  <span>
                                    {t("operations.retry.code")}{" "}
                                    <strong>
                                      {operation.providerCircuit.code ||
                                        t("unknown")}
                                    </strong>
                                  </span>
                                  <span>
                                    {t("operations.retry.failureCount")}{" "}
                                    <strong>
                                      {operation.providerCircuit.failureCount}
                                    </strong>
                                  </span>
                                </div>
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <>
                            <div className="flex items-center gap-1.5">
                              {campaign.failed_sends === 0 ? (
                                <CheckCircle2
                                  className="size-3.5 shrink-0 text-emerald-600"
                                  aria-hidden="true"
                                />
                              ) : allFailed ? (
                                <XCircle
                                  className="size-3.5 shrink-0 text-red-600"
                                  aria-hidden="true"
                                />
                              ) : (
                                <AlertCircle
                                  className="size-3.5 shrink-0 text-amber-600 dark:text-amber-300"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="text-xs font-medium tabular-nums">
                                {successRate.toFixed(1)}%
                              </span>
                            </div>
                            <div className="truncate text-[10px] text-muted-foreground">
                              {t("summary.accepted", {
                                accepted: campaign.successful_sends,
                                total: campaign.total_recipients,
                              })}
                            </div>
                            {campaign.failed_sends > 0 ? (
                              <div className="text-[10px] text-red-700 dark:text-red-300">
                                {t("summary.failed", {
                                  count: campaign.failed_sends,
                                })}
                              </div>
                            ) : null}
                          </>
                        )}
                        {failureSummary?.topReason &&
                        shouldSurfaceCampaignOutcomeAlerts(operation) ? (
                          <div
                            className={cn(
                              "flex min-w-0 items-start gap-1 text-[10px] leading-snug",
                              localFrequencyFailure
                                ? "text-amber-700 dark:text-amber-300"
                                : "text-red-700 dark:text-red-300"
                            )}
                          >
                            <AlertCircle
                              className="mt-0.5 size-3 shrink-0"
                              aria-hidden="true"
                            />
                            <div className="min-w-0">
                              <div className="font-medium">
                                {localFrequencyFailure
                                  ? t("failureSummary.localCooldown")
                                  : allFailed
                                    ? t("failureSummary.allFailed")
                                    : t("failureSummary.someFailed", {
                                        count: failureSummary.failedCount,
                                      })}
                              </div>
                              <div className="line-clamp-2 break-words">
                                {localFrequencyFailure
                                  ? t("failureSummary.localCooldownDescription")
                                  : failureSummary.topReason}
                              </div>
                              {failureSummary.topErrorCode ? (
                                <div className="mt-0.5">
                                  {t("failureSummary.errorCode")}{" "}
                                  <span>{failureSummary.topErrorCode}</span>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </TableCell>

                    <TableCell className="hidden py-3 align-top lg:table-cell">
                      <div className="text-sm">
                        {formatMessageDate(campaign.sent_at)}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {sender}
                      </div>
                    </TableCell>

                    <TableCell className="whitespace-normal py-3 align-top">
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {canPause ? (
                            <HistoryIconButton
                              label={
                                pendingAction === "pause"
                                  ? t("operations.pause.pending")
                                  : t("operations.pause.action")
                              }
                              disabled={Boolean(pendingOperation)}
                              onClick={() =>
                                void setCampaignPaused(campaign.id, true)
                              }
                            >
                              {pendingAction === "pause" ? (
                                <Loader2
                                  className="size-3.5 animate-spin"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Pause
                                  className="size-3.5"
                                  aria-hidden="true"
                                />
                              )}
                            </HistoryIconButton>
                          ) : null}
                          {canResume ? (
                            <HistoryIconButton
                              label={
                                pendingAction === "resume"
                                  ? t("operations.pause.resuming")
                                  : t("operations.pause.resume")
                              }
                              disabled={Boolean(pendingOperation)}
                              onClick={() =>
                                void setCampaignPaused(campaign.id, false)
                              }
                            >
                              {pendingAction === "resume" ? (
                                <Loader2
                                  className="size-3.5 animate-spin"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Play className="size-3.5" aria-hidden="true" />
                              )}
                            </HistoryIconButton>
                          ) : null}
                          {canCancel ? (
                            <HistoryIconButton
                              label={
                                pendingAction === "cancel"
                                  ? t("operations.cancel.pending")
                                  : t("operations.cancel.action")
                              }
                              disabled={Boolean(pendingOperation)}
                              onClick={() => void cancelCampaign(campaign.id)}
                            >
                              {pendingAction === "cancel" ? (
                                <Loader2
                                  className="size-3.5 animate-spin"
                                  aria-hidden="true"
                                />
                              ) : (
                                <XCircle
                                  className="size-3.5"
                                  aria-hidden="true"
                                />
                              )}
                            </HistoryIconButton>
                          ) : null}
                          {operation && canRetry ? (
                            <HistoryIconButton
                              label={
                                pendingAction === "retry"
                                  ? t("operations.retry.pending")
                                  : t("operations.retry.action", {
                                      count:
                                        operation.retry.failedRecipientCount,
                                    })
                              }
                              disabled={
                                Boolean(pendingOperation) ||
                                cooldownActive ||
                                (requiresProviderAcknowledgement &&
                                  !providerCircuitAcknowledged)
                              }
                              onClick={() =>
                                void retryCampaign(campaign.id, operation)
                              }
                            >
                              {pendingAction === "retry" ? (
                                <Loader2
                                  className="size-3.5 animate-spin"
                                  aria-hidden="true"
                                />
                              ) : (
                                <RotateCcw
                                  className="size-3.5"
                                  aria-hidden="true"
                                />
                              )}
                            </HistoryIconButton>
                          ) : null}
                          {campaign.channel === "whatsapp" &&
                          onViewAnalytics ? (
                            <HistoryIconButton
                              label={t("viewAnalytics")}
                              variant="ghost"
                              onClick={() => onViewAnalytics(campaign.id)}
                            >
                              <BarChart3
                                className="size-3.5"
                                aria-hidden="true"
                              />
                            </HistoryIconButton>
                          ) : null}
                          <Button
                            type="button"
                            variant={detailsExpanded ? "secondary" : "ghost"}
                            size="icon"
                            className="size-7 shrink-0"
                            aria-expanded={detailsExpanded}
                            aria-controls={messagePanelId}
                            aria-label={
                              detailsExpanded
                                ? t("details.hideDeliveryDetails")
                                : t("details.showDeliveryDetails", {
                                    count: messages.length,
                                  })
                            }
                            title={
                              detailsExpanded
                                ? t("details.hide")
                                : t("details.show", { count: messages.length })
                            }
                            onClick={() =>
                              setExpandedCampaignId(
                                detailsExpanded ? null : campaign.id
                              )
                            }
                          >
                            <ChevronDown
                              className={cn(
                                "size-3.5 transition-transform",
                                detailsExpanded && "rotate-180"
                              )}
                              aria-hidden="true"
                            />
                          </Button>
                        </div>

                        {requiresProviderAcknowledgement ? (
                          <label className="flex max-w-48 items-start justify-end gap-1.5 text-right text-[11px] leading-snug text-amber-800 dark:text-amber-200">
                            <input
                              type="checkbox"
                              className="mt-0.5 size-3.5 shrink-0 accent-current"
                              checked={providerCircuitAcknowledged}
                              disabled={Boolean(pendingOperation)}
                              onChange={event =>
                                setProviderCircuitAcknowledgement({
                                  campaignId: campaign.id,
                                  acknowledged: event.currentTarget.checked,
                                })
                              }
                            />
                            <span>
                              {t("operations.retry.acknowledgeCircuit")}
                            </span>
                          </label>
                        ) : null}

                        {feedback ? (
                          <p
                            role={
                              feedback.tone === "error" ? "alert" : "status"
                            }
                            className={cn(
                              "max-w-56 text-right text-[11px] leading-snug",
                              feedback.tone === "success" &&
                                "text-emerald-700 dark:text-emerald-300",
                              feedback.tone === "warning" &&
                                "text-amber-700 dark:text-amber-300",
                              feedback.tone === "error" &&
                                "text-red-700 dark:text-red-300"
                            )}
                          >
                            {feedback.message}
                          </p>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>

                  {cooldown ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={5}
                        className="whitespace-normal px-3 py-2"
                      >
                        <p
                          role="status"
                          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
                        >
                          {cooldown.nextEligibleAt
                            ? t("operations.retry.cooldown", {
                                count: cooldown.blockedRecipientCount,
                                date: format.dateTime(
                                  new Date(cooldown.nextEligibleAt),
                                  { dateStyle: "medium", timeStyle: "short" }
                                ),
                              })
                            : t("operations.retry.cooldownUnknown", {
                                count: cooldown.blockedRecipientCount,
                              })}
                        </p>
                      </TableCell>
                    </TableRow>
                  ) : null}

                  {detailsExpanded ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={5} className="whitespace-normal p-0">
                        <div
                          id={messagePanelId}
                          className="space-y-4 border-t bg-muted/10 px-4 py-4 sm:px-5"
                        >
                          <div>
                            <h3 className="text-sm font-semibold">
                              {t("details.title")}
                            </h3>
                          </div>

                          {operation ? (
                            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs text-muted-foreground sm:grid-cols-5">
                              {(
                                [
                                  ["accepted", deliveryFunnel?.accepted ?? 0],
                                  ["delivered", deliveryFunnel?.delivered ?? 0],
                                  ["read", deliveryFunnel?.read ?? 0],
                                  ["failed", operation.delivery.failed],
                                  ["pending", operation.delivery.pending],
                                ] as const
                              ).map(([key, value]) => {
                                const failedOutcome =
                                  key === "failed" &&
                                  value > 0 &&
                                  shouldSurfaceCampaignOutcomeAlerts(operation);
                                return (
                                  <div
                                    key={key}
                                    className="flex min-w-0 items-baseline justify-between gap-1"
                                  >
                                    <dt className="truncate">
                                      {t(`operations.delivery.${key}`)}
                                    </dt>
                                    <dd
                                      className={cn(
                                        "font-medium tabular-nums",
                                        failedOutcome
                                          ? "text-red-700 dark:text-red-300"
                                          : "text-foreground"
                                      )}
                                    >
                                      {value}
                                    </dd>
                                  </div>
                                );
                              })}
                            </dl>
                          ) : null}

                          <dl className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-3 xl:grid-cols-6">
                            {metricItems.map(metric => (
                              <div
                                key={metric.key}
                                className="min-w-0 bg-background px-3 py-2.5"
                              >
                                <dt className="truncate text-xs text-muted-foreground">
                                  {t(`details.metrics.${metric.key}`)}
                                </dt>
                                <dd
                                  className={cn(
                                    "mt-1 truncate text-sm font-semibold tabular-nums",
                                    metric.tone === "success" &&
                                      "text-emerald-700 dark:text-emerald-300",
                                    metric.tone === "danger" &&
                                      "text-red-700 dark:text-red-300"
                                  )}
                                >
                                  {metric.value}
                                </dd>
                                {metric.detail ? (
                                  <dd className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                                    {metric.detail}
                                  </dd>
                                ) : null}
                              </div>
                            ))}
                          </dl>
                          {campaign.channel === "whatsapp" &&
                          isCampaignCostUnpriced(campaign) ? (
                            <p className="text-xs leading-relaxed text-muted-foreground">
                              {t("costStatus.explanation")}
                            </p>
                          ) : null}

                          <div>
                            <div className="flex items-center justify-between gap-3">
                              <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                                {t("details.recipientEvents")}
                              </h4>
                              <Badge
                                variant="secondary"
                                className="tabular-nums"
                              >
                                {messages.length}
                              </Badge>
                            </div>

                            {messages.length > 0 ? (
                              <div className="mt-2 overflow-hidden rounded-md border bg-background">
                                <div className="hidden grid-cols-[minmax(0,1.3fr)_120px_100px_minmax(140px,0.8fr)] gap-3 bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground md:grid">
                                  <span>{t("details.recipient")}</span>
                                  <span>{t("details.status")}</span>
                                  <span>{t("details.provider")}</span>
                                  <span>{t("details.updated")}</span>
                                </div>
                                <div className="divide-y">
                                  {messages.map((message, index) => {
                                    const messageError =
                                      message.error_message ||
                                      message.failure_reason;
                                    const localSuppression =
                                      isContactFrequencyLimit(
                                        message.error_message
                                      ) ||
                                      isContactFrequencyLimit(
                                        message.failure_reason
                                      );
                                    return (
                                      <div
                                        key={message.id || index}
                                        className="grid gap-3 px-3 py-3 md:grid-cols-[minmax(0,1.3fr)_120px_100px_minmax(140px,0.8fr)] md:items-start"
                                      >
                                        <div className="min-w-0">
                                          <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground md:hidden">
                                            {t("details.recipient")}
                                          </div>
                                          <div className="break-all font-mono text-xs">
                                            {message.recipient ||
                                              message.phone ||
                                              "-"}
                                          </div>
                                        </div>
                                        <div>
                                          <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground md:hidden">
                                            {t("details.status")}
                                          </div>
                                          <Badge
                                            variant="outline"
                                            className={
                                              localSuppression
                                                ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
                                                : messageStatusClassName(
                                                    message.status
                                                  )
                                            }
                                          >
                                            {localSuppression
                                              ? t("details.localSuppression")
                                              : formatMessageStatus(
                                                  message.status
                                                )}
                                          </Badge>
                                        </div>
                                        <div className="min-w-0">
                                          <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground md:hidden">
                                            {t("details.provider")}
                                          </div>
                                          <div className="truncate text-sm">
                                            {localSuppression
                                              ? "airi.chat"
                                              : message.provider || "-"}
                                          </div>
                                        </div>
                                        <div>
                                          <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground md:hidden">
                                            {t("details.updated")}
                                          </div>
                                          <div className="text-xs text-muted-foreground">
                                            {formatMessageDate(
                                              resolveMessageUpdatedAt(message)
                                            )}
                                          </div>
                                        </div>
                                        {messageError ? (
                                          <div
                                            className={cn(
                                              "break-words rounded-md px-2.5 py-2 text-xs md:col-span-4",
                                              localSuppression
                                                ? "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-100"
                                                : "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-200"
                                            )}
                                          >
                                            <span className="mr-1 font-medium">
                                              {t("details.details")}
                                              {message.error_code
                                                ? ` ${message.error_code}:`
                                                : ":"}
                                            </span>
                                            <span>
                                              {localSuppression
                                                ? t(
                                                    "failureSummary.localCooldownDescription"
                                                  )
                                                : messageError}
                                            </span>
                                          </div>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            ) : (
                              <div className="mt-2 rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                                {t("details.noneAvailable")}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
