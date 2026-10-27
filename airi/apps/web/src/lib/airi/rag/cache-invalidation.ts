import {
  buildKbRetrievalCachePrefix,
  buildKbSearchCachePrefix,
} from "@/lib/airi/rag/kb/kb-cache";
import { invalidateCacheByPrefix } from "@/lib/cache";

export async function invalidateKbWorkspaceCaches(
  workspaceId: string
): Promise<void> {
  await Promise.all([
    invalidateCacheByPrefix(buildKbRetrievalCachePrefix(workspaceId)),
    invalidateCacheByPrefix(buildKbSearchCachePrefix(workspaceId)),
  ]);
}
