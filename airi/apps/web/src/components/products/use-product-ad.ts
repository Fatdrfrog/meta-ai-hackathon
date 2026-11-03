"use client";

import type { ProductAdRecord } from "@/lib/products/types";
import { useEffect, useState, useSyncExternalStore } from "react";
import { fetchProductAd } from "./ads-client";
import { productAdUrl, type ProductDraftError } from "./products-client";
import { usePolledSWR } from "./use-polled-swr";

/**
 * How often the studio asks for an ad while it's being made. SWR asks only
 * while the tab is visible, and stops once the ad is ready or failed, so a
 * finished video's link stays put while it plays.
 */
export const PRODUCT_AD_POLL_MS = 2000;

export const productAdPollInterval = (ad: ProductAdRecord | undefined) =>
  ad?.status === "making" ? PRODUCT_AD_POLL_MS : 0;

/**
 * One ad, kept current while it's being made: also when it's opened with
 * nothing cached, and when Try again or an edit answers with it making.
 */
export function useProductAd(workspaceId: string, adId: string) {
  return usePolledSWR<ProductAdRecord, ProductDraftError>(
    productAdUrl(workspaceId, adId),
    fetchProductAd,
    { revalidateOnFocus: false, shouldRetryOnError: false },
    productAdPollInterval
  );
}

/** The time now, ticking once a second while `active`: the making clock. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

// Below this the studio is one column with its main action in a bar kept at
// the bottom, as the CSS module lays it out.
const NARROW = "(max-width: 899px)";

const narrowNow = () =>
  typeof window !== "undefined" && window.matchMedia?.(NARROW).matches === true;

function subscribeNarrow(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(NARROW);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

/** Whether the studio is one column, with its main action at the bottom. */
export function useNarrowStudio(): boolean {
  return useSyncExternalStore(subscribeNarrow, narrowNow, () => false);
}
