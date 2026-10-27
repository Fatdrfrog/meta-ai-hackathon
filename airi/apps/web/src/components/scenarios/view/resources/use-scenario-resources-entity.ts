"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  fetchScenarioContextItems,
  fetchScenarioWhatsAppFlows,
  fetchScenarioWhatsAppTemplates,
  loadScenarioAudienceOptions,
  loadScenarioContextOptions,
  readCachedScenarioAudienceOptions,
  readCachedScenarioContextOptions,
} from "@/lib/scenarios/client";
import type {
  ScenarioAudienceOptions,
  ScenarioContextItem,
  ScenarioContextOption,
  ScenarioWhatsAppFlowOption,
  ScenarioWhatsAppTemplate,
} from "../../types";
import type { ScenarioGraphResourcesState } from "../graph/resources-context";
import { useLatestRef } from "../use-latest-ref";
import {
  subscribeWhatsAppTemplateCatalogInvalidation,
  WHATSAPP_TEMPLATE_CATALOG_CACHE_TTL_MS,
  WhatsAppTemplateCatalogRequestError,
} from "@/lib/whatsapp/templates/catalog-client";
import {
  staleWhatsAppTemplateCatalogMissError,
  type WhatsAppTemplateCatalogMetadata,
} from "@/lib/whatsapp/templates/catalog-contracts";

const EMPTY_AUDIENCE_OPTIONS: ScenarioAudienceOptions = {
  channels: [],
  classificationCategories: [],
  funnelStages: [],
  internalLabels: [],
  customers: [],
  metaReferralAds: [],
  metaReferralCampaigns: [],
  metaReferralAdSets: [],
  metaCampaignLabels: [],
};

const EMPTY_CONTEXT_ITEMS_BY_OPTION_ID: Record<string, ScenarioContextItem[]> =
  {};
const EMPTY_WHATSAPP_TEMPLATES: ScenarioWhatsAppTemplate[] = [];
const EMPTY_WHATSAPP_FLOWS: ScenarioWhatsAppFlowOption[] = [];
// One empty list for every unloaded resource, so memos that read it hold.
const EMPTY_LIST: never[] = [];

/**
 * A state update that keeps the shown value when a new answer has the same
 * content, so asking again after showing cached options re-renders nothing.
 */
function keepIfUnchanged<T>(next: T): (current: T) => T {
  return current =>
    JSON.stringify(current) === JSON.stringify(next) ? current : next;
}

type UseScenarioResourcesEntityParams = {
  workspaceId: string;
  whatsAppSourceIds?: readonly string[];
};

type LazyScenarioListResourceParams<TItem> = {
  workspaceId: string;
  workspaceIdRef: RefObject<string>;
  resourceKey?: string;
  fetchItems: (
    workspaceId: string,
    options?: { force?: boolean }
  ) => Promise<TItem[]>;
  errorMessage: string;
  maxAgeMs?: number;
};

type LazyScenarioListResourceFailure = {
  resourceKey: string;
  retryAt: string;
  /** The catalog's error code, e.g. WHATSAPP_TEMPLATES_RATE_LIMITED. */
  code: string | null;
};

