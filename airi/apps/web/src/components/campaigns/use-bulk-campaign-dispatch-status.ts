"use client";

import {
  isActiveBulkCampaignDispatchStatus,
  type CampaignCancellationResponse,
  type CampaignOperationStatusResponse,
  type CampaignPauseResponse,
} from "@/lib/campaign/campaign-operations-contracts";
import type { BulkCampaignDispatchStatus } from "@/lib/campaign/bulk-campaign-contracts";
import { useRealtime } from "@/hooks/use-realtime";
import type { RealtimeEventEnvelope } from "@icecore/shared/types/realtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { type SWRConfiguration } from "swr";

export const BULK_CAMPAIGN_STATUS_POLL_INTERVAL_MS = 2_000;
export const BULK_CAMPAIGN_DELIVERY_POLL_INTERVAL_MS = 30_000;
export const BULK_CAMPAIGN_REALTIME_DEBOUNCE_MS = 500;

export function shouldRetryCampaignStatusError(error: unknown) {
  const status =
    error && typeof error === "object" && "status" in error
      ? error.status
      : undefined;
  return (
    typeof status !== "number" ||
    status < 400 ||
    status >= 500 ||
    status === 408 ||
    status === 425 ||
    status === 429
  );
}

export const retryCampaignStatusError: NonNullable<
  SWRConfiguration["onErrorRetry"]
> = (error, _key, config, revalidate, options) => {
  if (!shouldRetryCampaignStatusError(error)) return;
  const delay = Math.min(
    BULK_CAMPAIGN_DELIVERY_POLL_INTERVAL_MS,
    5_000 * 2 ** Math.min(Math.max(options.retryCount - 1, 0), 3)
  );
  // SWR's supplied revalidator resolves only live subscribers for this cache key.
  // Hidden/offline views resume through the existing focus/reconnect handlers.
  setTimeout(() => {
    if (config.isVisible() && config.isOnline()) revalidate(options);
  }, delay);
};

// One workspace subscription serves the history page. The detail consumer may
// filter this same channel by campaign ID; useRealtime shares its connection.
export function useBulkCampaignRealtime(params: {
  workspaceId: string;
  campaignId?: string;
  onChange: () => void;
}) {
  const { workspaceId, campaignId, onChange } = params;
  const scope = useMemo(
    () => (workspaceId ? { kind: "workspace" as const, workspaceId } : null),
    [workspaceId]
  );
  const { channel, isConnected } = useRealtime(scope);
  const previousConnection = useRef({ workspaceId, isConnected });

  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = { workspaceId, isConnected };
    if (
      isConnected &&
      (!previous.isConnected || previous.workspaceId !== workspaceId)
    ) {
      onChange();
    }
  }, [workspaceId, isConnected, onChange]);

  useEffect(() => {
    if (!channel) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = (event: RealtimeEventEnvelope) => {
      if (
        event.workspaceId !== workspaceId ||
        (campaignId && event.payload.campaignId !== campaignId) ||
        timer
      )
        return;
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, BULK_CAMPAIGN_REALTIME_DEBOUNCE_MS);
    };
    channel.bind("campaign.delivery.changed", refresh);
    return () => {
      channel.unbind("campaign.delivery.changed", refresh);
      if (timer) clearTimeout(timer);
    };
  }, [channel, workspaceId, campaignId, onChange]);
}

export function getBulkCampaignStatusRefreshInterval(
  status: BulkCampaignDispatchStatus | null | undefined,
  pollIntervalMs = BULK_CAMPAIGN_STATUS_POLL_INTERVAL_MS
) {
  return isActiveBulkCampaignDispatchStatus(status)
    ? pollIntervalMs
    : status
      ? BULK_CAMPAIGN_DELIVERY_POLL_INTERVAL_MS
      : 0;
}

