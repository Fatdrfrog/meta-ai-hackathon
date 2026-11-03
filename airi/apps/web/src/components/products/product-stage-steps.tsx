"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import { Check } from "lucide-react";
import { STAGE_STEPS, type StageStep } from "./product-stage-model";
import styles from "./product-stage.module.css";

const COPY = PRODUCTS_COPY.stage;

export type StageStepState = "done" | "current" | "stopped" | "upcoming";

/** Each step's state, from the current step and the one where it stopped. */
export function stepStates(
  current: StageStep,
  stopped: StageStep | null
): StageStepState[] {
  const currentIndex = STAGE_STEPS.indexOf(current);
  return STAGE_STEPS.map((step, index) =>
    step === stopped
      ? "stopped"
      : index < currentIndex
        ? "done"
        : step === current
          ? "current"
          : "upcoming"
  );
}

/**
 * The five steps from a video to products on the shelf, each naming who does
 * it: Airi, ElevenLabs Scribe, Muse Spark, SAM and Muse Image, then the
 * owner. Where there's room, a row of dots joined by lines, with what each
 * finished step came to under its credit; in a narrow column, five segments
 * and the current step's one line. Nothing on it moves on its own: a step
 * changes only when the import does.
 */
export function StageSteps({
  current,
  stopped = null,
  counts = {},
  results = {},
}: {
  current: StageStep;
  /** Where photos, or the whole import, stopped. */
  stopped?: StageStep | null;
  /** The current step's progress, such as "3 of 7". */
  counts?: Partial<Record<StageStep, string>>;
  /** What a step behind came to, such as "7 products found". */
  results?: Partial<Record<StageStep, string>>;
}) {
  const states = stepStates(current, stopped);
  return (
    <div className={styles.steps}>
      <div aria-hidden="true" className={styles.segments}>
        {states.map((state, index) => (
          <span key={STAGE_STEPS[index]} data-state={state} />
        ))}
      </div>
      <ol aria-label={COPY.stepsLabel} className={styles.stepList}>
        {STAGE_STEPS.map((step, index) => {
          const state = states[index]!;
          const copy = COPY.steps[step];
          const count = step === current ? counts[step] : undefined;
          const result = step === current ? undefined : results[step];
          return (
            <li
              key={step}
              data-step={step}
              data-state={state}
              aria-current={step === current ? "step" : undefined}
              className={styles.step}
            >
              <span aria-hidden="true" className={styles.dot}>
                {state === "done" ? (
                  <Check strokeWidth={3} />
                ) : state === "stopped" ? (
                  "!"
                ) : null}
              </span>
              <span className={styles.stepLabel}>
                {copy.label}
                {count ? (
                  <span className={styles.stepCount}>{count}</span>
                ) : null}
              </span>
              <span className={styles.stepMaker}>{copy.maker}</span>
              {/* On a phone, the step's one line names its makers in short. */}
              <span aria-hidden="true" className={styles.stepMakerShort}>
                {"short" in copy ? copy.short : copy.maker}
              </span>
              {result ? (
                <span className={styles.stepResult}>{result}</span>
              ) : null}
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