function useLazyScenarioListResource<TItem>({
  workspaceId,
  workspaceIdRef,
  resourceKey = "",
  fetchItems,
  errorMessage,
  maxAgeMs = Infinity,
}: LazyScenarioListResourceParams<TItem>) {
  const [items, setItems] = useState<TItem[]>([]);
  const [loadedResourceKey, setLoadedResourceKey] = useState<string | null>(
    null
  );
  const [loadActivity, setLoadActivity] = useState<{
    resourceKey: string;
    refreshing: boolean;
  } | null>(null);
  const [failure, setFailure] =
    useState<LazyScenarioListResourceFailure | null>(null);
  const failureRef = useRef<LazyScenarioListResourceFailure | null>(null);
  const requestResourceKey = `${workspaceId}\u0000${resourceKey}`;
  const requestResourceKeyRef = useLatestRef(requestResourceKey);
  const requestTokenRef = useRef(0);
  const lastAttemptAtRef = useRef<number | null>(null);
  const loadPromiseRef = useRef<{
    resourceKey: string;
    token: number;
    promise: Promise<void>;
  } | null>(null);
  const hasLoaded = loadedResourceKey === requestResourceKey;

  const load = useCallback(
    async (force = false, invalidated = false) => {
      if (
        failureRef.current?.resourceKey === requestResourceKey &&
        Date.parse(failureRef.current.retryAt) > Date.now() &&
        (!hasLoaded || force)
      )
        return;
      if (
        hasLoaded &&
        !force &&
        !invalidated &&
        lastAttemptAtRef.current !== null &&
        Date.now() - lastAttemptAtRef.current < maxAgeMs
      )
        return;
      const inFlight = loadPromiseRef.current;
      if (inFlight?.resourceKey === requestResourceKey) {
        return inFlight.promise;
      }

      const requestWorkspaceId = workspaceId;
      const shouldRefresh = hasLoaded || items.length > 0;
      const requestToken = ++requestTokenRef.current;
      lastAttemptAtRef.current = Date.now();
      setLoadActivity({
        resourceKey: requestResourceKey,
        refreshing: shouldRefresh,
      });

      const requestPromise = (async () => {
        try {
          const nextItems = await fetchItems(workspaceId, { force });
          if (
            requestTokenRef.current !== requestToken ||
            requestResourceKeyRef.current !== requestResourceKey ||
            workspaceIdRef.current !== requestWorkspaceId
          ) {
            return;
          }
          setItems(nextItems);
          setLoadedResourceKey(requestResourceKey);
          failureRef.current = null;
          setFailure(null);
        } catch (error) {
          if (
            requestTokenRef.current === requestToken &&
            requestResourceKeyRef.current === requestResourceKey
          ) {
            const catalogError =
              error instanceof WhatsAppTemplateCatalogRequestError
                ? error
                : null;
            const retryAt =
              catalogError?.retryAt ||
              new Date(Date.now() + 30_000).toISOString();
            failureRef.current = {
              resourceKey: requestResourceKey,
              retryAt,
              code: catalogError?.code ?? null,
            };
            setFailure(failureRef.current);
            if (!catalogError) console.error(errorMessage, error);
          }
        } finally {
          if (
            requestTokenRef.current === requestToken &&
            requestResourceKeyRef.current === requestResourceKey
          ) {
            setLoadActivity(null);
          }
        }
      })().finally(() => {
        if (loadPromiseRef.current?.token === requestToken) {
          loadPromiseRef.current = null;
        }
      });

      loadPromiseRef.current = {
        resourceKey: requestResourceKey,
        token: requestToken,
        promise: requestPromise,
      };
      return requestPromise;
    },
    [
      errorMessage,
      fetchItems,
      hasLoaded,
      items.length,
      maxAgeMs,
      requestResourceKey,
      requestResourceKeyRef,
      workspaceId,
      workspaceIdRef,
    ]
  );

  const reset = useCallback(() => {
    requestTokenRef.current += 1;
    lastAttemptAtRef.current = null;
    setItems([]);
    setLoadedResourceKey(null);
    setLoadActivity(null);
    loadPromiseRef.current = null;
    failureRef.current = null;
    setFailure(null);
  }, []);
  const reloadAfterInvalidation = useCallback(() => {
    requestTokenRef.current += 1;
    loadPromiseRef.current = null;
    return load(false, true);
  }, [load]);

  return {
    items: hasLoaded ? items : EMPTY_LIST,
    loading:
      loadActivity?.resourceKey === requestResourceKey &&
      !loadActivity.refreshing,
    refreshing:
      loadActivity?.resourceKey === requestResourceKey &&
      loadActivity.refreshing,
    hasLoaded,
    error: failure?.resourceKey === requestResourceKey ? failure : null,
    load,
    reset,
    reloadAfterInvalidation,
  };
}