function optimisticPauseOperation(params: {
  campaignId: string;
  status: BulkCampaignDispatchStatus;
  paused: boolean;
}): CampaignOperationStatusResponse {
  return {
    campaignId: params.campaignId,
    status: params.status,
    requestedAt: null,
    scheduledAt: null,
    dispatchExpiresAt: null,
    startedAt: null,
    progressAt: null,
    finishedAt: null,
    cancelledAt: null,
    expiredAt: null,
    totalRecipients: 0,
    progress: {
      processed: 0,
      accepted: 0,
      attempted: 0,
      notAttempted: 0,
      successful: 0,
      failed: 0,
    },
    delivery: {
      pending: 0,
      accepted: 0,
      delivered: 0,
      read: 0,
      failed: 0,
    },
    stopReason: params.paused ? "paused_by_operator" : null,
    providerCircuit: {
      state: "closed",
      provider: null,
      code: null,
      openedAt: null,
      failureCount: 0,
      requiresAcknowledgement: false,
    },
    retry: {
      ofCampaignId: null,
      kind: null,
      failedRecipientCount: 0,
      available: false,
    },
    canCancel: true,
    paused: params.paused,
  };
}

async function readJsonBody<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

async function fetchCampaignOperationStatus(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const payload = await readJsonBody<
      CampaignOperationStatusResponse & { error?: string }
    >(response);
    throw Object.assign(
      new Error(
        payload?.error || "Campaign status is temporarily unavailable."
      ),
      { status: response.status }
    );
  }
  const payload = await readJsonBody<
    CampaignOperationStatusResponse & { error?: string }
  >(response);
  if (!payload) {
    throw new Error("Campaign status is temporarily unavailable.");
  }
  return payload;
}

