import { cn } from "@/lib/utils";
import { ImageIcon } from "lucide-react";

/**
 * Stands in, at the media's size, for media whose display URL has not
 * arrived yet (see resolveScenarioMediaDisplayUrl).
 */
export function ScenarioMediaPlaceholder({
  label,
  className,
  testId,
}: {
  /** The accessible name the media itself would have. */
  label: string;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      data-testid={testId}
      className={cn(
        "flex items-center justify-center bg-muted text-muted-foreground",
        className
      )}
    >
      <ImageIcon className="size-4" aria-hidden />
    </div>
  );
}
