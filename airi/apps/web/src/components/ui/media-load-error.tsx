import { cn } from "@/lib/utils";

/**
 * A media element that failed to load: what failed, a retry and a direct link,
 * so a broken attachment never leaves the operator with a dead glyph.
 */
export function MediaLoadError({
  message,
  href,
  onRetry,
  className,
  actionsClassName,
  linkClassName,
}: {
  message: string;
  href?: string | null;
  onRetry?: () => void;
  className?: string;
  actionsClassName?: string;
  linkClassName?: string;
}) {
  return (
    <div role="alert" className={className}>
      <span>{message}</span>
      <span
        className={cn("flex flex-wrap items-center gap-2", actionsClassName)}
      >
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="font-medium underline underline-offset-2"
          >
            Retry
          </button>
        ) : null}
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "font-medium underline underline-offset-2",
              linkClassName
            )}
          >
            Open in new tab
          </a>
        ) : null}
      </span>
    </div>
  );
}
