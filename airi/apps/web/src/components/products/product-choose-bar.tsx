"use client";

import { Button } from "@/components/ui/button";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type { WorkspaceProductRecord } from "@/lib/products/types";
import { Clapperboard } from "lucide-react";
import { useId, type Ref } from "react";
import styles from "./product-choose-bar.module.css";
import { initialOf } from "./product-shelf";
import theme from "./product-theme.module.css";

const COPY = PRODUCTS_COPY.choose;
// The chosen products the bar shows as thumbnails.
const THUMBS = 3;

/**
 * The bar under the shelf while the owner chooses products: how many are
 * chosen, Clear, and the two things to make with them. The video ad takes 1
 * to 3 products with photos and prices, and says so when the choice doesn't
 * fit; the carousel and order form take any.
 */
export function ProductChooseBar({
  chosen,
  adReady,
  makeKitRef,
  onClear,
  onMakeAd,
  onMakeKit,
}: {
  /** The chosen products, in shelf order. */
  chosen: readonly WorkspaceProductRecord[];
  adReady: boolean;
  /** The carousel and order form button, for the page to give the focus back to. */
  makeKitRef?: Ref<HTMLButtonElement>;
  onClear: () => void;
  onMakeAd: () => void;
  onMakeKit: () => void;
}) {
  const noteId = useId();
  const count = chosen.length;
  const adNote = count > 0 && !adReady;
  return (
    <div className={styles.dock}>
      <div role="region" aria-label={COPY.region} className={styles.bar}>
        <div className={styles.summary}>
          {count > 0 ? (
            <span aria-hidden="true" className={styles.thumbs}>
              {chosen.slice(0, THUMBS).map(product => (
                <span key={product.id}>
                  {product.imageUrl ? (
                    // Signed storage URLs, as the shelf shows them.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={product.imageUrl} alt="" draggable={false} />
                  ) : (
                    <b>{initialOf(product.name)}</b>
                  )}
                </span>
              ))}
            </span>
          ) : null}
          <div className={styles.text}>
            <p className={styles.count}>
              <span aria-live="polite">
                {count > 0 ? COPY.chosen(count) : COPY.note}
              </span>
              {count > 0 ? (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto px-0 py-0 text-[13px] font-medium"
                  onClick={onClear}
                >
                  {COPY.clear}
                </Button>
              ) : null}
            </p>
            {adNote ? (
              <p id={noteId} className={styles.note}>
                {COPY.adNote}
              </p>
            ) : null}
          </div>
        </div>
        <div className={styles.actions}>
          <Button
            variant="outline"
            className="h-10"
            disabled={!adReady}
            aria-describedby={adNote ? noteId : undefined}
            onClick={onMakeAd}
          >
            <Clapperboard aria-hidden="true" />
            <span className="max-sm:hidden">{COPY.makeAd}</span>
            <span className="sm:hidden">{COPY.makeAdShort}</span>
          </Button>
          <Button
            ref={makeKitRef}
            className={theme.fillOnPhone}
            disabled={count === 0}
            onClick={onMakeKit}
          >
            <span className="max-sm:hidden">{COPY.makeKit}</span>
            <span className="sm:hidden">{COPY.makeKitShort}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
