"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import type { ReactNode, RefObject } from "react";
import { ScenarioInfoHint } from "./scenario-info-hint";
import {
  ScenarioIssueIcon,
  type ScenarioIssueVisualSeverity,
} from "./view/scenario-issue-visuals";

const TONE_CLASS: Record<ScenarioIssueVisualSeverity, string> = {
  warning:
    "border-amber-300/70 bg-amber-50/60 text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-300",
  error:
    "border-rose-300/70 bg-rose-50/60 text-rose-700 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-300",
  info: "border-sky-300/70 bg-sky-50/60 text-sky-800 dark:border-sky-500/30 dark:bg-sky-950/30 dark:text-sky-300",
};

/**
 * A one-line step notice. It has no live role unless `live` is set, which is
 * only for notices that appear after a user action.
 */
export function ScenarioInlineNotice({
  id,
  focusRef,
  tone = "warning",
  live = false,
  children,
  action,
  details,
  detailsLabel,
  className,
  "data-testid": dataTestId,
}: {
  /** For a field's `aria-describedby`. */
  id?: string;
  /** Lets the caller move focus to the notice, as when its button goes. */
  focusRef?: RefObject<HTMLDivElement | null>;
  tone?: ScenarioIssueVisualSeverity;
  live?: boolean;
  /** One line. */
  children: ReactNode;
  /** A small ghost or outline Button. */
  action?: ReactNode;
  /** Rendered through ScenarioInfoHint. */
  details?: string;
  /** Required when `details` is set. */
  detailsLabel?: string;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <Alert
      id={id}
      ref={focusRef}
      tabIndex={focusRef ? -1 : undefined}
      role={live ? (tone === "error" ? "alert" : "status") : undefined}
      data-tone={tone}
      data-testid={dataTestId}
      className={cn(
        "flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug",
        TONE_CLASS[tone],
        className
      )}
    >
      <span aria-hidden className="flex h-4 shrink-0 items-center">
        <ScenarioIssueIcon severity={tone} className="size-3.5" />
      </span>
      <AlertDescription className="block min-w-0 flex-1 break-words text-[11px] leading-snug text-inherit">
        {children}
      </AlertDescription>
      {details ? (
        <ScenarioInfoHint
          label={detailsLabel ?? ""}
          className="-my-1 text-current hover:text-current"
        >
          {details}
        </ScenarioInfoHint>
      ) : null}
      {action ? <div className="-my-0.5 shrink-0">{action}</div> : null}
    </Alert>
  );
}
