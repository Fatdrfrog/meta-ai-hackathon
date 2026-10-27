import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function CampaignFlowStep({
  step,
  title,
  children,
  className,
  flush = false,
}: {
  step: number;
  title: string;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section
      data-testid="campaign-flow-step"
      data-step={String(step)}
      className={cn("min-w-0", className)}
    >
      <div className="mb-3 grid grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-x-3">
        <span
          aria-hidden="true"
          className="flex size-7 items-center justify-center rounded-full bg-foreground text-xs font-semibold tabular-nums text-background"
        >
          {step}
        </span>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      </div>
      <div className={cn("min-w-0", !flush && "sm:pl-10")}>{children}</div>
    </section>
  );
}
