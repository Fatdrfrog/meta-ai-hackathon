"use client";

import type { KBArticleAdmin } from "@/components/kb/kb-types";
import useSWR from "swr";

interface KBTreeData {
  articles: KBArticleAdmin[];
}

const fetcher = async (url: string): Promise<KBTreeData> => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Failed to fetch KB data");
  }
  return res.json();
};

interface UseKBArticlesOptions {
  revalidateOnFocus?: boolean;
  refreshInterval?: number;
  locale?: string | null;
}

export function useKBArticles(
  workspaceId: string,
  options?: UseKBArticlesOptions
) {
  const { revalidateOnFocus = false, refreshInterval = 0, locale } = options || {};
  const treeUrl = workspaceId
    ? locale?.trim()
      ? `/api/workspaces/${workspaceId}/kb/tree?locale=${encodeURIComponent(locale.trim())}`
      : `/api/workspaces/${workspaceId}/kb/tree`
    : null;

  const { data, error, isLoading, isValidating, mutate } = useSWR<KBTreeData>(
    treeUrl,
    fetcher,
    {
      revalidateOnFocus,
      revalidateOnReconnect: false,
      dedupingInterval: 0,
      refreshInterval,
      errorRetryCount: 2,
      errorRetryInterval: 1000,
      revalidateIfStale: true,
    }
  );

  return {
    articles: data?.articles ?? [],
    isLoading,
    isRefreshing: isValidating && !isLoading,
    error,
    mutate,
  };
}

export type { KBArticleAdmin as KBArticleData } from "@/components/kb/kb-types";
