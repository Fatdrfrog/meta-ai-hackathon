import {
  buildCacheKey,
  cache,
  cacheInvalidation,
  invalidateCacheByPrefix,
} from "@icecore/shared/lib/cache";

export {
  buildCacheKey,
  cache,
  cacheInvalidation,
  invalidateCacheByPrefix,
};

// Legacy function names for backward compatibility. Request pages are no
// longer cached, so only the workspace filter and plan-gate keys remain; a
// prefix scan here walked the whole Upstash keyspace on every inbound message.
export async function invalidateRequestsForWorkspace(
  workspaceId: string
): Promise<void> {
  await Promise.all([
    cache
      .del(buildCacheKey("workspace_channels_categories", [workspaceId]))
      .catch(() => undefined),
    cache
      .del(
        buildCacheKey("company_conversation_visibility_gate", [workspaceId])
      )
      .catch(() => undefined),
  ]);
}

export async function invalidateConversationCache(
  workspaceId: string,
  conversationId: string
): Promise<void> {
  await cacheInvalidation.conversation(workspaceId, conversationId);
}
