"use client";

import { useState } from "react";
import useSWR, { type SWRConfiguration, type SWRResponse } from "swr";

/**
 * useSWR, asking again after the wait `pollMs` gives for the data it holds
 * now (0: not again). SWR starts its wait over whenever refreshInterval
 * changes, and calls a function given as refreshInterval only when a wait
 * starts. So a function made on every render keeps putting the next ask off
 * while the page re-renders more often than the wait, and one kept for good
 * never starts asking when the data turns into something to wait on: its
 * first answer, or what a retry or an edit answered. SWR gets the wait as a
 * number instead, which changes only when the wait does.
 */
export function usePolledSWR<Data, Error = unknown>(
  key: string | null,
  fetcher: (url: string) => Promise<Data>,
  config: Omit<SWRConfiguration<Data, Error>, "refreshInterval">,
  pollMs: (data: Data | undefined) => number
): SWRResponse<Data, Error> {
  const [wait, setWait] = useState(0);
  const swr = useSWR<Data, Error>(key, fetcher, {
    ...config,
    refreshInterval: wait,
  });
  // Set while rendering, so the wait SWR gets matches what it shows.
  const wanted = pollMs(swr.data);
  if (wanted !== wait) setWait(wanted);
  return swr;
}
