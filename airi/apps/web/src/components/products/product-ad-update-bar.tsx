"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type { ProductAdRunKind } from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { CircleAlertIcon, StatusDot, clockTime } from "./product-ad-parts";
import styles from "./product-ad-studio.module.css";
import theme from "./product-theme.module.css";
import { useNow } from "./use-product-ad";

// The update card: what the owner changed that isn't in the video yet, and
// the one free "Update the video" (the page's one rose action while changes
// wait), with Undo all. While a run goes it says so with its clock; when the
// latest edit run failed it says why, with the earlier video still there,
// and offers Try again. On a phone the card stays in the page and its action
// sits in the bar at the bottom.

const COPY = PRODUCTS_COPY.ad;

/** The run going on the ad, as the card shows it. */
export type AdRunning = { kind: ProductAdRunKind; since: string };

export type AdUpdateProps = {
  /** Each change that isn't in the video yet, in words. */
  pending: readonly string[];
  /** Whether the changes can go in now: they pass the checks and nothing else runs. */
  canUpdate: boolean;
  onUpdate: () => void;
  onUndoAll: () => void;
  /** While "Update the video" is being sent. */
  saving: boolean;
  /** Why the update press failed; null when it didn't. */
  problem: string | null;
  /** The run going on now; null when the ad is ready. */
  running: AdRunning | null;
  /** Why the latest edit run failed, and whether Try again makes the video again. */
  failed: { reason: string; canRetry: boolean } | null;
  onRetry: () => void;
  retrying: boolean;
  retryProblem: string | null;
};

function RunningLine({ running }: { running: AdRunning }) {
  const now = useNow(true);
  const clock = clockTime(now - Date.parse(running.since));
  return (
    <p className={styles.runningLine}>
      <StatusDot />
      <span>
        {running.kind === "scene"
          ? COPY.makingPicture(clock)
          : COPY.updating(clock)}
      </span>
    </p>
  );
}

/** The card, in the side column (and under the picture on a phone). */
export function AdUpdateCard({
  pending,
  canUpdate,
  onUpdate,
  onUndoAll,
  saving,
  problem,
  running,
  failed,
  onRetry,
  retrying,
  retryProblem,
  showAction,
}: AdUpdateProps & {
  /** Whether the card holds the Update button; on a phone the bar does. */
  showAction: boolean;
}) {
  const count = pending.length;
  if (!running && !failed && count === 0) return null;
  return (
    <section
      className={cn(theme.sheet, styles.updateCard)}
      data-pending={count > 0 && !running ? "" : undefined}
      aria-label={COPY.update}
    >
      {running ? (
        <div className={styles.field} aria-live="polite">
          <RunningLine running={running} />
          <p className={styles.note}>
            {running.kind === "scene" ? COPY.rideAlong : COPY.waitForUpdate}
          </p>
        </div>
      ) : null}
      {!running && failed ? (
        <div className={styles.field}>
          <p role="alert" className={styles.alert}>
            <CircleAlertIcon />
            <span>{COPY.updateFailed(failed.reason)}</span>
          </p>
          {retryProblem ? (
            <p role="alert" className={styles.issue}>
              {retryProblem}
            </p>
          ) : null}
          {failed.canRetry ? (
            <div className={styles.actions}>
              <Button
                variant="outline"
                size="sm"
                disabled={retrying}
                onClick={onRetry}
              >
                {retrying ? COPY.starting : COPY.tryAgain}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {!running && count > 0 ? (
        <div className={styles.field}>
          <h3 className={styles.sectionTitle}>{COPY.pendingTitle(count)}</h3>
          <ul className={styles.pendingList}>
            {pending.map(change => (
              <li key={change}>{change}</li>
            ))}
          </ul>
          {showAction ? (
            <Button fullWidth disabled={!canUpdate} onClick={onUpdate}>
              {saving ? COPY.saving : COPY.update}
            </Button>
          ) : null}
          <div className={styles.updateFoot}>
            <span className={styles.note}>{COPY.updateNote}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={onUndoAll}
            >
              {COPY.undoAll}
            </Button>
          </div>
          {problem ? (
            <p role="alert" className={styles.issue}>
              {problem}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** The phone's bar: "{n} changes · Update the video", or the run going on. */
export function AdUpdateBarAction({
  pending,
  canUpdate,
  onUpdate,
  saving,
  running,
}: Pick<
  AdUpdateProps,
  "pending" | "canUpdate" | "onUpdate" | "saving" | "running"
>) {
  if (running)
    return (
      <div aria-hidden="true" className={styles.barRunning}>
        <RunningLine running={running} />
      </div>
    );
  return (
    <Button fullWidth disabled={!canUpdate} onClick={onUpdate}>
      {saving
        ? COPY.saving
        : `${COPY.pendingBar(pending.length)} · ${COPY.update}`}
    </Button>
  );
}
