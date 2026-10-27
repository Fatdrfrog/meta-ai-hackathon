"use client";

import {
  getUnifiedTemplatesAction,
  syncTemplatesAction,
} from "@/features/panel/messengers/whatsapp-templates/actions";
import { SourceRequiredState } from "@/components/onboarding/source-required-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { TemplateChannel } from "@icecore/shared/types/templates";
import type { WhatsAppTemplateStatus } from "@icecore/shared/types/whatsapp";
import { AlertCircle, Plus, RefreshCw, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { TemplatesTable } from "./templates-table";
import {
  filterWhatsAppTemplateSelectionItems,
  getWhatsAppTemplateMapKey,
  mergeWhatsAppTemplateSources,
  type WhatsAppTemplateSelectionItem,
} from "@/lib/whatsapp/templates/selection-utils";
import {
  fetchWhatsAppTemplateCatalog,
  invalidateWhatsAppTemplateCatalog,
  type WhatsAppTemplateCatalogResult,
} from "@/lib/whatsapp/templates/catalog-client";

interface WhatsAppTemplatesManagerProps {
  workspaceId: string;
}

type FetchTemplatesOptions = {
  silent?: boolean;
  force?: boolean;
};

const TEMPLATE_STATUS_FILTERS = new Set<WhatsAppTemplateStatus>([
  "APPROVED",
  "PENDING",
  "REJECTED",
  "PAUSED",
  "LIMIT_EXCEEDED",
]);
const TEMPLATE_CHANNEL_FILTERS = new Set<TemplateChannel>([
  "whatsapp",
  "telegram",
  "both",
]);

function parseStatusFilter(
  value: string | null
): WhatsAppTemplateStatus | undefined {
  if (!value) return undefined;
  return TEMPLATE_STATUS_FILTERS.has(value as WhatsAppTemplateStatus)
    ? (value as WhatsAppTemplateStatus)
    : undefined;
}

function parseChannelFilter(value: string | null): TemplateChannel | undefined {
  if (!value) return undefined;
  return TEMPLATE_CHANNEL_FILTERS.has(value as TemplateChannel)
    ? (value as TemplateChannel)
    : undefined;
}

function isLegacyWhatsAppCredentialsError(message: string) {
  return (
    message.includes("WhatsApp credentials not found") ||
    message.includes("WhatsApp Business Account ID not found") ||
    message.includes("WhatsApp access token not found")
  );
}

export function WhatsAppTemplatesManager({
  workspaceId,
}: WhatsAppTemplatesManagerProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tTemplates = useTranslations("templates");
  const fetchFailedMessage = tTemplates("alerts.fetchFailed");
  const loadFailedMessage = tTemplates("alerts.loadFailed");
  const [templates, setTemplates] = useState<WhatsAppTemplateSelectionItem[]>(
    []
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedTemplatesWarning, setSavedTemplatesWarning] = useState(false);
  const [retryAt, setRetryAt] = useState<string | null>(null);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const requestGenerationRef = useRef(0);
  const [stateWorkspaceId, setStateWorkspaceId] = useState(workspaceId);
  const [requiresWhatsAppConnection, setRequiresWhatsAppConnection] =
    useState(false);
  const [syncing, setSyncing] = useState(false);
  // ?create=1 (from the WhatsApp next-step card and the bulk page) opens the
  // create drawer as soon as the table is ready.
  const [createIntentToken, setCreateIntentToken] = useState(() =>
    searchParams.get("create") === "1" ? 1 : 0
  );
  const [searchDraft, setSearchDraft] = useState(
    () => searchParams.get("search") || ""
  );
  const [statusFilter, setStatusFilter] = useState<
    WhatsAppTemplateStatus | undefined
  >(() => parseStatusFilter(searchParams.get("status")));
  const [platformFilter, setPlatformFilter] = useState<
    TemplateChannel | undefined
  >(() => parseChannelFilter(searchParams.get("platform")));
  const [initialEditTemplateName, setInitialEditTemplateName] = useState<
    string | null
  >(() => searchParams.get("template"));
  const deferredSearchDraft = useDeferredValue(searchDraft);
  const connectWhatsAppHref = `/panel/w/${workspaceId}/settings/integrations?integration=whatsapp`;

  useEffect(() => {
    requestGenerationRef.current += 1;
    setStateWorkspaceId(workspaceId);
    setTemplates([]);
    setError(null);
    setSavedTemplatesWarning(false);
    setRetryAt(null);
    setLoading(true);
    setSyncing(false);
    setRequiresWhatsAppConnection(false);
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [workspaceId]);

  useEffect(() => {
    const remaining = Date.parse(retryAt || "") - Date.now();
    if (!(remaining > 0)) return;
    const timer = setTimeout(
      () => setRetryAt(null),
      Math.min(remaining, 2_147_483_647)
    );
    return () => clearTimeout(timer);
  }, [retryAt]);
  const coolingDown = Date.parse(retryAt || "") > Date.now();

  const adoptCatalog = useCallback((result: WhatsAppTemplateCatalogResult) => {
    setRequiresWhatsAppConnection(result.requiresWhatsAppConnection);
    setTemplates(current => {
      if (!result.error) return result.selectionItems;
      const byIdentity = new Map<string, WhatsAppTemplateSelectionItem>(
        current.map(template => [
          template.templateKey ||
            getWhatsAppTemplateMapKey(template.name, template.language),
          template,
        ])
      );
      for (const template of result.selectionItems) {
        const key =
          template.templateKey ||
          getWhatsAppTemplateMapKey(template.name, template.language);
        byIdentity.set(key, { ...byIdentity.get(key), ...template });
      }
      return Array.from(byIdentity.values(), template => ({
        ...template,
        isOnCurrentWaba:
          template.channel === "telegram"
            ? template.isOnCurrentWaba
            : undefined,
        canSwitchToCurrentWaba: false,
      }));
    });
    const needsWarning = Boolean(
      result.error ||
        result.catalog?.stale ||
        (result.catalog &&
          !["fresh", "succeeded"].includes(result.catalog.refreshOutcome))
    );
    setSavedTemplatesWarning(needsWarning);
    setRetryAt(result.catalog?.retryAt || result.error?.retryAt || null);
    setError(null);
  }, []);

  const replaceQueryParams = useCallback(
    (update: (params: URLSearchParams) => void) => {
      const currentPath =
        typeof window === "undefined" ? pathname : window.location.pathname;
      const currentQuery =
        typeof window === "undefined" || currentPath !== pathname
          ? searchParams.toString()
          : window.location.search.replace(/^\?/, "");
      const params = new URLSearchParams(currentQuery);
      update(params);
      const nextQuery = params.toString();

      const nextPath = nextQuery ? `${pathname}?${nextQuery}` : pathname;
      const currentFullPath =
        typeof window === "undefined"
          ? currentQuery
            ? `${pathname}?${currentQuery}`
            : pathname
          : `${window.location.pathname}${window.location.search}`;
      if (nextPath === currentFullPath) return;

      if (typeof window !== "undefined") {
        window.history.replaceState(window.history.state, "", nextPath);
      }
    },
    [pathname, searchParams]
  );

  const fetchTemplates = useCallback(
    async (options?: FetchTemplatesOptions) => {
      const requestGeneration = ++requestGenerationRef.current;
      const isCurrent = () =>
        workspaceRef.current === workspaceId &&
        requestGenerationRef.current === requestGeneration;
      const silent = options?.silent ?? false;
      if (!silent) {
        setLoading(true);
      }
      setError(null);
      try {
        const result = await fetchWhatsAppTemplateCatalog({
          workspaceId,
          fetchFailedMessage,
          includeUnified: true,
          loadUnifiedTemplates: getUnifiedTemplatesAction,
          force: options?.force,
        });
        if (!isCurrent()) return;
        adoptCatalog(result);
      } catch (err) {
        if (!isCurrent()) return;
        const message = err instanceof Error ? err.message : loadFailedMessage;
        if (isLegacyWhatsAppCredentialsError(message)) {
          setRequiresWhatsAppConnection(true);
          setTemplates([]);
          return;
        }
        setError(message);
        toast.error(loadFailedMessage);
      } finally {
        if (!silent && isCurrent()) {
          setLoading(false);
        }
      }
    },
    [adoptCatalog, fetchFailedMessage, loadFailedMessage, workspaceId]
  );

  useEffect(() => {
    void fetchTemplates();
  }, [fetchTemplates]);

  const handleSync = async () => {
    if (requiresWhatsAppConnection) {
      toast.error(tTemplates("connectRequiredCreateDisabled"));
      return;
    }
    if (syncing || coolingDown) return;
    const requestGeneration = ++requestGenerationRef.current;
    const isCurrent = () =>
      workspaceRef.current === workspaceId &&
      requestGenerationRef.current === requestGeneration;
    setSyncing(true);
    try {
      const result = await syncTemplatesAction({ workspaceId });
      if (!isCurrent()) return;
      if (result.success) {
        invalidateWhatsAppTemplateCatalog(workspaceId);
        const unifiedResult = await getUnifiedTemplatesAction({ workspaceId });
        if (!isCurrent()) return;
        const unifiedTemplates = unifiedResult.success
          ? unifiedResult.data.templates
          : [];
        adoptCatalog({
          metaTemplates: result.data.templates,
          unifiedTemplates,
          selectionItems: mergeWhatsAppTemplateSources({
            metaTemplates: result.data.templates,
            unifiedTemplates,
            currentWabaId: result.data.wabaId || result.data.catalog?.wabaId,
          }),
          requiresWhatsAppConnection: false,
          catalog: result.data.catalog,
        });
        if (!result.data.catalog?.stale)
          toast.success(
            result.data.errors > 0
              ? tTemplates("alerts.syncSuccessWithErrors", {
                  count: result.data.synced,
                  errors: result.data.errors,
                })
              : tTemplates("alerts.syncSuccess", { count: result.data.synced })
          );
      } else {
        if (result.code?.startsWith("WHATSAPP_TEMPLATES_")) {
          setSavedTemplatesWarning(true);
          setRetryAt(result.retryAt ?? null);
        }
        toast.error(result.error);
      }
    } catch {
      if (isCurrent()) toast.error(tTemplates("alerts.syncFailed"));
    } finally {
      if (isCurrent()) setSyncing(false);
    }
  };

  const handleCreateClick = useCallback(() => {
    if (requiresWhatsAppConnection) {
      toast.error(tTemplates("connectRequiredCreateDisabled"));
      return;
    }
    setCreateIntentToken(prev => prev + 1);
  }, [requiresWhatsAppConnection, tTemplates]);

  const handleStatusFilterChange = useCallback(
    (status: string) => {
      const nextStatus =
        status === "all" ? undefined : parseStatusFilter(status);
      setStatusFilter(nextStatus);
      replaceQueryParams(params => {
        if (status === "all") {
          params.delete("status");
        } else if (nextStatus) {
          params.set("status", status);
        }
      });
    },
    [replaceQueryParams]
  );

  const handleSearchChange = useCallback((value: string) => {
    setSearchDraft(value);
  }, []);

  const handlePlatformFilterChange = useCallback(
    (platform: string) => {
      const nextPlatform =
        platform === "all" ? undefined : parseChannelFilter(platform);
      setPlatformFilter(nextPlatform);
      replaceQueryParams(params => {
        if (platform === "all") {
          params.delete("platform");
        } else if (nextPlatform) {
          params.set("platform", platform);
        }
      });
    },
    [replaceQueryParams]
  );

  const clearTemplateDeepLink = useCallback(() => {
    setInitialEditTemplateName(null);
    replaceQueryParams(params => {
      params.delete("template");
    });
  }, [replaceQueryParams]);

  // The create intent is consumed once; a reload should not reopen it.
  useEffect(() => {
    if (searchParams.get("create") !== "1") return;
    replaceQueryParams(params => {
      params.delete("create");
    });
    // Only on mount: later URL changes are the page's own filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const syncLocalFiltersFromUrl = () => {
      const params =
        typeof window === "undefined"
          ? searchParams
          : new URLSearchParams(window.location.search);
      setSearchDraft(params.get("search") || "");
      setStatusFilter(parseStatusFilter(params.get("status")));
      setPlatformFilter(parseChannelFilter(params.get("platform")));
      setInitialEditTemplateName(params.get("template"));
    };

    window.addEventListener("popstate", syncLocalFiltersFromUrl);
    return () => {
      window.removeEventListener("popstate", syncLocalFiltersFromUrl);
    };
  }, [searchParams]);

  useEffect(() => {
    const currentParams =
      typeof window !== "undefined" && window.location.pathname === pathname
        ? new URLSearchParams(window.location.search)
        : searchParams;
    const currentSearch = currentParams.get("search") || "";
    if (searchDraft === currentSearch) return;

    const timeout = setTimeout(() => {
      replaceQueryParams(params => {
        if (searchDraft) {
          params.set("search", searchDraft);
        } else {
          params.delete("search");
        }
      });
    }, 250);

    return () => clearTimeout(timeout);
  }, [pathname, replaceQueryParams, searchDraft, searchParams]);

  const templateCounts = useMemo(() => {
    let whatsapp = 0;
    let telegram = 0;
    let both = 0;

    for (const template of templates) {
      const channel = template.channel || "whatsapp";
      if (channel === "both") {
        both += 1;
        whatsapp += 1;
        telegram += 1;
      } else if (channel === "telegram") {
        telegram += 1;
      } else {
        whatsapp += 1;
      }
    }

    return {
      all: templates.length,
      both,
      telegram,
      whatsapp,
    };
  }, [templates]);

  const normalizedSearchQuery = deferredSearchDraft.trim().toLowerCase();

  const filteredTemplates = useMemo(
    () =>
      filterWhatsAppTemplateSelectionItems(templates, {
        platformFilter,
        searchQuery: normalizedSearchQuery,
        statusFilter,
      }),
    [templates, normalizedSearchQuery, platformFilter, statusFilter]
  );

  const refreshTemplatesSilently = useCallback(() => {
    invalidateWhatsAppTemplateCatalog(workspaceId);
    void fetchTemplates({ silent: true, force: true });
  }, [fetchTemplates, workspaceId]);

  const handleTemplateDeleted = useCallback(
    (deletedTemplate: WhatsAppTemplateSelectionItem) => {
      const deletedKey = getWhatsAppTemplateMapKey(
        deletedTemplate.name,
        deletedTemplate.language
      );
      const deletedIds = new Set(
        [
          deletedTemplate.id,
          deletedTemplate.metaId,
          deletedTemplate.dbId,
        ].filter(Boolean)
      );

      setTemplates(current =>
        current.filter(template => {
          const key = getWhatsAppTemplateMapKey(
            template.name,
            template.language
          );
          return key !== deletedKey && !deletedIds.has(template.id);
        })
      );
      refreshTemplatesSilently();
    },
    [refreshTemplatesSilently]
  );

  if (loading || stateWorkspaceId !== workspaceId) {
    return (
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex justify-end gap-2">
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-9 w-36" />
          </div>
          <div className="flex gap-4">
            <Skeleton className="h-10 flex-1" />
            <Skeleton className="h-10 w-[180px]" />
          </div>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (requiresWhatsAppConnection) {
    return (
      <SourceRequiredState
        icon="whatsapp"
        title={tTemplates("connectRequiredTitle")}
        description={tTemplates("connectRequiredDescription")}
        primaryHref={connectWhatsAppHref}
        primaryLabel={tTemplates("connectRequiredAction")}
      />
    );
  }

  return (
    <div className="flex flex-col">
      <Card className="flex flex-col">
        <CardContent className="flex flex-col gap-4 pt-6">
          <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Tabs
              value={platformFilter || "all"}
              onValueChange={handlePlatformFilterChange}
            >
              <TabsList className="h-auto w-full flex-wrap justify-start sm:w-auto">
                <TabsTrigger value="all">
                  {tTemplates("tabs.all")}
                  <Badge variant="secondary" className="ml-2 text-xs">
                    {templateCounts.all}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="whatsapp">
                  {tTemplates("tabs.whatsapp")}
                  <Badge variant="secondary" className="ml-2 text-xs">
                    {templateCounts.whatsapp}
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="telegram">
                  {tTemplates("tabs.telegram")}
                  <Badge variant="secondary" className="ml-2 text-xs">
                    {templateCounts.telegram}
                  </Badge>
                </TabsTrigger>
                {templateCounts.both > 0 && (
                  <TabsTrigger value="both">
                    {tTemplates("tabs.both")}
                    <Badge variant="secondary" className="ml-2 text-xs">
                      {templateCounts.both}
                    </Badge>
                  </TabsTrigger>
                )}
              </TabsList>
            </Tabs>

            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 sm:flex-none"
                onClick={handleSync}
                disabled={syncing || requiresWhatsAppConnection || coolingDown}
              >
                <RefreshCw
                  className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`}
                />
                {tTemplates("sync")}
              </Button>
              <Button
                size="sm"
                className="flex-1 sm:flex-none"
                onClick={handleCreateClick}
                disabled={requiresWhatsAppConnection}
              >
                <Plus className="h-4 w-4 mr-2" />
                {tTemplates("create")}
              </Button>
            </div>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {savedTemplatesWarning && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="break-words">
                <p>
                  {tTemplates(
                    templates.length > 0
                      ? "alerts.savedTemplates"
                      : "alerts.refreshUnavailable"
                  )}
                </p>
                {coolingDown && (
                  <p>
                    {tTemplates("alerts.refreshCooldown", {
                      time: new Date(retryAt!).toLocaleTimeString(),
                    })}
                  </p>
                )}
              </AlertDescription>
            </Alert>
          )}

          <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:gap-4">
            <div className="min-w-0 flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={tTemplates("search")}
                  value={searchDraft}
                  onChange={e => handleSearchChange(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
            <Select
              value={statusFilter || "all"}
              onValueChange={handleStatusFilterChange}
            >
              <SelectTrigger className="h-9 w-full min-w-0 sm:w-[180px]">
                <SelectValue placeholder={tTemplates("filterByStatus")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {tTemplates("statuses.all")}
                </SelectItem>
                <SelectItem value="APPROVED">
                  {tTemplates("statuses.approved")}
                </SelectItem>
                <SelectItem value="PENDING">
                  {tTemplates("statuses.pending")}
                </SelectItem>
                <SelectItem value="REJECTED">
                  {tTemplates("statuses.rejected")}
                </SelectItem>
                <SelectItem value="PAUSED">
                  {tTemplates("statuses.paused")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <TemplatesTable
            templates={filteredTemplates}
            workspaceId={workspaceId}
            onRefresh={refreshTemplatesSilently}
            onDeleteOptimistic={handleTemplateDeleted}
            initialEditTemplateName={initialEditTemplateName}
            onConsumeInitialTemplateQuery={clearTemplateDeepLink}
            createIntentToken={createIntentToken}
            canCreateTemplates={!requiresWhatsAppConnection}
            createDisabledReason={tTemplates("connectRequiredCreateDisabled")}
          />
        </CardContent>
      </Card>
    </div>
  );
}
