"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type { ProductAdRecord } from "@/lib/products/types";
import { useCallback, useId } from "react";
import { AdBrief } from "./product-ad-brief";
import { AdFailed } from "./product-ad-failed";
import { AdMaking } from "./product-ad-making";
import { AdHead, AdProblem, AdSkeleton } from "./product-ad-parts";
import { AdReady } from "./product-ad-ready";
import styles from "./product-ad-studio.module.css";
import { useProductAd } from "./use-product-ad";

// The video ad studio: the brief for a new ad, the honest step list while
// it's made, the finished ad with its stills and copy, and a failed one. The
// page's ?ad view: ?ad=new&products=<ids> for a new ad, ?ad=<adId> for one
// already made. The page draws the way back; the studio draws no back button.

const COPY = PRODUCTS_COPY.ad;

/** Which ad the studio shows. */
export type AdStudioView =
  | { kind: "new"; productIds: string[] }
  | { kind: "ad"; adId: string };

/** What the page gives the studio. */
export type AdStudioProps = {
  workspaceId: string;
  view: AdStudioView;
  /**
   * After "Make the ad": the page swaps ?ad=new&products=… for ?ad=<adId> in
   * place, so a refresh or Back finds the ad.
   */
  onCreated: (adId: string) => void;
  /** "Change" on the brief's products: the shelf's Choose mode with them chosen. */
  onChangeProducts: (productIds: string[]) => void;
  /** Back to the page. */
  onClose: () => void;
};

/** The studio. */
export function AdStudio({
  workspaceId,
  view,
  onCreated,
  onChangeProducts,
  onClose,
}: AdStudioProps) {
  if (view.kind === "new")
    return (
      <AdBrief
        key={view.productIds.join(",")}
        workspaceId={workspaceId}
        productIds={view.productIds}
        onCreated={onCreated}
        onChangeProducts={onChangeProducts}
      />
    );
  return (
    <AdView
      key={view.adId}
      workspaceId={workspaceId}
      adId={view.adId}
      onChangeProducts={onChangeProducts}
      onClose={onClose}
    />
  );
}

/** An ad already made: loaded, then kept current while it's being made. */
function AdView({
  workspaceId,
  adId,
  onChangeProducts,
  onClose,
}: {
  workspaceId: string;
  adId: string;
  onChangeProducts: (productIds: string[]) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const { data: ad, error, mutate } = useProductAd(workspaceId, adId);
  // An edit or a retry answers with the ad as it now is.
  const onChanged = useCallback(
    (next: ProductAdRecord) => void mutate(next, { revalidate: false }),
    [mutate]
  );

  if (!ad)
    return (
      <section aria-labelledby={titleId} className={styles.studio}>
        <AdHead titleId={titleId} meta={null} />
        {error?.code === "ad_not_found" ? (
          <AdProblem
            message={COPY.notFound}
            action={
              <Button variant="outline" onClick={onClose}>
                {COPY.backToProducts}
              </Button>
            }
          />
        ) : error ? (
          <AdProblem
            message={COPY.loadFailed}
            action={
              <Button variant="outline" onClick={() => void mutate()}>
                {COPY.retry}
              </Button>
            }
          />
        ) : (
          <AdSkeleton label={COPY.loading} />
        )}
      </section>
    );

  return (
    <>
      {/* Said once when the ad turns ready or fails, wherever the focus is. */}
      <p className="sr-only" aria-live="polite">
        {COPY.announce[ad.status]}
      </p>
      {ad.status === "ready" ? (
        <AdReady
          key={ad.renderNo}
          workspaceId={workspaceId}
          ad={ad}
          onChanged={onChanged}
          onChangeProducts={onChangeProducts}
        />
      ) : ad.status === "failed" ? (
        <AdFailed workspaceId={workspaceId} ad={ad} onChanged={onChanged} />
      ) : (
        <AdMaking ad={ad} />
      )}
    </>
  );
}
