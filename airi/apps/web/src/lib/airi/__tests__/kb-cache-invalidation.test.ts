const invalidateCacheByPrefix = jest.fn();

jest.mock("@/lib/cache", () => ({
  buildCacheKey: (prefix: string, parts: string[]) =>
    `${prefix}:${parts.join(":")}`,
  invalidateCacheByPrefix: (...args: unknown[]) =>
    invalidateCacheByPrefix(...args),
}));

import {
  buildKbRetrievalCachePrefix,
  KB_RETRIEVAL_CACHE_VERSION,
  KB_SEARCH_CACHE_VERSION,
  buildKbSearchCacheKey,
  buildKbSearchCachePrefix,
} from "@/lib/airi/rag/kb/kb-cache";
import { invalidateKbWorkspaceCaches } from "@/lib/airi/rag/cache-invalidation";

describe("kb cache helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateCacheByPrefix.mockResolvedValue(undefined);
  });

  it("builds retrieval and search cache prefixes from shared versions", () => {
    expect(buildKbRetrievalCachePrefix("workspace-1")).toBe(
      `kb:retrieval:${KB_RETRIEVAL_CACHE_VERSION}:workspace-1:`
    );
    expect(buildKbSearchCachePrefix("workspace-1")).toBe(
      `kb:search:${KB_SEARCH_CACHE_VERSION}:workspace-1:`
    );
    expect(buildKbSearchCacheKey(["workspace-1", "query", "20"])).toBe(
      `kb:search:${KB_SEARCH_CACHE_VERSION}:workspace-1:query:20`
    );
  });

  it("invalidates both KB caches together", async () => {
    await invalidateKbWorkspaceCaches("workspace-1");

    expect(invalidateCacheByPrefix).toHaveBeenCalledWith(
      `kb:retrieval:${KB_RETRIEVAL_CACHE_VERSION}:workspace-1:`
    );
    expect(invalidateCacheByPrefix).toHaveBeenCalledWith(
      `kb:search:${KB_SEARCH_CACHE_VERSION}:workspace-1:`
    );
    expect(invalidateCacheByPrefix).toHaveBeenCalledTimes(2);
  });
});
