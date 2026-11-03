"use client";

import type { WorkspaceProductRecord } from "@/lib/products/types";
import { useCallback, useMemo, useState } from "react";

/** The most products one ad shows. */
export const AD_MAX_PRODUCTS = 3;
/** The most products the make view takes (?make=…), in shelf order. */
export const MAKE_MAX_PRODUCTS = 60;

const NONE: ReadonlySet<string> = new Set();

/**
 * A product a video ad can show: it has a cut-out photo and a price, as the
 * ad's brief and server check (adProductProblem). A photo of the whole
 * frame, kept for a product with no clear view, isn't a cut-out.
 */
export const canGoInAd = (product: WorkspaceProductRecord) =>
  product.hasCutout === true && product.price !== null;

/**
 * The shelf's Choose mode: whether the owner is choosing, and which products
 * are chosen. Chosen products are always given in shelf order; one that left
 * the shelf stays chosen in case it comes back with the next list, but isn't
 * given.
 */
export function useProductSelection(
  products: readonly WorkspaceProductRecord[]
) {
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(NONE);

  const chosenProducts = useMemo(
    () => products.filter(product => chosen.has(product.id)),
    [products, chosen]
  );
  const chosenIds = useMemo(
    () => chosenProducts.map(product => product.id),
    [chosenProducts]
  );

  /** Starts choosing, with these products chosen (none by default). */
  const start = useCallback((productIds: readonly string[] = []) => {
    setChosen(new Set(productIds));
    setChoosing(true);
  }, []);
  /** Stops choosing, and forgets what was chosen. */
  const stop = useCallback(() => {
    setChoosing(false);
    setChosen(NONE);
  }, []);
  const toggle = useCallback((productId: string) => {
    setChosen(current => {
      const next = new Set(current);
      if (!next.delete(productId)) next.add(productId);
      return next;
    });
  }, []);
  const clear = useCallback(() => setChosen(NONE), []);

  return {
    choosing,
    /** Every chosen id, for the shelf's checks. */
    chosen,
    /** The chosen products on the shelf, in shelf order. */
    chosenProducts,
    chosenIds,
    /** Whether a video ad can be made of them: 1 to 3, each with a photo and a price. */
    adReady:
      chosenProducts.length >= 1 &&
      chosenProducts.length <= AD_MAX_PRODUCTS &&
      chosenProducts.every(canGoInAd),
    start,
    stop,
    toggle,
    clear,
  };
}
