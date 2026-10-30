"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import { cn } from "@/lib/utils";
import {
  AudioLines,
  Check,
  CircleAlert,
  Film,
  ListChecks,
  ScanSearch,
  Scissors,
  type LucideIcon,
} from "lucide-react";
import { STAGE_STEPS, type StageStep } from "./product-stage-model";
import styles from "./product-stage.module.css";

const COPY = PRODUCTS_COPY.stage;

const STEP_ICONS: Record<StageStep, LucideIcon> = {
  prepare: Film,
  listen: AudioLines,
  watch: ScanSearch,
  photos: Scissors,
  check: ListChecks,
};

type StepState = "done" | "current" | "stopped" | "upcoming";

// Below lg the rail is a row of segments; the step text keeps its place for
// screen readers. A stop is dashed, so it never reads as a second current step.
const SEGMENT: Record<StepState, string> = {
  done: "bg-foreground/55",
  current: "bg-primary",
  stopped:
    "bg-[repeating-linear-gradient(90deg,var(--destructive)_0_5px,transparent_5px_8px)]",
  upcoming: "bg-foreground/12",
};

// The collapsed rail's one line names the step's maker in short.
const shortMaker = (step: StageStep) => {
  const copy = COPY.steps[step];
  return "short" in copy ? copy.short : copy.maker;
};

/**
 * The steps from a video to products on the shelf, each with who does it.
 * From lg it's a column beside the stage; below that, segments with the
 * current step's line under them, across the full width.
 */
export function StageRail({
  current,
  stopped = null,
  busy = false,
  counts = {},
}: {
  current: StageStep;
  /** Where photos, or the whole import, stopped. */
  stopped?: StageStep | null;
  /** Whether the current step is being worked on now. */
  busy?: boolean;
  /** A step's progress, such as "2 of 5". */
  counts?: Partial<Record<StageStep, string>>;
}) {
  const currentIndex = STAGE_STEPS.indexOf(current);
  const states = STAGE_STEPS.map(
    (step, index): StepState =>
      step === stopped
        ? "stopped"
        : index < currentIndex
          ? "done"
          : step === current
            ? "current"
            : "upcoming"
  );

  return (
    <div className="min-w-0 lg:py-1">
      <div aria-hidden="true" className="grid grid-cols-5 gap-1.5 lg:hidden">
        {states.map((state, index) => (
          <span
            key={STAGE_STEPS[index]}
            className={cn("h-1 rounded-full", SEGMENT[state])}
          />
        ))}
      </div>
      {/* From lg the steps spread down beside the stage; the cap keeps them
          from drifting far apart on a tall one. */}
      <ol
        aria-label={COPY.stepsLabel}
        className="mt-2.5 lg:mt-0 lg:flex lg:h-full lg:max-h-[27rem] lg:flex-col lg:justify-between lg:gap-4"
      >
        {STAGE_STEPS.map((step, index) => {
          const state = states[index]!;
          const isCurrent = step === current;
          const Icon =
            state === "done"
              ? Check
              : state === "stopped"
                ? CircleAlert
                : STEP_ICONS[step];
          const count = counts[step];
          return (
            <li
              key={step}
              aria-current={isCurrent ? "step" : undefined}
              data-step={step}
              data-state={state}
              className={cn(
                isCurrent
                  ? "flex flex-nowrap items-baseline gap-x-2"
                  : "max-lg:sr-only",
                "lg:grid lg:grid-cols-[1.75rem_minmax(0,1fr)_auto] lg:items-center lg:gap-x-2.5 lg:gap-y-0.5"
              )}
            >
              <span
                aria-hidden="true"
                data-state={state}
                data-busy={busy && state === "current" ? "" : undefined}
                className={cn(
                  styles.dot,
                  "relative hidden size-7 place-items-center rounded-full lg:row-span-2 lg:grid"
                )}
              >
                <Icon className="size-3.5" strokeWidth={2.2} />
              </span>
              <span
                className={cn(
                  "shrink-0 text-sm font-medium",
                  // The dot says "not yet"; the words stay readable.
                  state === "upcoming" && "text-muted-foreground"
                )}
              >
                {COPY.steps[step].label}
              </span>
              {count ? (
                <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums lg:justify-self-end">
                  {count}
                </span>
              ) : null}
              <span className="min-w-0 truncate text-xs text-muted-foreground lg:hidden">
                {shortMaker(step)}
              </span>
              <span className="text-xs text-balance text-muted-foreground max-lg:hidden lg:col-span-2 lg:col-start-2">
                {COPY.steps[step].maker}
              </span>
              {state === "done" || state === "stopped" ? (
                <span className="sr-only">
                  {state === "done" ? COPY.stepDone : COPY.stepStopped}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
