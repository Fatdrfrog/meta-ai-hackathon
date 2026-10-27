"use client";

import { ANALYTICS_STAT_CARD_CLASS } from "@/components/analytics/analytics-surface";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface StatsCardProps {
  title: string;
  value: string | number;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  subtitle?: string;
  color?: string;
}

export function StatsCard({
  title,
  value,
  trend,
  subtitle,
  color = "text-foreground",
}: StatsCardProps) {
  return (
    <Card className={ANALYTICS_STAT_CARD_CLASS}>
      <CardHeader className="gap-1 px-3">
        <CardTitle className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span className="min-w-0 break-words">{title}</span>
        </CardTitle>
        {trend ? (
          <div
            className={cn(
              "flex items-center gap-1 text-xs font-medium",
              trend.isPositive ? "text-chart-2" : "text-chart-1"
            )}
          >
            <span>
              {trend.value > 0 ? "+" : ""}
              {trend.value}%
            </span>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-0.5 px-3">
        <div
          className={cn(
            "break-words text-xl font-semibold tabular-nums",
            color
          )}
        >
          {value}
        </div>
        {subtitle ? (
          <CardDescription className="text-[11px] leading-snug">
            {subtitle}
          </CardDescription>
        ) : null}
      </CardContent>
    </Card>
  );
}
