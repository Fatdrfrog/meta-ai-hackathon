import { isWhatsAppTemplatesConnectionRequiredPayload } from "@/lib/whatsapp/templates/connection-state";
import type { UnifiedTemplate } from "@icecore/shared/types/templates";
import type {
  WhatsAppTemplate,
  WhatsAppTemplateStatus,
} from "@icecore/shared/types/whatsapp";
import {
  mergeWhatsAppTemplateSources,
  type WhatsAppTemplateSelectionItem,
} from "@/lib/whatsapp/templates/selection-utils";
import type { WhatsAppWabaHistoryEntry } from "@/lib/whatsapp/templates/waba-origin";
import type { WhatsAppTemplateCatalogMetadata } from "./catalog-contracts";

type TemplatesApiResponse = {
  templates?: WhatsAppTemplate[];
  error?: string;
  code?: string;
  requiresWhatsAppConnection?: boolean;
  wabaId?: string | null;
  previousWabaId?: string | null;
  wabaHistory?: WhatsAppWabaHistoryEntry[];
  catalog?: WhatsAppTemplateCatalogMetadata;
  providerCode?: number;
  retryAt?: string | null;
};

type UnifiedTemplatesLoadResult =
  | {
      success?: boolean;
      data?: {
        templates?: UnifiedTemplate[];
      };
    }
  | null
  | undefined;

export type WhatsAppTemplateCatalogResult = {
  metaTemplates: WhatsAppTemplate[];
  requiresWhatsAppConnection: boolean;
  selectionItems: WhatsAppTemplateSelectionItem[];
  unifiedTemplates: UnifiedTemplate[];
  catalog?: WhatsAppTemplateCatalogMetadata;
  error?: WhatsAppTemplateCatalogRequestError;
};

export class WhatsAppTemplateCatalogRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly providerCode?: number,
    readonly retryAt: string | null = null
  ) {
    super(message);
    this.name = "WhatsAppTemplateCatalogRequestError";
  }
}

export function shouldRetryWhatsAppTemplateCatalogError(
  error: unknown
): boolean {
  if (!(error instanceof WhatsAppTemplateCatalogRequestError)) return true;
  return (
    (error.status === 0 || error.status >= 500) &&
    !error.retryAt &&
    error.providerCode !== 80008 &&
    !error.code?.startsWith("WHATSAPP_TEMPLATES_")
  );
}

export type FetchWhatsAppTemplateCatalogParams = {
  sourceId?: string;
  fetchFailedMessage?: string;
  force?: boolean;
  includeUnified?: boolean;
  limit?: number;
  loadUnifiedTemplates?: (params: {
    workspaceId: string;
  }) => Promise<UnifiedTemplatesLoadResult>;
  status?: WhatsAppTemplateStatus;
  workspaceId: string;
};

const NO_STORE_OPTIONS: RequestInit = { cache: "no-store" };
const catalogLoadPromises = new Map<
  string,
  Promise<WhatsAppTemplateCatalogResult>
>();
export const WHATSAPP_TEMPLATE_CATALOG_CACHE_TTL_MS = 30_000;
const catalogCache = new Map<
  string,
  {
    workspaceId: string;
    expiresAt: number;
    result: WhatsAppTemplateCatalogResult;
  }
>();
let catalogCacheGeneration = 0;
const catalogCacheWrites = new Map<string, object>();
const invalidationListeners = new Set<(workspaceId?: string) => void>();

export function subscribeWhatsAppTemplateCatalogInvalidation(
  listener: (workspaceId?: string) => void
): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

/** Mutations invalidate every source/filter view, including mounted SWR readers. */
export function invalidateWhatsAppTemplateCatalog(workspaceId?: string): void {
  catalogCacheGeneration += 1;
  for (const [key, cached] of catalogCache) {
    if (!workspaceId || cached.workspaceId === workspaceId)
      catalogCache.delete(key);
  }
  for (const listener of invalidationListeners) listener(workspaceId);
}

function buildTemplateCatalogUrl(params: FetchWhatsAppTemplateCatalogParams) {
  const searchParams = new URLSearchParams({ workspaceId: params.workspaceId });
  if (params.sourceId?.trim())
    searchParams.set("sourceId", params.sourceId.trim());
  if (params.status) searchParams.set("status", params.status);
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    searchParams.set("limit", String(Math.floor(params.limit)));
  }
  if (params.force) searchParams.set("_refresh", String(Date.now()));
  return `/api/whatsapp/templates?${searchParams.toString()}`;
}

async function readResponseJson(response: Response): Promise<unknown> {
  return (await response.json().catch(() => null)) as unknown;
}

function getTemplateCatalogLoadKey(
  params: FetchWhatsAppTemplateCatalogParams,
  url: string
): string {
  return JSON.stringify({
    includeUnified: params.includeUnified === true,
    hasUnifiedLoader: Boolean(
      params.includeUnified && params.loadUnifiedTemplates
    ),
    url,
  });
}

