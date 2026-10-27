"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslations } from "next-intl";

export function MetricHelpTooltip({
  label,
  text,
}: {
  label: string;
  text: string;
}) {
  const t = useTranslations("DashboardClientPage");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 items-center justify-center rounded text-xs text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${t("metricDefinition")}: ${label}`}
        >
          {t("metricDefinition")}
        </button>
      </TooltipTrigger>
      <TooltipContent
        showArrow={false}
        side="top"
        sideOffset={6}
        className="max-w-64 px-3 py-2 text-left text-xs leading-relaxed text-balance"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
