"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getCampaignDeliveryFunnel,
  isActiveBulkCampaignDispatchStatus,
  type CampaignOperationStatusResponse,
} from "@/lib/campaign/campaign-operations-contracts";
import type { BulkCampaignDispatchStatus } from "@/lib/campaign/bulk-campaign-contracts";
import { AlertTriangle, Loader2, Pause, Play, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { useBulkCampaignDispatchStatus } from "./use-bulk-campaign-dispatch-status";

export type CampaignDispatchLiveStatusLabels = {
  lifecycleStatus: (status: BulkCampaignDispatchStatus) => string;
  /** Messages handed to the provider; a stopped run leaves the rest unsent. */
  attempted: (attempted: number, total: number) => string;
  accepted: (count: number) => string;
  delivered: (count: number) => string;
  read: (count: number) => string;
  failed: (count: number) => string;
  cancel: string;
  cancelling: string;
  pause: string;
  pausing: string;
  resume: string;
  resuming: string;
  paused: string;
  statusUnavailable: (message: string) => string;
  cancelFailed: (message: string) => string;
  pauseFailed: (message: string) => string;
};

export type CampaignDispatchLiveStatusProps = {
  workspaceId?: string | null;
  campaignId?: string | null;
  initialStatus?: BulkCampaignDispatchStatus | null;
  labels: CampaignDispatchLiveStatusLabels;
  compact?: boolean;
  onLifecycleChange?: (
    status: BulkCampaignDispatchStatus,
    operation: CampaignOperationStatusResponse | null
  ) => void;
};

export function CampaignDispatchLiveStatus(
  props: CampaignDispatchLiveStatusProps
) {
  const {
    operation,
    status,
    error,
    isPolling,
    cancel,
    cancelError,
    isCancelling,
    setPaused,
    pauseError,
    isUpdatingPause,
  } = useBulkCampaignDispatchStatus({
    workspaceId: props.workspaceId,
    campaignId: props.campaignId,
    initialStatus: props.initialStatus,
  });
  const dispatchKey = `${props.workspaceId || ""}:${props.campaignId || ""}`;
  const initialStatus = props.initialStatus ?? null;
  const onLifecycleChange = props.onLifecycleChange;
  const reportedLifecycleRef = useRef<{
    dispatchKey: string;
    status: BulkCampaignDispatchStatus | null;
  }>({
    dispatchKey,
    status: initialStatus,
  });

  useEffect(() => {
    if (reportedLifecycleRef.current.dispatchKey !== dispatchKey) {
      reportedLifecycleRef.current = {
        dispatchKey,
        status: initialStatus,
      };
    }
    if (!status || reportedLifecycleRef.current.status === status) {
      return;
    }

    reportedLifecycleRef.current.status = status;
    onLifecycleChange?.(status, operation);
  }, [dispatchKey, initialStatus, onLifecycleChange, operation, status]);

  if (!props.campaignId || !status) return null;

  const canCancel =
    isActiveBulkCampaignDispatchStatus(status) &&
    (operation?.canCancel ?? true);
  const isPaused = Boolean(canCancel && operation?.paused);
  const deliveryFunnel = operation
    ? getCampaignDeliveryFunnel(operation.delivery)
    : null;
  const metricClassName = props.compact
    ? "grid grid-cols-2 gap-1 text-[10px]"
    : "grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-5";
  const metricItemClassName = props.compact
    ? "rounded bg-muted px-1 py-1 text-center"
    : "rounded-md bg-muted/30 px-3 py-2";

  return (
    <div className="space-y-2" data-campaign-dispatch-status={status}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={props.compact ? "text-[10px]" : ""}>
          {isPaused
            ? props.labels.paused
            : props.labels.lifecycleStatus(status)}
        </Badge>
        {isPolling ? (
          <Loader2
            aria-label={
              isPaused ? props.labels.paused : props.labels.lifecycleStatus(status)
            }
            className="h-3.5 w-3.5 animate-spin text-muted-foreground"
          />
        ) : null}
        {canCancel && !isPaused ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={props.compact ? "h-7 px-2 text-[10px]" : ""}
            disabled={isCancelling || isUpdatingPause}
            onClick={() => void setPaused(true)}
          >
            {isUpdatingPause ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Pause className="mr-1.5 h-3.5 w-3.5" />
            )}
            {isUpdatingPause ? props.labels.pausing : props.labels.pause}
          </Button>
        ) : null}
        {canCancel && isPaused ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={props.compact ? "h-7 px-2 text-[10px]" : ""}
            disabled={isCancelling || isUpdatingPause}
            onClick={() => void setPaused(false)}
          >
            {isUpdatingPause ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-3.5 w-3.5" />
            )}
            {isUpdatingPause ? props.labels.resuming : props.labels.resume}
          </Button>
        ) : null}
        {canCancel ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={props.compact ? "h-7 px-2 text-[10px]" : ""}
            disabled={isCancelling || isUpdatingPause}
            onClick={() => void cancel()}
          >
            {isCancelling ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <XCircle className="mr-1.5 h-3.5 w-3.5" />
            )}
            {isCancelling ? props.labels.cancelling : props.labels.cancel}
          </Button>
        ) : null}
      </div>

      {operation && deliveryFunnel ? (
        <div className={metricClassName}>
          <div className={metricItemClassName}>
            {props.labels.attempted(
              operation.progress.attempted,
              operation.totalRecipients
            )}
          </div>
          <div className={metricItemClassName}>
            {props.labels.accepted(deliveryFunnel.accepted)}
          </div>
          <div className={metricItemClassName}>
            {props.labels.delivered(deliveryFunnel.delivered)}
          </div>
          <div className={metricItemClassName}>
            {props.labels.read(deliveryFunnel.read)}
          </div>
          <div className={metricItemClassName}>
            {props.labels.failed(operation.delivery.failed)}
          </div>
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {props.labels.statusUnavailable(error.message)}
          </AlertDescription>
        </Alert>
      ) : null}
      {cancelError ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {props.labels.cancelFailed(cancelError)}
          </AlertDescription>
        </Alert>
      ) : null}
      {pauseError ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {props.labels.pauseFailed(pauseError)}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function CampaignDispatchPlanLiveStatus(
  props: Omit<CampaignDispatchLiveStatusProps, "labels">
) {
  const t = useTranslations("MultiChannelCampaignBuilder");
  const tPlan = useTranslations("CampaignDispatchPlanCard");
  const labels: CampaignDispatchLiveStatusLabels = {
    lifecycleStatus: status =>
      t("dispatchLifecycleStatus", {
        status: tPlan("lifecycleStatus", { status }),
      }),
    attempted: (attempted, total) =>
      t("dispatchAttempted", { attempted, total }),
    accepted: count => t("dispatchAccepted", { count }),
    delivered: count => t("dispatchDelivered", { count }),
    read: count => t("dispatchRead", { count }),
    failed: count => t("dispatchFailed", { count }),
    cancel: t("cancelDispatch"),
    cancelling: t("cancellingDispatch"),
    pause: t("pauseDispatch"),
    pausing: t("pausingDispatch"),
    resume: t("resumeDispatch"),
    resuming: t("resumingDispatch"),
    paused: t("pausedDispatch"),
    statusUnavailable: message => t("dispatchStatusUnavailable", { message }),
    cancelFailed: message => t("dispatchCancelFailed", { message }),
    pauseFailed: message => t("dispatchPauseFailed", { message }),
  };

  return <CampaignDispatchLiveStatus {...props} labels={labels} />;
}
