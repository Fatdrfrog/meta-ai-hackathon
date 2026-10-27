"use client";

import { ANALYTICS_SURFACE_CLASS } from "@/components/analytics/analytics-surface";
import type { CampaignBlastContentProps } from "@/components/campaigns/campaign-blast-content";
import { CampaignHistory } from "@/components/campaigns/campaign-history";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PreservedTabsContent } from "@/components/ui/preserved-tabs-content";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  isBulkAnalyticsAudienceResolvable,
  type BulkAnalyticsAudienceFilters,
  type BulkAnalyticsAudienceSource,
} from "@/lib/analytics/bulk-analytics-contract";
import {
  getAiriBulkCampaignDraftStorageKey,
  normalizeAiriBulkCampaignDraft,
  type AiriBulkCampaignDraft,
} from "@/lib/airi-chats/bulk-campaign-draft";
import { cn } from "@/lib/utils";
import { BarChart3, Megaphone, MoreHorizontal, Trash2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";

type BulkCampaignsTab = "campaigns" | "analytics";
type BulkCampaignBuilderChannel = "whatsapp" | "telegram" | "email";
type RecipientSourceMode = "manual" | "saved" | "ephemeral";

type SavedBulkCampaignFilter = {
  id: string;
  name: string;
  filters: BulkAnalyticsAudienceFilters;
  created_at: string;
  updated_at: string;
  created_by: string | null;
};

type SavedFiltersResponse = {
  filters: SavedBulkCampaignFilter[];
};

const MANUAL_AUDIENCE_VALUE = "manual";
const ANALYTICS_AUDIENCE_VALUE = "analytics";
const SAVED_AUDIENCE_PREFIX = "saved:";

function savedAudienceValue(filterId: string) {
  return `${SAVED_AUDIENCE_PREFIX}${filterId}`;
}

function savedAudienceId(value: string) {
  return value.startsWith(SAVED_AUDIENCE_PREFIX)
    ? value.slice(SAVED_AUDIENCE_PREFIX.length)
    : null;
}

type BulkCampaignsPageClientProps = {
  workspaceId: string;
  days: number;
  emailEnabled: boolean;
  initialTab?: BulkCampaignsTab;
  initialCampaignIds?: string[];
  openAiriBulkDraftOnMount?: boolean;
  registeredUsersAudience?: {
    enabled: boolean;
    total: number;
    totalAuthUsers: number;
    skippedUnconfirmed: number;
    skippedInvalidEmail: number;
    skippedAnonymous: number;
    skippedDuplicate: number;
    preview?: Array<{
      userId: string;
      email: string;
      name: string;
      registeredAt: string;
      locale?: string;
    }>;
  } | null;
};

function readAiriBulkCampaignDraftFromStorage(
  workspaceId: string
): AiriBulkCampaignDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage?.getItem(
      getAiriBulkCampaignDraftStorageKey(workspaceId)
    );
    const draft = raw ? normalizeAiriBulkCampaignDraft(JSON.parse(raw)) : null;
    return draft?.workspaceId === workspaceId ? draft : null;
  } catch {
    return null;
  }
}

const CampaignBlastContent = dynamic(
  () =>
    import("@/components/campaigns/campaign-blast-content").then(
      module => module.CampaignBlastContent
    ),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[36rem] w-full" />,
  }
);

const BulkAnalytics = dynamic(
  () =>
    import("@/components/analytics/bulk-analytics").then(
      module => module.BulkAnalytics
    ),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[32rem] w-full" />,
  }
);

const fetcher = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || "Failed to load saved filters");
  }
  return payload;
};

