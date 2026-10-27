"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Plus, Trash2 } from "lucide-react";
import type {
  ComponentProps,
  KeyboardEvent,
  ReactElement,
  ReactNode,
  SyntheticEvent,
} from "react";

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

/**
 * Names an icon-only control on hover. It never carries information the
 * control's accessible name doesn't already give.
 */
export function ReplyOptionTooltip({
  label,
  children,
  side = "top",
}: {
  label: ReactNode;
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type ReplyOptionComposerProps = {
  value: string;
  onValueChange: (next: string) => void;
  onSubmit: () => void;
  /** Accessible name of the input; the placeholder is only an example. */
  ariaLabel: string;
  placeholder: string;
  addLabel: string;
  disabled?: boolean;
  maxLength?: number;
  className?: string;
  rowClassName?: string;
  inputClassName?: string;
  buttonClassName?: string;
  iconClassName?: string;
  footer?: ReactNode;
  onEnter?: (event: KeyboardEvent<HTMLInputElement>) => void;
};

export function ReplyOptionComposer({
  value,
  onValueChange,
  onSubmit,
  ariaLabel,
  placeholder,
  addLabel,
  disabled,
  maxLength,
  className,
  rowClassName,
  inputClassName,
  buttonClassName,
  iconClassName,
  footer,
  onEnter,
}: ReplyOptionComposerProps) {
  return (
    <div className={className}>
      <div
        className={cn("flex w-full min-w-0 items-center gap-1.5", rowClassName)}
      >
        <Input
          value={value}
          aria-label={ariaLabel}
          onChange={event => onValueChange(event.target.value)}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key !== "Enter") {
              return;
            }

            event.preventDefault();
            if (onEnter) {
              onEnter(event);
              return;
            }
            onSubmit();
          }}
          placeholder={placeholder}
          className={cn("nodrag nopan min-w-0 flex-1", inputClassName)}
          maxLength={maxLength}
        />
        <ReplyOptionTooltip label={addLabel}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "nodrag nopan nokey h-8 w-8 shrink-0",
              buttonClassName
            )}
            onClick={event => {
              event.stopPropagation();
              onSubmit();
            }}
            onPointerDown={stopPropagation}
            disabled={disabled}
            aria-label={addLabel}
          >
            <Plus className={cn("h-3.5 w-3.5", iconClassName)} aria-hidden />
          </Button>
        </ReplyOptionTooltip>
      </div>
      {footer}
    </div>
  );
}

export function ReplyOptionFieldRow({
  children,
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div className={cn("flex items-center gap-1.5", className)} {...props}>
      {children}
    </div>
  );
}

type ReplyOptionDeleteButtonProps = {
  label: string;
  onClick: () => void;
  className?: string;
  iconClassName?: string;
};

export function ReplyOptionDeleteButton({
  label,
  onClick,
  className,
  iconClassName,
}: ReplyOptionDeleteButtonProps) {
  return (
    <ReplyOptionTooltip label={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("nodrag nopan nokey h-8 w-8 shrink-0", className)}
        onClick={event => {
          event.stopPropagation();
          onClick();
        }}
        onPointerDown={stopPropagation}
        aria-label={label}
      >
        <Trash2 className={cn("h-3.5 w-3.5", iconClassName)} aria-hidden />
      </Button>
    </ReplyOptionTooltip>
  );
}

type BranchConnectionDotProps = {
  connected: boolean;
  /** "Connected" or "Not connected"; the dot's accessible name and tooltip. */
  label: string;
  /** Options without a route, such as link buttons, render no dot. */
  payload?: string;
  connectedClassName?: string;
  missingClassName?: string;
  className?: string;
};

export function BranchConnectionDot({
  connected,
  label,
  payload,
  connectedClassName,
  missingClassName,
  className,
}: BranchConnectionDotProps) {
  if (!payload) return null;

  return (
    <ReplyOptionTooltip label={label}>
      <span
        role="img"
        aria-label={label}
        data-connected={String(connected)}
        className={cn(
          "h-2 w-2 shrink-0 rounded-full border",
          connected
            ? (connectedClassName ?? "border-emerald-500 bg-emerald-400")
            : (missingClassName ?? "border-amber-300 bg-amber-200"),
          className
        )}
      />
    </ReplyOptionTooltip>
  );
}
