"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  GitBranch,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  Search,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useMemo, useState, type ReactNode } from "react";
import type {
  ScenarioRoutingSettingsPatch,
  ScenarioTriggerConfig,
} from "../types";
import { ScenarioHierarchyList } from "./hierarchy/list";
import { ScenarioStatusSwitch } from "./hierarchy/scenario-status-switch";
import {
  useScenarioStatusToggle,
  type SaveScenarioStatus,
} from "./hierarchy/use-scenario-status-toggle";
import type {
  ScenarioHierarchyDropPayload,
  ScenarioHierarchyIssueSummaryByScenarioId,
  ScenarioHierarchySubscenarioIndicatorByScenarioId,
  ScenarioListLayoutItem,
} from "./hierarchy/utils";
import { ScenarioSettingsPopover } from "./scenario-settings-popover";

export type ScenariosSidebarLayoutMode = "comfortable" | "compact" | "rail";
type ScenariosSidebarViewMode = "journeys" | "flat";

const RAIL_BUTTON_CLASS = "h-10 w-10 shrink-0 rounded-md";
const RAIL_ICON_CLASS = "h-3.5 w-3.5";
const COMPACT_ICON_CLASS = "h-4 w-4 shrink-0";
const COMFORTABLE_ICON_CLASS = "mr-1 h-3.5 w-3.5 shrink-0";

function resolveKeywordSearchText(
  triggerConfig: ScenarioTriggerConfig | null | undefined
): string {
  if (
    triggerConfig?.messageMatchMode !== "exact" &&
    triggerConfig?.messageMatchMode !== "contains"
  ) {
    return "";
  }
  return typeof triggerConfig?.keywordPattern === "string"
    ? triggerConfig.keywordPattern
    : "";
}

type ScenariosSidebarProps = {
  newButtonLabel: string;
  searchPlaceholder?: string;
  searchEmptyLabel?: string;
  searchClearLabel?: string;
  journeysLabel?: string;
  flatLabel?: string;
  scenariosCount: number;
  activeScenarioId: string | null;
  pendingScenarioId?: string | null;
  activeLabel: string;
  draftLabel: string;
  isCreatingScenario: boolean;
  createDisabled?: boolean;
  createLimitNotice?: ReactNode;
  layoutMode?: ScenariosSidebarLayoutMode;
  items: ScenarioListLayoutItem[];
  onCreateScenario: () => void;
  onSelectScenario: (scenarioId: string) => void;
  /** Pointer or focus reached a scenario it may open next. */
  onPrefetchScenario?: (scenarioId: string) => void;
  /** Pointer or focus left that scenario again. */
  onCancelScenarioPrefetch?: (scenarioId: string) => void;
  onScenarioNameCommit: (scenarioId: string, value: string) => Promise<boolean>;
  onScenarioSettingsSave?: SaveScenarioStatus;
  onScenarioRoutingSettingsChange?: (
    scenarioId: string,
    patch: ScenarioRoutingSettingsPatch
  ) => Promise<boolean> | boolean;
  onReorder: (payload: ScenarioHierarchyDropPayload) => void;
  onDeleteScenario?: (scenarioId: string) => void;
  onNormalizeScenarioLayout?: () => void;
  normalizeScenarioLayoutDisabled?: boolean;
  normalizeScenarioLayoutTitle?: string;
  subscenarioIndicatorByScenarioId?: ScenarioHierarchySubscenarioIndicatorByScenarioId;
  issueSummaryByScenarioId?: ScenarioHierarchyIssueSummaryByScenarioId;
};

function getScenarioIconLabel(name: string): string {
  const firstWord = name.trim().split(/\s+/)[0] ?? "";
  const firstCharacter = firstWord.charAt(0).toUpperCase();
  return firstCharacter || "S";
}

