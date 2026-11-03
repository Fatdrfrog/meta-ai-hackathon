"use client";

import { carouselVerdict } from "@/lib/products/kit-status";
import type {
  ProductKitPlanResponse,
  ProductKitRecord,
  ProductsMadeResponse,
} from "@/lib/products/types";
import { useEffect, useState } from "react";
import {
  fetchProductKit,
  fetchProductKitPlan,
  fetchProductsMade,
  productKitPlanUrl,
} from "./kits-client";
import { productKitUrl, productsMadeUrl } from "./products-client";
import { usePolledSWR } from "./use-polled-swr";

// The make view's data and "Made from your shelf", kept current while
// something is being made or Meta is checking a carousel. SWR only polls
// while the tab is visible.

/** While a part is being made, the kit is asked for every few seconds. */
export const KIT_MAKING_POLL_MS = 2_000;
/** While Meta checks a carousel (the server reads Meta at most once a minute). */
export const KIT_WAITING_POLL_MS = 30_000;
/** The made list while a kit is being made somewhere. */
export const MADE_MAKING_POLL_MS = 5_000;

/**
 * Whether Meta still checks the kit's carousel, whatever its other part is:
 * a kit whose order form failed or stayed a draft needs attention, but its
 * carousel row still says "This page updates on its own."
 */
function carouselWaiting(kit: ProductKitRecord): boolean {
  const carousel = kit.parts?.carousel;
  return (
    kit.status === "waiting_for_meta" ||
    (carousel?.state === "submitted" &&
      carouselVerdict(carousel.metaStatus) === "waiting")
  );
}

export function kitPollMs(kit: ProductKitRecord | undefined): number {
  if (kit?.status === "making") return KIT_MAKING_POLL_MS;
  if (kit && carouselWaiting(kit)) return KIT_WAITING_POLL_MS;
  return 0;
}

export function madePollMs(made: ProductsMadeResponse | undefined): number {
  if (!made) return 0;
  if (made.kits.some(kit => kit.status === "making"))
    return MADE_MAKING_POLL_MS;
  const waiting =
    made.kits.some(carouselWaiting) ||
    made.ads.some(ad => ad.status === "making");
  return waiting ? KIT_WAITING_POLL_MS : 0;
}

/** How often, and how many times, a plan missing products is asked for again. */
export const PLAN_MISSING_POLL_MS = 1_500;
export const PLAN_MISSING_POLLS = 6;

/**
 * What the make view needs for these products, before the press. A review
 * shows its done screen while its last decisions are still being saved, so
 * a plan missing some of the products is asked for again a few times.
 */
export function useProductKitPlan(
  workspaceId: string,
  productIds: readonly string[],
  importId: string | null
) {
  const expected = productIds.length;
  const key =
    expected > 0 ? productKitPlanUrl(workspaceId, productIds, importId) : null;
  // How many answers in a row were missing products, for this key.
  const [misses, setMisses] = useState<{ key: string | null; count: number }>({
    key: null,
    count: 0,
  });
  const missed = misses.key === key ? misses.count : 0;
  const plan = usePolledSWR<ProductKitPlanResponse>(
    key,
    fetchProductKitPlan,
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      onSuccess: answer =>
        setMisses(current => ({
          key,
          count:
            answer.products.length < expected
              ? (current.key === key ? current.count : 0) + 1
              : 0,
        })),
    },
    answer =>
      answer && answer.products.length < expected && missed < PLAN_MISSING_POLLS
        ? PLAN_MISSING_POLL_MS
        : 0
  );
  const waitingForProducts = Boolean(
    plan.data &&
      plan.data.products.length < expected &&
      missed < PLAN_MISSING_POLLS
  );
  return { plan, waitingForProducts };
}

/** One kit, starting from what the press answered, kept current. */
export function useProductKit(workspaceId: string, kit: ProductKitRecord) {
  // Until the first answer the kit is the press's (fallbackData).
  return usePolledSWR<ProductKitRecord>(
    productKitUrl(workspaceId, kit.id),
    fetchProductKit,
    {
      fallbackData: kit,
      revalidateOnMount: false,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
    kitPollMs
  );
}

/** "Made from your shelf": kits and ads, newest first. */
export function useProductsMade(workspaceId: string) {
  return usePolledSWR<ProductsMadeResponse>(
    productsMadeUrl(workspaceId),
    fetchProductsMade,
    { revalidateOnFocus: false, shouldRetryOnError: false },
    madePollMs
  );
}

/** Now, ticking once a second while `running`: liveness comes from text. */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

/** Seconds as a clock: 0:38, 1:04. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
});

/** A time on the owner's clock: "09:14". */
export function clockTime(iso: string): string {
  return TIME.format(new Date(iso));
}

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** When something was made: "today at 09:14", "yesterday at …", "2 Nov at …". */
export function madeWhen(
  iso: string,
  now: Date,
  words: {
    today: (time: string) => string;
    yesterday: (time: string) => string;
    onDay: (day: string, time: string) => string;
  }
): string {
  const at = new Date(iso);
  const time = TIME.format(at);
  if (dayKey(at) === dayKey(now)) return words.today(time);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(at) === dayKey(yesterday)) return words.yesterday(time);
  return words.onDay(DAY.format(at), time);
}
