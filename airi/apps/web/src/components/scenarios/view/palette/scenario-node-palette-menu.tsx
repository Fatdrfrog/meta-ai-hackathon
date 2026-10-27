"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { ScenarioNodePaletteItem } from "@/components/scenarios/graph/node-palette";
import { observeElementResize } from "@/lib/observe-element-resize";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleStop,
  Link2,
  MessageSquare,
  Plus,
  Search,
  Unlink,
  type LucideIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

export type ScenarioNodePaletteMenuSection = {
  id: ScenarioNodePaletteItem["kind"];
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  items: ScenarioNodePaletteItem[];
};

export type ScenarioRouteMenu = {
  destinations: readonly { nodeId: string; label: string }[];
  currentDestinationId: string | null;
  onSelect: (nodeId: string) => void;
  onDisconnect: () => void;
  onEnd: () => void;
  newMessageLabel: string;
  existingStepLabel: string;
  endLabel: string;
  disconnectLabel: string;
  branchLabel?: string;
  /** The branch after this route is collapsed; the toggle expands it. */
  branchCollapsed?: boolean;
  onToggleBranch?: () => void;
};

type ScenarioNodePaletteMenuProps = {
  contextMenu: {
    left: number;
    top: number;
    connectFromNodeId?: string;
    connectFromSourceHandle?: string | null;
  } | null;
  title: string;
  sourceLabel?: string | null;
  searchPlaceholder: string;
  emptyLabel: string;
  sections: ScenarioNodePaletteMenuSection[];
  onAddNodeFromPaletteItem: (item: ScenarioNodePaletteItem) => void;
  onClose: () => void;
  route?: ScenarioRouteMenu | null;
};

const MENU_EDGE_PADDING = 12;

const MENU_KIND_STYLES: Record<
  ScenarioNodePaletteItem["kind"],
  {
    section: string;
    chip: string;
    badge: string;
    button: string;
  }
> = {
  bulk: {
    section:
      "border-sky-200/80 bg-sky-50/80 dark:border-sky-900/50 dark:bg-sky-950/20",
    chip: "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-800/60 dark:bg-sky-900/40 dark:text-sky-200",
    badge:
      "border-sky-300/80 bg-sky-100/80 text-sky-700 dark:border-sky-800/70 dark:bg-sky-900/40 dark:text-sky-200",
    button:
      "border-sky-200/70 hover:border-sky-300 hover:bg-sky-50/90 dark:border-sky-900/40 dark:hover:border-sky-800/60 dark:hover:bg-sky-950/30",
  },
  trigger: {
    section:
      "border-amber-200/80 bg-amber-50/80 dark:border-amber-900/50 dark:bg-amber-950/20",
    chip: "border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-800/60 dark:bg-amber-900/40 dark:text-amber-200",
    badge:
      "border-amber-300/80 bg-amber-100/80 text-amber-700 dark:border-amber-800/70 dark:bg-amber-900/40 dark:text-amber-200",
    button:
      "border-amber-200/70 hover:border-amber-300 hover:bg-amber-50/90 dark:border-amber-900/40 dark:hover:border-amber-800/60 dark:hover:bg-amber-950/30",
  },
  context: {
    section:
      "border-sky-200/80 bg-sky-50/80 dark:border-sky-900/50 dark:bg-sky-950/20",
    chip: "border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-800/60 dark:bg-sky-900/40 dark:text-sky-200",
    badge:
      "border-sky-300/80 bg-sky-100/80 text-sky-700 dark:border-sky-800/70 dark:bg-sky-900/40 dark:text-sky-200",
    button:
      "border-sky-200/70 hover:border-sky-300 hover:bg-sky-50/90 dark:border-sky-900/40 dark:hover:border-sky-800/60 dark:hover:bg-sky-950/30",
  },
  logic: {
    section:
      "border-blue-200/80 bg-blue-50/80 dark:border-blue-900/50 dark:bg-blue-950/20",
    chip: "border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-800/60 dark:bg-blue-900/40 dark:text-blue-200",
    badge:
      "border-blue-300/80 bg-blue-100/80 text-blue-700 dark:border-blue-800/70 dark:bg-blue-900/40 dark:text-blue-200",
    button:
      "border-blue-200/70 hover:border-blue-300 hover:bg-blue-50/90 dark:border-blue-900/40 dark:hover:border-blue-800/60 dark:hover:bg-blue-950/30",
  },
  action: {
    section:
      "border-emerald-200/80 bg-emerald-50/80 dark:border-emerald-900/50 dark:bg-emerald-950/20",
    chip: "border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-900/40 dark:text-emerald-200",
    badge:
      "border-emerald-300/80 bg-emerald-100/80 text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-900/40 dark:text-emerald-200",
    button:
      "border-emerald-200/70 hover:border-emerald-300 hover:bg-emerald-50/90 dark:border-emerald-900/40 dark:hover:border-emerald-800/60 dark:hover:bg-emerald-950/30",
  },
  scenario_link: {
    section:
      "border-rose-200/80 bg-rose-50/80 dark:border-rose-900/50 dark:bg-rose-950/20",
    chip: "border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-800/60 dark:bg-rose-900/40 dark:text-rose-200",
    badge:
      "border-rose-300/80 bg-rose-100/80 text-rose-700 dark:border-rose-800/70 dark:bg-rose-900/40 dark:text-rose-200",
    button:
      "border-rose-200/70 hover:border-rose-300 hover:bg-rose-50/90 dark:border-rose-900/40 dark:hover:border-rose-800/60 dark:hover:bg-rose-950/30",
  },
};

