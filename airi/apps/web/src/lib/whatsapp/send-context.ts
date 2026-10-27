import { normalizeString } from "@/lib/scenarios/task-utils";
import { fetchSourceWithCredentialsResult } from "@/lib/sources/utils";
import { buildWhatsAppCallingOperationalReadiness } from "@/lib/whatsapp/auto-defaults";
import { isWhatsAppCloudApiMessagingSuspended } from "@icecore/shared/lib/whatsapp/source-state";
import { asWhatsAppRecord } from "@icecore/shared/lib/whatsapp/value-utils";
import { z } from "zod";

import { normalizeWhatsAppCredentials } from "./credentials";

export type WhatsAppSendContext = {
  sourceId?: string;
  workspaceId?: string;
  wabaId?: string;
  messagingAccountId?: string;
  waacId?: string;
  csId?: string;
  businessId?: string;
  phoneNumberId: string;
  accessToken: string;
  cachedMessagingLimit?: string;
  marketingMessagesEnabled?: boolean;
  catalogIds?: string[];
  callingReady?: boolean;
  cacheHit?: boolean;
  /** Undefined means no rebind; null means a malformed stored boundary. */
  attributionBoundaryAt?: string | null;
};

export type WhatsAppSendContextResolution =
  | {
      ok: true;
      context: WhatsAppSendContext;
    }
  | {
      ok: false;
      kind: "unavailable";
      reason:
        | "lookup_scope_missing"
        | "source_not_found"
        | "source_identity_mismatch"
        | "workspace_mismatch"
        | "messaging_suspended"
        | "credentials_missing";
    }
  | {
      ok: false;
      kind: "query_error";
      error: unknown;
    };

type WhatsAppSendContextResolutionOptions = {
  cacheMode?: "default" | "bypass";
};

const WHATSAPP_SEND_CONTEXT_CACHE_TTL_MS = 60_000;
const bindingBoundarySchema = z.string().datetime({ offset: true });
const whatsAppSendContextCache = new Map<
  string,
  { expiresAt: number; value: WhatsAppSendContext }
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
): WhatsAppSendContext | null {
  if (!cacheKey) return null;
  const cached = whatsAppSendContextCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    whatsAppSendContextCache.delete(cacheKey);
    return null;
  }
  return { ...cached.value, cacheHit: true };
}

function writeCachedSendContext(
  cacheKey: string | null,
  value: WhatsAppSendContext
): void {
  if (!cacheKey) return;
  whatsAppSendContextCache.set(cacheKey, {
    expiresAt: Date.now() + WHATSAPP_SEND_CONTEXT_CACHE_TTL_MS,
    value: { ...value },
  });
}

export function clearWhatsAppSendContextCache(params: {
  workspaceId?: string | null;
  sourceId?: string | null;
}): void {
  const workspaceId = normalizeString(params.workspaceId);
  const sourceId = normalizeString(params.sourceId);
  const sourceKey = buildSendContextCacheKey({ sourceId });
  const workspaceKey = buildSendContextCacheKey({ workspaceId });
  if (sourceKey) whatsAppSendContextCache.delete(sourceKey);
  if (workspaceKey) whatsAppSendContextCache.delete(workspaceKey);
}

