"use client";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Info } from "lucide-react";
import { useId, useState, type ReactNode, type SyntheticEvent } from "react";

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * An info button that shows one short sentence. It opens on click, tap, Enter
 * or Space, never on hover, so it works on touch and inside canvas nodes.
 * Focus stays on the button, so a hidden copy of the sentence describes it
 * for screen readers.
 */
export function ScenarioInfoHint({
  label,
  children,
  side = "top",
  describedById,
  className,
}: {
  /** Accessible name of the button, e.g. t("infoHintLabel", { topic }). */
  label: string;
  /** One short sentence. */
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  /** Id of the hidden copy, so a field can point aria-describedby at it too. */
  describedById?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const autoId = useId();
  const descriptionId = describedById ?? autoId;
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-describedby={descriptionId}
            data-scenario-info-hint=""
            className={cn(
              "nodrag nopan nokey inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground",
              className
            )}
            onClick={stopPropagation}
            onPointerDown={stopPropagation}
            onKeyDown={stopPropagation}
          >
            <Info className="size-3.5" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side={side}
          updatePositionStrategy="always"
          className="nodrag nopan nokey w-auto max-w-64 p-2 text-xs leading-snug"
          onOpenAutoFocus={event => event.preventDefault()}
          onClick={stopPropagation}
          onPointerDown={stopPropagation}
          onKeyDown={stopPropagation}
        >
          {children}
        </PopoverContent>
      </Popover>
      <span id={descriptionId} className="sr-only">
        {children}
      </span>
    </>
  );
}
