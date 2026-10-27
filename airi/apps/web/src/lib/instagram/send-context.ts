import { decryptMaybeString } from "@/lib/crypto";
import { normalizeString } from "@/lib/scenarios/task-utils";
import {
  resolveInstagramHumanAgentCapability,
  type InstagramHumanAgentCapability,
} from "@/lib/instagram/human-agent";
import { resolveInstagramSenderId } from "@/lib/instagram/outbound";
import { fetchSourceWithCredentials } from "@/lib/sources/utils";
import { resolveInstagramGraphBase } from "@icecore/shared/lib/meta/graph-version";

type InstagramSourceCredentials = {
  page_access_token?: unknown;
  auth_method?: unknown;
  instagram_business_account_id?: unknown;
  instagram_scoped_id?: unknown;
  page_id?: unknown;
  granted_permissions?: unknown;
  human_agent_enabled?: unknown;
};

type InstagramSendContext = {
  sourceId?: string;
  accessToken: string;
  senderId: string;
  graphApiBase: string;
  grantedPermissionsRaw?: unknown;
  humanAgentEnabledRaw?: unknown;
  cacheHit?: boolean;
};

const INSTAGRAM_SEND_CONTEXT_CACHE_TTL_MS = 60_000;
const instagramSendContextCache = new Map<
  string,
  { expiresAt: number; value: InstagramSendContext }
>();

function buildSendContextCacheKey(params: {
  workspaceId?: string;
  sourceId?: string;
}): string | null {
  if (params.sourceId) return `source:${params.sourceId}`;
  if (params.workspaceId) return `workspace:${params.workspaceId}`;
  return null;
}

function readCachedSendContext(
  cacheKey: string | null
): InstagramSendContext | null {
  if (!cacheKey) return null;
  const cached = instagramSendContextCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    instagramSendContextCache.delete(cacheKey);
    return null;
  }
  return { ...cached.value, cacheHit: true };
}

function writeCachedSendContext(
  cacheKey: string | null,
  value: InstagramSendContext
): void {
  if (!cacheKey) return;
  instagramSendContextCache.set(cacheKey, {
    expiresAt: Date.now() + INSTAGRAM_SEND_CONTEXT_CACHE_TTL_MS,
    value: { ...value, cacheHit: undefined },
  });
}

export async function resolveInstagramSendContext(params: {
  workspaceId?: string | null;
  sourceId?: string | null;
}): Promise<InstagramSendContext | null> {
  const workspaceId = normalizeString(params.workspaceId);
  const sourceId = normalizeString(params.sourceId);
  const cacheKey = buildSendContextCacheKey({ workspaceId, sourceId });
  const cached = readCachedSendContext(cacheKey);
  if (cached) {
    return cached;
  }

  const source =
    (sourceId
      ? await fetchSourceWithCredentials(sourceId, "instagram")
      : null) ||
    (workspaceId
      ? await fetchSourceWithCredentials(undefined, "instagram", {
          workspace_id: workspaceId,
        })
      : null);
  const creds = source?.credentials as InstagramSourceCredentials | undefined;
  if (!source || !creds?.page_access_token) {
    return null;
  }

  const authMethod = normalizeString(creds.auth_method);
  const senderId = resolveInstagramSenderId(creds, authMethod);
  const accessToken = normalizeString(
    decryptMaybeString(creds.page_access_token)
  );

  if (!senderId || !accessToken) {
    return null;
  }

  const graphApiBase = resolveInstagramGraphBase(authMethod);

  const sendContext: InstagramSendContext = {
    sourceId: normalizeString(source.id) || sourceId || undefined,
    accessToken,
    senderId,
    graphApiBase,
    grantedPermissionsRaw: creds.granted_permissions,
    humanAgentEnabledRaw: creds.human_agent_enabled,
  };

  writeCachedSendContext(cacheKey, sendContext);
  return { ...sendContext, cacheHit: false };
}

/**
 * Human Agent capability of the account this context sends from. Without a
 * per-source flag, AIRI_INSTAGRAM_HUMAN_AGENT_ENABLED decides.
 */
export function resolveInstagramSendContextHumanAgent(
  sendContext: InstagramSendContext | null
): InstagramHumanAgentCapability {
  return resolveInstagramHumanAgentCapability({
    channel: "instagram",
    hasInstagramSource: Boolean(sendContext),
    grantedPermissionsRaw: sendContext?.grantedPermissionsRaw,
    humanAgentEnabledRaw:
      sendContext?.humanAgentEnabledRaw ??
      process.env.AIRI_INSTAGRAM_HUMAN_AGENT_ENABLED,
  });
}
