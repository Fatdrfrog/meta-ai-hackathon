"use client";

import useSWR, { useSWRConfig } from "swr";
import { useCallback } from "react";
import {
  buildBulkCampaignBatchPlanUrl,
  bulkCampaignCheckSWROptions,
  bulkCampaignJsonFetcher,
} from "./bulk-campaign-client";
import type {
  BulkCampaignBatchPlanPreviewResponse,
  BulkCampaignChannel,
} from "./bulk-campaign-contracts";

export type BulkCampaignBatchPlanPreviewState = {
  preview: BulkCampaignBatchPlanPreviewResponse | null;
  error: Error | undefined;
  isLoading: boolean;
  isRefreshing: boolean;
  refresh: () => void;
};

export function useBulkCampaignBatchPlanPreview(params: {
  workspaceId: string;
  channel: BulkCampaignChannel;
  sourceId?: string;
  enabled?: boolean;
}): BulkCampaignBatchPlanPreviewState {
  const enabled = params.enabled ?? true;
  const url =
    enabled && params.workspaceId
      ? buildBulkCampaignBatchPlanUrl({
          workspaceId: params.workspaceId,
          channel: params.channel,
          sourceId: params.sourceId,
        })
      : null;

  const { cache } = useSWRConfig();
  // Each check costs Meta reads on the WhatsApp account; refresh() re-checks.
  const { data, error, isLoading, isValidating, mutate } =
    useSWR<BulkCampaignBatchPlanPreviewResponse>(
      url,
      bulkCampaignJsonFetcher,
      bulkCampaignCheckSWROptions(url ? cache.get(url)?.error : undefined)
    );
  const refresh = useCallback(() => {
    void mutate().catch(() => undefined);
  }, [mutate]);
  const preview: BulkCampaignBatchPlanPreviewResponse | null =
    data ??
    (error
      ? {
          configured: false,
          channel: params.channel,
          error: error.message,
        }
      : null);

  return {
    preview,
    error: error as Error | undefined,
    isLoading,
    isRefreshing: isValidating,
    refresh,
  };
}
