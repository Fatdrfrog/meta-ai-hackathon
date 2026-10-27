"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { Pencil, Sparkles } from "lucide-react";
import type { ReactNode, SyntheticEvent } from "react";
import type { TranslateFn } from "../../types";

export type ReplyModeToggleValue = "fixed" | "ai";

const ITEM_CLASS = "h-7 flex-none gap-1 px-2 text-xs";

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * Chooses who writes a message: the merchant's own text or AI. Trailing
 * controls, such as the Variables picker, wrap with the toggle.
 */
export function ReplyModeToggle({
  value,
  onChange,
  t,
  disabled = false,
  className,
  children,
}: {
  value: ReplyModeToggleValue;
  onChange: (value: ReplyModeToggleValue) => void;
  t: TranslateFn;
  disabled?: boolean;
  className?: string;
  /** Trailing controls, such as Variables. */
  children?: ReactNode;
}) {
  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}
    >
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        value={value}
        disabled={disabled}
        aria-label={t("actionReplyModeLabel")}
        className="nodrag nopan nokey"
        onValueChange={next => {
          // A second click on the active item would clear the value.
          if ((next === "fixed" || next === "ai") && next !== value) {
            onChange(next);
          }
        }}
        onClick={stopPropagation}
        onPointerDown={stopPropagation}
      >
        <ToggleGroupItem value="fixed" className={ITEM_CLASS}>
          <Pencil className="size-3.5" aria-hidden />
          {t("replyModeFixed")}
        </ToggleGroupItem>
        <ToggleGroupItem value="ai" className={ITEM_CLASS}>
          <Sparkles className="size-3.5" aria-hidden />
          {t("replyModeAi")}
        </ToggleGroupItem>
      </ToggleGroup>
      {children}
    </div>
  );
}