async function requestWhatsAppTemplateCatalog(
  params: FetchWhatsAppTemplateCatalogParams,
  url: string
): Promise<WhatsAppTemplateCatalogResult> {
  const loadUnifiedTemplates =
    params.includeUnified === true ? params.loadUnifiedTemplates : undefined;
  const unifiedTemplatesPromise = loadUnifiedTemplates
    ? loadUnifiedTemplates({ workspaceId: params.workspaceId }).catch(
        () => null
      )
    : Promise.resolve(null);

  let response: Response | undefined;
  let networkError: WhatsAppTemplateCatalogRequestError | undefined;
  try {
    response = await fetch(url, NO_STORE_OPTIONS);
  } catch (error) {
    networkError = new WhatsAppTemplateCatalogRequestError(
      error instanceof Error
        ? error.message
        : params.fetchFailedMessage || "Failed to fetch templates",
      0
    );
  }
  const data = response
    ? ((await readResponseJson(response)) as TemplatesApiResponse | null)
    : null;

  if (!response?.ok) {
    if (isWhatsAppTemplatesConnectionRequiredPayload(data)) {
      return {
        metaTemplates: [],
        requiresWhatsAppConnection: true,
        selectionItems: [],
        unifiedTemplates: [],
      };
    }
    const error =
      networkError ??
      new WhatsAppTemplateCatalogRequestError(
        data?.error || params.fetchFailedMessage || "Failed to fetch templates",
        response!.status,
        data?.code,
        data?.providerCode,
        data?.retryAt ?? null
      );
    const unifiedResult = await unifiedTemplatesPromise;
    if (
      !loadUnifiedTemplates ||
      !unifiedResult?.success ||
      !Array.isArray(unifiedResult.data?.templates)
    )
      throw error;
    const unifiedTemplates = unifiedResult.data.templates;
    return {
      metaTemplates: [],
      requiresWhatsAppConnection: false,
      unifiedTemplates,
      selectionItems: mergeWhatsAppTemplateSources({
        metaTemplates: [],
        unifiedTemplates,
      }).map(template => ({ ...template, canSwitchToCurrentWaba: false })),
      error,
    };
  }

  const unifiedResult = await unifiedTemplatesPromise;
  const metaTemplates = Array.isArray(data?.templates) ? data.templates : [];
  const unifiedTemplates =
    unifiedResult?.success && Array.isArray(unifiedResult.data?.templates)
      ? unifiedResult.data.templates
      : [];

  return {
    metaTemplates,
    requiresWhatsAppConnection: false,
    selectionItems: mergeWhatsAppTemplateSources({
      metaTemplates,
      unifiedTemplates,
      currentWabaId: data?.wabaId,
      previousWabaId: data?.previousWabaId,
      wabaHistory: data?.wabaHistory,
    }),
    unifiedTemplates,
    catalog: data?.catalog,
  };
}

export async function fetchWhatsAppTemplateCatalog(
  params: FetchWhatsAppTemplateCatalogParams
): Promise<WhatsAppTemplateCatalogResult> {
  const cacheKey = getTemplateCatalogLoadKey(
    params,
    buildTemplateCatalogUrl({ ...params, force: false })
  );
  const cached = catalogCache.get(cacheKey);
  if (!params.force && cached && cached.expiresAt > Date.now())
    return cached.result;
  const generation = catalogCacheGeneration;
  const url = buildTemplateCatalogUrl(params);
  const loadKey = `${generation}:${getTemplateCatalogLoadKey(params, buildTemplateCatalogUrl({ ...params, force: false }))}:${Boolean(params.force)}`;
  const existing = catalogLoadPromises.get(loadKey);
  if (existing) return existing;
  const cacheWriteToken = {};
  catalogCacheWrites.set(cacheKey, cacheWriteToken);

  const promise = requestWhatsAppTemplateCatalog(params, url).then(result => {
    if (
      catalogCacheGeneration === generation &&
      catalogCacheWrites.get(cacheKey) === cacheWriteToken
    ) {
      // Successful snapshots can receive webhook updates during provider cooldown.
      if (catalogCache.size >= 100)
        catalogCache.delete(catalogCache.keys().next().value!);
      catalogCache.set(cacheKey, {
        workspaceId: params.workspaceId,
        result,
        expiresAt: Math.max(
          Date.now() + WHATSAPP_TEMPLATE_CATALOG_CACHE_TTL_MS,
          result.error && result.selectionItems.length === 0
            ? Date.parse(result.error.retryAt || "") || 0
            : 0
        ),
      });
    }
    if (catalogCacheWrites.get(cacheKey) === cacheWriteToken)
      catalogCacheWrites.delete(cacheKey);
    return result;
  });
  catalogLoadPromises.set(loadKey, promise);
  promise.then(
    () => {
      if (catalogLoadPromises.get(loadKey) === promise) {
        catalogLoadPromises.delete(loadKey);
      }
    },
    () => {
      if (catalogCacheWrites.get(cacheKey) === cacheWriteToken)
        catalogCacheWrites.delete(cacheKey);
      if (catalogLoadPromises.get(loadKey) === promise) {
        catalogLoadPromises.delete(loadKey);
      }
    }
  );
  return promise;
}