export function useScenarioResourcesEntity({
  workspaceId,
  whatsAppSourceIds = [],
}: UseScenarioResourcesEntityParams) {
  // Options this tab read for the workspace minutes ago show at once; the
  // canvas previews and trigger labels need them.
  const [contextOptions, setContextOptions] = useState<ScenarioContextOption[]>(
    () => readCachedScenarioContextOptions(workspaceId) ?? []
  );
  const [contextItemsByOptionId, setContextItemsByOptionId] = useState<
    Record<string, ScenarioContextItem[]>
  >({});
  const [contextItemsLoading, setContextItemsLoading] = useState(false);
  const [audienceOptions, setAudienceOptions] =
    useState<ScenarioAudienceOptions>(
      () =>
        readCachedScenarioAudienceOptions(workspaceId) ?? EMPTY_AUDIENCE_OPTIONS
    );
  const [resourceWorkspaceId, setResourceWorkspaceId] = useState(workspaceId);

  const contextItemsCacheRef = useRef<Record<string, ScenarioContextItem[]>>(
    {}
  );
  const workspaceIdRef = useLatestRef(workspaceId);
  const [templateCatalog, setTemplateCatalog] = useState<
    WhatsAppTemplateCatalogMetadata | undefined
  >();
  const templateCatalogRef = useRef<
    WhatsAppTemplateCatalogMetadata | undefined
  >(undefined);
  const templateCatalogRequestRef = useRef(0);
  const fetchWhatsAppTemplateItems = useCallback(
    (requestWorkspaceId: string, options?: { force?: boolean }) => {
      const requestToken = ++templateCatalogRequestRef.current;
      return fetchScenarioWhatsAppTemplates(requestWorkspaceId, {
        ...options,
        throwOnError: true,
        onCatalogLoaded: catalog => {
          if (
            requestWorkspaceId !== workspaceIdRef.current ||
            templateCatalogRequestRef.current !== requestToken
          )
            return;
          templateCatalogRef.current = catalog;
          setTemplateCatalog(catalog);
        },
      });
    },
    [workspaceIdRef]
  );
  const whatsAppSourceScopeKey = Array.from(
    new Set(
      whatsAppSourceIds
        .map(sourceId => sourceId.trim())
        .filter(sourceId => sourceId.length > 0)
    )
  )
    .sort()
    .join("\u0000");
  const fetchWhatsAppFlowItems = useCallback(
    (requestWorkspaceId: string, options?: { force?: boolean }) =>
      fetchScenarioWhatsAppFlows(requestWorkspaceId, {
        ...options,
        sourceIds: whatsAppSourceScopeKey
          ? whatsAppSourceScopeKey.split("\u0000")
          : [],
      }),
    [whatsAppSourceScopeKey]
  );
  const {
    items: whatsAppTemplates,
    loading: whatsAppTemplatesLoading,
    refreshing: whatsAppTemplatesRefreshing,
    hasLoaded: hasLoadedWhatsAppTemplates,
    load: loadWhatsAppTemplatesRequest,
    reset: resetWhatsAppTemplates,
    error: whatsAppTemplatesError,
    reloadAfterInvalidation: reloadInvalidatedTemplates,
  } = useLazyScenarioListResource<ScenarioWhatsAppTemplate>({
    workspaceId,
    workspaceIdRef,
    fetchItems: fetchWhatsAppTemplateItems,
    errorMessage: "Failed to load WhatsApp templates:",
    maxAgeMs: WHATSAPP_TEMPLATE_CATALOG_CACHE_TTL_MS,
  });
  const {
    items: whatsAppFlows,
    loading: whatsAppFlowsLoading,
    refreshing: whatsAppFlowsRefreshing,
    hasLoaded: hasLoadedWhatsAppFlows,
    load: loadWhatsAppFlows,
    reset: resetWhatsAppFlows,
  } = useLazyScenarioListResource<ScenarioWhatsAppFlowOption>({
    workspaceId,
    workspaceIdRef,
    resourceKey: whatsAppSourceScopeKey,
    fetchItems: fetchWhatsAppFlowItems,
    errorMessage: "Failed to load WhatsApp flows:",
  });
  const loadWhatsAppTemplates = useCallback(
    (force = false) => {
      const retryAt = templateCatalogRef.current?.retryAt;
      if (force && retryAt && Date.parse(retryAt) > Date.now())
        return Promise.resolve();
      return loadWhatsAppTemplatesRequest(force);
    },
    [loadWhatsAppTemplatesRequest]
  );
  useEffect(
    () =>
      subscribeWhatsAppTemplateCatalogInvalidation(changedWorkspaceId => {
        if (changedWorkspaceId && changedWorkspaceId !== workspaceId) return;
        if (
          hasLoadedWhatsAppTemplates ||
          whatsAppTemplatesLoading ||
          whatsAppTemplatesRefreshing
        )
          void reloadInvalidatedTemplates();
      }),
    [
      hasLoadedWhatsAppTemplates,
      reloadInvalidatedTemplates,
      whatsAppTemplatesLoading,
      whatsAppTemplatesRefreshing,
      workspaceId,
    ]
  );

  const loadContextOptions = useCallback(async () => {
    const requestWorkspaceId = workspaceId;
    try {
      const options = await loadScenarioContextOptions(workspaceId);
      if (workspaceIdRef.current !== requestWorkspaceId) return;
      setContextOptions(keepIfUnchanged(options));
    } catch (error) {
      console.error("Failed to load scenario context options:", error);
    }
  }, [workspaceId, workspaceIdRef]);

  const loadContextItems = useCallback(
    async (contextOptionId: string, forceRefresh = false) => {
      if (!contextOptionId) return;

      if (!forceRefresh && contextItemsCacheRef.current[contextOptionId]) {
        return;
      }

      const requestWorkspaceId = workspaceId;
      try {
        setContextItemsLoading(true);
        const items = await fetchScenarioContextItems({
          workspaceId,
          contextOptionId,
        });
        if (workspaceIdRef.current !== requestWorkspaceId) return;
        contextItemsCacheRef.current[contextOptionId] = items;
        setContextItemsByOptionId(current => ({
          ...current,
          [contextOptionId]: items,
        }));
      } catch (error) {
        console.error("Failed to load scenario context items:", error);
      } finally {
        if (workspaceIdRef.current === requestWorkspaceId) {
          setContextItemsLoading(false);
        }
      }
    },
    [workspaceId, workspaceIdRef]
  );

  const loadAudienceOptions = useCallback(async () => {
    const requestWorkspaceId = workspaceId;
    try {
      const options = await loadScenarioAudienceOptions(workspaceId);
      if (workspaceIdRef.current !== requestWorkspaceId) return;
      setAudienceOptions(keepIfUnchanged(options));
    } catch (error) {
      console.error("Failed to load scenario audience options:", error);
    }
  }, [workspaceId, workspaceIdRef]);

  useEffect(() => {
    void loadContextOptions();
  }, [loadContextOptions]);

  useEffect(() => {
    void loadAudienceOptions();
  }, [loadAudienceOptions]);

  const resourceWorkspaceSynced = resourceWorkspaceId === workspaceId;
  const effectiveContextItemsByOptionId = resourceWorkspaceSynced
    ? contextItemsByOptionId
    : EMPTY_CONTEXT_ITEMS_BY_OPTION_ID;
  const effectiveWhatsAppTemplates = resourceWorkspaceSynced
    ? whatsAppTemplates
    : EMPTY_WHATSAPP_TEMPLATES;
  const effectiveWhatsAppFlows = resourceWorkspaceSynced
    ? whatsAppFlows
    : EMPTY_WHATSAPP_FLOWS;
  const effectiveWhatsAppTemplatesLoading = resourceWorkspaceSynced
    ? whatsAppTemplatesLoading
    : false;
  const effectiveWhatsAppTemplatesRefreshing = resourceWorkspaceSynced
    ? whatsAppTemplatesRefreshing
    : false;
  const effectiveHasLoadedWhatsAppTemplates = resourceWorkspaceSynced
    ? hasLoadedWhatsAppTemplates
    : false;
  const effectiveWhatsAppFlowsLoading = resourceWorkspaceSynced
    ? whatsAppFlowsLoading
    : false;
  const effectiveWhatsAppFlowsRefreshing = resourceWorkspaceSynced
    ? whatsAppFlowsRefreshing
    : false;
  const effectiveHasLoadedWhatsAppFlows = resourceWorkspaceSynced
    ? hasLoadedWhatsAppFlows
    : false;
  const effectiveContextItemsLoading = resourceWorkspaceSynced
    ? contextItemsLoading
    : false;

  const graphResourceState = useMemo<ScenarioGraphResourcesState>(() => {
    // A saved copy Meta couldn't refresh reads like a failed lookup, rate
    // limited while Meta's cooldown lasts.
    const staleCatalogError =
      staleWhatsAppTemplateCatalogMissError(templateCatalog);
    return {
      whatsAppTemplatesLoading: effectiveWhatsAppTemplatesLoading,
      whatsAppTemplatesRefreshing: effectiveWhatsAppTemplatesRefreshing,
      hasLoadedWhatsAppTemplates: effectiveHasLoadedWhatsAppTemplates,
      whatsAppTemplatesError: resourceWorkspaceSynced
        ? whatsAppTemplatesError ||
          (staleCatalogError
            ? {
                retryAt: staleCatalogError.retryAt,
                code: staleCatalogError.code,
              }
            : null)
        : null,
      whatsAppFlowsLoading: effectiveWhatsAppFlowsLoading,
      whatsAppFlowsRefreshing: effectiveWhatsAppFlowsRefreshing,
      contextItemsLoading: effectiveContextItemsLoading,
    };
  }, [
    effectiveWhatsAppTemplatesLoading,
    effectiveWhatsAppTemplatesRefreshing,
    effectiveHasLoadedWhatsAppTemplates,
    effectiveWhatsAppFlowsLoading,
    effectiveWhatsAppFlowsRefreshing,
    effectiveContextItemsLoading,
    resourceWorkspaceSynced,
    whatsAppTemplatesError,
    templateCatalog,
  ]);

  if (!resourceWorkspaceSynced) {
    workspaceIdRef.current = workspaceId;
    contextItemsCacheRef.current = {};
    setContextItemsByOptionId(EMPTY_CONTEXT_ITEMS_BY_OPTION_ID);
    resetWhatsAppTemplates();
    templateCatalogRef.current = undefined;
    templateCatalogRequestRef.current += 1;
    setTemplateCatalog(undefined);
    resetWhatsAppFlows();
    setResourceWorkspaceId(workspaceId);
  }

  return {
    contextOptions,
    contextItemsByOptionId: effectiveContextItemsByOptionId,
    contextItemsLoading: effectiveContextItemsLoading,
    audienceOptions,
    whatsAppTemplates: effectiveWhatsAppTemplates,
    whatsAppTemplatesLoading: effectiveWhatsAppTemplatesLoading,
    whatsAppTemplatesRefreshing: effectiveWhatsAppTemplatesRefreshing,
    hasLoadedWhatsAppTemplates: effectiveHasLoadedWhatsAppTemplates,
    whatsAppFlows: effectiveWhatsAppFlows,
    whatsAppFlowsLoading: effectiveWhatsAppFlowsLoading,
    whatsAppFlowsRefreshing: effectiveWhatsAppFlowsRefreshing,
    hasLoadedWhatsAppFlows: effectiveHasLoadedWhatsAppFlows,
    graphResourceState,
    loadContextOptions,
    loadContextItems,
    loadAudienceOptions,
    loadWhatsAppTemplates,
    loadWhatsAppFlows,
  };
}
