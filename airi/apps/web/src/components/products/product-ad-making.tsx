"use client";

import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  PRODUCT_AD_STEPS,
  type ProductAdRecord,
  type ProductAdStep,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { useId } from "react";
import {
  AdBriefLine,
  AdDownload,
  AdHead,
  AdProductChips,
  AdSceneList,
  AdSketch,
  AdStill,
  StatusDot,
  adFileName,
  clockTime,
} from "./product-ad-parts";
import styles from "./product-ad-studio.module.css";
import { ProductChip } from "./product-controls";
import theme from "./product-theme.module.css";
import { useNow } from "./use-product-ad";

// The ad being made: an honest step list, each step with the model doing it
// and its seconds, one determinate bar, and the scenes filling in (the exact
// photo first, then Muse Image's picture once Muse Spark checked it). The
// clock and the counts are what moves; nothing loops.

const COPY = PRODUCTS_COPY.ad;

/** No step started this long after the press: the media queue is busy. */
export const WAITING_FOR_SLOT_MS = 10_000;

// How much of the bar each step fills: the pictures take longest.
const STEP_WEIGHTS: Record<ProductAdStep, number> = {
  script: 0.15,
  pictures: 0.45,
  framing: 0.1,
  video: 0.3,
};

export type MakingStep = {
  step: ProductAdStep;
  name: string;
  model: string;
  state: "done" | "now" | "next";
  /** Seconds it took, or so far; null when there's nothing true to show. */
  seconds: number | null;
};

const stepIndex = (step: ProductAdStep | null) =>
  step ? PRODUCT_AD_STEPS.indexOf(step) : -1;

const museCount = (ad: ProductAdRecord) =>
  ad.scenes.filter(scene => scene.method === "muse").length;

/** Whether every scene's picture is settled: Muse Image's, or the exact photo for good. */
export function picturesSettled(ad: ProductAdRecord): boolean {
  return (
    ad.status !== "making" ||
    stepIndex(ad.step) > PRODUCT_AD_STEPS.indexOf("pictures")
  );
}

/** The step list as it stands at `now`. */
export function makingSteps(ad: ProductAdRecord, now: number): MakingStep[] {
  const current = stepIndex(ad.step);
  const requested = Date.parse(ad.requestedAt);
  const muse = museCount(ad);
  const total = ad.products.length;
  return PRODUCT_AD_STEPS.map((step, index) => {
    const state =
      current === -1
        ? "next"
        : index < current
          ? "done"
          : index === current
            ? "now"
            : "next";
    const timing = ad.timings[step];
    const started = timing ? Date.parse(timing.startedAt) : Number.NaN;
    const finished = timing?.finishedAt
      ? Date.parse(timing.finishedAt)
      : Number.NaN;
    // A step's start from an earlier run says nothing about this one.
    const seconds =
      state === "done" && Number.isFinite(started) && Number.isFinite(finished)
        ? Math.max(0, Math.round((finished - started) / 1000))
        : state === "now" && Number.isFinite(started) && started >= requested
          ? Math.max(0, Math.floor((now - started) / 1000))
          : null;
    const name =
      step === "pictures"
        ? state === "done"
          ? COPY.steps.picturesMade(muse, total - muse)
          : COPY.steps.pictures(muse, total)
        : COPY.steps[step];
    return { step, name, model: COPY.stepModels[step], state, seconds };
  });
}

/** How far the ad is, 0 to 1: the steps done, and the pictures in so far. */
export function makingProgress(ad: ProductAdRecord): number {
  const current = stepIndex(ad.step);
  if (current === -1) return 0;
  let done = 0;
  PRODUCT_AD_STEPS.forEach((step, index) => {
    if (index < current) done += STEP_WEIGHTS[step];
    else if (index === current && step === "pictures" && ad.products.length)
      done += (STEP_WEIGHTS.pictures * museCount(ad)) / ad.products.length;
  });
  return Math.min(1, done);
}

export function AdMaking({ ad }: { ad: ProductAdRecord }) {
  const titleId = useId();
  const now = useNow(true);
  const elapsed = Math.max(0, now - Date.parse(ad.requestedAt));
  const waiting = ad.startedAt === null && elapsed > WAITING_FOR_SLOT_MS;
  const steps = makingSteps(ad, now);
  const progress = makingProgress(ad);
  const statusUrl = ad.stills.statusUrl;
  const scenePicture =
    ad.scenes.find(scene => scene.imageUrl)?.imageUrl ?? null;
  const first = ad.products[0];
  const captionOf = (productId: string) =>
    ad.script?.captions.find(entry => entry.productId === productId)?.caption;

  return (
    <section aria-labelledby={titleId} className={styles.studio}>
      <AdHead
        titleId={titleId}
        meta={COPY.summary(
          ad.products.map(product => product.name),
          null,
          ad.language
        )}
        status={
          <ProductChip tone="accent">
            <StatusDot />
            {COPY.making(clockTime(elapsed))}
          </ProductChip>
        }
      />
      <div className={styles.columns}>
        <aside className={styles.side}>
          <div className={styles.picture}>
            {statusUrl ? (
              <AdStill url={statusUrl} alt={COPY.statusPicture} />
            ) : scenePicture ? (
              <AdStill url={scenePicture} alt="" />
            ) : first ? (
              <AdSketch product={first} />
            ) : null}
          </div>
          {statusUrl ? (
            <div className={styles.downloads}>
              <p className={styles.note}>{COPY.statusPictureReady}</p>
              <AdDownload url={statusUrl} fileName={adFileName(ad, "status")}>
                {COPY.statusPicture}
              </AdDownload>
            </div>
          ) : null}
        </aside>

        <div className={styles.main}>
          <div className={cn(theme.sheet, styles.panel)}>
            <AdProductChips products={ad.products} />
            <AdBriefLine ad={ad} />
          </div>

          <div className={cn(theme.sheet, styles.panel)}>
            <h3 className={cn(theme.displayM, styles.title)}>
              {ad.renderNo > 1 && ad.step === "video"
                ? COPY.remakingTitle
                : COPY.makingTitle}
            </h3>
            <div
              role="progressbar"
              aria-label={COPY.progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
              className={styles.progress}
            >
              <div
                className={styles.progressFill}
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <ol className={styles.steps}>
              {steps.map(row => (
                <li
                  key={row.step}
                  className={styles.step}
                  data-state={row.state}
                >
                  <span className={styles.stepDot} aria-hidden="true">
                    {row.state === "done" ? <Check /> : null}
                  </span>
                  <span className={styles.stepText}>
                    <span className={styles.stepName}>
                      {row.name}
                      <span className="sr-only">
                        , {COPY.stepStates[row.state]}
                      </span>
                    </span>
                    <span className={styles.stepModel}>{row.model}</span>
                  </span>
                  <span className={styles.stepTime}>
                    {row.seconds === null ? "" : COPY.seconds(row.seconds)}
                  </span>
                </li>
              ))}
            </ol>
            {waiting ? (
              <p className={styles.note}>{COPY.waitingForSlot}</p>
            ) : null}
            <p className={styles.note}>{COPY.leave}</p>
          </div>

          <div className={cn(theme.sheet, styles.panel)}>
            <AdSceneList
              ad={ad}
              settled={picturesSettled(ad)}
              body={productId => {
                const caption = captionOf(productId);
                return caption ? (
                  <p className={styles.caption}>{caption}</p>
                ) : null;
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
