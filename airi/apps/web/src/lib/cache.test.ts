const mockCacheDel = jest.fn();
const mockInvalidateCacheByPrefix = jest.fn();
const mockInvalidateConversation = jest.fn();

jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: (namespace: string, parts: string[]) =>
    `icecore:${namespace}:${parts.join(":")}`,
  cache: {
    del: (...args: unknown[]) => mockCacheDel(...args),
  },
  cacheInvalidation: {
    conversation: (...args: unknown[]) => mockInvalidateConversation(...args),
  },
  invalidateCacheByPrefix: (...args: unknown[]) =>
    mockInvalidateCacheByPrefix(...args),
}));

import { invalidateRequestsForWorkspace } from "./cache";

describe("invalidateRequestsForWorkspace", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCacheDel.mockResolvedValue(undefined);
  });

  it("deletes only the workspace filter and plan-gate keys, without a prefix scan", async () => {
    await invalidateRequestsForWorkspace("workspace-1");

    expect(mockCacheDel.mock.calls.map(([key]) => key).sort()).toEqual([
      "icecore:company_conversation_visibility_gate:workspace-1",
      "icecore:workspace_channels_categories:workspace-1",
    ]);
    expect(mockInvalidateCacheByPrefix).not.toHaveBeenCalled();
    expect(mockInvalidateConversation).not.toHaveBeenCalled();
  });

  it("resolves when a key delete fails", async () => {
    mockCacheDel.mockRejectedValue(new Error("cache unavailable"));

    await expect(
      invalidateRequestsForWorkspace("workspace-1")
    ).resolves.toBeUndefined();
  });
});
