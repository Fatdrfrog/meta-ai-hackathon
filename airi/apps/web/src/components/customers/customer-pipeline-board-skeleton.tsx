import { Skeleton } from "@/components/ui/skeleton";

const CARDS_PER_COLUMN = [4, 3, 5, 2];

/**
 * Mirrors the loaded board (compact lists as tall as their cards, dense
 * cards) so the route fallback, the lazy chunk fallback and the first fetch
 * don't jump. Kept out of customer-pipeline-board.tsx, which loads lazily.
 */
export function CustomerPipelineBoardSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-1 items-start gap-3 overflow-hidden pb-2">
      {CARDS_PER_COLUMN.map((cardCount, columnIndex) => (
        <div
          key={columnIndex}
          className="flex w-[280px] shrink-0 flex-col rounded-xl bg-muted/60 max-sm:w-[85vw]"
        >
          <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
            <Skeleton className="size-2.5 rounded-full" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="ml-auto h-4 w-6 rounded-full" />
          </div>
          <div className="flex flex-col gap-2 px-2 pb-2">
            {Array.from({ length: cardCount }).map((__, cardIndex) => (
              <div key={cardIndex} className="rounded-lg border bg-card p-2.5">
                <Skeleton className="mb-1.5 h-4 w-36" />
                <Skeleton className="mb-2 h-3 w-24" />
                <div className="mb-2 flex gap-1">
                  <Skeleton className="h-5 w-16 rounded-full" />
                  <Skeleton className="h-5 w-12 rounded-full" />
                </div>
                <Skeleton className="h-3 w-44" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
