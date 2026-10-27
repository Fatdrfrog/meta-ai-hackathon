"use client";

import type { WorkspaceIntegrationsData } from "@/types/integrations";
import useSWR from "swr";

const fetcher = async (url: string): Promise<WorkspaceIntegrationsData> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch integrations");
  return res.json();
};

export function useIntegrations(workspaceId: string) {
  const { data, error, isLoading, mutate } = useSWR<WorkspaceIntegrationsData>(
    `/api/workspaces/${workspaceId}/integrations`,
    fetcher,
    {
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      refreshInterval: 5000,
      refreshWhenHidden: false,
      focusThrottleInterval: 1000,
      dedupingInterval: 1000,
    }
  );

  return {
    sources: data?.sources ?? [],
    removedWhatsAppSource: data?.removedWhatsAppSource ?? null,
    emailSources: data?.emailSources ?? [],
    emailIntegrationEnabled: data?.emailIntegrationEnabled ?? false,
    emailProviderStatus: data?.emailProviderStatus ?? "disconnected",
    emailProviderConnected: data?.emailProviderConnected ?? false,
    hasCompanyWhatsAppInventory: data?.hasCompanyWhatsAppInventory ?? false,
    isLoading,
    isError: error,
    mutate, // For optimistic updates
  };
}
