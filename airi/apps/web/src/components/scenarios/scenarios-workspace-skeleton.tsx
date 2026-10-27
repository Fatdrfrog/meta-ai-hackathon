import { Skeleton } from "@/components/ui/skeleton";

export function ScenariosWorkspaceSkeleton() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="border-b bg-background px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Skeleton className="h-10 w-10 rounded-md sm:h-8 sm:w-8" />
          <Skeleton className="h-11 w-24 rounded-md sm:h-9 sm:w-20" />
          <Skeleton className="ml-auto h-8 w-20 rounded-md" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-16 shrink-0 flex-col overflow-hidden border-r bg-muted/20 p-2 md:w-80">
          <div className="hidden flex-col gap-2 md:flex">
            <Skeleton className="h-8 w-full rounded-md" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-7 w-24 rounded-md" />
              <Skeleton className="h-7 w-16 rounded-md" />
              <Skeleton className="ml-auto h-7 w-7 rounded-md" />
            </div>
          </div>
          <div className="mt-1 flex min-h-0 flex-1 flex-col items-center gap-2 md:mt-3 md:items-stretch">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="h-10 w-10 shrink-0 rounded-lg border bg-background/80 p-2 md:h-auto md:w-auto md:p-3"
              >
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="mt-2 hidden h-3 w-1/2 md:block" />
              </div>
            ))}
          </div>
        </aside>
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/20">
          <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border)/0.45)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border)/0.45)_1px,transparent_1px)] bg-[size:28px_28px]" />
          <div className="absolute left-10 top-16 w-48 rounded-lg border bg-background/95 p-3 shadow-sm">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
          <div className="absolute left-[19rem] top-28 w-52 rounded-lg border bg-background/95 p-3 shadow-sm">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-3 w-36" />
          </div>
        </div>
      </div>
    </div>
  );
}