export const ScenariosSidebar = memo(function ScenariosSidebar({
  newButtonLabel,
  searchPlaceholder = "Search scenarios",
  searchEmptyLabel = "No matching scenarios",
  searchClearLabel = "Clear search",
  journeysLabel = "Journeys",
  flatLabel = "Flat list",
  scenariosCount,
  activeScenarioId,
  pendingScenarioId,
  activeLabel,
  draftLabel,
  isCreatingScenario,
  createDisabled = false,
  createLimitNotice,
  layoutMode = "comfortable",
  items,
  onCreateScenario,
  onSelectScenario,
  onPrefetchScenario,
  onCancelScenarioPrefetch,
  onScenarioNameCommit,
  onScenarioSettingsSave,
  onScenarioRoutingSettingsChange,
  onReorder,
  onDeleteScenario,
  onNormalizeScenarioLayout,
  normalizeScenarioLayoutDisabled,
  normalizeScenarioLayoutTitle,
  subscenarioIndicatorByScenarioId,
  issueSummaryByScenarioId,
}: ScenariosSidebarProps) {
  const t = useTranslations("Scenarios");
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] =
    useState<ScenariosSidebarViewMode>("journeys");
  const isCompact = layoutMode === "compact";
  const isRail = layoutMode === "rail";
  const showToolbarNormalizeButton =
    isCompact && Boolean(onNormalizeScenarioLayout && activeScenarioId);
  const activeScenario =
    items.find(item => item.item.scenario._id === activeScenarioId)?.item
      .scenario ?? null;
  const { handleStatusToggle, savingSettingsScenarioId } =
    useScenarioStatusToggle(items, onScenarioSettingsSave);
  const isSavingActiveSettings = savingSettingsScenarioId === activeScenarioId;

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const hasActiveSearch = normalizedSearchQuery.length > 0;

  const filteredItems = useMemo(() => {
    if (!normalizedSearchQuery) {
      return items;
    }

    const layoutItemByScenarioId = new Map(
      items.map(
        layoutItem => [layoutItem.item.scenario._id, layoutItem] as const
      )
    );

    const matches = items.filter(layoutItem => {
      const scenario = layoutItem.item.scenario;
      const summary = scenario.builderSummary;
      const triggerSearchText = (summary?.triggers || [])
        .map(triggerSummary =>
          [
            triggerSummary.label,
            resolveKeywordSearchText(triggerSummary.triggerConfig),
            Array.isArray(triggerSummary.triggerConfig?.channelFilter)
              ? triggerSummary.triggerConfig.channelFilter.join(" ")
              : "",
          ]
            .filter(Boolean)
            .join(" ")
        )
        .join(" ");
      const searchText = [
        scenario.name,
        scenario.description,
        summary?.primaryActionType,
        triggerSearchText,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return searchText.includes(normalizedSearchQuery);
    });

    if (viewMode === "flat") {
      return matches;
    }

    const includedScenarioIds = new Set<string>();

    for (const match of matches) {
      includedScenarioIds.add(match.item.scenario._id);

      let parentScenarioId = match.item.directParentScenarioId;
      while (parentScenarioId) {
        includedScenarioIds.add(parentScenarioId);
        parentScenarioId =
          layoutItemByScenarioId.get(parentScenarioId)?.item
            .directParentScenarioId ?? null;
      }

      if (match.item.depth === 0) {
        for (const candidate of items) {
          if (candidate.item.rootScenarioId === match.item.rootScenarioId) {
            includedScenarioIds.add(candidate.item.scenario._id);
          }
        }
      }
    }

    return items.filter(layoutItem =>
      includedScenarioIds.has(layoutItem.item.scenario._id)
    );
  }, [items, normalizedSearchQuery, viewMode]);

  if (isRail) {
    return (
      <aside className="flex h-full w-full flex-col overflow-y-auto bg-muted/20 p-2">
        <div className="flex min-w-0 shrink-0 flex-col items-center gap-2">
          <div className="flex flex-col items-center justify-center gap-1">
            <Button
              size="icon"
              variant="outline"
              className={RAIL_BUTTON_CLASS}
              onClick={onCreateScenario}
              disabled={isCreatingScenario || createDisabled}
              title={newButtonLabel}
              aria-label={newButtonLabel}
            >
              {isCreatingScenario ? (
                <Loader2 className={cn(RAIL_ICON_CLASS, "animate-spin")} />
              ) : (
                <Plus className={RAIL_ICON_CLASS} />
              )}
            </Button>
            {onNormalizeScenarioLayout && activeScenarioId ? (
              <Button
                size="icon"
                variant="outline"
                className={RAIL_BUTTON_CLASS}
                onClick={onNormalizeScenarioLayout}
                disabled={
                  isCreatingScenario || Boolean(normalizeScenarioLayoutDisabled)
                }
                title={normalizeScenarioLayoutTitle}
                aria-label={normalizeScenarioLayoutTitle}
              >
                <LayoutGrid className={RAIL_ICON_CLASS} />
              </Button>
            ) : null}
            {activeScenario &&
            activeScenario.mode !== "bulk_campaign" &&
            onScenarioRoutingSettingsChange ? (
              <ScenarioSettingsPopover
                scenario={activeScenario}
                disabled={isCreatingScenario || isSavingActiveSettings}
                triggerClassName={RAIL_BUTTON_CLASS}
                onSettingsChange={onScenarioRoutingSettingsChange}
              />
            ) : null}
          </div>
          {activeScenario ? (
            <div className="flex flex-col items-center justify-center gap-1 py-1">
              <ScenarioStatusSwitch
                scenarioId={activeScenario._id}
                status={activeScenario.status}
                activeLabel={activeLabel}
                draftLabel={draftLabel}
                compact
                disabled={
                  !onScenarioSettingsSave ||
                  isCreatingScenario ||
                  isSavingActiveSettings
                }
                onStatusToggle={handleStatusToggle}
              />
              {isSavingActiveSettings ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <span className="max-w-16 truncate text-[10px] text-muted-foreground">
                  {activeScenario.status === "active"
                    ? activeLabel
                    : draftLabel}
                </span>
              )}
            </div>
          ) : null}
        </div>

        <Separator className="my-1.5" />

        <div
          className={`min-h-0 flex-1 overflow-y-auto ${
            isCreatingScenario ? "pointer-events-none opacity-60" : ""
          }`}
        >
          <div className="flex flex-col items-center gap-2 py-1">
            {items.map(layoutItem => {
              const scenario = layoutItem.item.scenario;
              const isActive = scenario._id === activeScenarioId;

              return (
                <Button
                  key={scenario._id}
                  type="button"
                  size="icon"
                  variant={isActive ? "secondary" : "outline"}
                  className={cn(
                    RAIL_BUTTON_CLASS,
                    "text-xs font-semibold",
                    isActive &&
                      "border border-primary/30 bg-primary/10 text-primary"
                  )}
                  onPointerEnter={() => onPrefetchScenario?.(scenario._id)}
                  onFocus={() => onPrefetchScenario?.(scenario._id)}
                  onPointerLeave={() =>
                    onCancelScenarioPrefetch?.(scenario._id)
                  }
                  onBlur={() => onCancelScenarioPrefetch?.(scenario._id)}
                  onClick={() => {
                    onSelectScenario(scenario._id);
                  }}
                  title={scenario.name}
                  aria-label={scenario.name}
                  aria-pressed={isActive}
                  aria-busy={pendingScenarioId === scenario._id}
                >
                  {pendingScenarioId === scenario._id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    getScenarioIconLabel(scenario.name)
                  )}
                </Button>
              );
            })}
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        "flex h-full w-full flex-col bg-muted/15",
        isCompact ? "gap-1.5 p-1.5" : "gap-2 p-2"
      )}
    >
      <div className={isCompact ? "space-y-1" : "space-y-1.5"}>
        <div className="relative">
          <Search
            className={cn(
              "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground",
              isCompact ? "left-2 h-3.5 w-3.5" : "left-2.5 h-4 w-4"
            )}
          />
          <Input
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className={cn(
              "bg-background pr-8",
              isCompact ? "h-8 pl-7 text-xs" : "h-8 pl-8 text-sm"
            )}
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={searchClearLabel}
              title={searchClearLabel}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div
        className={cn(
          "min-w-0 gap-1",
          isCompact
            ? "flex items-center justify-between"
            : "flex flex-wrap items-center"
        )}
      >
        <div
          className={cn(
            "inline-flex shrink-0 rounded-md border bg-background p-0.5",
            isCompact ? "gap-0.5" : ""
          )}
        >
          <Button
            type="button"
            size="sm"
            variant={viewMode === "journeys" ? "secondary" : "ghost"}
            className={cn(
              "min-w-0 text-xs",
              isCompact ? "h-7 w-7 px-0" : "h-7 px-2"
            )}
            onClick={() => setViewMode("journeys")}
            disabled={isCreatingScenario}
            title={journeysLabel}
          >
            <GitBranch
              className={
                isCompact ? COMPACT_ICON_CLASS : COMFORTABLE_ICON_CLASS
              }
            />
            <span className={isCompact ? "sr-only" : "truncate"}>
              {journeysLabel}
            </span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant={viewMode === "flat" ? "secondary" : "ghost"}
            className={cn(
              "min-w-0 text-xs",
              isCompact ? "h-7 w-7 px-0" : "h-7 px-2"
            )}
            onClick={() => setViewMode("flat")}
            disabled={isCreatingScenario}
            title={flatLabel}
          >
            <List
              className={
                isCompact ? COMPACT_ICON_CLASS : COMFORTABLE_ICON_CLASS
              }
            />
            <span className={isCompact ? "sr-only" : "truncate"}>
              {flatLabel}
            </span>
          </Button>
        </div>
        <div
          className={cn(
            "ml-auto flex min-w-0 items-center justify-end gap-1",
            isCompact ? "shrink-0" : "flex-1 flex-wrap"
          )}
        >
          <Button
            size="sm"
            variant={isCompact ? "outline" : "default"}
            className={cn(
              "min-w-0 text-xs",
              isCompact ? "h-8 w-8 px-0" : "h-7 max-w-full px-2"
            )}
            onClick={onCreateScenario}
            disabled={isCreatingScenario || createDisabled}
            title={newButtonLabel}
            aria-label={newButtonLabel}
          >
            {isCreatingScenario ? (
              <Loader2
                className={cn(
                  isCompact ? COMPACT_ICON_CLASS : "mr-1 h-4 w-4 shrink-0",
                  "animate-spin"
                )}
              />
            ) : (
              <Plus
                className={
                  isCompact ? COMPACT_ICON_CLASS : "mr-1 h-4 w-4 shrink-0"
                }
              />
            )}
            <span className={isCompact ? "sr-only" : "truncate"}>
              {newButtonLabel}
            </span>
          </Button>
          {showToolbarNormalizeButton ? (
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-8 w-8 shrink-0"
              onClick={onNormalizeScenarioLayout}
              disabled={
                isCreatingScenario || Boolean(normalizeScenarioLayoutDisabled)
              }
              title={normalizeScenarioLayoutTitle}
              aria-label={normalizeScenarioLayoutTitle}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        {/* Says why New is disabled, next to the button it disables. */}
        {createDisabled && createLimitNotice ? (
          <div className="text-xs">{createLimitNotice}</div>
        ) : null}
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          isCompact ? "pr-0.5" : "pr-1",
          isCreatingScenario ? "pointer-events-none opacity-60" : ""
        )}
      >
        {filteredItems.length === 0 ? (
          <div
            className={cn(
              "rounded-lg border border-dashed bg-background/70 text-center text-muted-foreground",
              isCompact ? "px-2 py-4 text-xs" : "px-3 py-6 text-sm"
            )}
          >
            {searchEmptyLabel}
          </div>
        ) : (
          <ScenarioHierarchyList
            items={filteredItems}
            allItems={items}
            viewMode={viewMode}
            density={isCompact ? "compact" : "comfortable"}
            scenariosCount={scenariosCount}
            activeScenarioId={activeScenarioId}
            pendingScenarioId={pendingScenarioId}
            activeLabel={activeLabel}
            draftLabel={draftLabel}
            isInteractionDisabled={isCreatingScenario}
            disableReorder={hasActiveSearch}
            forceExpandAll={hasActiveSearch}
            onSelectScenario={onSelectScenario}
            onPrefetchScenario={onPrefetchScenario}
            onCancelScenarioPrefetch={onCancelScenarioPrefetch}
            onScenarioNameCommit={onScenarioNameCommit}
            onScenarioSettingsSave={onScenarioSettingsSave}
            onScenarioRoutingSettingsChange={onScenarioRoutingSettingsChange}
            onReorder={onReorder}
            onDeleteScenario={onDeleteScenario}
            onNormalizeScenarioLayout={
              isCompact ? undefined : onNormalizeScenarioLayout
            }
            normalizeScenarioLayoutDisabled={normalizeScenarioLayoutDisabled}
            subscenarioIndicatorByScenarioId={subscenarioIndicatorByScenarioId}
            issueSummaryByScenarioId={issueSummaryByScenarioId}
          />
        )}
      </div>

      <div className="space-y-1 border-t px-1 pt-1">
        <div className="truncate text-[10px] text-muted-foreground">
          {t("sidebarTotalCount", {
            count: scenariosCount,
          })}
        </div>
      </div>
    </aside>
  );
});
