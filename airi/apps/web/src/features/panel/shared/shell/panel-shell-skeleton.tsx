import { PanelSkeleton } from "@/components/ui/panel-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { ReactNode } from "react";

/**
 * The workspace frame (header bar over the page area) shown while a hard load
 * waits for the workspace layout, so the first paint already has the panel's
 * shape instead of a full-screen spinner. Sizes follow SiteHeader and
 * PanelMain.
 */
export function PanelShellSkeleton({ children }: { children?: ReactNode }) {
  return (
    <div className="flex h-svh w-full flex-col" aria-busy="true">
      <span className="sr-only">
        <Spinner />
      </span>
      <div className="flex min-h-[48px] w-full min-w-0 shrink-0 items-center gap-[4px] border-b bg-background px-[12px] py-[4px] md:min-h-12 md:gap-2 md:px-4 lg:px-3">
        <Skeleton className="size-8 shrink-0 md:size-7" />
        <Skeleton className="ml-auto size-8 shrink-0 rounded-lg" />
        <Skeleton className="h-8 w-24 shrink-0 sm:w-36" />
        <Skeleton className="size-8 shrink-0" />
        <Skeleton className="size-8 shrink-0" />
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {children ?? <PanelSkeleton />}
      </div>
    </div>
  );
}