export async function resolveWhatsAppSendContextResult(
  params: {
    workspaceId?: string | null;
    sourceId?: string | null;
  },
  options: WhatsAppSendContextResolutionOptions = {}
): Promise<WhatsAppSendContextResolution> {
  const workspaceId = normalizeString(params.workspaceId);
  const sourceId = normalizeString(params.sourceId);
  const cacheKey = buildSendContextCacheKey({ workspaceId, sourceId });
  const bypassCache = options.cacheMode === "bypass";
  if (bypassCache) {
    clearWhatsAppSendContextCache({ workspaceId, sourceId });
  }
  const cached = bypassCache ? null : readCachedSendContext(cacheKey);
  if (cached) {
    if (workspaceId && cached.workspaceId !== workspaceId) {
      return {
        ok: false,
        kind: "unavailable",
        reason: "workspace_mismatch",
      };
    }
    return { ok: true, context: cached };
  }

  if (!sourceId && !workspaceId) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "lookup_scope_missing",
    };
  }
  const sourceResult = sourceId
    ? await fetchSourceWithCredentialsResult(sourceId, "whatsapp")
    : await fetchSourceWithCredentialsResult(undefined, "whatsapp", {
        workspace_id: workspaceId,
      });
  if (!sourceResult.ok) {
    return {
      ok: false,
      kind: "query_error",
      error: sourceResult.error,
    };
  }
  const source = sourceResult.source;

  if (!source) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "source_not_found",
    };
  }
  if (sourceId && normalizeString(source.id) !== sourceId) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "source_identity_mismatch",
    };
  }
  if (workspaceId && normalizeString(source.workspace_id) !== workspaceId) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "workspace_mismatch",
    };
  }

  if (isWhatsAppCloudApiMessagingSuspended(source.credentials)) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "messaging_suspended",
    };
  }

  const normalized = normalizeWhatsAppCredentials(source.credentials);
  const phoneNumberId = normalizeString(normalized.phoneNumberId);
  const accessToken = normalizeString(normalized.accessToken);
  if (!phoneNumberId || !accessToken) {
    return {
      ok: false,
      kind: "unavailable",
      reason: "credentials_missing",
    };
  }

  // A rebind creates this boundary even when Meta conversions were never enabled.
  // Do not use the enabled/complete conversions configuration projection here.
  const rawConfig = asWhatsAppRecord(source.credentials).conversions_api;
  const rawBoundary = asWhatsAppRecord(rawConfig).attribution_boundary_at;
  const parsedBoundary = bindingBoundarySchema.safeParse(rawBoundary);
  const boundaryDate = parsedBoundary.success
    ? new Date(parsedBoundary.data)
    : null;
  const malformedConfig =
    rawConfig !== undefined &&
    (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig));
  const attributionBoundaryAt =
    rawBoundary === undefined && !malformedConfig
      ? undefined
      : boundaryDate && Number.isFinite(boundaryDate.getTime())
        ? boundaryDate.toISOString()
        : null;
  const sendContext = {
    sourceId: normalizeString(source.id),
    workspaceId:
      normalizeString(source.workspace_id) || workspaceId || undefined,
    wabaId: normalizeString(normalized.wabaId) || undefined,
    messagingAccountId:
      normalizeString(normalized.messagingAccountId) || undefined,
    waacId: normalizeString(normalized.waacId) || undefined,
    csId: normalizeString(normalized.csId) || undefined,
    businessId: normalizeString(normalized.businessId) || undefined,
    phoneNumberId,
    accessToken,
    attributionBoundaryAt,
    cachedMessagingLimit:
      normalizeString(normalized.messagingLimit) || undefined,
    marketingMessagesEnabled: normalized.marketingMessagesEnabled === true,
    catalogIds: normalized.catalogIds,
    callingReady: buildWhatsAppCallingOperationalReadiness(
      source.credentials as Record<string, unknown>
    ).ready,
  };
  writeCachedSendContext(cacheKey, sendContext);
  return {
    ok: true,
    context: { ...sendContext, cacheHit: false },
  };
}

export async function resolveWhatsAppSendContext(params: {
  workspaceId?: string | null;
  sourceId?: string | null;
}): Promise<WhatsAppSendContext | null> {
  const result = await resolveWhatsAppSendContextResult(params);
  return result.ok ? result.context : null;
}

export async function resolveFreshWhatsAppSendContext(params: {
  workspaceId?: string | null;
  sourceId?: string | null;
}): Promise<WhatsAppSendContext | null> {
  const result = await resolveWhatsAppSendContextResult(params, {
    cacheMode: "bypass",
  });
  return result.ok ? result.context : null;
}
