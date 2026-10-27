"use client";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ComponentPropsWithoutRef } from "react";

type ScenarioNodeCardProps = ComponentPropsWithoutRef<typeof Card> & {
  selected?: boolean;
  muted?: boolean;
  interactive?: boolean;
};

/** Cancels Action node CardContent `px-3` so channel chrome can sit on the card edge. */
export const SCENARIO_NODE_CHANNEL_PREVIEW_BLEED_CLASS =
  "-mx-3 w-[calc(100%+1.5rem)] max-w-none";

export function ScenarioNodeCard({
  className,
  selected = false,
  muted = false,
  interactive = false,
  ...props
}: ScenarioNodeCardProps) {
  return (
    <Card
      className={cn(
        "relative border-2 bg-background/95 shadow-sm transition-shadow",
        selected && "shadow-lg ring-2 ring-primary/40",
        muted && "opacity-60",
        interactive && "cursor-pointer hover:shadow-lg hover:ring-2",
        className
      )}
      {...props}
    />
  );
}
