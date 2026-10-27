import { cn } from "@/lib/utils";

/** Quiet, bounded surfaces keep the data ahead of the card chrome. */
export const ANALYTICS_CARD_CLASS = "border border-border/80 shadow-none";

/** Compact KPI / metric tiles. */
export const ANALYTICS_STAT_CARD_CLASS = cn(
  ANALYTICS_CARD_CLASS,
  "min-w-0 gap-3 py-4"
);

/**
 * Applied on the analytics content shell so every shadcn Card
 * uses the same restrained surface, including existing specialist reports.
 */
export const ANALYTICS_SURFACE_CLASS = cn(
  "[&_[data-slot=card]]:!border-border/80",
  "[&_[data-slot=card]]:!shadow-none",
  "[&_[data-slot=card]_[data-slot=card]]:!shadow-none",
  "[&_[data-slot=card]_[data-slot=card]]:bg-muted/25"
);
