"use client";

import { useFormatter } from "next-intl";
import { useEffect, useState, useSyncExternalStore } from "react";

function subscribeToTimeZone(onChange: () => void) {
  window.addEventListener("focus", onChange);
  return () => window.removeEventListener("focus", onChange);
}

function getBrowserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function getServerTimeZone() {
  return "UTC";
}

/** True until `retryAt` (epoch ms) has passed. */
export function useRetryLocked(retryAt: number | null | undefined): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (typeof retryAt !== "number" || retryAt <= now) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, Math.max(0, retryAt - Date.now()))
    );
    return () => clearTimeout(timer);
  }, [retryAt, now]);
  return typeof retryAt === "number" && retryAt > now;
}

/**
 * Formats a time with its date and the viewer's timezone, so a retry time
 * hours away still reads right. Every "try again after" uses it.
 */
export function useCampaignTimeFormatter(): (
  value: string | number | Date
) => string {
  const format = useFormatter();
  const timeZone = useSyncExternalStore(
    subscribeToTimeZone,
    getBrowserTimeZone,
    getServerTimeZone
  );
  return value =>
    `${format.dateTime(new Date(value), {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    })} (${timeZone})`;
}