export function useBulkCampaignDispatchStatus(params: {
  workspaceId?: string | null;
  campaignId?: string | null;
  initialStatus?: BulkCampaignDispatchStatus | null;
  pollIntervalMs?: number;
}) {
  const campaignId = params.campaignId?.trim() || "";
  const workspaceId = params.workspaceId?.trim() || "";
  const requestKey =
    campaignId && workspaceId
      ? `/api/campaigns/${encodeURIComponent(
          campaignId
        )}/status?workspaceId=${encodeURIComponent(workspaceId)}`
      : null;
  const [locallyCancelledKey, setLocallyCancelledKey] = useState<string | null>(
    null
  );
  const [cancelFailure, setCancelFailure] = useState<{
    requestKey: string;
    message: string;
  } | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [localPause, setLocalPause] = useState<{
    requestKey: string;
    paused: boolean;
  } | null>(null);
  const [pauseFailure, setPauseFailure] = useState<{
    requestKey: string;
    message: string;
  } | null>(null);
  const [isUpdatingPause, setIsUpdatingPause] = useState(false);
  const shouldLoad = requestKey !== null && Boolean(params.initialStatus);

  const swr = useSWR<CampaignOperationStatusResponse>(
    shouldLoad ? requestKey : null,
    fetchCampaignOperationStatus,
    {
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      shouldRetryOnError: shouldRetryCampaignStatusError,
      onErrorRetry: retryCampaignStatusError,
      refreshInterval: latest =>
        getBulkCampaignStatusRefreshInterval(
          latest?.status ?? params.initialStatus,
          params.pollIntervalMs
        ),
    }
  );
  const mutate = swr.mutate;
  const refreshStatus = useCallback(() => {
    void mutate().catch(() => undefined);
  }, [mutate]);
  useBulkCampaignRealtime({
    workspaceId: shouldLoad ? workspaceId : "",
    campaignId,
    onChange: refreshStatus,
  });

  const locallyCancelled = Boolean(
    requestKey && locallyCancelledKey === requestKey
  );
  const locallyPaused =
    requestKey && localPause?.requestKey === requestKey
      ? localPause.paused
      : null;
  if (
    localPause &&
    requestKey === localPause.requestKey &&
    swr.data &&
    (swr.data.paused === localPause.paused ||
      !isActiveBulkCampaignDispatchStatus(swr.data.status))
  ) {
    setLocalPause(null);
  }
  const operation =
    locallyCancelled && swr.data
      ? {
          ...swr.data,
          status: "cancelled" as const,
          canCancel: false,
          paused: false,
        }
      : swr.data
        ? {
            ...swr.data,
            paused: locallyPaused ?? swr.data.paused,
          }
        : locallyPaused !== null &&
            campaignId &&
            params.initialStatus &&
            isActiveBulkCampaignDispatchStatus(params.initialStatus)
          ? optimisticPauseOperation({
              campaignId,
              status: params.initialStatus,
              paused: locallyPaused,
            })
          : null;
  const status = locallyCancelled
    ? ("cancelled" as const)
    : (operation?.status ?? params.initialStatus ?? null);

  const cancel = useCallback(async () => {
    if (
      !requestKey ||
      !campaignId ||
      !workspaceId ||
      !isActiveBulkCampaignDispatchStatus(status) ||
      isCancelling
    ) {
      return false;
    }

    setIsCancelling(true);
    setCancelFailure(null);
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
        const payload = await readJsonBody<
          Partial<CampaignCancellationResponse> & {
            error?: string;
            status?: BulkCampaignDispatchStatus;
          }
        >(response);
        const locallyCancelledResponse = payload?.status === "cancelled";

        if (locallyCancelledResponse) {
          setLocallyCancelledKey(requestKey);
          void mutate().catch(() => undefined);
        }
        setCancelFailure({
          requestKey,
          message: payload?.error || "Failed to cancel campaign.",
        });
        return locallyCancelledResponse;
      }

      const payload = await readJsonBody<
        Partial<CampaignCancellationResponse> & {
          status?: BulkCampaignDispatchStatus;
        }
      >(response);
      if (payload?.status === "cancelled") {
        setLocallyCancelledKey(requestKey);
        void mutate().catch(() => undefined);
      }

      return true;
    } catch (error) {
      setCancelFailure({
        requestKey,
        message:
          error instanceof Error ? error.message : "Failed to cancel campaign.",
      });
      return false;
    } finally {
      setIsCancelling(false);
    }
  }, [campaignId, isCancelling, requestKey, status, mutate, workspaceId]);

  const setPaused = useCallback(
    async (paused: boolean) => {
      if (
        !requestKey ||
        !campaignId ||
        !workspaceId ||
        !isActiveBulkCampaignDispatchStatus(status) ||
        isCancelling ||
        isUpdatingPause
      ) {
        return false;
      }

      setIsUpdatingPause(true);
      setPauseFailure(null);
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
          const payload = await readJsonBody<
            Partial<CampaignPauseResponse> & { error?: string }
          >(response);
          setPauseFailure({
            requestKey,
            message: payload?.error || "Failed to update campaign pause.",
          });
          return false;
        }
        setLocalPause({ requestKey, paused });
        try {
          await mutate();
        } catch {
          // Keep the local pause until the next successful status refresh.
        }
        return true;
      } catch (error) {
        setPauseFailure({
          requestKey,
          message:
            error instanceof Error
              ? error.message
              : "Failed to update campaign pause.",
        });
        return false;
      } finally {
        setIsUpdatingPause(false);
      }
    },
    [
      campaignId,
      isCancelling,
      isUpdatingPause,
      mutate,
      requestKey,
      status,
      workspaceId,
    ]
  );
  const pollingError = swr.error instanceof Error ? swr.error : null;

  return {
    operation,
    status,
    error: pollingError,
    isLoading: swr.isLoading,
    isPolling: Boolean(
      shouldLoad && !pollingError && isActiveBulkCampaignDispatchStatus(status)
    ),
    cancel,
    cancelError:
      requestKey && cancelFailure?.requestKey === requestKey
        ? cancelFailure.message
        : null,
    isCancelling,
    setPaused,
    pauseError:
      requestKey && pauseFailure?.requestKey === requestKey
        ? pauseFailure.message
        : null,
    isUpdatingPause,
    mutate,
  };
}