function clampPosition(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeSearchValue(value: string) {
  return value.trim().toLowerCase();
}

function paletteItemMatchesQuery(params: {
  item: ScenarioNodePaletteItem;
  query: string;
  section: ScenarioNodePaletteMenuSection;
}) {
  const { item, query, section } = params;
  if (!query) return true;

  return [
    item.title ?? item.id,
    item.id,
    section.title,
    section.subtitle ?? "",
  ].some(value => value.toLowerCase().includes(query));
}

export const ScenarioNodePaletteMenu = memo(function ScenarioNodePaletteMenu({
  contextMenu,
  title,
  sourceLabel,
  searchPlaceholder,
  emptyLabel,
  sections,
  onAddNodeFromPaletteItem,
  onClose,
  route,
}: ScenarioNodePaletteMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const returnFocusTargetRef = useRef<HTMLElement | null>(null);
  const contextMenuKey = contextMenu
    ? [
        contextMenu.connectFromNodeId ?? "canvas",
        contextMenu.connectFromSourceHandle ?? "default",
        contextMenu.left,
        contextMenu.top,
      ].join(":")
    : "closed";
  const [queryState, setQueryState] = useState({
    key: contextMenuKey,
    value: "",
  });
  const query = queryState.key === contextMenuKey ? queryState.value : "";
  const [existingStepsKey, setExistingStepsKey] = useState<string | null>(null);
  const showExistingSteps =
    existingStepsKey === contextMenuKey || Boolean(query.trim());
  const destinationMatches =
    route?.destinations.filter(destination =>
      destination.label.toLowerCase().includes(query.trim().toLowerCase())
    ) ?? [];
  const setQuery = useCallback(
    (value: string) => setQueryState({ key: contextMenuKey, value }),
    [contextMenuKey]
  );
  const [resolvedPosition, setResolvedPosition] = useState({
    left: contextMenu?.left ?? MENU_EDGE_PADDING,
    top: contextMenu?.top ?? MENU_EDGE_PADDING,
    maxHeight: 520,
  });
  const normalizedQuery = normalizeSearchValue(query);
  const filteredSections = useMemo(() => {
    if (!normalizedQuery) return sections;

    const nextSections: ScenarioNodePaletteMenuSection[] = [];
    for (const section of sections) {
      const items = section.items.filter(item =>
        paletteItemMatchesQuery({ item, query: normalizedQuery, section })
      );
      if (items.length > 0) {
        nextSections.push({ ...section, items });
      }
    }
    return nextSections;
  }, [normalizedQuery, sections]);

  const menuOpen = Boolean(contextMenu);
  useEffect(() => {
    if (!menuOpen) {
      const returnFocusTarget = returnFocusTargetRef.current;
      returnFocusTargetRef.current = null;
      returnFocusTarget?.focus();
      return;
    }

    const activeElement =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (activeElement && !menuRef.current?.contains(activeElement)) {
      returnFocusTargetRef.current = activeElement;
    }
    searchInputRef.current?.focus();
  }, [contextMenuKey, menuOpen]);

  useEffect(() => {
    return () => {
      const returnFocusTarget = returnFocusTargetRef.current;
      returnFocusTargetRef.current = null;
      returnFocusTarget?.focus();
    };
  }, []);

  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) return;

    const menu = menuRef.current;
    const container =
      menu.offsetParent instanceof HTMLElement
        ? menu.offsetParent
        : menu.parentElement;

    if (!container) return;

    const updatePosition = () => {
      const maxHeight = Math.max(
        0,
        container.clientHeight - MENU_EDGE_PADDING * 2
      );
      const menuWidth = Math.min(
        menu.offsetWidth,
        container.clientWidth - MENU_EDGE_PADDING * 2
      );
      const menuHeight = Math.min(menu.scrollHeight, maxHeight);
      const maxLeft = Math.max(
        MENU_EDGE_PADDING,
        container.clientWidth - menuWidth - MENU_EDGE_PADDING
      );
      const maxTop = Math.max(
        MENU_EDGE_PADDING,
        container.clientHeight - menuHeight - MENU_EDGE_PADDING
      );
      const left = clampPosition(contextMenu.left, MENU_EDGE_PADDING, maxLeft);
      const top = clampPosition(contextMenu.top, MENU_EDGE_PADDING, maxTop);

      setResolvedPosition(previous =>
        previous.left === left &&
        previous.top === top &&
        previous.maxHeight === maxHeight
          ? previous
          : { left, top, maxHeight }
      );
    };

    updatePosition();

    const disconnectMenuObserver = observeElementResize(menu, updatePosition);
    const disconnectContainerObserver = observeElementResize(
      container,
      updatePosition
    );
    window.addEventListener("resize", updatePosition);

    return () => {
      disconnectMenuObserver();
      disconnectContainerObserver();
      window.removeEventListener("resize", updatePosition);
    };
  }, [contextMenu, filteredSections, sourceLabel]);

  if (!contextMenu) return null;

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-label={title}
      className="absolute z-20 w-[320px] max-w-[calc(100%-24px)]"
      style={{
        left: resolvedPosition.left,
        top: resolvedPosition.top,
      }}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={handleMenuKeyDown}
    >
      <Card
        className="gap-0 overflow-hidden border-border/80 py-0 shadow-2xl backdrop-blur supports-[backdrop-filter]:bg-background/95"
        style={{ maxHeight: resolvedPosition.maxHeight }}
      >
        <CardHeader className="border-b bg-muted/20 px-4 py-3">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
          {sourceLabel ? (
            <div className="mt-1 rounded-md border border-border/70 bg-background/70 px-2 py-1 text-[11px] font-medium text-muted-foreground">
              {sourceLabel}
            </div>
          ) : null}
          <div
            className="relative mt-1"
            onMouseDown={event => event.stopPropagation()}
            onPointerDown={event => event.stopPropagation()}
          >
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-8 w-full rounded-md border border-border/70 bg-background/90 pl-8 pr-2 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
              onChange={event => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
          </div>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 space-y-3 overflow-y-auto px-4 pb-4 pt-3">
          {route ? (
            <div className="space-y-1">
              <button
                type="button"
                role="menuitem"
                className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  const item = sections
                    .flatMap(section => section.items)
                    .find(item => item.id === "action-reply");
                  if (item) onAddNodeFromPaletteItem(item);
                }}
              >
                <MessageSquare className="size-4" />
                {route.newMessageLabel}
              </button>
              <button
                type="button"
                role="menuitem"
                aria-expanded={showExistingSteps}
                className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setExistingStepsKey(contextMenuKey);
                  searchInputRef.current?.focus();
                }}
              >
                <Link2 className="size-4" />
                {route.existingStepLabel}
              </button>
              {showExistingSteps && (
                <div className="max-h-64 overflow-y-auto rounded-md border p-1">
                  {destinationMatches.length ? (
                    destinationMatches.map(destination => (
                      <button
                        key={destination.nodeId}
                        type="button"
                        role="menuitem"
                        className="flex min-h-10 w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => route.onSelect(destination.nodeId)}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {destination.label}
                        </span>
                        {destination.nodeId === route.currentDestinationId && (
                          <Check className="size-4 shrink-0" aria-hidden />
                        )}
                      </button>
                    ))
                  ) : (
                    <p className="p-3 text-xs text-muted-foreground">
                      {emptyLabel}
                    </p>
                  )}
                </div>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={route.onEnd}
                className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CircleStop className="size-4" />
                {route.endLabel}
              </button>
              {route.currentDestinationId && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={route.onDisconnect}
                    className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Unlink className="size-4" />
                    {route.disconnectLabel}
                  </button>
                  {route.onToggleBranch && (
                    <>
                      <Separator
                        decorative={false}
                        className="my-1"
                        data-testid="route-branch-separator"
                      />
                      <button
                        type="button"
                        role="menuitem"
                        onClick={route.onToggleBranch}
                        className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {route.branchCollapsed ? (
                          <ChevronsUpDown className="size-4" aria-hidden />
                        ) : (
                          <ChevronsDownUp className="size-4" aria-hidden />
                        )}
                        {route.branchLabel}
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          ) : filteredSections.length > 0 ? (
            filteredSections.map(section => {
              const Icon = section.icon;
              const sectionStyle = MENU_KIND_STYLES[section.id];

              return (
                <section
                  key={section.id}
                  className={cn(
                    "rounded-xl border p-2.5",
                    sectionStyle.section
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border shadow-sm",
                        sectionStyle.chip
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-foreground/80">
                          {section.title}
                        </div>
                        <Badge
                          variant="outline"
                          className={cn(
                            "px-1.5 py-0 text-[10px] font-semibold",
                            sectionStyle.badge
                          )}
                        >
                          {section.items.length}
                        </Badge>
                      </div>
                      {section.subtitle ? (
                        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                          {section.subtitle}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {section.items.map(item => (
                      <div
                        key={item.id}
                        title={item.disabled ? item.disabledHint : undefined}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => onAddNodeFromPaletteItem(item)}
                          disabled={item.disabled}
                          aria-disabled={item.disabled}
                          className={cn(
                            "group flex w-full items-center gap-3 rounded-xl border bg-background/90 px-3 py-2.5 text-left transition-[background-color,border-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
                            sectionStyle.button
                          )}
                        >
                          <div
                            className={cn(
                              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border shadow-sm transition-transform duration-150 group-hover:scale-[1.03]",
                              sectionStyle.chip
                            )}
                          >
                            <Icon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold leading-snug">
                              {item.title ?? item.id}
                            </div>
                            {item.disabled && item.disabledHint ? (
                              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                                {item.disabledHint}
                              </p>
                            ) : null}
                          </div>
                          <Plus className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:scale-110 group-hover:text-foreground" />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })
          ) : (
            <div className="rounded-lg border border-dashed border-border/80 px-3 py-6 text-center text-xs text-muted-foreground">
              {emptyLabel}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
});
