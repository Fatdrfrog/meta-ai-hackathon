import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder for one Requests list row while the list loads. */
export function RequestRowSkeleton() {
  return (
    <div className="flex flex-col gap-2 border-b border-border/40 px-3 py-3 md:p-3">
      <div className="flex w-full items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-3 w-16 shrink-0" />
      </div>
      <div className="flex flex-col gap-1.5 pl-10">
        <Skeleton className="h-3 w-full max-w-md" />
        <Skeleton className="h-3 w-3/4 max-w-xs" />
        <div className="mt-1 flex items-center gap-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
        </div>
      </div>
    </div>
  );
}
