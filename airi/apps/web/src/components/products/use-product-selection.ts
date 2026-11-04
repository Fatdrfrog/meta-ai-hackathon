"use client";

import { PRODUCT_PICKS_MAX } from "@/lib/products/templates";
import type { WorkspaceProductRecord } from "@/lib/products/types";
import { useCallback, useMemo, useState } from "react";

/** The most products one ad shows. */
export const AD_MAX_PRODUCTS = 3;

/**
 * A product a video ad can show: it has a cut-out photo and a price, as the
 * ad's brief and server check (adProductProblem). A photo of the whole
 * frame, kept for a product with no clear view, isn't a cut-out.
 */
export const canGoInAd = (product: WorkspaceProductRecord) =>
  product.hasCutout === true && product.price !== null;

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** Distinct product ids, in the order given, at most PRODUCT_PICKS_MAX. */
export function cleanPicks(ids: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !OBJECT_ID.test(id)) continue;
    seen.add(id.toLowerCase());
    if (seen.size === PRODUCT_PICKS_MAX) break;
  }
  return [...seen];
}

/** The picks an address keeps (?picks=<id,id,…>, in pick order); [] for none. */
export function picksIn(search: URLSearchParams | null): string[] {
  const value = search?.get("picks");
  return value ? cleanPicks(value.split(",")) : [];
}

/**
 * The owner's picks on the shelf, in the order they were tapped. Always on:
 * a tap on a product picks it, another lets it go; there is no mode, no
 * Done. A pick that left the shelf stays picked in case it comes back with
 * the next list, but isn't given (`on`), and the numbers count the ones
 * that are on the shelf.
 */
export function useProductSelection(
  products: readonly WorkspaceProductRecord[],
  initial: () => readonly string[] = () => []
) {
  const [picks, setPicks] = useState<readonly string[]>(() =>
    cleanPicks(initial())
  );

  const byId = useMemo(
    () => new Map(products.map(product => [product.id, product])),
    [products]
  );
  /** The picked products on the shelf, in pick order. */
  const picked = useMemo(
    () =>
      picks.flatMap(id => {
        const product = byId.get(id);
        return product ? [product] : [];
      }),
    [picks, byId]
  );
  /** Each picked product's number, from 1, in pick order. */
  const numbers = useMemo(
    () => new Map(picked.map((product, index) => [product.id, index + 1])),
    [picked]
  );

  /** Picks it, or lets it go: a tap on its bay. */
  const toggle = useCallback((productId: string) => {
    setPicks(current =>
      current.includes(productId)
        ? current.filter(id => id !== productId)
        : current.length >= PRODUCT_PICKS_MAX
          ? current
          : [...current, productId]
    );
  }, []);
  /** Picks it if it isn't: a drag that starts on an unpicked product. */
  const pick = useCallback((productId: string) => {
    setPicks(current =>
      current.includes(productId) || current.length >= PRODUCT_PICKS_MAX
        ? current
        : [...current, productId]
    );
  }, []);
  /** These picks instead, in this order. */
  const set = useCallback((productIds: readonly string[]) => {
    setPicks(cleanPicks(productIds));
  }, []);
  const clear = useCallback(() => setPicks([]), []);

  return {
    /** Every pick, on the shelf or not, in pick order: what the address keeps. */
    picks,
    /** The picked products on the shelf, in pick order. */
    picked,
    numbers,
    toggle,
    pick,
    set,
    clear,
  };
}
