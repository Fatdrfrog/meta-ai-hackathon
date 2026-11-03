"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type { ProductAdRecord } from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { useId, useState } from "react";
import { retryProductAd } from "./ads-client";
import {
  AdBar,
  AdBriefLine,
  AdDownload,
  AdHead,
  AdProductChips,
  AdSceneList,
  AdSketch,
  AdStill,
  CircleAlertIcon,
  adFileName,
  fileSize,
} from "./product-ad-parts";
import { AdPlayer } from "./product-ad-player";
import styles from "./product-ad-studio.module.css";
import { ProductChip } from "./product-controls";
import theme from "./product-theme.module.css";
import { ProductDraftError } from "./products-client";
import { useNarrowStudio } from "./use-product-ad";

// An ad that couldn't be made: why, in the owner's terms (a spending refusal
// in the import's own words), and "Try again", which picks up where it
// stopped and reuses what was made. What was made stays to see: the scenes,
// the Status picture, and the last video when an edit's remake failed.

const COPY = PRODUCTS_COPY.ad;

type RetryErrorCode = keyof typeof COPY.retryErrors;
const retryError = (code: string) =>
  COPY.retryErrors[
    (code in COPY.retryErrors ? code : "failed") as RetryErrorCode
  ];

export function AdFailed({
  workspaceId,
  ad,
  onChanged,
}: {
  workspaceId: string;
  ad: ProductAdRecord;
  onChanged: (ad: ProductAdRecord) => void;
}) {
  const titleId = useId();
  const narrow = useNarrowStudio();
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reason = COPY.failReasons[ad.errorCode ?? "failed"];

  const retry = async () => {
    if (sending) return;
    setSending(true);
    setProblem(null);
    try {
      onChanged(await retryProductAd(workspaceId, ad.id));
    } catch (error) {
      setProblem(
        retryError(error instanceof ProductDraftError ? error.code : "failed")
      );
    } finally {
      setSending(false);
    }
  };

  const tryAgain = (full: boolean) => (
    <Button fullWidth={full} disabled={sending} onClick={() => void retry()}>
      {sending ? COPY.starting : COPY.tryAgain}
    </Button>
  );
  const scenePicture =
    ad.scenes.find(scene => scene.imageUrl)?.imageUrl ?? null;
  const first = ad.products[0];

  return (
    <section aria-labelledby={titleId} className={styles.studio}>
      <AdHead
        titleId={titleId}
        meta={COPY.summary(
          ad.products.map(product => product.name),
          null,
          ad.language
        )}
        status={<ProductChip tone="danger">{COPY.failedChip}</ProductChip>}
      />
      <div className={styles.columns}>
        <aside className={styles.side}>
          <div className={styles.picture}>
            {ad.video ? (
              <AdPlayer video={ad.video} />
            ) : ad.stills.statusUrl ? (
              <AdStill url={ad.stills.statusUrl} alt={COPY.statusPicture} />
            ) : scenePicture ? (
              <AdStill url={scenePicture} alt="" />
            ) : first ? (
              <AdSketch product={first} />
            ) : null}
          </div>
          <div className={styles.downloads}>
            {ad.video ? (
              <>
                <p className={styles.note}>{COPY.lastVideo}</p>
                <AdDownload
                  url={ad.video.url}
                  fileName={adFileName(ad, "video")}
                >
                  {COPY.download(fileSize(ad.video.bytes))}
                </AdDownload>
              </>
            ) : null}
            {ad.stills.statusUrl ? (
              <AdDownload
                url={ad.stills.statusUrl}
                fileName={adFileName(ad, "status")}
              >
                {COPY.statusPicture}
              </AdDownload>
            ) : null}
          </div>
        </aside>

        <div className={styles.main}>
          <div className={cn(theme.sheet, styles.panel)}>
            <p className={styles.alert}>
              <CircleAlertIcon />
              <span>{COPY.failed(reason)}</span>
            </p>
            <p className={styles.note}>{COPY.tryAgainNote}</p>
            {problem ? (
              <p role="alert" className={styles.issue}>
                {problem}
              </p>
            ) : null}
            {narrow ? null : (
              <div className={styles.actions}>{tryAgain(false)}</div>
            )}
          </div>

          <div className={cn(theme.sheet, styles.panel)}>
            <AdProductChips products={ad.products} />
            <AdBriefLine ad={ad} />
          </div>

          {ad.scenes.some(scene => scene.imageUrl) ? (
            <div className={cn(theme.sheet, styles.panel)}>
              <AdSceneList ad={ad} settled />
            </div>
          ) : null}
        </div>
      </div>
      {narrow ? <AdBar>{tryAgain(true)}</AdBar> : null}
    </section>
  );
}
