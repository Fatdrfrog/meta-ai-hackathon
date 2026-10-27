import { buildCacheKey } from "@/lib/cache";

export const KB_RETRIEVAL_CACHE_VERSION = "v6";
export const KB_SEARCH_CACHE_VERSION = "v1";

export function buildKbRetrievalCacheKey(parts: string[]): string {
  return buildCacheKey(`kb:retrieval:${KB_RETRIEVAL_CACHE_VERSION}`, parts);
}

export function buildKbRetrievalCachePrefix(workspaceId: string): string {
  return `${buildKbRetrievalCacheKey([workspaceId])}:`;
}

export function buildKbSearchCacheKey(parts: string[]): string {
  return buildCacheKey(`kb:search:${KB_SEARCH_CACHE_VERSION}`, parts);
}

export function buildKbSearchCachePrefix(workspaceId: string): string {
  return `${buildKbSearchCacheKey([workspaceId])}:`;
}
