"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { SCENARIO_COLLAPSIBLE_OPEN_EVENT } from "./scenario-collapsible-section-dom";
import { ScenarioInfoHint } from "./scenario-info-hint";

type ScenarioCollapsibleInfo = { label: string; text: string };

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * Open state of a section, controlled or not. It opens once when errors go
 * from 0 to above 0, and when `openScenarioCollapsibleAncestors` asks it to.
 */
function useScenarioCollapsibleOpen({
  defaultOpen,
  open: openProp,
  onOpenChange,
  errorCount,
}: {
  defaultOpen: boolean | undefined;
  open: boolean | undefined;
  onOpenChange: ((open: boolean) => void) | undefined;
  errorCount: number;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(
    () => (defaultOpen ?? false) || errorCount > 0
  );
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const isControlledRef = useRef(isControlled);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
    isControlledRef.current = isControlled;
  });

  const changeOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  // Uncontrolled: open when errors first appear, adjusted during render.
  const [trackedErrorCount, setTrackedErrorCount] = useState(errorCount);
  if (trackedErrorCount !== errorCount) {
    setTrackedErrorCount(errorCount);
    if (trackedErrorCount === 0 && errorCount > 0 && !isControlled) {
      setUncontrolledOpen(true);
    }
  }
  // Controlled: ask the owner to open when errors first appear.
  const previousErrorCountRef = useRef(errorCount);
  useEffect(() => {
    const previous = previousErrorCountRef.current;
    previousErrorCountRef.current = errorCount;
    if (previous === 0 && errorCount > 0 && isControlled && !openProp) {
      onOpenChangeRef.current?.(true);
    }
  }, [errorCount, isControlled, openProp]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const handleOpen = () => {
      if (!isControlledRef.current) setUncontrolledOpen(true);
      onOpenChangeRef.current?.(true);
    };
    root.addEventListener(SCENARIO_COLLAPSIBLE_OPEN_EVENT, handleOpen);
    return () =>
      root.removeEventListener(SCENARIO_COLLAPSIBLE_OPEN_EVENT, handleOpen);
  }, []);

  return { open, changeOpen, rootRef };
}

/** A count badge whose number is hidden when a screen reader label names it. */
function ScenarioCollapsibleCountBadge({
  variant,
  value,
  label,
  "data-testid": dataTestId,
}: {
  variant: "secondary" | "destructive";
  value: number;
  label?: string;
  "data-testid"?: string;
}) {
  return (
    <Badge
      variant={variant}
      data-testid={dataTestId}
      className="h-4 min-w-4 px-1 text-[10px] tabular-nums"
    >
      <span aria-hidden={label ? true : undefined}>{value}</span>
      {label ? <span className="sr-only">{label}</span> : null}
    </Badge>
  );
}

/** The trigger row: the trigger button with its badges, then the info hint. */
function ScenarioCollapsibleHeader({
  title,
  open,
  isSection,
  count,
  countLabel,
  errorCount,
  errorCountLabel,
  info,
}: {
  title: string;
  open: boolean;
  isSection: boolean;
  count: number | undefined;
  countLabel: string | undefined;
  errorCount: number;
  errorCountLabel: string | undefined;
  info: ScenarioCollapsibleInfo | undefined;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const hasCount = typeof count === "number" && count > 0;

  return (
    <div
      className={cn(
        "flex min-w-0 items-center",
        isSection ? "gap-1" : "gap-0.5",
        isSection && info && "pr-2"
      )}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            "nodrag nopan nokey flex min-w-0 items-center gap-1.5 text-left text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isSection
              ? "h-8 flex-1 px-3 text-foreground hover:bg-muted/50"
              : "h-6 rounded-md px-1 text-muted-foreground hover:text-foreground"
          )}
          onClick={stopPropagation}
          onPointerDown={stopPropagation}
        >
          <Chevron
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className={cn("truncate", isSection && "flex-1")}>{title}</span>
          {hasCount ? (
            <ScenarioCollapsibleCountBadge
              variant="secondary"
              value={count}
              label={countLabel}
            />
          ) : null}
          {errorCount > 0 ? (
            <ScenarioCollapsibleCountBadge
              variant="destructive"
              value={errorCount}
              label={errorCountLabel}
              data-testid="scenario-collapsible-error-count"
            />
          ) : null}
        </button>
      </CollapsibleTrigger>
      {info ? (
        <ScenarioInfoHint label={info.label}>{info.text}</ScenarioInfoHint>
      ) : null}
    </div>
  );
}

/** Muted one-line summary shown while the section is closed. */
function ScenarioCollapsibleSummary({
  summary,
  isSection,
}: {
  summary: string;
  isSection: boolean;
}) {
  return (
    <p
      className={cn(
        "truncate text-[11px] text-muted-foreground",
        isSection ? "px-3 pb-1.5" : "px-1"
      )}
    >
      {summary}
    </p>
  );
}

type ScenarioCollapsibleSectionProps = {
  title: string;
  /** Shown as a secondary badge when above 0. */
  count?: number;
  /** Screen reader text for the count, e.g. t("routeCount", { count }). */
  countLabel?: string;
  /** Muted one-line summary shown while closed. */
  summary?: string;
  /** Info hint rendered next to the trigger, not inside it. */
  info?: ScenarioCollapsibleInfo;
  /** Destructive count; the section opens when it goes from 0 to above 0. */
  errorCount?: number;
  /** Screen reader text for the error count. */
  errorCountLabel?: string;
  /** Rendered only while closed, e.g. route rows that own handles. */
  collapsedContent?: ReactNode;
  /** Keeps closed children mounted but hidden (form fields only). */
  keepMounted?: boolean;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: "section" | "inline";
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
};

/**
 * A section with a good default that the merchant opens when needed. Route
 * rows that own handles go in `collapsedContent`, which renders while the
 * section is closed, so their edges keep a source handle. `keepMounted` only
 * suits form fields: a hidden handle has no bounds for its edge.
 * Children and `collapsedContent` render edge to edge; callers pad them.
 */
export function ScenarioCollapsibleSection({
  title,
  count,
  countLabel,
  summary,
  info,
  errorCount = 0,
  errorCountLabel,
  collapsedContent,
  keepMounted = false,
  defaultOpen,
  open: openProp,
  onOpenChange,
  variant = "section",
  children,
  className,
  "data-testid": dataTestId,
}: ScenarioCollapsibleSectionProps) {
  const { open, changeOpen, rootRef } = useScenarioCollapsibleOpen({
    defaultOpen,
    open: openProp,
    onOpenChange,
    errorCount,
  });
  const isSection = variant === "section";

  return (
    <Collapsible
      ref={rootRef}
      open={open}
      onOpenChange={changeOpen}
      data-scenario-collapsible=""
      data-variant={variant}
      data-error-count={errorCount}
      data-testid={dataTestId}
      className={cn(
        "min-w-0",
        isSection && "border-t border-border/60",
        className
      )}
    >
      <ScenarioCollapsibleHeader
        title={title}
        open={open}
        isSection={isSection}
        count={count}
        countLabel={countLabel}
        errorCount={errorCount}
        errorCountLabel={errorCountLabel}
        info={info}
      />
      {!open && summary ? (
        <ScenarioCollapsibleSummary summary={summary} isSection={isSection} />
      ) : null}
      {!open ? collapsedContent : null}
      {keepMounted ? (
        <CollapsibleContent forceMount hidden={!open}>
          {children}
        </CollapsibleContent>
      ) : (
        <CollapsibleContent>{children}</CollapsibleContent>
      )}
    </Collapsible>
  );
}