export function BulkCampaignsPageClient({
  workspaceId,
  days,
  emailEnabled,
  initialTab = "campaigns",
  initialCampaignIds = [],
  openAiriBulkDraftOnMount = false,
  registeredUsersAudience = null,
}: BulkCampaignsPageClientProps) {
  const t = useTranslations("BulkCampaignsPage");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<BulkCampaignsTab>(initialTab);
  const [historyFocus, setHistoryFocus] = useState<{
    campaignId: string | null;
    requestKey: number;
  }>({ campaignId: null, requestKey: 0 });
  const [analyticsCampaignIds, setAnalyticsCampaignIds] =
    useState<string[]>(initialCampaignIds);
  /** Bump only on history deep-link so multi-select URL sync does not remount analytics. */
  const [analyticsDeepLinkKey, setAnalyticsDeepLinkKey] = useState(0);
  const [ephemeralAudienceFilters, setEphemeralAudienceFilters] =
    useState<BulkAnalyticsAudienceFilters | null>(null);
  const [activeBuilderChannel, setActiveBuilderChannel] =
    useState<BulkCampaignBuilderChannel>("whatsapp");
  const [recipientSourceMode, setRecipientSourceMode] =
    useState<RecipientSourceMode>("manual");
  const [selectedFilterId, setSelectedFilterId] = useState<string | null>(null);
  const [pendingAudienceValue, setPendingAudienceValue] = useState(
    MANUAL_AUDIENCE_VALUE
  );
  const initialAiriBulkDraftKey = openAiriBulkDraftOnMount ? workspaceId : "";
  const initialAiriBulkDraftRef = useRef<{
    key: string;
    draft: AiriBulkCampaignDraft | null;
  } | null>(null);
  if (initialAiriBulkDraftRef.current?.key !== initialAiriBulkDraftKey) {
    initialAiriBulkDraftRef.current = {
      key: initialAiriBulkDraftKey,
      draft: openAiriBulkDraftOnMount
        ? readAiriBulkCampaignDraftFromStorage(workspaceId)
        : null,
    };
  }
  const initialAiriBulkDraft = initialAiriBulkDraftRef.current.draft;
  const filtersUrl = `/api/workspaces/${workspaceId}/bulk-campaign-filters`;

  const replaceTabSearchParams = useCallback(
    (tab: BulkCampaignsTab, campaignIds?: string[] | null) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", tab);
      params.delete("campaignId");
      params.delete("campaignIds");
      if (campaignIds && campaignIds.length > 0) {
        for (const campaignId of campaignIds) {
          const id = String(campaignId || "").trim();
          if (id) params.append("campaignId", id);
        }
      }
      const query = params.toString();
      router.replace(query ? `?${query}` : "?", { scroll: false });
    },
    [router, searchParams]
  );

  const handleTabChange = useCallback(
    (value: string) => {
      const nextTab: BulkCampaignsTab =
        value === "analytics" ? "analytics" : "campaigns";
      setActiveTab(nextTab);
      replaceTabSearchParams(
        nextTab,
        nextTab === "analytics" ? analyticsCampaignIds : null
      );
    },
    [analyticsCampaignIds, replaceTabSearchParams]
  );

  const handleOpenCampaignHistory = useCallback(
    (campaignId?: string) => {
      const target =
        campaignId ||
        (analyticsCampaignIds.length === 1 ? analyticsCampaignIds[0] : null);
      setHistoryFocus(current => ({
        campaignId: target,
        requestKey: current.requestKey + 1,
      }));
      handleTabChange("campaigns");
    },
    [analyticsCampaignIds, handleTabChange]
  );

  const handleViewAnalytics = useCallback(
    (campaignId: string) => {
      const id = String(campaignId || "").trim();
      if (!id) return;
      setAnalyticsCampaignIds([id]);
      setAnalyticsDeepLinkKey(key => key + 1);
      setActiveTab("analytics");
      replaceTabSearchParams("analytics", [id]);
    },
    [replaceTabSearchParams]
  );

  const handleAnalyticsCampaignIdsChange = useCallback(
    (campaignIds: string[]) => {
      const normalized = Array.from(
        new Set(campaignIds.map(id => String(id || "").trim()).filter(Boolean))
      );
      let changed = false;
      setAnalyticsCampaignIds(prev => {
        if (
          prev.length === normalized.length &&
          prev.every((id, index) => id === normalized[index])
        ) {
          return prev;
        }
        changed = true;
        return normalized;
      });
      if (changed && activeTab === "analytics") {
        replaceTabSearchParams("analytics", normalized);
      }
    },
    [activeTab, replaceTabSearchParams]
  );

  const handleSendToAudience = useCallback(
    (filters: BulkAnalyticsAudienceFilters) => {
      setEphemeralAudienceFilters(filters);
      setSelectedFilterId(null);
      setRecipientSourceMode("ephemeral");
      setPendingAudienceValue(ANALYTICS_AUDIENCE_VALUE);
      setActiveTab("campaigns");
      replaceTabSearchParams("campaigns", null);
    },
    [replaceTabSearchParams]
  );

  const {
    data,
    isLoading,
    mutate: mutateFilters,
  } = useSWR<SavedFiltersResponse>(
    activeTab === "campaigns" && activeBuilderChannel === "whatsapp"
      ? filtersUrl
      : null,
    fetcher,
    {
      revalidateOnFocus: false,
    }
  );

  const savedFilters = useMemo(() => data?.filters ?? [], [data?.filters]);
  const savedFilterSelectionAllowed = activeBuilderChannel === "whatsapp";
  const selectedFilterStillAvailable =
    selectedFilterId !== null &&
    (isLoading ||
      !data ||
      savedFilters.some(filter => filter.id === selectedFilterId));
  const effectiveSelectedFilterId =
    savedFilterSelectionAllowed && selectedFilterStillAvailable
      ? selectedFilterId
      : null;
  const effectiveRecipientSourceMode: RecipientSourceMode =
    !savedFilterSelectionAllowed
      ? "manual"
      : recipientSourceMode === "ephemeral" && ephemeralAudienceFilters
        ? "ephemeral"
        : recipientSourceMode === "saved" && effectiveSelectedFilterId
          ? "saved"
          : "manual";
  const selectedFilter =
    savedFilters.find(filter => filter.id === effectiveSelectedFilterId) ??
    null;
  const appliedAudienceValue =
    effectiveRecipientSourceMode === "ephemeral"
      ? ANALYTICS_AUDIENCE_VALUE
      : effectiveRecipientSourceMode === "saved" && selectedFilter
        ? savedAudienceValue(selectedFilter.id)
        : MANUAL_AUDIENCE_VALUE;
  const pendingSavedFilterId = savedAudienceId(pendingAudienceValue);
  const pendingSavedFilter = pendingSavedFilterId
    ? (savedFilters.find(filter => filter.id === pendingSavedFilterId) ?? null)
    : null;
  const pendingAudienceAvailable =
    pendingAudienceValue === MANUAL_AUDIENCE_VALUE ||
    (pendingAudienceValue === ANALYTICS_AUDIENCE_VALUE &&
      Boolean(ephemeralAudienceFilters)) ||
    Boolean(pendingSavedFilter);
  const canApplyPendingAudience =
    savedFilterSelectionAllowed &&
    pendingAudienceAvailable &&
    pendingAudienceValue !== appliedAudienceValue;
  const pendingAudienceLimited = Boolean(
    pendingSavedFilter &&
      !isBulkAnalyticsAudienceResolvable(pendingSavedFilter.filters)
  );
  const showSavedFilterSelector =
    activeBuilderChannel === "whatsapp" &&
    (isLoading || savedFilters.length > 0 || Boolean(ephemeralAudienceFilters));
  const showAudienceSelector = showSavedFilterSelector;

  const analyticsRecipientFilters =
    activeBuilderChannel === "whatsapp"
      ? effectiveRecipientSourceMode === "ephemeral" && ephemeralAudienceFilters
        ? ephemeralAudienceFilters
        : effectiveRecipientSourceMode === "saved" && selectedFilter
          ? selectedFilter.filters
          : null
      : null;
  // Keep a stable object identity so the builder's audience keys do not churn
  // on every render, which can feed a render loop while async data settles.
  const recipientSource: CampaignBlastContentProps["recipientSource"] = useMemo(
    () =>
      analyticsRecipientFilters
        ? ({
            type: "bulk_analytics",
            filters: analyticsRecipientFilters,
          } satisfies BulkAnalyticsAudienceSource)
        : "manual",
    [analyticsRecipientFilters]
  );

  const analyticsMountKey = useMemo(
    () => `${workspaceId}-${days}-${analyticsDeepLinkKey}`,
    [analyticsDeepLinkKey, days, workspaceId]
  );

  useEffect(() => {
    setSelectedFilterId(current =>
      current === effectiveSelectedFilterId
        ? current
        : effectiveSelectedFilterId
    );
  }, [effectiveSelectedFilterId]);

  useEffect(() => {
    setRecipientSourceMode(current =>
      current === effectiveRecipientSourceMode
        ? current
        : effectiveRecipientSourceMode
    );
  }, [effectiveRecipientSourceMode]);

  useEffect(() => {
    setPendingAudienceValue(current => {
      if (!savedFilterSelectionAllowed) return MANUAL_AUDIENCE_VALUE;
      if (current === ANALYTICS_AUDIENCE_VALUE && !ephemeralAudienceFilters) {
        return appliedAudienceValue;
      }
      const currentSavedFilterId = savedAudienceId(current);
      if (
        currentSavedFilterId &&
        !savedFilters.some(filter => filter.id === currentSavedFilterId)
      ) {
        return appliedAudienceValue;
      }
      return current;
    });
  }, [
    appliedAudienceValue,
    ephemeralAudienceFilters,
    savedFilterSelectionAllowed,
    savedFilters,
  ]);

  const handleApplyAudience = () => {
    if (!canApplyPendingAudience) return;

    if (pendingAudienceValue === MANUAL_AUDIENCE_VALUE) {
      setRecipientSourceMode("manual");
      setSelectedFilterId(null);
      return;
    }

    if (
      pendingAudienceValue === ANALYTICS_AUDIENCE_VALUE &&
      ephemeralAudienceFilters
    ) {
      setRecipientSourceMode("ephemeral");
      setSelectedFilterId(null);
      return;
    }

    if (pendingSavedFilter) {
      setRecipientSourceMode("saved");
      setSelectedFilterId(pendingSavedFilter.id);
    }
  };

  const handleClearAudience = () => {
    setPendingAudienceValue(MANUAL_AUDIENCE_VALUE);
    setRecipientSourceMode("manual");
    setSelectedFilterId(null);
  };

  const handleDeleteFilter = async (filter: SavedBulkCampaignFilter) => {
    try {
      const response = await fetch(`${filtersUrl}/${filter.id}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t("filters.deleteFailed"));
      }
      if (effectiveSelectedFilterId === filter.id) {
        setSelectedFilterId(null);
        setRecipientSourceMode("manual");
      }
      if (savedAudienceId(pendingAudienceValue) === filter.id) {
        setPendingAudienceValue(
          effectiveSelectedFilterId === filter.id
            ? MANUAL_AUDIENCE_VALUE
            : appliedAudienceValue
        );
      }
      await mutateFilters();
      toast.success(t("filters.deleted"));
    } catch (deleteError) {
      toast.error(
        deleteError instanceof Error
          ? deleteError.message
          : t("filters.deleteFailed")
      );
    }
  };

  const analyticsActive = activeTab === "analytics";

  return (
    <div
      className={cn(
        "h-full min-h-0 overflow-x-hidden",
        !analyticsActive && "overflow-y-auto"
      )}
    >
      <div
        className={cn(
          "flex w-full flex-col",
          analyticsActive
            ? "h-full min-h-0"
            : "mx-auto max-w-[1600px] gap-3 p-4 pb-28 sm:gap-4 sm:p-5 lg:p-6 xl:pb-6"
        )}
      >
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className={cn("w-full gap-0", analyticsActive && "h-full min-h-0")}
        >
          <div
            className={cn(
              "flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between",
              analyticsActive && "shrink-0 px-4 py-3 sm:px-6 lg:px-8"
            )}
          >
            <div className="min-w-0">
              <h1 className="text-xl font-semibold sm:text-2xl">{t("title")}</h1>
            </div>
            <TabsList className="grid h-10 w-full grid-cols-2 sm:w-auto">
              <TabsTrigger value="campaigns" className="gap-2 px-3">
                {!analyticsActive ? (
                  <Megaphone className="size-4" aria-hidden="true" />
                ) : null}
                {t("tabs.campaigns")}
              </TabsTrigger>
              <TabsTrigger value="analytics" className="gap-2 px-3">
                {!analyticsActive ? (
                  <BarChart3 className="size-4" aria-hidden="true" />
                ) : null}
                {t("tabs.analytics")}
              </TabsTrigger>
            </TabsList>
          </div>

          <PreservedTabsContent
            activeValue={activeTab}
            className="mt-6 space-y-8"
            value="campaigns"
          >
              <>
                <CampaignBlastContent
                  workspaceId={workspaceId}
                  emailEnabled={emailEnabled}
                  onChannelChange={setActiveBuilderChannel}
                  recipientSource={recipientSource}
                  initialDraft={initialAiriBulkDraft}
                  registeredUsersAudience={
                    emailEnabled ? registeredUsersAudience : null
                  }
                  audienceSourceSlot={
                    showAudienceSelector ? (
                      <div className="mb-5 space-y-2">
                        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                          <div className="min-w-0 space-y-1.5">
                            <Label
                              htmlFor="bulk-campaign-audience-source"
                              className="text-xs text-muted-foreground"
                            >
                              {t("filters.sourceLabel")}
                            </Label>
                            {isLoading ? (
                              <Skeleton className="h-9 w-full" />
                            ) : (
                              <Select
                                value={pendingAudienceValue}
                                onValueChange={setPendingAudienceValue}
                              >
                                <SelectTrigger
                                  id="bulk-campaign-audience-source"
                                  className="h-9 w-full min-w-0"
                                  aria-label={t("filters.sourceLabel")}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent className="max-w-[min(420px,calc(100vw-2rem))]">
                                  <SelectItem value={MANUAL_AUDIENCE_VALUE}>
                                    {t("filters.manual")}
                                  </SelectItem>
                                  {ephemeralAudienceFilters ? (
                                    <SelectItem value={ANALYTICS_AUDIENCE_VALUE}>
                                      {t("filters.fromAnalytics")}
                                    </SelectItem>
                                  ) : null}
                                  {savedFilters.map(filter => {
                                    const resolvable =
                                      isBulkAnalyticsAudienceResolvable(
                                        filter.filters
                                      );
                                    return (
                                      <SelectItem
                                        key={filter.id}
                                        value={savedAudienceValue(filter.id)}
                                      >
                                        <span className="min-w-0 truncate">
                                          {filter.name}
                                        </span>
                                        {!resolvable ? (
                                          <Badge
                                            variant="outline"
                                            className="shrink-0 px-1.5 py-0 text-[10px] font-medium"
                                          >
                                            {t("filters.limitedBadge")}
                                          </Badge>
                                        ) : null}
                                      </SelectItem>
                                    );
                                  })}
                                </SelectContent>
                              </Select>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            disabled={!canApplyPendingAudience}
                            onClick={handleApplyAudience}
                          >
                            {t("filters.apply")}
                          </Button>
                          {appliedAudienceValue !== MANUAL_AUDIENCE_VALUE ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={handleClearAudience}
                            >
                              {t("filters.clear")}
                            </Button>
                          ) : null}
                          {savedFilters.length > 0 ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  className="size-9"
                                  aria-label={t("filters.manage")}
                                  title={t("filters.manage")}
                                >
                                  <MoreHorizontal
                                    className="size-4"
                                    aria-hidden="true"
                                  />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="end"
                                className="w-72"
                              >
                                <DropdownMenuLabel>
                                  {t("filters.manageTitle")}
                                </DropdownMenuLabel>
                                {savedFilters.map(filter => (
                                  <DropdownMenuItem
                                    key={filter.id}
                                    variant="destructive"
                                    aria-label={t("filters.deleteAria", {
                                      name: filter.name,
                                    })}
                                    onSelect={() =>
                                      void handleDeleteFilter(filter)
                                    }
                                  >
                                    <Trash2
                                      className="size-4"
                                      aria-hidden="true"
                                    />
                                    <span className="truncate">
                                      {filter.name}
                                    </span>
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </div>
                      </div>
                        {pendingAudienceLimited || canApplyPendingAudience ? (
                          <p className="text-xs text-muted-foreground">
                            {pendingAudienceLimited
                              ? t("filters.limitedDescription")
                              : t("filters.pendingHint")}
                          </p>
                        ) : null}
                      </div>
                    ) : null
                  }
                />
                <CampaignHistory
                  workspaceId={workspaceId}
                  onViewAnalytics={handleViewAnalytics}
                  focusCampaignId={historyFocus.campaignId}
                  focusRequestKey={historyFocus.requestKey}
                  onClearFocus={() => setHistoryFocus(current => ({...current, campaignId: null}))}

                />
              </>
          </PreservedTabsContent>

          <PreservedTabsContent
            activeValue={activeTab}
            className="min-h-0 min-w-0 flex-1"
            value="analytics"
          >
            <div
              data-analytics-content
              className={cn(
                "analytics-brand-theme h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto bg-muted/15 px-4 py-4 sm:px-6 lg:px-8",
                ANALYTICS_SURFACE_CLASS
              )}
            >
              <BulkAnalytics
                key={analyticsMountKey}
                workspaceId={workspaceId}
                days={days}
                initialCampaignIds={analyticsCampaignIds}
                onSelectedCampaignsChange={handleAnalyticsCampaignIdsChange}
                onSendToAudience={handleSendToAudience}
                onOpenCampaignHistory={handleOpenCampaignHistory}
              />
            </div>
          </PreservedTabsContent>
        </Tabs>
      </div>
    </div>
  );
}
