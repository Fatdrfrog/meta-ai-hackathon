"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/async-states";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  CRM_ATTENTION_CHIP_ORDER,
  parseCrmAttentionFilter,
} from "@/lib/crm/attention";
import {
  isUsefulLeadChurn,
  isUsefulLeadSentiment,
  primaryLeadContactPoint,
  resolveNamedCrmStageKey,
} from "@/lib/crm/conversation-preview";
import { formatRelativeTime } from "@/lib/date-utils";
import {
  ChevronLeft,
  ChevronRight,
  Kanban,
  Search,
  SlidersHorizontal,
  TableIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { CrmWorkspaceRealtime } from "./crm-workspace-realtime";
import { CustomerDetailSheet } from "./customer-detail-sheet";
import { CustomerPipelineBoardSkeleton } from "./customer-pipeline-board-skeleton";

type CustomerSummary = {
  _id: string;
  displayName: string | null;
  status: string;
  currentFunnelStage: string | null;
  ownerUserId?: string | null;
  ownerLabel?: string | null;
  lastInteractionAt: string | null;
  createdAt: string | null;
  profileSummary: {
    channels?: string[];
    languages?: string[];
    tags?: string[];
    contactPoints?: {
      emails?: string[];
      phones?: string[];
      usernames?: string[];
      visitorIds?: string[];
      whatsappUserIds?: string[];
      whatsappParentUserIds?: string[];
    };
    lastSentiment?: string | null;
    churnRiskLevel?: string | null;
    estimatedCustomerLtv?: number | null;
    conversationCount?: number;
  } | null;
  behavioralProfile: {
    status?: string;
    summary?: string | null;
    communicationStyle?: string | null;
  } | null;
};

type CustomersResponse = {
  customers: CustomerSummary[];
  pagination: {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  availableFunnelStages: string[];
};

function fetcher<T>(url: string): Promise<T> {
  return fetch(url).then(async res => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data as T;
  });
}

function getInitials(name: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function sentimentColor(sentiment: string | null | undefined): string {
  if (!sentiment) return "text-muted-foreground";
  switch (sentiment.toLowerCase()) {
    case "positive":
      return "text-green-600 dark:text-green-400";
    case "negative":
      return "text-red-600 dark:text-red-400";
    default:
      return "text-muted-foreground";
  }
}

function churnBadgeVariant(
  level: string | null | undefined
): "default" | "secondary" | "destructive" | "outline" {
  if (!level) return "outline";
  switch (level.toLowerCase()) {
    case "high":
      return "destructive";
    case "medium":
      return "secondary";
    default:
      return "outline";
  }
}

function namedFunnelStageCopy(
  t: (key: never) => string,
  stage: string
): string {
  const named = resolveNamedCrmStageKey(stage);
  return named ? t(`stages.${named}` as never) : stage;
}

/** Keeps the filters menu open while several options are toggled. */
function keepMenuOpen(event: Event) {
  event.preventDefault();
}

function CustomersTableSkeleton() {
  return (
    <div className="rounded-lg border">
      <div className="px-4 py-3 border-b flex gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-24" />
        ))}
      </div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-4 border-b last:border-b-0"
        >
          <Skeleton className="h-9 w-9 rounded-full shrink-0" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

const CustomerPipelineBoard = dynamic(
  () =>
    import("./customer-pipeline-board").then(
      module => module.CustomerPipelineBoard
    ),
  {
    ssr: false,
    loading: () => <CustomerPipelineBoardSkeleton />,
  }
);

export function CustomersPage({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("LeadsPage");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("active");
  const [funnelStage, setFunnelStage] = useState("all");
  const [viewMode, setViewMode] = useState<"list" | "board">(
    searchParams.get("view") === "list" ? "list" : "board"
  );
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(
    null
  );
  const [boardTotal, setBoardTotal] = useState<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listScrollerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const attention = parseCrmAttentionFilter(searchParams.get("attention"));
  const salesOnly = searchParams.get("salesOnly") === "1";
  const includeSupport = searchParams.get("support") === "1";
  const ownerMine = searchParams.get("owner") === "me";

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search]);

  // "/" jumps to search, as on Trello, unless the user is already typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu']"
        )
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const buildUrl = useCallback(() => {
    const params = new URLSearchParams({
      workspaceId,
      page: String(page),
      limit: "50",
      status,
    });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (funnelStage && funnelStage !== "all") {
      params.set("funnelStage", funnelStage);
    }
    if (ownerMine) params.set("owner", "me");
    return `/api/customers?${params.toString()}`;
  }, [workspaceId, page, status, debouncedSearch, funnelStage, ownerMine]);

  const { data, error, isLoading, mutate } = useSWR<CustomersResponse>(
    viewMode === "list" ? buildUrl() : null,
    fetcher,
    {
      keepPreviousData: true,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    }
  );

  const customers = data?.customers || [];
  const pagination = data?.pagination;
  const availableStages = data?.availableFunnelStages || [];

  const goToPage = (nextPage: number) => {
    setPage(nextPage);
    if (listScrollerRef.current) listScrollerRef.current.scrollTop = 0;
  };

  // Stable, so memoized board cards don't re-render on every page render.
  const handleSelectCustomer = useCallback((customerId: string) => {
    setSelectedCustomerId(customerId);
  }, []);

  const handleRowKeyDown = (e: React.KeyboardEvent, customerId: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelectedCustomerId(customerId);
    }
  };

  const updateQuery = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (!value) params.delete(key);
        else params.set(key, value);
      }
      const query = params.toString();
      router.replace(query ? `?${query}` : "?");
    },
    [router, searchParams]
  );

  const updateViewMode = (nextView: string) => {
    const next = nextView === "board" ? "board" : "list";
    setViewMode(next);
    updateQuery({ view: next === "list" ? "list" : null });
  };

  const updateAttention = (value: string) => {
    if (!value) return;
    const next = parseCrmAttentionFilter(value);
    updateQuery({ attention: next === "attention" ? null : next });
  };

  const boardCountLabel =
    boardTotal === null
      ? null
      : attention === "all"
        ? t("leadCountInPipeline", { count: boardTotal })
        : t("leadCountNeedAttention", { count: boardTotal });
  const countLabel =
    viewMode === "board"
      ? boardCountLabel
      : pagination
        ? t("leadCount", { count: pagination.totalCount })
        : null;
  const activeFilterCount =
    (status !== "active" ? 1 : 0) +
    (ownerMine ? 1 : 0) +
    (viewMode === "board" ? (salesOnly ? 1 : 0) + (includeSupport ? 1 : 0) : 0);

  const clearFilters = () => {
    setStatus("active");
    setPage(1);
    updateQuery({ owner: null, salesOnly: null, support: null });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-x-hidden px-3 pb-2 pt-3 sm:px-4 lg:px-5">
      <CrmWorkspaceRealtime workspaceId={workspaceId} />

      <Tabs
        value={viewMode}
        onValueChange={updateViewMode}
        className="flex min-h-0 flex-1 flex-col gap-3"
      >
        {/* One slim toolbar, like a Trello board header, so the board gets the
            height. Phones: title + view, then search + filters, then queues. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="text-lg font-semibold tracking-tight">
              {t("title")}
            </h1>
            {countLabel ? (
              <p
                className="truncate text-sm tabular-nums text-muted-foreground"
                aria-live="polite"
              >
                {countLabel}
              </p>
            ) : null}
          </div>

          <TabsList className="h-8">
            <TabsTrigger value="board" title={t("kanbanBoard")}>
              <Kanban className="size-4" />
              <span className="max-lg:sr-only">{t("kanbanBoard")}</span>
            </TabsTrigger>
            <TabsTrigger value="list" title={t("list")}>
              <TableIcon className="size-4" />
              <span className="max-lg:sr-only">{t("list")}</span>
            </TabsTrigger>
          </TabsList>

          {viewMode === "board" ? (
            // Wrapping breaks the joined segments; scroll sideways when narrow.
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={attention}
              onValueChange={updateAttention}
              aria-label={t("filterAttentionAria")}
              className="scrollbar-hide order-last max-w-full max-md:w-full max-md:overflow-x-auto md:order-none"
            >
              {CRM_ATTENTION_CHIP_ORDER.map(filter => (
                <ToggleGroupItem
                  key={filter}
                  value={filter}
                  className="flex-none px-3"
                >
                  {t(`attention.${filter}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}

          <div className="ml-auto flex min-w-0 items-center gap-2 max-sm:w-full">
            <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                placeholder={t("searchPlaceholder")}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-8 pl-8 pr-8"
                aria-label={t("searchAria")}
                aria-keyshortcuts="/"
              />
              <Kbd
                aria-hidden="true"
                className="absolute right-2 top-1/2 -translate-y-1/2 max-sm:hidden"
              >
                /
              </Kbd>
            </div>

            {viewMode === "list" && availableStages.length > 0 ? (
              <Select
                value={funnelStage}
                onValueChange={v => {
                  setFunnelStage(v);
                  setPage(1);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-40 shrink-0"
                  aria-label={t("filterFunnelAria")}
                >
                  <SelectValue placeholder={t("funnelStagePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("allStages")}</SelectItem>
                  {availableStages.map(stage => (
                    <SelectItem key={stage} value={stage}>
                      {namedFunnelStageCopy(t, stage)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 gap-1.5"
                  aria-label={
                    activeFilterCount > 0
                      ? `${t("filters")} (${activeFilterCount})`
                      : t("filters")
                  }
                >
                  <SlidersHorizontal className="size-4" />
                  <span className="max-sm:sr-only">{t("filters")}</span>
                  {activeFilterCount > 0 ? (
                    <Badge
                      variant="secondary"
                      className="h-5 min-w-5 rounded-full px-1.5 tabular-nums"
                    >
                      {activeFilterCount}
                    </Badge>
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>{t("filterStatus")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={status}
                  onValueChange={v => {
                    setStatus(v);
                    setPage(1);
                  }}
                >
                  <DropdownMenuRadioItem value="active" onSelect={keepMenuOpen}>
                    {t("statusActive")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem
                    value="archived"
                    onSelect={keepMenuOpen}
                  >
                    {t("statusArchived")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="all" onSelect={keepMenuOpen}>
                    {t("statusAll")}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={ownerMine}
                  onSelect={keepMenuOpen}
                  onCheckedChange={next => {
                    setPage(1);
                    updateQuery({ owner: next ? "me" : null });
                  }}
                >
                  {t("myLeads")}
                </DropdownMenuCheckboxItem>
                {viewMode === "board" ? (
                  <>
                    <DropdownMenuCheckboxItem
                      checked={salesOnly}
                      onSelect={keepMenuOpen}
                      onCheckedChange={next => {
                        updateQuery({ salesOnly: next ? "1" : null });
                      }}
                    >
                      {t("salesOnly")}
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={includeSupport}
                      disabled={salesOnly}
                      onSelect={keepMenuOpen}
                      onCheckedChange={next => {
                        updateQuery({ support: next ? "1" : null });
                      }}
                    >
                      {t("showSupport")}
                    </DropdownMenuCheckboxItem>
                  </>
                ) : null}
                {activeFilterCount > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={clearFilters}>
                      {t("clearFilters")}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <TabsContent value="board" className="min-h-0 flex-1 overflow-hidden">
          <CustomerPipelineBoard
            workspaceId={workspaceId}
            status={status}
            search={debouncedSearch}
            attention={attention}
            salesOnly={salesOnly}
            includeSupport={includeSupport}
            ownerMine={ownerMine}
            onSelectCustomer={handleSelectCustomer}
            onTotalChange={setBoardTotal}
          />
        </TabsContent>

        <TabsContent
          value="list"
          data-testid="leads-list-panel"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"
        >
          {error ? (
            <ErrorState
              message={error.message || t("loadFailed")}
              onRetry={() => mutate()}
            />
          ) : isLoading && !data ? (
            <CustomersTableSkeleton />
          ) : customers.length === 0 ? (
            <EmptyState
              title={t("emptyTitle")}
              description={
                debouncedSearch ? t("emptySearch") : t("emptyDefault")
              }
            />
          ) : (
            <>
              {/* One scroller for both axes: the table's own x-scroller would put
                  its scrollbar below the last row, out of view. */}
              <div
                ref={listScrollerRef}
                data-testid="leads-list-scroller"
                className="min-h-0 flex-1 overflow-auto rounded-lg border [&>[data-slot=table-container]]:overflow-visible"
              >
                <Table aria-label={t("tableAria")}>
                  <TableHeader className="sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_var(--border)]">
                    <TableRow className="border-b-0 hover:bg-transparent">
                      <TableHead className="w-[260px]">{t("columnLead")}</TableHead>
                      <TableHead>{t("columnOwner")}</TableHead>
                      <TableHead>{t("columnChannels")}</TableHead>
                      <TableHead>{t("columnStage")}</TableHead>
                      <TableHead className="text-center">
                        {t("columnSentiment")}
                      </TableHead>
                      <TableHead className="text-center">
                        {t("columnConversations")}
                      </TableHead>
                      <TableHead>{t("columnChurn")}</TableHead>
                      <TableHead>{t("columnLastInteraction")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customers.map(customer => {
                      const channels = customer.profileSummary?.channels || [];
                      const sentiment = customer.profileSummary?.lastSentiment;
                      const churnRisk = customer.profileSummary?.churnRiskLevel;
                      const convCount =
                        customer.profileSummary?.conversationCount ?? 0;
                      const contactLine = primaryLeadContactPoint(
                        customer.profileSummary?.contactPoints
                      );

                      return (
                        <TableRow
                          key={customer._id}
                          className="cursor-pointer"
                          tabIndex={0}
                          role="button"
                          aria-label={t("viewProfileAria", {
                            name: customer.displayName || t("unknownLead"),
                          })}
                          onClick={() => handleSelectCustomer(customer._id)}
                          onKeyDown={e => handleRowKeyDown(e, customer._id)}
                        >
                          <TableCell>
                            <div className="flex w-[240px] items-center gap-3">
                              <Avatar className="h-9 w-9 shrink-0">
                                <AvatarFallback className="text-xs font-medium">
                                  {getInitials(customer.displayName)}
                                </AvatarFallback>
                              </Avatar>
                              <div className="min-w-0">
                                <p
                                  className="truncate font-medium"
                                  title={customer.displayName || undefined}
                                >
                                  {customer.displayName || t("unknownLead")}
                                </p>
                                {contactLine && (
                                  <p
                                    className="truncate text-xs text-muted-foreground"
                                    title={contactLine}
                                  >
                                    {contactLine}
                                  </p>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm text-muted-foreground">
                              {customer.ownerLabel || t("unassigned")}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              {channels.slice(0, 3).map(ch => (
                                <Badge
                                  key={ch}
                                  variant="outline"
                                  className="text-xs"
                                >
                                  {ch}
                                </Badge>
                              ))}
                              {channels.length > 3 && (
                                <Badge variant="outline" className="text-xs">
                                  +{channels.length - 3}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            {customer.currentFunnelStage ? (
                              <Badge variant="secondary" className="text-xs">
                                {namedFunnelStageCopy(
                                  t,
                                  customer.currentFunnelStage
                                )}
                              </Badge>
                            ) : (
                              <span className="text-sm text-muted-foreground">
                                -
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            {isUsefulLeadSentiment(sentiment) ? (
                              <span
                                className={`text-sm font-medium ${sentimentColor(sentiment)}`}
                              >
                                {t(
                                  `sentiment.${sentiment?.toLowerCase()}` as never
                                )}
                              </span>
                            ) : (
                              <span className="text-sm text-muted-foreground">
                                -
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            <span className="text-sm tabular-nums">
                              {convCount}
                            </span>
                          </TableCell>
                          <TableCell>
                            {isUsefulLeadChurn(churnRisk) ? (
                              <Badge
                                variant={churnBadgeVariant(churnRisk)}
                                className="text-xs"
                              >
                                {t(
                                  `churn.${churnRisk?.toLowerCase()}` as never
                                )}
                              </Badge>
                            ) : (
                              <span className="text-sm text-muted-foreground">
                                -
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <span className="text-sm text-muted-foreground">
                              {customer.lastInteractionAt
                                ? formatRelativeTime(customer.lastInteractionAt)
                                : "-"}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* The lead count sits in the toolbar; only paging stays here. */}
              {pagination && pagination.totalPages > 1 && (
                <div className="flex shrink-0 items-center justify-end gap-2 px-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!pagination.hasPrevPage}
                    onClick={() => goToPage(Math.max(1, page - 1))}
                    aria-label={t("previousPage")}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="px-2 text-sm tabular-nums">
                    {pagination.page} / {pagination.totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!pagination.hasNextPage}
                    onClick={() => goToPage(page + 1)}
                    aria-label={t("nextPage")}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>

      <CustomerDetailSheet
        workspaceId={workspaceId}
        customerId={selectedCustomerId}
        open={selectedCustomerId !== null}
        onOpenChange={open => {
          if (!open) setSelectedCustomerId(null);
        }}
      />
    </div>
  );
}
